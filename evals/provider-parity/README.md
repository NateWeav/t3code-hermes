# Provider parity

Scores how close the Hermes provider is to Claude and Codex in T3 Code, as one number out of 100 and a ranked list of what to fix next. It measures the integration, not the model: Hermes and Claude run the same model.

## What it measures

| Layer       | Source                                                                                                                                | Cost                  | Scored                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| Conformance | Committed replay fixtures, replayed through `HermesAdapterV2` and checked against the Claude or Codex assertion for the same scenario | Free, about a minute  | Nine facets: turns, tools, approvals, control, planning, subagents, background, context, threads |
| Live        | The Hermes recorder run live against a benchmark Hermes home, checked against the same assertions                                     | Haiku tokens          | Reliability (sample consistency); feeds next steps                                               |
| Stack       | A fresh T3 server with Claude, Codex and Hermes instances, the same three prompts each, timed from the server's database              | Haiku and Luna tokens | Latency against Claude, reliability                                                              |
| Field       | Your own T3 Hermes history, opened read-only                                                                                          | Free                  | Tracked, not scored                                                                              |

A scenario counts as **parity** when Hermes passes the same assertion function a reference provider's fixture uses. Passing only a Hermes-specific assertion counts half. The summary also reports **Claude Code coverage**: how many scored scenarios that have a Claude fixture are at parity. Every one of them at parity is the bar for "on par with Claude Code". Scenarios are classified in [scenarios.ts](scenarios.ts): `applicable`, `twin` (the prompt names another provider's tools, so it scores 0 until a Hermes-worded twin exists), or `na` with a reason. Declared capability flags are reported as a gap map and never scored.

## Set up the benchmark Hermes home

Live and stack runs never touch your real Hermes profile. Create a standalone `HERMES_HOME` outside `~/.hermes`, so it gets its own idle-exit gateway:

```yaml
# ~/.hermes-bench/config.yaml
model:
  default: claude-haiku-5-5
  provider: custom:cliproxyapi-claude
  base_url: <Anthropic-compatible endpoint>
  api_mode: anthropic_messages
custom_providers:
  - name: cliproxyapi-claude
    base_url: <Anthropic-compatible endpoint>
    key_env: CLIPROXYAPI_API_KEY
    model: claude-haiku-5-5
    models: { claude-haiku-5-5: {} }
    discover_models: false
    api_mode: anthropic_messages
```

Put `CLIPROXYAPI_API_KEY=...` in `~/.hermes-bench/.env` (mode 600). Keep the provider name: committed fixtures pin the model id `custom:cliproxyapi-claude:claude-haiku-5-5`. The recorder refuses `~/.hermes` and its profiles. A new home builds its own Python environment on first launch, which can outlast a recorder run; if Hermes then reports that no dependency environment is committed, run `HERMES_HOME=<home> hermes pm repair` once.

## Run it

From `evals/`:

```bash
pnpm provider-parity --out runs/<name>                      # conformance only
pnpm provider-parity --out runs/<name> --live --samples 2   # + live Hermes runs
pnpm provider-parity --out runs/<name> --stack              # + stack latency suite
pnpm provider-parity --out runs/<name> --field              # + your history
pnpm provider-parity --out runs/<name> --all --baseline runs/<prev>
```

`--scenario a,b` narrows live runs. `--references` also replays the Claude and Codex fixtures. `--hermes-home` defaults to `~/.hermes-bench`; `--db` defaults to `$T3HERMES_HOME/userdata/statev2.sqlite`. A run writes `scorecard.json` and `summary.md`; pass the run directory to `--baseline` next time to see deltas and regressions.

One live sample of every scenario takes about 15 minutes. The stack suite takes 5 to 10 minutes and runs real Claude and Codex turns.

## Climb it

1. Run with `--live` and read **Next steps** in `summary.md`. They are ranked by headline points gained.
2. A scenario that passes live but has no fixture is free points: record it into the fixtures with `node scripts/record-hermes-acp-replay-fixture.ts --hermes-home ~/.hermes-bench --scenario <name>` from `apps/server`, then add a `hermes` variant to [the fixture registry](../../apps/server/src/orchestration-v2/testkit/fixtures/index.ts) using the assertion the live run passed.
3. A scenario that fails live is a real gap. Fix it in the Hermes adapter or ACP support, or with a Hermes patch under `infra/hermes/`, then record it.
4. A `twin` scenario needs a Hermes-worded prompt: add a `hermes_<name>` fixture whose hermes variant reuses the reference assertion, and set `twin` in `scenarios.ts`.
5. Rerun with `--baseline` and show the delta in the PR. No facet may regress.

Rules that keep the number honest:

- Never edit a reference assertion or its fixtures to let Hermes pass. Shared assertions must keep passing for every provider that uses them.
- A variant's `assertOutput` is the user-visible contract that parity compares. Checks of one provider's wire frames, native ids or token ledgers go in that variant's `assertProviderDetails`, which replay also runs. Moving a reference's wire checks there keeps them, and lets other providers share the rest.
- Fixtures come only from the recorder, never from hand edits.
- A Hermes-only assertion scores half; say why in the PR.
- Changing a classification in `scenarios.ts` needs a reason in the entry.

Scenarios marked `providerBound` (`message_steering`, `subagent`, `subagent_v2`, `subagent_v2_nested`, `web_search`) have only reference assertions that check their own provider's identity, wire frames or item shapes. Hermes reaches half credit there with its own assertion, and full credit once the reference's wire checks move to its `assertProviderDetails`, leaving an `assertOutput` that Hermes can share.

`run.test.ts` tests the grader and runs in CI.
