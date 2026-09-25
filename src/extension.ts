// hal Bridge: localhost HTTP transport exposing vscode.lm to the hal R package.
//
// On activation, binds an HTTP server to 127.0.0.1:<random> and writes the
// chosen port plus a per-launch random token to a discovery file (port.json)
// in a per-user application data dir -- NOT the system temp dir, which the OS
// garbage-collects (e.g. Windows Storage Sense) and would orphan a still-live
// bridge. The R-side HalClientVSCode reads that file, then POSTs /chat
// requests with `Authorization: Bearer <token>` and reads back SSE-framed
// events.
//
// Security boundaries:
//  - 127.0.0.1 only (no LAN/WAN exposure).
//  - Bearer-token auth on /chat and /models defends against same-machine
//    actors (browser extensions, other processes) that don't have read
//    access to the port file.
//  - /version and /health stay unauthenticated for liveness checks.
//  - Concurrent /chat requests capped to prevent quota-burn abuse.

import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

const BRIDGE_VERSION = '0.1.4';

// Discovery file lives in a durable per-user app-data dir, not os.tmpdir().
// Windows: %LOCALAPPDATA%\hal-bridge\port.json
// POSIX:   $XDG_RUNTIME_DIR/hal-bridge/port.json, else ~/.cache/hal-bridge/...
// The R-side .hal_bridge_port_file() computes the identical path.
function portFileDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || os.tmpdir();
    return path.join(base, 'hal-bridge');
  }
  const base = process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), '.cache');
  return path.join(base, 'hal-bridge');
}
const PORT_FILE = path.join(portFileDir(), 'port.json');
const MAX_CONCURRENT_CHAT = 4;

let inFlightChat = 0;

// Read the pid recorded in the current port file, if any.
function portFileOwnerPid(): number | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
    return typeof info.pid === 'number' ? info.pid : undefined;
  } catch {
    return undefined;
  }
}

// Delete the port file only if it belongs to THIS process, so one Positron
// window closing never removes another live window's discovery file.
function unlinkOwnPortFile(): void {
  try {
    if (portFileOwnerPid() === process.pid) fs.unlinkSync(PORT_FILE);
  } catch { /* nothing to clean */ }
}

