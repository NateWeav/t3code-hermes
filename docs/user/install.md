# Install T3 Hermes

T3 Hermes is a separate app with the T3 nightly artwork against a teal sky. It can run beside T3 Code and keeps its own projects, settings, and sign-ins in `~/.t3-hermes/userdata`. Existing T3 Code data stays in place. Hermes's default desktop capture shortcut is **Ctrl+Alt+Shift+H**; change it in Settings.

T3 Hermes runs coding agents on your computer (or server) and lets you control them from the desktop app, web app, or mobile app. Install it on the machine where your agents will run first.

## Requirements

You need at least one installed, authenticated coding agent (provider) before starting a thread. You can launch T3 Hermes first and set up providers from the [Welcome page](./welcome-page.md) or **Settings → Providers**.

`npx t3-hermes@nightly` needs Node.js only to run npm itself; the CLI it installs is a self-contained executable. SSH hosts and WSL backends need Node.js 22.16+ (22.x), 23.11+ (23.x), or 24.10 and later. The native desktop app includes its server runtime.

## Run without installing

```bash
npx t3-hermes@nightly
```

T3 Hermes publishes only nightly builds, so always ask for `@nightly`. At a terminal, it first offers to install the `t3-hermes` command in `~/.local/bin`; if you say no, it asks again at the next minor release, and `npx t3-hermes@nightly install` installs it later. Where these pages say `t3`, type `t3-hermes` (or `npx t3-hermes@nightly`).

| Task                          | Command                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Start server and open web app | `t3-hermes` (or `t3-hermes ./my-project`)                                      |
| Start server without browser  | `t3-hermes serve`                                                              |
| Set up remote access          | `t3-hermes up` ([Remote access](./remote-access.md))                           |
| Run in the background         | `t3-hermes service install` ([Background service](./background-service.md))    |
| Update                        | `t3-hermes update`                                                             |
| Reclaim database space        | `t3-hermes doctor` ([Details](./background-service.md#reclaim-database-space)) |
| Uninstall                     | `t3-hermes uninstall`                                                          |

If `t3-hermes` reports a server is already running, connect with `t3-hermes pair` or pass a separate `--base-dir`. A bare directory name is accepted only if it already exists. Run `t3-hermes --help` for all commands.

### Intel Macs

There is no standalone `t3-hermes` binary for Intel Macs—use the desktop app, or build a server from source with `vp` ([development runbook](../operations/00_development.md#first-checkout)):

```bash
git clone https://github.com/NateWeav/t3code-hermes
cd t3code-hermes && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

A server run this way is a plain Node program: `t3-hermes update` and the background service do not apply, so update it with `git pull` and a rebuild.

## Desktop app

Download from [GitHub Releases](https://github.com/NateWeav/t3code-hermes/releases), using the installer for your operating system. On Debian or Ubuntu, install the `.deb` with `sudo apt install ./T3-Hermes-*.deb`. Upstream T3 Code package-manager entries install the upstream app, not Hermes.

- **Linux AppImage**: `chmod +x ./T3-Hermes-*.AppImage && ./T3-Hermes-*.AppImage` (x86_64 and ARM64; check with `uname -m`). The `.deb` self-updates with a password prompt; if your desktop has no password prompt, download the new `.deb` and install it the same way.

### The `t3-hermes` command

The desktop app bundles `t3-hermes` and sets it up on first launch (manage anytime under **Settings → About → t3-hermes command**). Use **Add to PATH** if needed, then open a new terminal. If you already have another `t3-hermes`, it stays as it is.

- **Open a folder in the running desktop app**: Run `t3-hermes app` (or `t3-hermes app ../my-project`) from a terminal, or drag folders from your file manager onto the desktop sidebar.

### Windows Subsystem for Linux

Select a WSL distro in **Settings → Sharing & access** to run agents and projects inside WSL (install Node.js and provider CLIs inside that distro). T3 Hermes manages its own server runtime inside WSL automatically.

## Mobile app

Install a T3 Hermes iOS or Android build from your distributor. It installs alongside the official T3 Code mobile app and has its own sign-ins and saved connections. The mobile app connects to a server on another machine via [remote access](./remote-access.md).

- If the mobile app crashes on launch, open **Settings → Diagnostics** on the next launch to copy recent startup crash reports.

## Providers

Open **Settings → Providers** (web or desktop), select the environment, and enable the providers you use. Installation and sign-in always happen on the **environment's machine**.

| Provider         | Install and authenticate                                                                                                 | Guide                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Codex**        | Connect with ChatGPT in Settings, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. | [Codex](./providers-codex.md)             |
| **Claude**       | Install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`.                               | [Claude](./providers-claude.md)           |
| **Cursor**       | Sign in in Settings or install [Cursor CLI](https://cursor.com/cli) and run `agent login`.                               | [Cursor](./cursor.md)                     |
| **Grok Build**   | Install [Grok Build CLI](https://x.ai/cli) and run `grok login`.                                                         | [Grok](./providers-grok.md)               |
| **Hermes**       | Install [Hermes Agent](https://github.com/NousResearch/hermes-agent); credentials are read from `~/.hermes/.env`.        | [Hermes subagents](./hermes-subagents.md) |
| **Antigravity**  | Install managed runtime and sign in with Google in Settings.                                                             | [Antigravity](./providers-antigravity.md) |
| **OpenCode**     | Install [OpenCode](https://opencode.ai) and run `opencode auth login`.                                                   | [OpenCode](./providers-opencode.md)       |
| **Kiro**         | Install [Kiro CLI](https://kiro.dev/docs/cli/) and run `kiro-cli login`.                                                 | [Kiro](./providers-kiro.md)               |
| **Pi**           | Install [Pi](./providers-pi.md) (Node.js 22.19+) and run `pi` → `/login`.                                                | [Pi](./providers-pi.md)                   |
| **Muse Code**    | Install [Muse Code](https://dev.meta.ai/docs/muse-code) and run `muse login`.                                            | [Muse Code](./providers-muse.md)          |
| **fx**           | Install [fx](https://fx.sh) and run `fx login`.                                                                          | [fx](./providers-fx.md)                   |
| **ACP Registry** | Add GitHub Copilot and other agents in **Settings → Providers → Add provider → Show more**.                              | [ACP](./providers-acp.md)                 |

- **Binary path**: If a CLI isn't on the server's `PATH` (common with version managers), set **Binary path** in the provider's settings. Hermes' executable is `hermes`; enable its provider card after installation.
- **Updates**: Click **Update now** on outdated provider cards (supports Homebrew, mise `latest`, npm/pnpm/Yarn/Bun/Volta/Vite+, or the CLI's own updater; update Nix, Chocolatey, or pinned mise installs manually).
- **Multiple instances**: Add extra provider instances for separate accounts, API keys, or custom endpoints (mark secret env vars as sensitive).

### Provider check timeouts

If a working CLI times out during T3 Hermes's readiness check, increase its probe deadline (in milliseconds) in the server's environment (or systemd override / `service.env`) and restart:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 t3-hermes serve
```

| Provider     | Environment variable                   |
| ------------ | -------------------------------------- |
| Codex        | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude       | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor       | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity  | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok         | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Hermes       | `T3CODE_HERMES_PROBE_TIMEOUT_MS`       |
| Kiro         | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx           | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi           | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code    | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode     | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

## Next steps

- [User guide index](./README.md): overview of how T3 Code works.
- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): control when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Updating T3 Code](./updating.md): keep apps, servers, and providers up to date.
