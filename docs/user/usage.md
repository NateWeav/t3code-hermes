# Review usage and plan limits

The Usage page shows subscription capacity and activity together. Account cards keep short and long
reset windows separate, show the remaining percentage, and display when each window resets.
Refreshing asks each environment for current provider data; T3 Code keeps the last successful
reading visible when a provider is temporarily unavailable.

Codex and Claude limits use their CLI's signed-in account. On macOS, Claude's native Keychain
credential is reused; on other platforms T3 Code reads Claude Code's native credentials file.
OpenCode Go detects `~/.local/share/opencode/auth.json` and uses that API key to read authoritative
rolling, weekly, and monthly limits. If the usage API is temporarily unavailable, finalized
OpenCode Go costs in the local `opencode.db` provide an estimated fallback. The card labels these
local estimates in their window names. Optional `OPENCODE_GO_WORKSPACE_ID` and
`OPENCODE_GO_AUTH_COOKIE` overrides enable the web-dashboard source. The cookie contains sensitive
dashboard session credentials; avoid exposing it in environment diagnostics and rotate it if it is
exposed.
Cards with a detected sign-in but no readable usage explain that state instead of reporting a
misleading zero.

Activity appears below the account cards and contains token and API-equivalent cost reporting. It
scans provider transcripts stored on each environment; raw transcript contents remain on that
machine.

Activity combines Codex, Claude Code, Hermes, and OpenCode usage from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here. For OpenCode, the page uses the provider-aware cost
stored with each completed response, including OpenCode Go models such as Kimi.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
