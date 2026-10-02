# Hermes patches

Patches this fork carries against [Hermes Agent](https://github.com/NousResearch/hermes-agent)
itself, for behaviour T3 Code depends on that stock Hermes does not provide. They are here rather
than vendored because Hermes is a separate project on its own release cadence; drop each one once
upstream carries the change.

The server embeds them, and the Hermes panel's Patches tab applies and removes them for you.

## Versions

`hermes update` follows Hermes `main`, so users' checkouts sit anywhere along it, and one patch
text stops fitting within days. Each patch therefore ships several versions, one directory per
patch, listed in [`patches.json`](./patches.json). Each version records the Hermes commit it was
made and verified against: applied there alone and together with the other patches, and its tests
passed. The server reverses an applied version, or applies the newest version that fits the
checkout, so an older checkout keeps working with an older version. Versions other than the newest
are dropped once their commit is more than 30 days old.

To add a version, rebase the patch onto a newer Hermes commit, save it as
`<patch-id>/<first 12 characters of the commit>.patch`, and list it first under that patch in
`patches.json` with the commit and its UTC committer date
(`TZ=UTC git log -1 --format=%cd --date=format-local:%Y-%m-%dT%H:%M:%SZ <commit>`). A new patch also
needs its id, title, and `neededFor` text there; patch order is the order the tab shows and the
order the patches stack in. Then run `node scripts/generate-hermes-patches.ts`, which rejects an
inconsistent manifest; a server test fails until the generated file matches.

To apply one by hand, use the version listed first that fits:

```bash
cd ~/.hermes/hermes-agent
git apply --check /path/to/t3code/infra/hermes/<patch-id>/<version>.patch
git apply /path/to/t3code/infra/hermes/<patch-id>/<version>.patch
```

## `acp-central-ssh-execution`

**Needed by:** a single central T3/Hermes server that executes terminal and file tools on a remote
SSH host without launching T3 or Hermes on that target.

Hermes already has an SSH terminal backend, but its default behavior mirrors local credentials,
skills, and cache into the remote user's `~/.hermes`. This patch adds
`terminal.ssh_sync_files: false`, which keeps those files on the central Hermes host. It also makes
ACP honor `terminal.cwd` as the remote project root instead of replacing it with T3's local project
placeholder.

Example central provider-instance environment:

```text
TERMINAL_ENV=ssh
TERMINAL_SSH_HOST=192.168.1.5
TERMINAL_SSH_USER=aeris
TERMINAL_SSH_KEY=/home/aeris/.ssh/id_ed25519_aeris_core_fleet
TERMINAL_CWD=/home/aeris/meridian-news-v3-standalone
TERMINAL_SSH_SYNC_FILES=false
```

The remote target needs only SSH, Bash, and the project toolchain (not even `scp`). It does not need
Node, T3, the Hermes binary, provider credentials, memories, or a `.hermes` directory.

Upstream already carries half of this: `SSHEnvironment` takes `sync_files`, used by Hermes's own SSH
workspace browser. The patch exposes it as config and roots ACP tools at the remote cwd.

Restart the T3 Code server after applying the patch. Configure each approved SSH target as a
separate Hermes provider instance; do not change the default Hermes instance away from local
execution.

## `acp-delegation-progress`

**Needed by:** live progress and background results for the subagents Hermes delegates to. Without
it, stock Hermes suppresses `delegate_task`'s structured arguments and results and never reports
child progress over ACP, so T3 Code parses the readable text and shows background subagents as idle
once dispatched.

The patch keeps the existing human-readable content while exposing `rawInput` arguments, parsed
`rawOutput` results, and bounded per-child snapshots in `rawOutput.hermesDelegation`. Child progress
routes through the executor's copied context variables, never goals, task indices, or FIFO order:
overlapping delegations can have identical goals and batch-local indices, and unknown or conflicting
ownership is dropped. Registry-forced stalls and worker crashes report through the same child relay,
so detached work cannot stay falsely active. A parent result with `status: "dispatched"` only
acknowledges launch; child lifecycle events settle each subagent. The original ACP process must stay
connected; missed results are not recovered from disk.

Restart the T3 Code server after applying the patch so provider sessions spawn patched Hermes. No
configuration changes are required.

The patch's `tests/acp_adapter/test_delegation_progress.py` and `test_delegation_finalization.py`
drive the real executor, child relays, stale monitor, and background worker. Run them with
`tests/acp_adapter/test_tools.py` and `test_events.py` in a scratch checkout with an isolated
`HERMES_HOME` and `PYTHONDONTWRITEBYTECODE=1`, never in the live install.

## `acp-background-reports`

**Needed by:** the sidebar's Monitoring status for background processes Hermes starts, such as a CI
watcher, and the agent picking its work back up when they finish. Stock Hermes reports a background
`terminal` call as finished the moment the process starts and says nothing when it exits, so T3 Code
cannot tell the work is still running, and the agent never hears that it is done.

The patch adds two ACP extension notifications. `_hermes/process` reports a background process left
running by a `terminal` call, keyed by that tool call, and again when it exits, with its exit code.
`_hermes/notification` carries the text Hermes's CLI injects as the next turn when background work
finishes (process completions, watch matches, heartbeats, background subagent results), sent once the
session is idle. Stock ACP never drains those events, so an agent that promised to report back never
heard that its work had finished. ACP turns stay client-driven: Hermes reports, and the client decides
whether to prompt. T3 Code prompts with the notification once no turn is running, unless the user
pressed Stop, in which case it waits for their next message. Clients that do not know the methods
ignore them.

Restart the T3 Code server after applying the patch. `display.background_process_notifications: off`
in Hermes's `config.yaml` still suppresses process notifications; process status is always reported.

The patch's `tests/acp_adapter/test_background_reports.py` spawns real processes against an isolated
process registry. Run it with the rest of `tests/acp_adapter/` in a scratch checkout, as for `acp-delegation-progress`.

## `gateway-multiplex-webhook-session-close`

**Needed by:** gateways with `gateway.multiplex_profiles: true` that serve webhook routes for a
named profile (`/p/<profile>/webhooks/...`). Without it, those runs never get `ended_at`, so T3
Code reports them as failed once its two-hour staleness window passes, and Hermes's
`prune_sessions` never reaps the rows.

The run writes its session row to `profiles/<profile>/state.db`, but the webhook adapter's
completion hook runs outside the profile scope and ended the session in the launch home's
`state.db`, which has no such row. The patch closes it in the store `SessionStore._db_for_key`
resolves from the session key. Single-profile gateways and default-profile keys are unchanged.
Restart the gateway with `hermes gateway restart` after applying it.

The patch's test in `tests/gateway/test_webhook_session_close.py` runs a profile webhook delivery
through the real adapter pipeline on a multiplexed store.
