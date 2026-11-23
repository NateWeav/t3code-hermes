# T3 Connect setup

Deployment and client configuration for T3 Connect. See [T3 Connect](../internals/06_t3-connect.md) for trust boundaries and [infra/relay/README.md](../../infra/relay/README.md#deployment) for relay provisioning.

## T3 Hermes builds

T3 Hermes installs alongside T3 Code with its own application IDs and data. Desktop and CLI
state defaults to `~/.t3-hermes/userdata`; use `T3HERMES_HOME` or `--home-dir` to override it.
`T3HERMES_PORT` overrides the default server port of 4773. Existing T3 Code data is not migrated.
The CLI executable and npm package are `t3-hermes`; background-service installation and SSH
provisioning require that package/version to be published before use.

The release workflow publishes `t3-hermes` with the `nightly` npm tag for nightlies and `latest`
for stable releases, then installs and checks the published CLI before publishing the GitHub release.
Configure an npm trusted publisher on the `t3-hermes` package for GitHub Actions: owner `NateWeav`,
repository `t3code-hermes`, workflow `release.yml`, with no environment. Publishing uses the job's
OIDC identity; no npm token secret is required.

Desktop release builds use the fork's GitHub release feed via `GITHUB_REPOSITORY` (or the explicit
`T3CODE_DESKTOP_UPDATE_REPOSITORY` override). Do not point Hermes at upstream's release feed.

Mobile uses `com.nateweav.t3hermes` with `.dev` and `.preview` variants. Set
`T3CODE_APPLE_TEAM_ID` for your Apple team and configure signing for these IDs, including their
widget and sharing extensions. Set `T3HERMES_EAS_PROJECT_ID` and `T3HERMES_EXPO_OWNER` to your
own Expo project; OTA updates are disabled until a project ID is set. Configure your own App Store
submission target in `apps/mobile/eas.json` before submitting.

Desktop uses upstream's `t3code://app/` and `t3code-dev://app/` sign-in callbacks and
renderer origins, so it can use upstream Clerk without registering Hermes-specific desktop
redirects. The callback handler is shared with T3 Code: quit the other app, then launch or restart
the app you want to sign into before beginning login. Closing the other app alone does not change
the OS handler; if the browser offers an application chooser, select the intended app. Both apps
can run together after login, with independent sessions and data.

Mobile retains separate `t3-hermes`, `t3-hermes-dev`, and `t3-hermes-preview` schemes; its
redirect URLs still need approval in the Clerk instance used by the mobile build.
Native passkeys, Apple/Google sign-in,
and mobile push require configuration for the new app IDs. The upstream relay's APNs credentials
must not be assumed to support Hermes's bundle ID.

## Public application configuration

T3 Connect is disabled in a fresh clone. Copy `.env.example` to `.env` for production, or set these public identifiers in `.env` / `.env.local` (process env > `.env.local` > `.env`):

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T3CODE_CLERK_JWT_TEMPLATE=<JWT template name>
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T3CODE_RELAY_URL=https://relay.example.com
```

`CLERK_SECRET_KEY` belongs only in relay secrets, never in client config. Client and bundled-server builds embed these values at build time; EAS preview/production environments need the publishable key, JWT template, and relay URL.

## Clerk setup

### CLI OAuth application

Create a public OAuth application in Clerk (authorization code + PKCE):

1. Redirect URI: `http://127.0.0.1:34338/callback`
2. Scopes: `openid`, `profile`, `email`, `offline_access`
3. Enable **Device authorization grant** (required for headless/SSH login; Clerk enables it per account on request).
4. Set `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` to its public client ID.

### JWT template

Create a Clerk JWT template named `t3-relay` with `{ "aud": "t3-code-relay" }`. Set `T3CODE_CLERK_JWT_TEMPLATE=t3-relay` on clients and `CLERK_JWT_AUDIENCE=t3-code-relay` on the relay.

### Desktop OAuth redirects

Enable Clerk's Native API, add `t3code-dev://app/` and `t3code://app/` to the SSO redirect allowlist, and add `t3code-dev://app` and `t3code://app` to `allowed_origins` via `PATCH https://api.clerk.com/v1/instance` (preserving existing entries).

### Android native sign-in redirects

In Clerk **Native applications > Allowlist for mobile SSO redirect**, allow each variant's callback:

| Variant     | Callback                                      |
| ----------- | --------------------------------------------- |
| Development | `clerk://com.t3tools.t3code.dev.callback`     |
| Preview     | `clerk://com.t3tools.t3code.preview.callback` |
| Production  | `clerk://com.t3tools.t3code.callback`         |

### Restricting sign-ups

Use Clerk's allowlist or Restricted mode for new sign-ups (an enabled empty allowlist blocks all sign-ups). Ban the account in Clerk to revoke existing sessions.

## Android FCM push setup

The relay sends Android push notifications directly via FCM HTTP v1 (no Expo Push account required):

1. Register each Android package (`com.t3tools.t3code.{dev,preview}` / `com.t3tools.t3code`) in Firebase and download `google-services.json`.
2. Pass `T3CODE_ANDROID_GOOGLE_SERVICES_FILE=/abs/path/google-services.json` when prebuilding/building locally or as an EAS file variable (available to fingerprint generation as well).
3. Enable the FCM API and store the Firebase service-account JSON only in the relay's `FCM_SERVICE_ACCOUNT` secret (never in EAS app env or the repo). Set `APNS_ENABLED=false` for an Android-only relay stage.
4. For local smoke/watch verification without deploying a relay, use `vp run push:android:smoke` and `vp run push:android:watch` from `infra/relay`.

## Desktop passkeys

For a signed macOS build (`com.nateweav.t3hermes`):

1. Create an explicit macOS App ID with **Associated Domains** and a matching distribution provisioning profile.
2. In Clerk Native API settings, add an iOS app with the same Apple Team ID and bundle ID, and verify `https://<frontend-api>/.well-known/apple-app-site-association` includes `<TEAM_ID>.com.nateweav.t3hermes`.
3. Configure signing per [Apple signing and notarization](./03_release.md#apple-signing-and-notarization-macos). Local signed builds use `T3CODE_APPLE_TEAM_ID`, `T3CODE_MACOS_PROVISIONING_PROFILE`, and optionally `T3CODE_CLERK_PASSKEY_RP_DOMAINS`. Bump the build version after changing Associated Domains so macOS refreshes cached Shared Web Credentials.

Unsigned `dev:desktop` cannot exercise passkeys. For renderer HMR with passkeys, launch an installed signed build against `vp run dev:web`:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 T3HERMES_PORT=14773 \
  "/Applications/T3 Hermes (Alpha).app/Contents/MacOS/T3 Hermes (Alpha)"
```