export function activate(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('halBridge');
  const requestedPort = cfg.get<number>('port') ?? 0;

  // 32 bytes of cryptographic randomness, hex-encoded → 64-char secret. New
  // every activation; rotates whenever Positron reloads.
  const token = crypto.randomBytes(32).toString('hex');

  const server = http.createServer((req, res) => {
    handleRequest(req, res, token).catch((err) => {
      console.error('hal-bridge: unhandled error', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      } else {
        try { res.end(); } catch {}
      }
    });
  });

  // This instance's discovery info, set once the server is listening, plus a
  // writer reused by both initial activation and the self-heal interval.
  let info: Record<string, unknown> | null = null;
  const writePortFile = () => {
    if (!info) return;
    try {
      // 0o600 enforces owner-only on POSIX. Windows ignores `mode`, but
      // %LOCALAPPDATA% is already per-user via NTFS ACLs by default.
      fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
      fs.writeFileSync(PORT_FILE, JSON.stringify(info, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error('hal-bridge: failed to write port file', e);
    }
  };

  server.listen(requestedPort, '127.0.0.1', () => {
    const addr = server.address();
    if (typeof addr === 'object' && addr) {
      info = {
        port: addr.port,
        pid: process.pid,
        version: BRIDGE_VERSION,
        token,
        started: new Date().toISOString()
      };
      writePortFile();
      console.log(
        `hal-bridge ${BRIDGE_VERSION} listening on 127.0.0.1:${addr.port}`
      );
    }
  });

  // Self-heal: if our port file disappears while we're still listening -- e.g.
  // another Positron window's deactivate() removed the shared file, or an OS
  // cleanup did -- rewrite it. Only writes when the file is absent, so it never
  // clobbers a file currently owned by another live instance.
  const heal = setInterval(() => {
    if (info && server.listening && !fs.existsSync(PORT_FILE)) {
      writePortFile();
    }
  }, 5000);

  context.subscriptions.push({
    dispose: () => {
      clearInterval(heal);
      try { server.close(); } catch {}
      unlinkOwnPortFile();
    }
  });
}

export function deactivate() {
  unlinkOwnPortFile();
}

// -- Request handling ---------------------------------------------------------

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  expectedToken: string
) {
  const url = req.url ?? '';
  const method = req.method ?? 'GET';

  // Public liveness endpoints: no token required, no model access exposed.
  if (method === 'GET' && url === '/version') {
    return json(res, 200, { version: BRIDGE_VERSION });
  }
  if (method === 'GET' && url === '/health') {
    return json(res, 200, {
      status: 'ok', inFlightChat, maxConcurrentChat: MAX_CONCURRENT_CHAT
    });
  }

  // Everything else requires the bearer token.
  if (!isAuthorized(req, expectedToken)) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('WWW-Authenticate', 'Bearer realm="hal-bridge"');
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (method === 'GET' && url === '/models') {
    const models = await vscode.lm.selectChatModels({});
    return json(res, 200, models.map((m) => ({
      id: m.id,
      vendor: m.vendor,
      family: m.family,
      name: m.name,
      version: m.version,
      maxInputTokens: m.maxInputTokens
    })));
  }

  if (method === 'POST' && url === '/chat') {
    if (inFlightChat >= MAX_CONCURRENT_CHAT) {
      res.statusCode = 429;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Retry-After', '5');
      res.end(JSON.stringify({
        error: 'too many concurrent /chat requests',
        inFlight: inFlightChat,
        limit: MAX_CONCURRENT_CHAT
      }));
      return;
    }
    inFlightChat++;
    try {
      let body: string;
      try {
        body = await readBody(req);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          return json(res, 413, { error: err.message });
        }
        throw err;
      }
      const payload = JSON.parse(body);
      await handleChat(res, payload);
    } finally {
      inFlightChat--;
    }
    return;
  }

  res.statusCode = 404;
  res.end();
}

function isAuthorized(
  req: http.IncomingMessage,
  expectedToken: string
): boolean {
  const header = (req.headers['authorization'] ?? '') as string;
  if (!header.startsWith('Bearer ')) return false;
  const provided = header.slice('Bearer '.length).trim();
  // Constant-time comparison defends against timing attacks. Both strings
  // are hex of the same length when valid; pad+truncate to keep
  // timingSafeEqual happy if a junk token is provided.
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// -- /chat --------------------------------------------------------------------

interface ChatPayload {
  vendor?: string;
  family?: string;
  id?: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ChatPart[];
}

type ChatPart =
  | { type: 'text'; value: string }
  | { type: 'tool_call'; callId: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      callId: string;
      content: string;
      // Optional base64 image (hal plot vision, R side >= 0.1.4). Older R
      // clients simply omit it; older bridges ignore it -- compatible both
      // directions with no protocol version gate.
      image?: { mimeType?: string; data: string };
    };

interface ChatTool {
  name: string;
  description?: string;
  parameters?: object;
}

async function handleChat(res: http.ServerResponse, payload: ChatPayload) {
  const selector: vscode.LanguageModelChatSelector = {};
  if (payload.vendor) selector.vendor = payload.vendor;
  if (payload.family) selector.family = payload.family;
  if (payload.id)     selector.id = payload.id;

  const models = await vscode.lm.selectChatModels(selector);
  if (models.length === 0) {
    return json(res, 404, { error: 'No matching vscode.lm model.' });
  }
  const model = models[0];

  const messages = payload.messages.map(toVscodeMessage);
  const tools = (payload.tools ?? []).map<vscode.LanguageModelChatTool>((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.parameters ?? { type: 'object', properties: {} }
  }));

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const cts = new vscode.CancellationTokenSource();
  res.on('close', () => cts.cancel());

  // Consumer-side vscode.lm has no static image-capability query -- a model
  // that doesn't accept images throws at sendRequest. If that happens BEFORE
  // any output has streamed and we sent DataParts, strip them to a text
  // placeholder and retry once. Never retry after streaming has begun (the
  // client would receive duplicated text).
  let streamedAny = false;
  const runOnce = async (msgs: vscode.LanguageModelChatMessage[]) => {
    const response = await model.sendRequest(
      msgs,
      tools.length ? { tools } : {},
      cts.token
    );
    for await (const part of response.stream) {
      streamedAny = true;
      if (part instanceof vscode.LanguageModelTextPart) {
        sse(res, { type: 'text', value: part.value });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        sse(res, {
          type: 'tool_call',
          callId: part.callId,
          name: part.name,
          input: part.input
        });
      }
    }
  };

  try {
    try {
      await runOnce(messages);
    } catch (err) {
      const hadImages = payload.messages.some((m) =>
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'tool_result' && p.image?.data)
      );
      if (streamedAny || !hadImages) throw err;
      console.warn('hal-bridge: model rejected image input; retrying text-only', err);
      const stripped = payload.messages.map((m) => {
        if (!Array.isArray(m.content)) return m;
        return {
          ...m,
          content: m.content.map((p) =>
            p.type === 'tool_result' && p.image?.data
              ? {
                  ...p,
                  image: undefined,
                  content: `${p.content}\n[plot image omitted: model does not accept image input]`
                }
              : p
          )
        };
      });
      await runOnce(stripped.map(toVscodeMessage));
    }
    sse(res, { type: 'done' });
  } catch (err: any) {
    sse(res, { type: 'error', message: String(err?.message ?? err) });
  } finally {
    cts.dispose();
    res.end();
  }
}

