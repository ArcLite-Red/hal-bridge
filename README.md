# hal Bridge

Tiny VS Code / Positron extension that exposes the `vscode.lm` Language Model
API as a localhost HTTP endpoint, so the [hal](https://github.com/ArcLite-Red/hal)
R package can route requests through the editor's built-in Copilot models
without going through the Copilot CLI (and the org policy machinery the CLI
inherits).

## How it works

On activation, the extension starts an HTTP server bound to `127.0.0.1` on
an OS-assigned port. It writes the port number (plus a per-launch bearer
token) to a discovery file in a durable per-user app-data directory so hal
can find it:

```
%LOCALAPPDATA%\hal-bridge\port.json                 (Windows)
$XDG_RUNTIME_DIR/hal-bridge/port.json               (Linux, if set)
~/.cache/hal-bridge/port.json                       (macOS / Linux fallback)
```

The discovery file deliberately avoids the system temp directory, which the
OS garbage-collects (e.g. Windows Storage Sense) and would otherwise orphan
a still-running bridge.

The R-side `HalClientVSCode` reads that file, POSTs chat requests, and
streams responses back over Server-Sent Events. Tool calls round-trip as
JSON; no subprocess, no MCP, no CLI.

## Endpoints

- `GET /version` &mdash; bridge version.
- `GET /models` &mdash; available `vscode.lm` models the user can access.
- `POST /chat` &mdash; chat request; streams `text` / `tool_call` / `done`
  events as SSE. `tool_result` parts in the request may carry an optional
  `image: { mimeType, data }` (base64 PNG &mdash; hal plot vision, 0.1.4+);
  it is forwarded to the model as a `LanguageModelDataPart`. If the
  selected model rejects image input, the bridge strips images and
  retries once text-only. Request bodies are capped at 20 MB (413).

## Releasing

The bridge ships **inside the hal R package** (`hal/inst/extdata/`), not
from this repo. hal installs it via the Positron CLI in
`hal_install_bridge()`. To cut a release:

1. Bump `version` in `package.json` (keep semver in step with the change).
2. `npm run package` &mdash; recompiles from source, then produces
   `hal-bridge-<version>.vsix`. Never package from a stale `out/`; this
   script always recompiles first.
3. Copy the VSIX into the sibling R package:
   `cp hal-bridge-<version>.vsix ../hal/inst/extdata/` and delete the old
   VSIX there (hal bundles exactly one).
4. In `../hal/R/bridge.R`, set `BRIDGE_VERSION` to the same version string.
   hal's version-match check in `hal_bridge_status()` compares against it.
5. Commit both repos; note the bridge bump in hal's `NEWS.md`.

Loose `.vsix` files and `out/` in this repo are untracked build artifacts
(`.gitignore`d) &mdash; the copy inside `hal/inst/extdata/` is the only
artifact that ships. Verify sync any time with:

```sh
npm run compile
unzip -p ../hal/inst/extdata/hal-bridge-<version>.vsix \
  extension/out/extension.js | diff - out/extension.js
```

## License

MIT.
