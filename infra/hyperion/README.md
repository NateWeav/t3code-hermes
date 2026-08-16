# Headless self-update (hyperion)

Nightly self-update for a headless T3 Code (Hermes fork) install that runs from TypeScript source
under a systemd **user** unit. Written for the `hyperion` box (Ubuntu 22.04, ARM, 11 GB RAM, **no
swap**), but nothing in here is host-specific — the fork URL, branch, checkout path, service name,
and health target are all parameters.

| File                        | Purpose                                                 |
| --------------------------- | ------------------------------------------------------- |
| `t3code-update.sh`          | the updater; safe to run by hand at any time            |
| `t3code-update.service`     | user unit, `Type=oneshot`, runs the script              |
| `t3code-update.timer`       | nightly at 09:00 UTC (05:00 US/Eastern in EDT) + jitter |
| `t3code-update.env.example` | host-specific overrides → `~/.config/t3code-update.env` |

> **Never run `t3 service install`.** It installs the _published_ upstream npm package into
> `~/.t3/runtime/versions/<v>/` and runs that, silently dropping this fork's Hermes provider.
> See [FORK.md](../../FORK.md) § Headless deployment.

## What a run does

1. `git fetch origin <branch>`. If `HEAD` already matches and `apps/web/dist` exists, exit 0 with
   no output — nightly no-op runs leave nothing in the journal.
2. **Stop `t3code.service` first**, before anything else, so the web build gets the RAM the server
   was holding.
3. `git reset --hard origin/<branch>` → `pnpm install --frozen-lockfile` →
   `NODE_OPTIONS=--max-old-space-size=<cap> pnpm --filter @t3tools/web build`. The web app is the
   only thing that needs building; the server runs from source.
4. Restart the service and health-check it: `systemctl --user is-active` plus an HTTP probe against
   the configured host:port (any response below 500 counts — the root path may legitimately answer
   3xx/4xx unauthenticated), retried until `T3CODE_HEALTH_TIMEOUT_SECONDS`.
5. On any failure: log loudly, dump the server's journal, roll the checkout back to the previous
   commit, reinstall, put back the pre-update `apps/web/dist` (kept aside before the build, so the
   rollback usually needs no rebuild), restart, re-check, and exit non-zero.

The failed commit is recorded in `~/.local/state/t3code-update/failed-commit`; the updater will not
retry that exact commit until `origin/<branch>` moves, the marker is deleted, or it is run with
`--force`. That keeps a bad commit from stopping the server every night.

Everything goes to stdout/stderr, so journald has the whole story.

## One-time bootstrap on the VM

`~/t3code` on hyperion is an **rsync'd copy, not a git clone**. The first run converts it in place:
`git init`, `remote add origin`, fetch, then `git reset --hard origin/main`. `reset` (rather than
`checkout`) is deliberate — it overwrites colliding untracked files instead of refusing. Ignored
files (`node_modules`, `apps/web/dist`) survive, so the follow-up install is cheap. `~/.t3` lives
outside the checkout and is never touched; the script refuses to run if `T3CODE_HOME` is inside
`T3CODE_DIR`.

Chicken-and-egg: the rsync'd copy predates this directory, so the first run has to use a copy of
the script delivered out of band.

```bash
# 0. from your workstation (the script is not on the VM yet)
scp infra/hyperion/t3code-update.sh hyperion:/tmp/t3code-update.sh
# private fork over HTTPS? give git non-interactive credentials first, e.g. a
# deploy key plus T3CODE_REPO_URL=git@github.com:<owner>/<repo>.git, or
# `git config --global credential.helper store` with a PAT.

# 1. on the VM: host-specific config (optional — defaults cover hyperion)
mkdir -p ~/.config
cp ~/t3code/infra/hyperion/t3code-update.env.example ~/.config/t3code-update.env  # after step 2,
                                                                                  # or write by hand
$EDITOR ~/.config/t3code-update.env

# 2. bootstrap + first update, watching it run
bash /tmp/t3code-update.sh --verbose
#    → converts ~/t3code into a git checkout of the fork
#    → stops t3code.service, installs, builds the web app, restarts, health-checks

# 3. install the units (now that ~/t3code/infra/hyperion exists)
mkdir -p ~/.config/systemd/user
cp ~/t3code/infra/hyperion/t3code-update.service ~/.config/systemd/user/
cp ~/t3code/infra/hyperion/t3code-update.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now t3code-update.timer
systemctl --user list-timers t3code-update.timer

# 4. lingering must be on for the timer to fire while logged out (already set on hyperion)
sudo loginctl enable-linger "$USER"

rm /tmp/t3code-update.sh
```

