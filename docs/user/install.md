# Install T3 Hermes

T3 Hermes is a separate app with the T3 nightly artwork against a teal sky. It can run beside T3 Code and keeps its
own projects, settings, and sign-ins in `~/.t3-hermes/userdata`. Existing T3 Code data stays in
place. Hermes's default desktop capture shortcut is **Ctrl+Alt+Shift+H**; change it in Settings.

T3 Hermes runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

`npx t3` needs Node.js only to run npm itself; the CLI it installs is a
self-contained executable. SSH hosts and WSL backends need Node.js 22.16+
(22.x), 23.11+ (23.x), or 24.10 and later. The native desktop app includes its
server runtime.

You need an installed, authenticated provider before starting a thread. You can
launch T3 Hermes and configure providers afterwards.

## Run without installing

```bash
npx t3-hermes@nightly
```

This starts the server and opens the local web app. Run
`npx t3-hermes@nightly --help` for command-line options. T3 Hermes publishes
only nightly builds, so always ask for `@nightly`. To keep a server running
after you log out, use the [background service](./background-service.md).

At a terminal, it first offers to install the `t3-hermes` command in
`~/.local/bin`. If you say no, it asks again at the next minor release, and
`npx t3-hermes@nightly install` installs it later.

Run `npx t3-hermes@nightly help` for the same reference. To start in a new
working directory, use an explicit path such as `npx t3-hermes@nightly ./my-project`.
A bare directory name is accepted only if it already exists.

If `t3-hermes` or `t3-hermes start` reports an already running server, connect
to that server instead. Stop it before starting a replacement, or use a
different `--base-dir` for an independent server.

To return freed database space to disk, run `npx t3-hermes@nightly doctor`
(see [Reclaim database space](./background-service.md#reclaim-database-space)).

To use it from your other devices, run `npx t3-hermes@nightly up` (see
[Remote access](./remote-access.md)).

### Intel Macs

The executable is built for Apple Silicon Macs, Linux, and Windows. There is
no Intel Mac build of it, because Node cannot produce a single executable for
that platform; the Intel desktop app is unaffected. To run a standalone server
on an Intel Mac, build it from source with `vp`, which provides the Node
version it needs ([Install vp](../operations/development.md#first-checkout)):

```bash
git clone https://github.com/NateWeav/t3code-hermes
cd t3code-hermes && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

A server run this way is a plain Node program: `t3-hermes update` and the
background service do not apply, so update it with `git pull` and a rebuild,
and start it however you run other Node processes.

## Desktop app

Download a release from [GitHub Releases](https://github.com/NateWeav/t3code-hermes/releases),
using the installer for your operating system. On Debian or Ubuntu, install the `.deb` with
`sudo apt install ./T3-Hermes-*.deb`. Upstream T3 Code package-manager entries install
the upstream app, not Hermes.

### Linux

AppImage and `.deb` downloads are available for x86_64 and ARM64. Check your
architecture with `uname -m`: for `x86_64`, choose a file ending in
`x86_64.AppImage` or `amd64.deb`; for `aarch64`, choose `arm64.AppImage` or
`arm64.deb`.

To launch an AppImage, open a terminal in its download folder. Replace
`T3-Code.AppImage` below with the exact filename you downloaded:

```bash
chmod +x ./T3-Code.AppImage
./T3-Code.AppImage
```

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### The `t3-hermes` command

The desktop app includes the `t3-hermes` command-line tool. A new install sets
it up on first launch; after an update, or any time, choose **Install** next to
**t3-hermes command** in **Settings → About**. On macOS and Linux it adds a
`t3-hermes` link in `~/.local/bin` (or `~/bin`); on Windows it adds the app's
command folder to your `PATH`. Open a new terminal afterwards. If the folder is
not on your `PATH`, **Add to PATH** on the Welcome page or in **Settings → About**
adds one line to your shell's startup file. **Remove** takes it off, and the app
does not add it again. If you already have another `t3-hermes`, it stays as it is.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
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

### Drop a folder on the sidebar

Drag one or more folders from Finder, Explorer, or your file manager onto the
sidebar. Each one opens as a project on this computer, the same as `t3 app`.
Files dropped on a thread still attach to that thread. Browsers do not share
folder paths, so in the web app use **Add project** instead.

## Mobile app

Install a T3 Hermes iOS or Android build from your distributor. It installs alongside the official
T3 Code mobile app and has its own sign-ins and saved connections.
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

Store links and QR codes are also available in **Settings → About → Mobile app**
on web and desktop. The store apps work with both stable and Nightly servers. Test builds are optional:

- **iPhone and iPad:** TestFlight is invite-only.
- **Android:** download an APK from the
  [Android beta releases](https://github.com/pingdotgg/t3code/releases?q=android-beta-).

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Hermes      | Install [Hermes Agent](https://github.com/NousResearch/hermes-agent); credentials are read from `~/.hermes/.env`.                                         |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                                                                                         |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.
Hermes' executable is `hermes`; enable its provider card after installation.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when T3 Code cannot tell. Claude, Codex, and
OpenCode installs T3 Code cannot identify stay manual: update them through the
installer you used. T3 Code runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Cursor and Antigravity update with T3 Code. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release T3 Code tested. When T3 Code finds a newer compatible
release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure T3 Code for everyone on a machine.
