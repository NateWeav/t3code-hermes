#!/usr/bin/env bash
set -euo pipefail

release_version="${1:?release version is required}"
release_dist_tag="${2:?npm dist-tag is required}"
export npm_config_registry=https://registry.npmjs.org

# Allow npm's public metadata to propagate before testing a fresh install.
published_version=""
for attempt in {1..12}; do
  published_version="$(npm view "t3-hermes@${release_dist_tag}" version 2>/dev/null || true)"
  if [[ "$published_version" == "$release_version" ]]; then
    break
  fi
  sleep 5
done
if [[ "$published_version" != "$release_version" ]]; then
  echo "::error::t3-hermes@${release_dist_tag} resolves to '${published_version}', expected '${release_version}'." >&2
  exit 1
fi

# Avoid the checkout's binaries, npm cache, and user state masking a broken package.
smoke_dir="$(mktemp -d)"
trap 'rm -rf "$smoke_dir"' EXIT
cd "$smoke_dir"
actual_version="$(npm_config_cache="$smoke_dir/cache" T3HERMES_HOME="$smoke_dir/state" \
  npm exec --yes --package="t3-hermes@${release_version}" -- t3-hermes --version)"
if [[ "$actual_version" != "t3-hermes v${release_version}" ]]; then
  echo "::error::Published CLI reported '${actual_version}', expected '${release_version}'." >&2
  exit 1
fi
echo "Verified t3-hermes@${release_version} on npm tag ${release_dist_tag}."
