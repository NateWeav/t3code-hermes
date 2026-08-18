# T3 Code — Hermes fork

A fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) that adds
[Hermes Agent](https://github.com/NousResearch/hermes-agent) as a first-class provider, so you can
drive Hermes from T3 Code's web, desktop, and mobile clients instead of `hermes-webui`.

Upstream is MIT licensed; that license is retained verbatim in [LICENSE](./LICENSE). Everything in
[docs/](./docs) still applies — this file only covers what is specific to the fork.

## What this fork changes

| Change                                              | Where                                                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hermes` provider driver (ACP over stdio)           | `apps/server/src/provider/{Drivers,Layers,Services,acp}/Hermes*.ts`                                                                                         |
| Hermes text generation (titles, commit messages, …) | `apps/server/src/textGeneration/HermesTextGeneration.ts`                                                                                                    |
| `HermesSettings` + driver registration              | `packages/contracts/src/{settings,model}.ts`, `provider/builtInDrivers.ts`                                                                                  |
| Hermes branding in the clients                      | `apps/web/src/components/**`, `apps/mobile/src/components/ProviderIcon.tsx`                                                                                 |
| Auto-bootstrap default provider is overridable      | `apps/server/src/serverRuntimeStartup.ts`                                                                                                                   |
| Model picker falls back to a populated provider     | `apps/web/src/components/chat/ModelPickerContent.tsx`                                                                                                       |
| ACP `available_commands_update` / `usage_update`    | `apps/server/src/provider/acp/{AcpRuntimeModel,AcpSessionRuntime}.ts`                                                                                       |
| Shared slash-command dedupe (was Claude-private)    | `apps/server/src/provider/slashCommands.ts`                                                                                                                 |
| Hermes Tasks panel (cron jobs)                      | `apps/server/src/hermes/`, `packages/contracts/src/hermesCron.ts`, `apps/web/src/components/hermes/`                                                        |
| Hermes Memory panel (Hindsight)                     | `apps/server/src/integrations/hindsight/`, `packages/contracts/src/hindsight.ts`, `apps/web/src/{state/hindsight.ts,components/hermes/HermesMemoryTab.tsx}` |
| Reasoning-effort selector (Hermes `config.yaml`)    | `apps/server/src/hermes/hermesReasoning*.ts`, `infra/hermes/`                                                                                               |

The auto-bootstrap and model-picker rows are not Hermes-specific but matter on Hermes-only hosts.
The ACP session-update and slash-command-dedupe rows are not Hermes-specific at all — they are
upstream-shaped additions that any ACP provider (Cursor, Grok) picks up for free. Upstream
hardcodes `codex` as
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

## Enable the Memory tab (optional)

The Hermes panel's Memory tab reads an open-source [Hindsight](https://github.com/vectorize-io/hindsight)
agent-memory service. Run Hindsight on the same host as the T3 server — it can stay bound to
loopback, because every request is proxied through the server, which is what keeps the tab working
from the mobile app and over T3 Connect. Add to the same `settings.json`:

```json
{
  "integrations": {
    "hindsight": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:8888",
      "apiKey": "only-if-your-instance-requires-one",
      "defaultBank": "hermes"
    }
  }
}
```

Only `enabled` is required; `baseUrl` defaults to `http://127.0.0.1:8888`. The `apiKey` is stripped
from settings before they are sent to any client, so it never leaves the server process. With the
block absent the integration is completely inert — no socket is opened — and the tab renders a
pointer at this section. See [docs/user/hermes-memory.md](./docs/user/hermes-memory.md).

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

**Keeping it current.** [`infra/hyperion/`](./infra/hyperion) has a self-update script plus a
systemd timer that nightly fetches the fork, stops the service, reinstalls, rebuilds the web app,
restarts, health-checks, and rolls back on failure. It also converts an rsync'd (non-git) copy of
the source into a real checkout on first run. See
[infra/hyperion/README.md](./infra/hyperion/README.md).

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
- **`auth.status` is inferred, not introspected.** Hermes authenticates from its own
  `~/.hermes/.env`, which T3 Code never reads. Instead a completed ACP handshake that returned a
  non-empty model list is reported as `authenticated` — Hermes only lists models whose upstream it
  resolved credentials for — and the upstreams are derived from the model slug prefixes and shown on
  the provider card. A handshake that succeeds but reports no models is `unauthenticated`.
- **Hermes-specific surfaces are partial.** Scheduled tasks (Hermes cron) are exposed read-mostly
  in the Hermes panel: the sidebar's clock button lists jobs with their schedule, last run, and
  recent history, and lets you pause/resume a job or mute its notifications. Authoring stays in
  chat — create, edit, and delete are deliberately not built, because asking Hermes for a recurring
  task in natural language is the better interface and the CLI covers the rest. Profiles are still
  not exposed; use the `hermes` CLI for those. Chat, streaming, tool calls, approvals, resume,
  model switching, slash commands, and the context-window meter all work.
- **Memory browsing goes through Hindsight, not Hermes's own notes.** The panel's Memory tab talks
  to a [Hindsight](https://github.com/vectorize-io/hindsight) service (HTTP API 0.9.1) over the T3
  websocket, never client-to-Hindsight, so a loopback-bound Hindsight still works from mobile and
  through a tunnel. Recall, browsing by pathway, retaining one note, and triggering a reflection are
  built; editing and deleting memories deliberately are not. Mental models have no meaning-based
  search in Hindsight's API, so a query matches them by text and they sort after the ranked results.
  Hermes's _own_ `~/.hermes` notes remain unexposed — a Hermes with no Hindsight has no Memory tab
  content, and the tab says so. Fixture-pinned tests fail loudly if a Hindsight upgrade changes a
  response shape.
- **Task data is read from Hermes's own state files.** `hermes cron` has no JSON output mode as of
  Hermes 0.20.2, so T3 Code reads `cron/jobs.json` and the `cron/executions.db` ledger directly and
  shells out to `hermes cron pause`/`resume` for the one mutation. Fixture-pinned tests fail loudly
  if a Hermes upgrade changes either shape.
- **Reasoning effort needs a Hermes patch, and applies on the next turn.** ACP has no reasoning
  channel, so the composer's Reasoning selector writes a per-model entry under
  `agent.reasoning_overrides` in your own `~/.hermes/config.yaml` — the same file the `hermes` CLI
  reads, so a level picked in T3 Code is the level the terminal uses. **Stock Hermes ignores that
  file on the ACP surface**: `acp_adapter/session.py`'s `_make_agent` never passes
  `reasoning_config` to `AIAgent`, so ACP is the one Hermes surface that skips the
  `resolve_reasoning_config` chokepoint and always takes the provider default. Apply
  [`infra/hermes/0001-acp-honor-reasoning-config.patch`](./infra/hermes) to your Hermes checkout —
  without it the selector still appears but changes nothing. With it, Hermes reads the level when
  it builds an agent, and because `session/set_model` rebuilds the agent, T3 Code re-sends the
  current model when the level changes so a new level lands on the next turn rather than only on a
  new session. The levels offered per model come from Hermes's own
  `~/.hermes/models_dev_cache.json`; when that cache is missing or unreadable the selector is
  omitted rather than guessed at, and a config that fails to parse is never overwritten.
- **`respondToUserInput` is unimplemented** — Hermes has no equivalent ACP extension, so nothing
  ever opens such a request.

## Tracking upstream

Syncing is **merge-based, not rebase-based** — this fork's `main` is pushed, so rewriting it would
break every clone — and it runs nightly at 05:30 UTC from
[`.github/workflows/sync-upstream.yml`](./.github/workflows/sync-upstream.yml)
(`workflow_dispatch` also works). The job merges `upstream/main` into `main`, pushes, and then
dispatches `ci.yml` by hand, because pushes made with the default `GITHUB_TOKEN` do not trigger
other workflows.

Two kinds of issue come out of it:

- **`upstream-sync-conflict`** — the merge conflicted and was aborted, so `main` is untouched. The
  issue lists the conflicted files and the run fails. Only one such issue is open at a time; resolve
  it locally and close it. Note that the conflicted-file list comes from `git ls-files -u`, not from
  a grep for conflict markers: `apps/web/src/components/chat/ChatComposer.tsx` contains NUL bytes,
  so grep and rg classify it as binary and skip it silently (git will not even write conflict
  markers into it). Any sweep you write by hand must read the index, or use `grep -a`.
- **`hermes-parity-review`** — advisory, and the merge still landed. It fires when the incoming
  upstream commits touched two or more sibling provider adapters
  (`Drivers/{Claude,Codex,Cursor,Grok,OpenCode}*.ts`) or anything under `provider/acp/`, because
  upstream has fixed a bug across every sibling adapter in a commit that merged perfectly cleanly
  while leaving the Hermes copy broken. Git cannot see that kind of drift; a human has to check
  `HermesDriver.ts`, `HermesAcpSupport.ts`, and `HermesTextGeneration.ts`.

To sync by hand:

```bash
git remote add upstream https://github.com/pingdotgg/t3code
git fetch upstream && git merge upstream/main
```

The Hermes driver is additive — new files plus registration lines — so conflicts are usually
limited to `builtInDrivers.ts`, `settings.ts`, and the client branding lists. Three files carry
enough fork-specific judgment that they should always be resolved by hand rather than by taking one
side wholesale: `apps/web/src/components/chat/ChatComposer.tsx`,
`apps/web/src/components/chat/ChatView.tsx`, and the usage provider list in `usageProviders.ts`.

## CI on the fork

Upstream's workflows target paid Blacksmith runners that only exist in its org, and several deploy
upstream-only infrastructure. This fork therefore diverges in `.github/workflows/` as follows.

- **Runners.** Every `blacksmith-*` label is replaced: Linux jobs run on `ubuntu-24.04`, Windows on
  `windows-latest`, and **every macOS job runs on the self-hosted Apple Silicon runner**
  (`[self-hosted, macOS, ARM64, t3code-mac-arm64]`) — the desktop build matrix's two mac entries
  (arm64 natively, x64 cross-compiled), `mobile-ipa.yml`, `ci.yml`'s mobile native static analysis,
  the iOS half of `mobile-showcase-screenshots.yml`, and `macos-self-hosted-build.yml`. GitHub's
  hosted macOS minutes bill at 10x on a private repo, so this keeps them out of the loop entirely.
  That machine needs **Xcode** (the IPA build and the simulator screenshots), **Homebrew** (the
  mobile lint Brewfile), and a **Rust toolchain host** for the resource monitor — and while the
  laptop is offline those jobs simply queue rather than fail.
- **Guarded workflows.** `deploy-relay.yml`, `mobile-eas-preview.yml`, `mobile-eas-production.yml`,
  `web-preview.yml`, `publish-aur.yml`, `pr-vouch.yml`, and `issue-labels.yml` carry a job-level
  `if: github.repository == 'pingdotgg/t3code'`, so they skip here and still work if this fork is
  ever merged back. (`release.yml`'s `publish_aur` caller carries the same guard, because the
  reusable workflow declares `AUR_SSH_PRIVATE_KEY` as required.) `ci.yml`, `pr-size.yml`,
  `thread-transfer-report.yml`, `mobile-fingerprint-check.yml`, and
  `mobile-showcase-screenshots.yml` run normally.
- **Nightly release.** `release.yml` runs once a night at 07:00 UTC (upstream builds every three
  hours) and produces the desktop artifacts — macOS dmg/zip, Linux AppImage, Windows nsis — plus the
  updater manifests, attached to a GitHub prerelease. Everything that needs upstream credentials
  degrades instead of failing: the T3 Connect config resolves to empty values (so builds ship with
  T3 Connect disabled), the npm `t3` publish is skipped, and the Vercel deploy, the version-bump
  commit, and the Discord announcement skip when their secrets are absent. macOS and Windows code
  signing already degrade to unsigned. The desktop updater feed is derived from `GITHUB_REPOSITORY`,
  so fork builds self-update from fork releases.
- **iOS IPA.** `mobile-ipa.yml` builds an unsigned, sideloadable `T3Code-<version>.ipa` of the
  production Expo variant on the self-hosted mac. It has no schedule: run it via
  `workflow_dispatch` to get a workflow artifact, or let a published release trigger it to have the
  IPA attached to that release. Install it with AltStore or Sideloadly, which re-sign on install —
  which is why the build turns code signing off entirely.
