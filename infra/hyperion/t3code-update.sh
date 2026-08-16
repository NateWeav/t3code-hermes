#!/usr/bin/env bash
#
# t3code-update.sh — idempotent self-update for a headless T3 Code (Hermes fork)
# install that runs from TypeScript source under a systemd *user* unit.
#
#   1. fetch origin/<branch>; exit 0 quietly when the checkout is already current
#   2. stop the server FIRST (frees RAM before the memory-heavy web build)
#   3. hard-reset the checkout, `pnpm install --frozen-lockfile`, build only the web app
#   4. restart, then health-check (systemctl is-active + HTTP probe)
#   5. on failure: roll back to the previous commit, restore/rebuild, restart, exit non-zero
#
# Never uses `t3 service install` — that would replace this fork with the published
# upstream npm package. See FORK.md § Headless deployment.
#
# All output goes to stdout/stderr so journald captures it:
#   journalctl --user -u t3code-update -n 200
#
# Usage: t3code-update.sh [--force] [--verbose] [--help]

set -euo pipefail

# ---------------------------------------------------------------------------
# Re-exec from a private copy.
#
# This script lives inside the checkout it is about to hard-reset, and bash
# reads scripts lazily — rewriting the file mid-run can make bash misparse the
# remainder. Run from a throwaway copy instead. A script change therefore takes
# effect on the *next* run, which is the safe ordering.
# ---------------------------------------------------------------------------
if [[ "${T3CODE_UPDATE_REEXEC:-0}" != "1" ]]; then
  __self_copy="$(mktemp "${TMPDIR:-/tmp}/t3code-update.XXXXXX")"
  cat "${BASH_SOURCE[0]}" >"${__self_copy}"
  export T3CODE_UPDATE_REEXEC=1
  export T3CODE_UPDATE_SELF_COPY="${__self_copy}"
  exec bash "${__self_copy}" "$@"
fi
SELF_COPY="${T3CODE_UPDATE_SELF_COPY:-}"

# ---------------------------------------------------------------------------
# Configuration
#
# Every value below can be overridden by the environment or by the config file
# (plain KEY=value lines, systemd EnvironmentFile compatible). The config file
# wins over exported variables, so keep host-specific values there.
# ---------------------------------------------------------------------------
T3CODE_UPDATE_CONFIG="${T3CODE_UPDATE_CONFIG:-${XDG_CONFIG_HOME:-${HOME}/.config}/t3code-update.env}"
if [[ -r "${T3CODE_UPDATE_CONFIG}" ]]; then
  # shellcheck source=/dev/null
  . "${T3CODE_UPDATE_CONFIG}"
fi

# Git remote the install tracks. Must be the fork, never upstream.
T3CODE_REPO_URL="${T3CODE_REPO_URL:-https://github.com/NateWeav/t3code-hermes.git}"
T3CODE_BRANCH="${T3CODE_BRANCH:-main}"
# Checkout the systemd unit runs from (WorkingDirectory / ExecStart path).
T3CODE_DIR="${T3CODE_DIR:-${HOME}/t3code}"
# The server's systemd *user* unit.
T3CODE_SERVICE="${T3CODE_SERVICE:-t3code.service}"
# Health check target. Left empty, both are parsed out of the unit's ExecStart
# (--host/--port), which keeps the tailnet address out of this file.
T3CODE_HEALTH_HOST="${T3CODE_HEALTH_HOST:-}"
T3CODE_HEALTH_PORT="${T3CODE_HEALTH_PORT:-}"
T3CODE_HEALTH_PATH="${T3CODE_HEALTH_PATH:-/}"
# How long to wait for the server to answer after a restart, and per request.
T3CODE_HEALTH_TIMEOUT_SECONDS="${T3CODE_HEALTH_TIMEOUT_SECONDS:-150}"
T3CODE_HEALTH_REQUEST_TIMEOUT_SECONDS="${T3CODE_HEALTH_REQUEST_TIMEOUT_SECONDS:-10}"
T3CODE_HEALTH_INTERVAL_SECONDS="${T3CODE_HEALTH_INTERVAL_SECONDS:-5}"
# V8 heap cap for the web build. hyperion has 11 GB RAM and NO swap; the server
# is stopped before this runs, but other services still hold most of it.
T3CODE_BUILD_HEAP_MB="${T3CODE_BUILD_HEAP_MB:-2560}"
T3CODE_WEB_PACKAGE="${T3CODE_WEB_PACKAGE:-@t3tools/web}"
# Marker files (last deployed commit, known-bad commit) and the run lock.
T3CODE_STATE_DIR="${T3CODE_STATE_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/t3code-update}"
# Set to 1 to let the updater discard uncommitted changes to tracked files.
T3CODE_DISCARD_LOCAL_CHANGES="${T3CODE_DISCARD_LOCAL_CHANGES:-0}"

