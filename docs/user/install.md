# Install T3 Hermes

T3 Hermes is a separate app with the T3 nightly artwork against a teal sky. It can run beside T3 Code and keeps its
own projects, settings, and sign-ins in `~/.t3-hermes/userdata`. Existing T3 Code data stays in
place. Hermes's default desktop capture shortcut is **Ctrl+Alt+Shift+H**; change it in Settings.

T3 Hermes runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

Command-line use, SSH hosts, and WSL backends need Node.js 22.16+ (22.x), 23.11+
(23.x), or 24.10 and later. The native desktop app includes its server runtime.

You need an installed, authenticated provider before starting a thread. You can
launch T3 Hermes and configure providers afterwards.

## Run without installing

When the CLI package is published for your Hermes release:

```bash
npx t3-hermes@latest
```

This starts the server and opens the local web app. Run
`npx t3-hermes@latest --help` for command-line options.

## Desktop app

Download a release from [GitHub Releases](https://github.com/NateWeav/t3code-hermes/releases),
using the installer for your operating system. Upstream T3 Code package-manager entries install
the upstream app, not Hermes.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install Node.js and provider CLIs inside that distro. T3 Hermes installs its
matching server runtime there automatically; the first launch after an app
update can take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
npx t3-hermes app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `npx t3-hermes app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Install a T3 Hermes iOS or Android build from your distributor. It installs alongside the official
T3 Code mobile app and has its own sign-ins and saved connections.
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.                             |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                      |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                             |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                |
| Hermes      | Install [Hermes Agent](https://github.com/NousResearch/hermes-agent); credentials are read from `~/.hermes/.env`. |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                          |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                                                 |

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Hermes' executable is `hermes`; enable its provider card after installation.
Antigravity can use its managed runtime without a `PATH` entry.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when T3 Code can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
