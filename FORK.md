# T3 Code — Hermes fork

A fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) that adds
[Hermes Agent](https://github.com/NousResearch/hermes-agent) as a first-class provider, so you can
drive Hermes from T3 Code's web, desktop, and mobile clients instead of `hermes-webui`.

Upstream is MIT licensed; that license is retained verbatim in [LICENSE](./LICENSE). Everything in
[docs/](./docs) still applies — this file only covers what is specific to the fork.

## What this fork changes

| Change                                              | Where                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| `hermes` provider driver (ACP over stdio)           | `apps/server/src/provider/{Drivers,Layers,Services,acp}/Hermes*.ts`         |
| Hermes text generation (titles, commit messages, …) | `apps/server/src/textGeneration/HermesTextGeneration.ts`                    |
| `HermesSettings` + driver registration              | `packages/contracts/src/{settings,model}.ts`, `provider/builtInDrivers.ts`  |
| Hermes branding in the clients                      | `apps/web/src/components/**`, `apps/mobile/src/components/ProviderIcon.tsx` |
| Auto-bootstrap default provider is overridable      | `apps/server/src/serverRuntimeStartup.ts`                                   |
| Model picker falls back to a populated provider     | `apps/web/src/components/chat/ModelPickerContent.tsx`                       |

The last two are not Hermes-specific but matter on Hermes-only hosts. Upstream hardcodes `codex` as
the provider stamped onto auto-bootstrapped projects, and the model picker opens on whatever
instance the thread is bound to — so on a machine with no Codex CLI you get a project wired to a
provider with no models and a picker that renders "No models found" with no hint that other
providers are populated.

The Hermes driver reuses the existing ACP runtime (`apps/server/src/provider/acp/`) that already
backs Cursor and Grok, so it inherits streaming, tool-call cards, approvals, session resume, and
model switching. See [docs/internals/providers.md](./docs/internals/providers.md).

## Requirements

- **Node `^24.13.1`** — the server runs directly from TypeScript source via Node's type stripping.
- **pnpm 11.10.0** — `corepack enable && corepack prepare pnpm@11.10.0 --activate`.
- **Hermes Agent with the ACP adapter.** Verified against **v0.20.0 (2026.8.3)**. The adapter lives
  in the `acp_adapter` package of the Hermes checkout and needs the `acp` Python dependency.
- A C toolchain (`build-essential` or equivalent) — some dependencies build native modules.

Confirm Hermes can speak ACP before touching T3 Code. This should log
`ACP client connected` / `Initialize from unknown (protocol v1)` on stderr:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}}' \
  | hermes acp
```

If `hermes` is not on your `PATH` it is usually at `~/.hermes/hermes-agent/venv/bin/hermes`. Note
the absolute path — you will need it below.

## Install and run

```bash
git clone <this-repo-url> t3code && cd t3code
pnpm install --frozen-lockfile
pnpm --filter @t3tools/web build     # only the web app needs a build step
node apps/server/src/bin.ts start --no-browser
```

The server resolves the built web assets at `apps/web/dist` relative to itself, so no other package
needs building. Add `--host <ip>` and `--port <port>` to bind somewhere other than loopback, and
pass a directory argument to set the working directory used for provider sessions.

Mint a login (prints a URL and QR code):

```bash
node apps/server/src/bin.ts pair --ttl 2h
```

## Enable the Hermes provider

**The driver ships disabled** — it will not probe for a Hermes binary until you turn it on. Create
`<T3CODE_HOME>/userdata/settings.json` (`T3CODE_HOME` defaults to `~/.t3`):

```json
{
  "providers": {
    "hermes": {
      "enabled": true,
      "binaryPath": "/home/you/.hermes/hermes-agent/venv/bin/hermes"
    }
  }
}
```

`binaryPath` may be omitted if `hermes` is on the server process's `PATH`. Restart the server, then
check `<T3CODE_HOME>/caches/hermes.json` — a working setup reports `"status": "ready"`, the Hermes
version, and a populated `models` array.

Models are discovered over ACP from Hermes's own configuration, so whatever providers you have
credentials for in `~/.hermes/.env` are what appear in the picker. Until the first ACP handshake
completes, the snapshot shows a single placeholder slug; that is expected.

## Headless deployment

For an always-on box, run it under systemd as a user service. Two things differ from a normal
T3 Code install and will silently bite you otherwise:

1. **Do not use `t3 service install`.** It downloads the _published_ `t3` package into a managed
   runtime directory (`~/.t3/runtime/versions/<v>/node_modules/t3/dist/bin.mjs`) and runs that —
   i.e. upstream code, without the Hermes driver. Write your own unit pointing at this checkout.
2. **Use `start --no-browser`, not `serve`.** `serve` forces `startupPresentation=headless`, which
   hard-disables auto-bootstrap of a default project and thread, so you land on a project picker
   with nothing in it. `--no-browser` keeps `start` headless-safe.

```ini
# ~/.config/systemd/user/t3code.service
[Unit]
Description=T3 Code server (Hermes fork)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/t3code
ExecStart=/usr/local/bin/node %h/t3code/apps/server/src/bin.ts start \
  --host <bind-address> --port 8790 --no-browser %h
Restart=on-failure
RestartSec=10
Environment=NODE_OPTIONS=--max-old-space-size=1536
# Only needed when Codex is not installed on this host:
Environment=T3CODE_BOOTSTRAP_PROVIDER_INSTANCE=hermes
Environment=T3CODE_BOOTSTRAP_MODEL=<a-model-slug-hermes-reports>

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now t3code
sudo loginctl enable-linger "$USER"   # survive logout and reboot
```

**Bind deliberately.** The server controls agents on the host, which is remote code execution by
design. Bind to a private interface — a Tailscale address, or loopback behind a reverse proxy.
Do not bind `0.0.0.0` on a machine with a public IP, and do not put it behind Tailscale Funnel.

`T3CODE_BOOTSTRAP_PROVIDER_INSTANCE` / `T3CODE_BOOTSTRAP_MODEL` only affect _newly_ bootstrapped
projects. An existing project keeps the default it was created with; change that in the UI under
Project Settings → default model.

## Known limitations

- **Session modes are best-effort.** The adapter sends `session/set_mode` through the generic ACP
  request escape hatch and only logs a warning if Hermes rejects it. Approval enforcement is done
  by the adapter's own permission gate, so behaviour is correct either way.
- **`auth.status` reports `unknown`.** Hermes authenticates from its own `~/.hermes/.env` rather
  than through ACP, so T3 Code cannot introspect it. Not a fault condition.
- **No Hermes-specific surfaces.** Cron jobs, profiles, and memory/notes browsing are not exposed;
  use the `hermes` CLI for those. Chat, streaming, tool calls, approvals, resume, and model
  switching all work.
- **`respondToUserInput` is unimplemented** — Hermes has no equivalent ACP extension, so nothing
  ever opens such a request.

## Tracking upstream

`origin` should point at this fork. Add upstream separately and rebase when you want new releases:

```bash
git remote add upstream https://github.com/pingdotgg/t3code
git fetch upstream && git rebase upstream/main
```

The Hermes driver is additive — new files plus registration lines — so conflicts are usually
limited to `builtInDrivers.ts`, `settings.ts`, and the client branding lists.