VERBOSE="${T3CODE_UPDATE_VERBOSE:-0}"
FORCE=0

FETCH_REFSPEC="+refs/heads/${T3CODE_BRANCH}:refs/remotes/origin/${T3CODE_BRANCH}"
REMOTE_REF="refs/remotes/origin/${T3CODE_BRANCH}"
WEB_DIST="${T3CODE_DIR}/apps/web/dist"
DIST_ROLLBACK="${T3CODE_STATE_DIR}/web-dist-rollback"
FAILED_MARKER="${T3CODE_STATE_DIR}/failed-commit"
DEPLOYED_MARKER="${T3CODE_STATE_DIR}/deployed-commit"

SERVICE_STOPPED=0
SERVICE_RESTORED=0
DIST_STASHED=0
BOOTSTRAPPED=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { printf '[t3code-update] %s\n' "$*"; }
warn() { printf '[t3code-update] WARNING: %s\n' "$*" >&2; }
err() { printf '[t3code-update] ERROR: %s\n' "$*" >&2; }

die() {
  err "$*"
  exit 1
}

# Only shown with --verbose or on a terminal: nightly no-op runs stay silent.
debug() {
  if [[ "${VERBOSE}" == "1" ]] || [[ -t 1 ]]; then
    log "$*"
  fi
}

run() {
  log "+ $*"
  "$@"
}

usage() {
  cat <<'EOF'
Usage: t3code-update.sh [options]

  --force     rebuild and restart even when the checkout is already current,
              and ignore the known-bad-commit marker
  --verbose   log no-op runs too
  --help      this text

Configuration is read from ${XDG_CONFIG_HOME:-~/.config}/t3code-update.env
(override with T3CODE_UPDATE_CONFIG). See infra/hyperion/README.md.
EOF
}

git_repo() { git -C "${T3CODE_DIR}" "$@"; }

now() { date +%s; }

on_exit() {
  local status=$?
  if [[ -n "${SELF_COPY}" ]]; then
    rm -f "${SELF_COPY}"
  fi
  if ((status != 0)) && [[ "${SERVICE_STOPPED}" == "1" && "${SERVICE_RESTORED}" != "1" ]]; then
    err "aborted (exit ${status}) while ${T3CODE_SERVICE} was stopped — starting it again"
    systemctl --user start "${T3CODE_SERVICE}" ||
      err "could not start ${T3CODE_SERVICE}; start it by hand"
  fi
}
trap on_exit EXIT

while (($# > 0)); do
  case "$1" in
    --force) FORCE=1 ;;
    --verbose | -v) VERBOSE=1 ;;
    --help | -h)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1 (PATH=${PATH})"
}

preflight() {
  require_cmd git
  require_cmd pnpm
  require_cmd node
  require_cmd systemctl
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not found — the health check will only test TCP connectivity"
  fi
  mkdir -p "${T3CODE_STATE_DIR}"
}

# Only one updater at a time; a manual run and the timer can overlap.
acquire_lock() {
  if ! command -v flock >/dev/null 2>&1; then
    return 0
  fi
  exec 9>"${T3CODE_STATE_DIR}/update.lock"
  if ! flock -n 9; then
    log "another t3code-update run holds the lock — skipping"
    exit 0
  fi
}

# ---------------------------------------------------------------------------
# Checkout bootstrap
#
# First run on hyperion finds ~/t3code as an rsync'd copy of the source with no
# .git at all. Adopt it in place: git init + remote + fetch + reset --hard.
# `reset --hard` (rather than `checkout`) is deliberate — it overwrites colliding
# files that are untracked instead of refusing. node_modules and other ignored
# files are left alone, so the follow-up install stays cheap. ~/.t3 lives outside
# the checkout and is never touched.
# ---------------------------------------------------------------------------
ensure_remote() {
  local current=""
  current="$(git_repo remote get-url origin 2>/dev/null || true)"
  if [[ -z "${current}" ]]; then
    run git -C "${T3CODE_DIR}" remote add origin "${T3CODE_REPO_URL}"
  elif [[ "${current}" != "${T3CODE_REPO_URL}" ]]; then
    warn "origin is ${current}, expected ${T3CODE_REPO_URL} — repointing it"
    run git -C "${T3CODE_DIR}" remote set-url origin "${T3CODE_REPO_URL}"
  fi
}