Checks worth doing once, before trusting the timer:

```bash
systemctl --user start t3code-update.service   # no-op run, must exit 0 quietly
systemctl --user show t3code.service -p ExecStart --value   # health host/port are parsed from here
node ~/t3code/apps/server/src/bin.ts --version || true
```

Both units are `%h`-relative and assume the checkout is `~/t3code`. If it is not, edit
`ExecStart`/`WorkingDirectory` in the service unit and set `T3CODE_DIR` in the env file.

The service unit sets an explicit `PATH` (user units get a minimal one) covering
`~/.local/share/pnpm`, `~/.local/bin`, and `/usr/local/bin`. If `node`, `pnpm`, or `git` live
elsewhere, extend it — the script fails fast with `missing required command: …` and prints the PATH
it searched.

## Logs

```bash
journalctl --user -u t3code-update -n 200 --no-pager   # last run
journalctl --user -u t3code-update -f                  # follow
journalctl --user -u t3code-update --since "3 days ago"
systemctl --user status t3code-update.service          # exit status of the last run
systemctl --user list-timers t3code-update.timer       # when it next fires / last fired
```

A successful no-op run logs nothing. A real update logs the commit range, every command it ran, and
the health check result. A failure logs `UPDATE FAILED`, the attempted commit, and 60 lines of the
server's own journal.

State lives in `~/.local/state/t3code-update/`:

| Path                 | Meaning                                                         |
| -------------------- | --------------------------------------------------------------- |
| `deployed-commit`    | last commit that deployed and passed the health check           |
| `failed-commit`      | commit that failed; blocks retries until removed or superseded  |
| `web-dist-rollback/` | pre-update `apps/web/dist`, kept only for the duration of a run |
| `update.lock`        | `flock` guard against concurrent runs                           |

## Running it by hand

```bash
~/t3code/infra/hyperion/t3code-update.sh --verbose   # log even when there is nothing to do
~/t3code/infra/hyperion/t3code-update.sh --force     # rebuild/restart regardless, ignore the marker
systemctl --user start t3code-update.service         # exactly what the timer does
```

## Disabling the timer

```bash
systemctl --user stop t3code-update.timer      # until next boot / re-enable
systemctl --user disable --now t3code-update.timer   # permanently
```

Manual runs of the script still work with the timer disabled. To remove it entirely, delete the two
unit files from `~/.config/systemd/user/` and `systemctl --user daemon-reload`.

## When it fails

```bash
journalctl --user -u t3code-update -n 200 --no-pager   # what broke
systemctl --user status t3code.service                 # is the server back up?
```

The server should already be back on the previous commit. Once the upstream fix lands, the next
nightly run picks it up automatically (`origin/main` moved, so the marker no longer matches). To
retry the same commit sooner:

```bash
rm ~/.local/state/t3code-update/failed-commit
~/t3code/infra/hyperion/t3code-update.sh --verbose
```

Common causes:

- **`FATAL ERROR: … heap out of memory` / the build gets OOM-killed.** hyperion has no swap and
  shares RAM with several other services. Tune `T3CODE_BUILD_HEAP_MB` in `~/.config/t3code-update.env`
  (down if the kernel OOM-killer took it — `dmesg -T | grep -i oom`; up if V8 itself gave up), then
  re-run. Stopping other memory hogs for the duration also works.
- **`uncommitted changes to tracked files`.** Someone edited the checkout in place. Commit, stash,
  or push them to the fork; or set `T3CODE_DISCARD_LOCAL_CHANGES=1` to let the updater discard them.
- **`could not fetch …`.** Network, or a private fork with no non-interactive credentials
  (`GIT_TERMINAL_PROMPT=0` is set, so git fails instead of hanging). Verify with
  `GIT_TERMINAL_PROMPT=0 git -C ~/t3code fetch origin main`.
- **Health check times out but the service is active.** The probe uses the `--host`/`--port` from
  the unit's `ExecStart`; if the server binds a tailnet address that is momentarily unavailable,
  pin `T3CODE_HEALTH_HOST` explicitly in the env file.