function toVscodeMessage(m: ChatMessage): vscode.LanguageModelChatMessage {
  const parts = normalizeContent(m.content);

  if (m.role === 'user') {
    const userParts: (string | vscode.LanguageModelToolResultPart)[] = [];
    for (const p of parts) {
      if (p.type === 'text') userParts.push(p.value);
      else if (p.type === 'tool_result') {
        const resultParts: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [
          new vscode.LanguageModelTextPart(p.content)
        ];
        if (p.image?.data) {
          resultParts.push(vscode.LanguageModelDataPart.image(
            Buffer.from(p.image.data, 'base64'),
            p.image.mimeType ?? 'image/png'
          ));
        }
        userParts.push(new vscode.LanguageModelToolResultPart(p.callId, resultParts));
      }
    }
    if (userParts.length === 1 && typeof userParts[0] === 'string') {
      return vscode.LanguageModelChatMessage.User(userParts[0]);
    }
    const msg = vscode.LanguageModelChatMessage.User('');
    msg.content = userParts.map((p) =>
      typeof p === 'string' ? new vscode.LanguageModelTextPart(p) : p
    ) as any;
    return msg;
  }

  const asstParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
  for (const p of parts) {
    if (p.type === 'text') asstParts.push(new vscode.LanguageModelTextPart(p.value));
    else if (p.type === 'tool_call') {
      asstParts.push(new vscode.LanguageModelToolCallPart(p.callId, p.name, p.input as object));
    }
  }
  if (asstParts.length === 1 && asstParts[0] instanceof vscode.LanguageModelTextPart) {
    return vscode.LanguageModelChatMessage.Assistant((asstParts[0] as vscode.LanguageModelTextPart).value);
  }
  const msg = vscode.LanguageModelChatMessage.Assistant('');
  msg.content = asstParts as any;
  return msg;
}

function normalizeContent(content: string | ChatPart[]): ChatPart[] {
  if (typeof content === 'string') return [{ type: 'text', value: content }];
  return content;
}

// -- helpers ------------------------------------------------------------------

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function sse(res: http.ServerResponse, obj: unknown) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// 20 MB request cap: generous for chat history + a few base64 plots, small
// enough that a runaway client can't balloon extension-host memory.
const MAX_BODY_BYTES = 20 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new PayloadTooLargeError());
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

class PayloadTooLargeError extends Error {
  constructor() { super('Request body exceeds 20MB limit.'); }
}
