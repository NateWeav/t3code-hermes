# Hermes runtime rollout and rollback

The runtime repair is reviewed upstream at [NousResearch/hermes-agent#144707](https://github.com/NousResearch/hermes-agent/pull/144707). The PR is not an activation receipt: verify the gateway process and a real ACP session separately.

## Route policy

Claude uses `custom:cliproxyapi-claude:claude-opus-5-5`, with the provider root `http://10.0.0.7:8317`, `anthropic_messages`, adaptive thinking and provider-owned `extra_body.max_tokens: 16384`. The SDK appends `/v1/messages`; do not include `/v1/messages` in the base URL.

GPT/Kimi/GLM and other existing models retain `custom:cliproxyapi` on `http://10.0.0.7:8317/v1`, Chat Completions. Do not copy the Claude cap onto that provider or set a global output cap.

Interactive defaults use low Claude effort and 80 model iterations per turn. The separate GCP `upstream-sync` profile uses medium Claude effort and 120 iterations. Delegated tasks use 40/60 iterations respectively. These are per-task working budgets, not session-length limits: preserve complex-work capability by reporting progress and requesting explicit continuation at exhaustion.

Context compaction triggers at the lower of the ratio-based threshold and 120,000 tokens, without misrepresenting the model's context window. Gateway message hygiene is 160 messages. Tool output is capped at 20,000 bytes, file reads at 30,000 characters/600 lines, with continuation/full-output paths preserved. Related reads should be batched; CI waits use one background watcher and its completion rather than model-driven polling.

## Installation boundary

All three hosts use a managed source installation at `~/.hermes/hermes-agent`; the PATH launcher calls its `.hermes/bin/hermes`, which selects the PM-managed Python/dependency generation. Install the Anthropic dependency through `hermes pm install --extra anthropic`, not a guessed venv or raw pip. Processes retain old imports until restarted.

GCP additionally has `/etc/hermes/config.yaml`, an administrator overlay that wins over profile files. Its model, auxiliary compression and delegation routes must agree with the intended transport. The `upstream-sync` profile is independent; changing the default profile is insufficient.

Default configs are synchronized between hosts. Check for propagation before writing a second host and preserve an original pre-sync backup where available. Never copy credentials into evidence, patches, or PRs.

The maintained source branches use `updates.parked_branch_strategy: update_in_place` so the normal updater does not silently switch away from unmerged repairs. Keep patch commits and the recorded rollback SHA until upstream includes them.

## Activation and readiness

1. Inspect the live control socket's `active-work` response. Never infer inactivity from T3's last completed run alone.
2. Use the gateway's graceful lifecycle. Hyperion's implementation agent is itself gateway-owned; drain it after the turn, not with a forced restart mid-turn.
3. Read `gateway_state.json` and the live control socket back. Check PID, source SHA, served profiles and active work. A CLI version alone is not proof that the running gateway adopted changes.
4. In actual ACP, verify a fresh Claude terminal-tool/follow-up cycle, reconnect/load that session and repeat, then switch to GPT for a smoke check. Bound probes by time and calls.
5. Read allowlisted `Model request controls` logs: native Messages, adaptive thinking, intended effort and explicit cap. Read token/cache/time counters for the exact probe session. Reasoning counters of zero do not establish absence of hidden reasoning.
6. Exercise Stop immediately before a background completion. Read back the durable producer fence and admissions: old automatic work must not admit a model turn; fresh explicit input must still complete.
7. Existing Claude threads must explicitly select the new provider ID. Resume refreshes context/tool limits without rewriting cached instructions. Do not revive an old interrupted autonomous task as a verification probe.

A host is **not ready** if activation or any required live verification remains pending. Recovery/status diagnostics are not a substitute for autonomous-work ownership in T3.

## GCP automation ingress

`upstream-sync` remains a separate, explicitly standalone gateway. It owns `127.0.0.1:8645`; the default gateway keeps its listener on 8644. Both existing smee services target `/p/upstream-sync/webhooks/<route>` on 8645. Signed irrelevant `ping` requests return `200` with `status: ignored`; unsigned requests return `401`. Do not send a real maintenance event just to test ingress.

## Rollback

Timestamped `config.yaml.runtime-fix-*.bak` files are private backups alongside each changed profile config. GCP's managed overlay and the two smee unit files have equivalent timestamped backups. Restore the complete matching set only with the affected gateway idle, then use the supported graceful restart. Do not restore a synchronized default config casually: it can propagate to other hosts.

Source deployment receipts record the pre-change SHA, installed SHA, exact touched files and SHA-256 digests. Reverse only the repair commits or restore those files from the recorded base after checking for later edits; never reset/clean the whole live checkout. Preserve prior untracked ACP work on Hyperion and the unrelated T3 source-control edit in its main checkout.

Evidence and bounded probe scripts are staged under `~/.hermes/cache/scratch/hermes-runtime-audit-20261025/` on Hyperion. Scratch evidence is not durable source; the upstream PR and this runbook are the reviewable records.
