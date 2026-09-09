# T3 Connect setup

Deployment and client configuration for T3 Connect. The [architecture note](../internals/t3-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions.

## T3 Hermes builds

T3 Hermes installs alongside T3 Code with its own application IDs and data. Desktop and CLI
state defaults to `~/.t3-hermes/userdata`; use `T3HERMES_HOME` or `--home-dir` to override it.
`T3HERMES_PORT` overrides the default server port of 4773. Existing T3 Code data is not migrated.
The CLI executable and npm package are `t3-hermes`; background-service installation and SSH
provisioning require that package/version to be published before use.

Desktop release builds use the fork's GitHub release feed via `GITHUB_REPOSITORY` (or the explicit
`T3CODE_DESKTOP_UPDATE_REPOSITORY` override). Do not point Hermes at upstream's release feed.

Mobile uses `com.nateweav.t3hermes` with `.dev` and `.preview` variants. Set
`T3CODE_APPLE_TEAM_ID` for your Apple team and configure signing for these IDs, including their
widget and sharing extensions. Set `T3HERMES_EAS_PROJECT_ID` and `T3HERMES_EXPO_OWNER` to your
own Expo project; OTA updates are disabled until a project ID is set. Configure your own App Store
submission target in `apps/mobile/eas.json` before submitting.

Using the production Connect service still requires its Clerk administrator to allow Hermes's
native sign-in callbacks: `t3-hermes://app/`, `t3-hermes-dev://app/`, and the mobile redirect URLs
for `t3-hermes`, `t3-hermes-dev`, and `t3-hermes-preview`. Desktop content retains the
`t3code://app` / `t3code-dev://app` renderer origins for upstream server compatibility; those
origins are not registered as OS launch handlers by Hermes. Native passkeys, Apple/Google sign-in,
and mobile push require configuration for the new app IDs. The upstream relay's APNs credentials
must not be assumed to support Hermes's bundle ID.

## Public application configuration

T3 Connect is disabled in a fresh clone. To build against the production deployment, copy the
repository-root example:

```sh
cp .env.example .env
```

For another deployment, set these values in the repository-root `.env` or `.env.local`:

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T3CODE_CLERK_JWT_TEMPLATE=<JWT template name>
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T3CODE_RELAY_URL=https://relay.example.com
```

Process variables take precedence over `.env.local`, then `.env`. Use these canonical names;
the build loader supplies framework-specific aliases. These values are public identifiers.
`CLERK_SECRET_KEY` belongs only in the relay's secrets, never in client configuration.

Client and bundled-server builds embed the public values, so set them before building.
EAS preview and production environments need the publishable key, JWT template name, and relay URL.
Bundled servers also accept runtime overrides for operator-managed deployments.

Copy `infra/relay/.env.example` to `infra/relay/.env` for relay deployment settings.
Deploy `prod` before personal stages because it owns the retained database that their branches
depend on. The deploy wrapper writes the resulting relay URL back to the root `.env`.

## CLI OAuth application

In Clerk's OAuth applications settings:

1. Create a public OAuth application for the T3 CLI, using authorization-code exchange with PKCE.
2. Allow both redirect URIs: `http://127.0.0.1:34338/callback` and
   `https://app.t3.codes/connect/callback`. A custom `T3CODE_HOSTED_APP_URL` needs its own
   `/connect/callback` URL. Headless and SSH authorization depend on the hosted redirect.
3. Enable the `openid`, `profile`, and `email` scopes.
4. Set `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` to the generated public client ID in local and release
   build environments.

## JWT template

Create a Clerk JWT template named `t3-relay` with claims:

```json
{ "aud": "t3-code-relay" }
```

Set `T3CODE_CLERK_JWT_TEMPLATE=t3-relay` for clients and
`CLERK_JWT_AUDIENCE=t3-code-relay` for the relay. The production relay deployment environment
also defines `CLERK_JWT_TEMPLATE`. The audience stays the same across relay stages; the relay
URL selects the deployment.

## Desktop OAuth redirects

Enable Clerk's Native API and add the desktop redirects to its SSO redirect allowlist:

```text
t3-hermes-dev://app/
t3-hermes://app/
```

Add the corresponding origin to the Clerk instance's Backend API `allowed_origins` array.
Development uses `t3code-dev://app`; production uses `t3code://app`. Update the array with
`PATCH https://api.clerk.com/v1/instance` using the Clerk secret key, preserving existing entries.
The Clerk Electron integration handles token
persistence and system-browser callback delivery.

## Desktop passkeys

For a production macOS app with bundle ID `com.nateweav.t3hermes`:

1. Create an explicit macOS App ID in the Apple Developer portal with **Associated Domains**.
2. Create a provisioning profile for that App ID and the distribution signing certificate.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID.
   This setting also configures Electron/macOS passkeys.
4. Check `https://<frontend-api>/.well-known/apple-app-site-association`. Its
   `webcredentials.apps` must include `<TEAM_ID>.com.nateweav.t3hermes`.
5. Configure signing as described in the [release runbook](./release.md#2-apple-signing--notarization-setup-macos).

Local signed builds additionally use:

```dotenv
T3CODE_APPLE_TEAM_ID=ABC1234567
T3CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/t3code.provisionprofile
# Override only when the RP domain differs from the Clerk Frontend API hostname.
T3CODE_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

Without the override, the build derives the RP domain from the Clerk publishable key.
After changing Associated Domains, bump the build version before rebuilding. macOS can otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

The ordinary `dev:desktop` launcher is unsigned and cannot exercise macOS passkeys. For renderer
HMR, install a signed build, start `vp run dev:web`, and launch the installed executable with the
actual web and server ports. For example, with the default ports:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
T3HERMES_PORT=14773 \
  "/Applications/T3 Hermes (Alpha).app/Contents/MacOS/T3 Hermes (Alpha)"
```

Rebuild the signed app after native dependency, main-process, preload, entitlement, provisioning,
or signing changes. Renderer edits can reuse it. Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/T3 Code (Alpha).app"
codesign -d --entitlements :- "/Applications/T3 Code (Alpha).app"
```

## Restricting sign-ups

Use Clerk's allowlist for permitted email addresses or domains, or Restricted mode for invitation-only
sign-up. An enabled empty allowlist blocks all new sign-ups.

Sign-up restrictions do not revoke an existing account's access. Ban the account in Clerk when
its active sessions and future sign-ins must be disabled.
