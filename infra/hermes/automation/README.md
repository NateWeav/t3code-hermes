# Hermes patch drift resolver

[`hermes-patches.yml`](../../../.github/workflows/hermes-patches.yml) files a `hermes-patch-drift`
issue when a carried patch stops fitting Hermes `main`. These files let the Hermes `upstream-sync`
profile on the maintainer host pick that issue up and open a PR adding rebased versions, the same
way it already resolves `upstream-sync-conflict` issues. Nothing here ships in T3 Code.

| File                              | Installs to                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `hermes-patch-drift.py`           | `~/.hermes/profiles/upstream-sync/scripts/`: filters events and parses the issue for the prompt |
| `route.yaml`                      | merged into `platforms.webhook.extra.routes` in the default profile's `~/.hermes/config.yaml`   |
| `hermes-patch-drift-smee.service` | `~/.config/systemd/user/`: relays GitHub's webhook to the new route                             |

## Why a second smee client

smee-client forwards to exactly one target URL, and the existing `hermes-upstream-sync-smee.service`
targets `/p/upstream-sync/webhooks/t3code-upstream-conflict`, so the new route would never see an
event through it. smee.io itself broadcasts every delivery to every client connected to a channel,
so a second client on the **same** channel (same `smee.env`, same GitHub webhook, same secret)
pointed at the new route gets every event too. Each route's filter script then drops the other
kind of issue with `[SILENT]`.

That keeps the two resolvers independent: no change to the working conflict route or its script, no
new GitHub webhook, and each route keeps its own prompt, lock, and skills. One dispatching route
would have to merge two prompts into one, and a mistake in it would break both pipelines.

## Install after merge

1. Copy the filter and make it executable:

   ```bash
   install -m 0755 infra/hermes/automation/hermes-patch-drift.py \
     ~/.hermes/profiles/upstream-sync/scripts/hermes-patch-drift.py
   ```

2. Back up `~/.hermes/config.yaml`, then paste `route.yaml` under
   `platforms.webhook.extra.routes`, indented to match `t3code-upstream-conflict`. Replace the
   secret placeholder with that route's `secret` value.
3. Install and start the relay:

   ```bash
   cp infra/hermes/automation/hermes-patch-drift-smee.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now hermes-patch-drift-smee.service
   ```

4. Static webhook routes load only at gateway startup. Once `~/.hermes/runtime/active_sessions.json`
   is empty, `systemctl --user restart hermes-gateway.service`.
5. Verify: an HMAC-signed POST of a payload the filter rejects to
   `http://127.0.0.1:8644/p/upstream-sync/webhooks/t3code-hermes-patch-drift` returns 200
   `ignored/script`, and `journalctl --user -u hermes-patch-drift-smee.service` shows
   `POST .../t3code-hermes-patch-drift - 200` after the next GitHub issue event. To run the
   resolver on demand, dispatch `hermes-patches.yml`; if it reports drift, or to rerun on an existing
   issue, add the `hermes-auto-resolve` label to it as the owner.
