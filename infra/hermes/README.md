# Hermes patches

Patches this fork carries against [Hermes Agent](https://github.com/NousResearch/hermes-agent)
itself, for behaviour T3 Code depends on that stock Hermes does not provide. They are here rather
than vendored because Hermes is a separate project on its own release cadence; drop each one once
upstream carries the change.

The server embeds them, and the Hermes panel's Patches tab applies and removes them for you.

`hermes acp`, which T3 Code spawns, is a viewer of the Hermes gateway since Hermes v0.22.1
(2026-10-14): `HermesACPAgent()` builds `GatewayACPAgent` (`acp_adapter/gateway_server.py`), turns
run in the gateway daemon, and the in-process ACP server (`HermesACPAgent` with a `SessionManager`,
`acp_adapter/events.py`'s callbacks) runs only in Hermes's tests. A patch to that server applies
cleanly, passes its tests, and does nothing.

## Versions

`hermes update` follows Hermes `main`, so users' checkouts sit anywhere along it, and one patch
text stops fitting within days. Each patch therefore ships several versions, one directory per
patch, listed in [`patches.json`](./patches.json). Each version records the Hermes commit it was
made and verified against: applied there alone and together with the other patches, and its tests
passed. The server reverses an applied version, or applies the newest version that fits the
checkout, so an older checkout keeps working with an older version. Whenever the manifest changes,
every version other than a patch's newest whose `hermesCommitDate` is more than 30 days old is
deleted.

A patch current Hermes no longer needs, or no longer runs, is retired rather than deleted: it keeps
its entry and every version, with `"retired": true`. The tab lists it only where it is still
applied, offering Remove, and Update Hermes takes it off without putting it back, so a checkout
that has it is never left with changes T3 Code cannot name. Delete the entry once no supported
checkout can still carry it.

[`hermes-patches.yml`](../../.github/workflows/hermes-patches.yml) keeps the newest versions
current. Every three hours it checks each live (not retired) one against Hermes `main`: it must
apply (alone, or on the patches before it when it builds on them), must not reverse-apply (which
means upstream now carries it), must stack in manifest order, and must not fail a patch-relevant
Hermes test that passes on unpatched `main`. A patch that changes `acp_adapter/` must also ship a
test that builds the agent as `hermes acp` does (`HermesACPAgent()` with no arguments, or
`GatewayACPAgent`), and no test that forces the in-process server
(`HermesACPAgent.__new__(HermesACPAgent, ...)`, `session_manager=`). Drift files a
`hermes-patch-drift` issue, and the maintainer's Hermes resolver answers it with
a PR that adds a rebased version, or deletes a patch upstream made obsolete, and applies the 30-day
rule. To run the same check locally against a clean Hermes checkout outside `~/.hermes` (Hermes's
test guard fails tests run from under it):

```bash
node .github/scripts/hermes-patch-drift.cjs check --hermes <checkout> --state /tmp/state.json
(cd <checkout> && uv sync --locked --python 3.14 --extra all --group dev)
node .github/scripts/hermes-patch-drift.cjs test --hermes <checkout> --state /tmp/state.json \
  --python <checkout>/.venv/bin/python
node .github/scripts/hermes-patch-drift.cjs report --state /tmp/state.json --body /tmp/drift.md
```

Skip the two middle commands for an apply-only check; `report` then reports no test results.

To add a version, rebase the patch onto a newer Hermes commit, save it as
`<patch-id>/<first 12 characters of the commit>.patch`, and list it first under that patch in
`patches.json` with the commit and its UTC committer date
(`TZ=UTC git log -1 --format=%cd --date=format-local:%Y-%m-%dT%H:%M:%SZ <commit>`). A new patch also
needs its id, title, and `neededFor` text there; patch order is the order the tab shows and the
order the patches stack in. Then run `node scripts/generate-hermes-patches.ts`, which rejects an
inconsistent manifest; a server test fails until the generated file matches.

The Patches tab picks the version for you, and is the easier way. To apply one by hand, go through
the versions listed in `patches.json` in order and use the first that both fits and has a
`hermesCommit` your checkout already contains:

```bash
cd ~/.hermes/hermes-agent
git merge-base --is-ancestor <hermesCommit> HEAD && echo contained
git apply --check /path/to/t3code/infra/hermes/<patch-id>/<version>.patch
git apply /path/to/t3code/infra/hermes/<patch-id>/<version>.patch
```

If no version passes both checks, apply a version only when it is the one version that passes
`--check`. When several pass, they can be changing different code, so use the Patches tab,
which refuses when it can't tell them apart.

## `acp-central-ssh-execution`

**Needed by:** a single central T3/Hermes server that executes terminal and file tools on a remote
SSH host without launching T3 or Hermes on that target.

Hermes already has an SSH terminal backend, but its default behavior mirrors local credentials,
skills, and cache into the remote user's `~/.hermes`. This patch adds
`terminal.ssh_sync_files: false`, which keeps those files on the central Hermes host. It also keeps
an ACP session's tools in the profile's remote `terminal.cwd` when T3 reopens the session from a
different project folder: T3's folder is a path on the central host, which the target does not have.

The gateway runs the tools from its Hermes home's `config.yaml` (and `.env`). Terminal variables on
the T3 provider instance never reach it, and a Hermes with only those set runs its tools on the
central host without saying so. So give each SSH target its own Hermes home and point a Hermes
provider instance at it.

Example `config.yaml` in `~/.hermes/profiles/aeris-core` (configure its model like any profile):

```yaml
terminal:
  backend: ssh
  ssh_host: 192.168.1.5
  ssh_user: aeris
  ssh_key: /home/aeris/.ssh/id_ed25519_aeris_core_fleet
  cwd: /home/aeris/meridian-news-v3-standalone
  ssh_sync_files: false
```

Example provider-instance environment in T3 Code:

```text
HERMES_HOME=/home/aeris/.hermes/profiles/aeris-core
```

The remote target needs only SSH, Bash, and the project toolchain (not even `scp`). It does not need
Node, T3, the Hermes binary, provider credentials, memories, or a `.hermes` directory.

Upstream already carries half of this: `SSHEnvironment` takes `sync_files`, used by Hermes's own SSH
workspace browser. The patch exposes it as config and keeps ACP tools at the remote cwd.

After applying the patch, stop that home's gateway (`HERMES_HOME=<home> hermes gateway stop`) so the
next `hermes acp` starts one with the patched code, and restart the T3 Code server. Terminal changes
apply to new sessions and when a session is resumed. Configure each approved SSH target as a
separate Hermes provider instance; do not change the default Hermes instance away from local
execution.

## `acp-delegation-progress`

**Needed by:** live progress for the subagents Hermes delegates to. Without it, `hermes acp` drops
the gateway's `subagent.*` events and suppresses `delegate_task`'s structured arguments and results,
so T3 Code parses the readable text and shows background subagents as idle once dispatched.

The patch keeps the existing human-readable content while exposing `rawInput` arguments and parsed
`rawOutput` results, and projects the gateway's per-child events as bounded snapshots in
`rawOutput.hermesDelegation` on the parent call. The gateway stamps each top-level child's events
with its `delegate_task` call id (`parent_tool_call_id`), so children are never matched by goals,
task indices, or order: overlapping delegations can have identical goals, and unknown or conflicting
ownership is dropped. Background children keep reporting after the turn that spawned them ends.
Registry-forced stalls and worker crashes report a terminal event per child, with the same secret
redaction as other live child progress, so detached work cannot stay falsely active. A parent result
with `status: "dispatched"` only acknowledges launch; child lifecycle events settle each subagent.
Progress sent while T3 Code was disconnected is not replayed, but the gateway still hands each
result to the agent in a turn of its own.

Restart the Hermes gateway as well as the T3 Code server after applying the patch: the gateway
publishes the events and must run the patched code. An unpatched gateway sends no call ids, so the
viewer drops every child event. No configuration changes are required.

The patch's `tests/acp_adapter/test_gateway_delegation_progress.py` and `test_delegation_tools.py`
build the agent as `hermes acp` does and drive the real executor, child relays, event stream, stale
monitor, and background worker. Run them with `tests/gateway/test_local_viewer_events_turn.py` in a
scratch checkout with an isolated `HERMES_HOME` and `PYTHONDONTWRITEBYTECODE=1`, never in the live
install.

## `acp-fast-mode`

**Needed by:** the Fast Mode toggle for Hermes models. Stock Hermes applies `/fast` only in its CLI,
TUI, and gateway, never in ACP sessions, and sends fast-mode parameters only to the first-party
endpoints that bill for them, so a proxy that forwards `service_tier` (such as CLIProxyAPI) never
gets it.

The patch adds a per-session `fast_mode` ACP config option (`on`/`off`). `hermes acp` is a viewer
of the Hermes gateway, so the option becomes that session's `/fast` on the gateway, which applies
it through the same route gate as `/fast` on each turn. The gateway forgets a session's `/fast`
when it restarts or the conversation resets, so the choice is sent again before every prompt. It
is deliberately not advertised in `configOptions`, since Zed would render it in place of the model
picker; instead, picker rows whose route takes fast mode carry `_meta.hermes.fastMode: true`, which
is how T3 Code knows where to offer the toggle. It also lets a custom endpoint opt in:

```yaml
custom_providers:
  - name: cliproxyapi
    base_url: http://localhost:8317/v1
    capabilities:
      fast_mode: true
```

Applying the patch from T3 Code's Patches tab writes that opt-in for every custom endpoint whose
root identifies as CLIProxyAPI (an unauthenticated `GET /` answering `"CLI Proxy API Server"`), with
a trailing `# added by T3 Code` marker; removing the patch deletes only marked flags. Applying it
with `git apply` leaves `config.yaml` alone.

The opt-in covers `service_tier: priority` (OpenAI and xAI models) only. Anthropic's `speed: fast`
is a Messages API parameter, and custom endpoints speak chat completions, so Claude models behind a
proxy stay ungated.

Restart the Hermes gateway and the T3 Code server after applying the patch: the gateway runs the
fast-mode gate and the endpoint opt-in. The patch's `tests/acp_adapter/test_fast_mode.py` drives the real config, gate,
ACP gateway viewer, and gateway session controls, with only the model inventory and the model call
stubbed; run it with the rest of `tests/acp_adapter/` in a scratch checkout, as for
`acp-delegation-progress`.

## `acp-reasoning-once`

**Needed by:** Hermes reasoning that appears only as reasoning. With `display.show_reasoning` on,
the gateway adds the turn's last reasoning to the start of the final reply as a `💭 **Reasoning:**`
code block for messaging platforms. Local viewers skip that block because they already stream
`reasoning.delta`. ACP sessions were kept as an exception on the assumption that editors have no
reasoning event, but the ACP gateway bridge streams `reasoning.delta` as thought chunks. A
reasoning model's ACP reply therefore repeated its reasoning as reply text. Because that final text
no longer began with what had streamed, the bridge also sent the whole reply a second time.

The patch removes the ACP exception. Verified against hermes-agent `749cb638ff` (`main`,
2026-10-26), alone and after the other patches. Restart the Hermes gateway after applying it. Run
the patch's `tests/gateway/test_local_viewer_reasoning.py` in a scratch checkout, as for
`acp-delegation-progress`.

## `acp-lost-turn-refusal`

**Needed by:** recovering a Hermes session after a gateway restart loses a turn. Hermes fences the
lost turn as `unknown` and refuses each later ACP prompt until someone sends
`/discard <admission>`. T3 sends that discard itself when the user's next message is refused
unsubmitted, then resends the message. Stock `hermes acp` only re-reads the fence when the prompt
reconnects, after its own fence check. So the first prompt after a restart is queued behind the lost
turn while ACP reports it failed. The discard then runs it without the prompt open.

The patch refuses a prompt whose reconnect just adopted a lost turn, and withdraws its own input if
it is queued behind a lost turn before refusing. Either way the refusal says nothing was submitted.
Without it, T3 discards the lost turn so the queued input runs once, and shows its reply as a
continuation instead of resending it. Verified against hermes-agent `edfa1c2a13` (`main`,
2026-10-26), alone and after the other patches. New `hermes acp` processes pick it up; restarting the gateway is not required. Run the
patch's `tests/acp_adapter/test_gateway_queued_unknown.py` in a scratch checkout, as for
`acp-delegation-progress`.

## `acp-launch-yolo-resume`

**Needed by:** Full access on an existing Hermes thread. T3 Code launches `hermes acp` with
`HERMES_YOLO_MODE=1` for Full access, and a runtime-mode change relaunches it and reopens the
session. Stock Hermes freezes that flag into a session's policy only when `session.create` makes
it, so a reopened session keeps the approval mode it was created with: switched to Full access it
keeps asking for approval, and its subagents (which cannot ask) keep denying dangerous commands;
switched away it keeps approving everything.

The patch sets the session's `/yolo` on the gateway (`config.set yolo`) whenever `hermes acp`
loads, resumes, or forks a session: on under `HERMES_YOLO_MODE`, off otherwise. It is the same
persisted, session-scoped bypass as `/yolo` in the TUI, so it survives a gateway restart and
covers the session's subagents. A gateway that refuses it fails the reopen instead of running in
the wrong mode.

Verified against hermes-agent `5b32cfc230` (`main`, 2026-10-26), alone and after the other
patches. New `hermes acp` processes pick it up; restarting the gateway is not required. Run the
patch's `tests/acp_adapter/test_gateway_launch_yolo_resume.py` in a scratch checkout, as for
`acp-delegation-progress`.

## Retired

**`acp-background-reports`** and **`acp-durable-completion-receipts`** hooked Hermes's in-process
ACP server: the first reported background `terminal` processes (`_hermes/process`) and woke the agent
when background work finished (`_hermes/notification`); the second kept a finished subagent's result
pending until a wake turn handed its ids back. Under the gateway viewer neither runs. The gateway
now does both jobs itself: it starts its own turn when a background process or subagent finishes
(`gateway/run_notifications.py`), which T3 Code shows through post-settle continuation, and keeps
async delegation results durable in its own store (`gateway/session_worker_delegation.py`). The
sidebar's Monitoring status for a running background process has no gateway equivalent yet, so a
background `terminal` call reads as finished once the process starts.

Remove the receipts patch before the one it builds on; the tab shows the second once the first is
off.