ensure_checkout() {
  case "${T3CODE_DIR}" in
    "${HOME}" | "${HOME}/" | /) die "refusing to manage T3CODE_DIR=${T3CODE_DIR}" ;;
  esac
  local t3_home="${T3CODE_HOME:-${HOME}/.t3}"
  case "${t3_home%/}/" in
    "${T3CODE_DIR%/}"/*)
      die "T3CODE_HOME (${t3_home}) is inside ${T3CODE_DIR}; the updater would clobber server state"
      ;;
  esac

  if [[ ! -e "${T3CODE_DIR}" ]]; then
    log "no checkout at ${T3CODE_DIR} — cloning ${T3CODE_REPO_URL} (${T3CODE_BRANCH})"
    run git clone --branch "${T3CODE_BRANCH}" "${T3CODE_REPO_URL}" "${T3CODE_DIR}"
    BOOTSTRAPPED=1
    return
  fi

  [[ -d "${T3CODE_DIR}" ]] || die "${T3CODE_DIR} exists but is not a directory"

  if [[ -d "${T3CODE_DIR}/.git" ]] || git_repo rev-parse --git-dir >/dev/null 2>&1; then
    ensure_remote
    return
  fi

  # Bootstrap: an rsync'd (non-git) copy.
  [[ -f "${T3CODE_DIR}/apps/server/src/bin.ts" ]] ||
    die "${T3CODE_DIR} is neither a git checkout nor a t3code source tree; refusing to touch it"

  log "converting the non-git copy at ${T3CODE_DIR} into a checkout of ${T3CODE_REPO_URL}"
  log "tracked files will be replaced by ${T3CODE_BRANCH}; ignored files (node_modules, dist) are kept"
  run git -C "${T3CODE_DIR}" init -q
  ensure_remote
  run git -C "${T3CODE_DIR}" fetch --prune origin "${FETCH_REFSPEC}"
  run git -C "${T3CODE_DIR}" symbolic-ref HEAD "refs/heads/${T3CODE_BRANCH}"
  run git -C "${T3CODE_DIR}" reset --hard "${REMOTE_REF}"
  git_repo branch --set-upstream-to "origin/${T3CODE_BRANCH}" "${T3CODE_BRANCH}" >/dev/null 2>&1 || true
  BOOTSTRAPPED=1
  log "bootstrap complete at $(git_repo rev-parse --short HEAD)"
}

fetch_origin() {
  local attempt
  for attempt in 1 2 3; do
    if git_repo fetch --prune origin "${FETCH_REFSPEC}"; then
      return 0
    fi
    warn "git fetch failed (attempt ${attempt}/3)"
    sleep $((attempt * 10))
  done
  die "could not fetch ${T3CODE_REPO_URL} ${T3CODE_BRANCH}"
}

assert_clean_worktree() {
  local dirty=""
  dirty="$(git_repo status --porcelain --untracked-files=no)"
  [[ -n "${dirty}" ]] || return 0
  if [[ "${T3CODE_DISCARD_LOCAL_CHANGES}" == "1" ]]; then
    warn "discarding local changes to tracked files:"
    printf '%s\n' "${dirty}" >&2
    return 0
  fi
  err "uncommitted changes to tracked files in ${T3CODE_DIR}:"
  printf '%s\n' "${dirty}" >&2
  die "commit/stash them, or set T3CODE_DISCARD_LOCAL_CHANGES=1 to let the updater discard them"
}

# ---------------------------------------------------------------------------
# Service control + health
# ---------------------------------------------------------------------------
stop_service() {
  run systemctl --user stop "${T3CODE_SERVICE}"
  SERVICE_STOPPED=1
  SERVICE_RESTORED=0
}

start_service() {
  run systemctl --user restart "${T3CODE_SERVICE}"
  SERVICE_RESTORED=1
}

resolve_health_target() {
  if [[ -n "${T3CODE_HEALTH_HOST}" && -n "${T3CODE_HEALTH_PORT}" ]]; then
    return 0
  fi
  local exec_start="" host="" port="" i
  exec_start="$(systemctl --user show "${T3CODE_SERVICE}" --property=ExecStart --value 2>/dev/null || true)"
  if [[ -n "${exec_start}" ]]; then
    local words=()
    read -r -a words <<<"${exec_start}"
    for ((i = 0; i < ${#words[@]}; i++)); do
      case "${words[i]}" in
        --host) host="${words[i + 1]:-}" ;;
        --host=*) host="${words[i]#--host=}" ;;
        --port) port="${words[i + 1]:-}" ;;
        --port=*) port="${words[i]#--port=}" ;;
      esac
    done
  fi
  [[ -n "${T3CODE_HEALTH_HOST}" ]] || T3CODE_HEALTH_HOST="${host:-127.0.0.1}"
  [[ -n "${T3CODE_HEALTH_PORT}" ]] || T3CODE_HEALTH_PORT="${port:-8790}"
  # A wildcard bind is not a usable probe target.
  case "${T3CODE_HEALTH_HOST}" in
    0.0.0.0 | '::' | '*') T3CODE_HEALTH_HOST="127.0.0.1" ;;
  esac
}

health_url() {
  local host="${T3CODE_HEALTH_HOST}"
  case "${host}" in
    *:*) host="[${host}]" ;;
  esac
  printf 'http://%s:%s%s' "${host}" "${T3CODE_HEALTH_PORT}" "${T3CODE_HEALTH_PATH}"
}

# Any HTTP response below 500 means the server is up and routing; the root path
# may legitimately answer 3xx/4xx for an unauthenticated probe.
http_probe() {
  local url code=""
  url="$(health_url)"
  if command -v curl >/dev/null 2>&1; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "${T3CODE_HEALTH_REQUEST_TIMEOUT_SECONDS}" "${url}" 2>/dev/null || true)"
    case "${code}" in
      "" | 000) return 1 ;;
      5??) return 1 ;;
      *) return 0 ;;
    esac
  fi
  timeout "${T3CODE_HEALTH_REQUEST_TIMEOUT_SECONDS}" \
    bash -c "exec 3<>/dev/tcp/${T3CODE_HEALTH_HOST}/${T3CODE_HEALTH_PORT}" 2>/dev/null
}

wait_for_health() {
  local deadline elapsed
  deadline=$(($(now) + T3CODE_HEALTH_TIMEOUT_SECONDS))
  log "waiting up to ${T3CODE_HEALTH_TIMEOUT_SECONDS}s for $(health_url)"
  while :; do
    if systemctl --user is-failed --quiet "${T3CODE_SERVICE}"; then
      err "${T3CODE_SERVICE} entered a failed state"
      return 1
    fi
    if systemctl --user is-active --quiet "${T3CODE_SERVICE}" && http_probe; then
      elapsed=$((T3CODE_HEALTH_TIMEOUT_SECONDS - (deadline - $(now))))
      log "healthy after ~${elapsed}s"
      return 0
    fi
    if (($(now) >= deadline)); then
      err "health check timed out after ${T3CODE_HEALTH_TIMEOUT_SECONDS}s"
      return 1
    fi
    sleep "${T3CODE_HEALTH_INTERVAL_SECONDS}"
  done
}

dump_service_logs() {
  err "last 60 journal lines for ${T3CODE_SERVICE}:"
  journalctl --user -u "${T3CODE_SERVICE}" -n 60 --no-pager >&2 2>/dev/null ||
    err "(journalctl unavailable)"
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
install_deps() {
  (cd "${T3CODE_DIR}" && run pnpm install --frozen-lockfile)
}

# The web build is the only build step (the server runs from TS source) and the
# only memory-heavy one, hence the explicit heap cap on a swapless host.
build_web() {
  log "+ NODE_OPTIONS=--max-old-space-size=${T3CODE_BUILD_HEAP_MB} pnpm --filter ${T3CODE_WEB_PACKAGE} build"
  (
    cd "${T3CODE_DIR}"
    NODE_OPTIONS="--max-old-space-size=${T3CODE_BUILD_HEAP_MB}" \
      pnpm --filter "${T3CODE_WEB_PACKAGE}" build
  )
}

stash_dist() {
  rm -rf "${DIST_ROLLBACK}"
  if [[ -d "${WEB_DIST}" ]]; then
    mv "${WEB_DIST}" "${DIST_ROLLBACK}"
    DIST_STASHED=1
    debug "kept the previous web build at ${DIST_ROLLBACK} for rollback"
  fi
}

restore_dist() {
  [[ "${DIST_STASHED}" == "1" && -d "${DIST_ROLLBACK}" ]] || return 1
  rm -rf "${WEB_DIST}"
  mv "${DIST_ROLLBACK}" "${WEB_DIST}"
  DIST_STASHED=0
  log "restored the previous web build from ${DIST_ROLLBACK}"
}

discard_dist_backup() {
  rm -rf "${DIST_ROLLBACK}"
  DIST_STASHED=0
}

# The build only starts after `stash_dist`, so if it never ran the assets on
# disk are still the ones that go with the commit we are rolling back to.
restore_web_assets_for_rollback() {
  if restore_dist; then
    log "reused the pre-update web build; skipping the rollback rebuild"
    return
  fi
  if [[ -f "${WEB_DIST}/index.html" ]]; then
    log "the existing web build predates this run; skipping the rollback rebuild"
    return
  fi
  build_web || err "rollback rebuild failed — the web assets may be missing or stale"
}

# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------
rollback() {
  local previous_sha="$1" failed_sha="$2" reason="$3"
  err "=============================================================="
  err "UPDATE FAILED: ${reason}"
  err "  attempted: ${failed_sha}"
  err "  rolling back to: ${previous_sha:-<no previous commit>}"
  err "=============================================================="
  dump_service_logs

  printf '%s\n' "${failed_sha}" >"${FAILED_MARKER}"

  systemctl --user stop "${T3CODE_SERVICE}" || true
  SERVICE_STOPPED=1
  SERVICE_RESTORED=0

  if [[ -n "${previous_sha}" ]]; then
    if ! git_repo reset --hard "${previous_sha}"; then
      err "git reset to ${previous_sha} failed — the checkout needs manual repair"
    fi
  fi

  if ! install_deps; then
    err "pnpm install failed during rollback"
  fi

  restore_web_assets_for_rollback

  if ! start_service; then
    err "could not restart ${T3CODE_SERVICE} after rollback"
  fi

  if wait_for_health; then
    err "rolled back to ${previous_sha} and the service is healthy again"
    err "the update to ${failed_sha} will NOT be retried until that commit changes"
    err "or ${FAILED_MARKER} is removed (or you pass --force)"
  else
    err "SERVICE IS DOWN after rollback — manual intervention required"
    err "  systemctl --user status ${T3CODE_SERVICE}"
    err "  journalctl --user -u ${T3CODE_SERVICE} -n 200"
    dump_service_logs
  fi
  exit 1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  preflight
  acquire_lock
  ensure_checkout
  resolve_health_target

  fetch_origin

  local target_sha current_sha
  target_sha="$(git_repo rev-parse "${REMOTE_REF}")"
  current_sha="$(git_repo rev-parse HEAD 2>/dev/null || echo "")"

  if [[ "${current_sha}" == "${target_sha}" && -f "${WEB_DIST}/index.html" ]] &&
    [[ "${FORCE}" != "1" && "${BOOTSTRAPPED}" != "1" ]]; then
    debug "already at ${target_sha} with a built web app — nothing to do"
    exit 0
  fi

  if [[ "${FORCE}" != "1" && -f "${FAILED_MARKER}" ]] &&
    [[ "$(cat "${FAILED_MARKER}")" == "${target_sha}" ]]; then
    err "origin/${T3CODE_BRANCH} is still ${target_sha}, which failed to deploy on a previous run"
    err "not retrying. Remove ${FAILED_MARKER} or run with --force once it is fixed."
    exit 1
  fi

  if [[ "${current_sha}" == "${target_sha}" ]]; then
    log "at ${target_sha} but a rebuild is needed (first run after bootstrap, missing web build, or --force)"
  else
    log "updating ${current_sha:-<none>} -> ${target_sha}"
    git_repo --no-pager log --oneline --no-decorate "${current_sha}..${target_sha}" 2>/dev/null |
      head -n 20 || true
  fi

  assert_clean_worktree

  # Stop first: the build needs the RAM the server is holding.
  log "stopping ${T3CODE_SERVICE} before the build (frees memory)"
  stop_service

  if [[ -n "${current_sha}" && "${current_sha}" != "${target_sha}" ]]; then
    if ! git_repo symbolic-ref HEAD "refs/heads/${T3CODE_BRANCH}"; then
      rollback "${current_sha}" "${target_sha}" "could not switch HEAD to ${T3CODE_BRANCH}"
    fi
    if ! git_repo reset --hard "${target_sha}"; then
      rollback "${current_sha}" "${target_sha}" "git reset to ${target_sha} failed"
    fi
  fi

  if ! install_deps; then
    rollback "${current_sha}" "${target_sha}" "pnpm install --frozen-lockfile failed"
  fi

  stash_dist

  if ! build_web; then
    rollback "${current_sha}" "${target_sha}" "web build failed (out of memory? lower T3CODE_BUILD_HEAP_MB)"
  fi

  if ! start_service; then
    rollback "${current_sha}" "${target_sha}" "systemctl --user restart ${T3CODE_SERVICE} failed"
  fi

  if ! wait_for_health; then
    rollback "${current_sha}" "${target_sha}" "the service did not come back healthy"
  fi

  discard_dist_backup
  rm -f "${FAILED_MARKER}"
  printf '%s\n' "${target_sha}" >"${DEPLOYED_MARKER}"
  log "updated to ${target_sha} and ${T3CODE_SERVICE} is healthy"
}

main "$@"
