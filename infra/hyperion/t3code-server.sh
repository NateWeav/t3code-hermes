#!/usr/bin/env bash
# Use the release bundle after an upgrade; retain source startup for rollback
# to installations that predate bundled nightly deployments.
set -euo pipefail
T3CODE_DIR="${T3CODE_DIR:-${HOME}/t3code}"
export T3HERMES_HOME="${T3HERMES_HOME:-${HOME}/.t3}"
if [[ -f "${T3CODE_DIR}/apps/server/dist/.nightly-version" ]]; then
  exec node "${T3CODE_DIR}/apps/server/dist/bin.mjs" "$@"
fi
exec node "${T3CODE_DIR}/apps/server/src/bin.ts" "$@"
