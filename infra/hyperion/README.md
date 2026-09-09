# Published nightly updates on Hyperion

This systemd user timer checks GitHub every five minutes for the latest published nightly of
`NateWeav/t3code-hermes`. It builds the release source locally, including the server bundle and web
client, so it works on ARM Linux without a prebuilt release binary. Node 24, pnpm, git, curl, and
systemd user services must be installed and on the unit's PATH.

Do not use `t3 service install` for this setup: it installs the upstream npm package instead of
this fork. The updater follows published nightly tags, not `main` or the npm `latest` tag.

## Install or migrate

Back up the existing service units, checkout edits, and T3 home before migrating. Take a consistent
SQLite snapshot rather than copying a live database file. Commit or stash checkout edits (including
untracked files you want to keep); the updater refuses tracked edits by default. A legacy source
copy without `.git` is adopted in place, replacing files that collide with the release checkout.

Install these files from a checkout containing this updater. Keep them outside the deployment
checkout so switching release tags cannot remove the updater or its release resolver:

```bash
mkdir -p ~/.local/lib/t3code-update ~/.config/systemd/user/t3code.service.d
install -m 755 infra/hyperion/t3code-update.sh infra/hyperion/t3code-server.sh ~/.local/lib/t3code-update/
install -m 644 infra/hyperion/resolve-nightly.ts ~/.local/lib/t3code-update/
cp infra/hyperion/t3code-update.service infra/hyperion/t3code-update.timer ~/.config/systemd/user/
# For a new configuration; preserve and edit an existing file instead.
(umask 077; cp -n infra/hyperion/t3code-update.env.example ~/.config/t3code-update.env)
chmod 600 ~/.config/t3code-update.env
```

The default deployment checkout is `~/t3code`. Edit the configuration for another location, service,
or health target. Private repositories need git credentials and `GH_TOKEN` or `GITHUB_TOKEN` for
GitHub release discovery. The configuration uses plain `KEY=value` lines and absolute paths.

Change the existing server unit's ExecStart to use the launcher, preserving its existing arguments,
working directory, environment, and T3 home. For example, on Hyperion:

```ini
# ~/.config/systemd/user/t3code.service.d/nightly.conf
[Service]
ExecStart=
ExecStart=%h/.local/lib/t3code-update/t3code-server.sh start --host 100.119.85.48 --port 8790 --no-browser /home/ubuntu
Environment=T3HERMES_HOME=/home/ubuntu/.t3
Environment=PATH=%h/.local/share/pnpm:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
```

For a custom checkout, set `T3CODE_DIR` in both the server unit
and updater configuration. Keep `T3HERMES_HOME` outside the deployment checkout and set it in both
places if it differs from `~/.t3`. The launcher uses the bundle once its nightly marker exists and
falls back to source for rollback to an older installation.

```bash
systemctl --user daemon-reload
systemctl --user start t3code-update.service
journalctl --user -u t3code-update -n 200 --no-pager
node ~/t3code/apps/server/dist/bin.mjs --version
# A second run should succeed without restarting the server.
systemctl --user start t3code-update.service
systemctl --user enable --now t3code-update.timer
sudo loginctl enable-linger "$USER"
systemctl --user list-timers t3code-update.timer
```

The updater uses a 4096 MB V8 heap cap. Adjust `T3CODE_BUILD_HEAP_MB` for available memory; a build
stops the server to free RAM and interrupts active sessions. Release lookup and fetch happen before
stopping it. Installing updated updater files is a separate maintenance step; the timer updates the
application only.

## Deployment and recovery

An unchanged release with complete versioned artifacts does not restart the server. A new release
is checked out on the local `nightly-deploy` branch, dependencies are installed with the frozen
lockfile, and both bundles are built with the published version. The temporary server manifest
change is restored after the build. The service restarts and must pass service-state and HTTP health
checks.

On build or health failure, the updater resets to the previous commit, reinstalls dependencies,
restores the previous server and web artifacts, and restarts. The failed commit is recorded to avoid
repeated interruptions until another release is published. Logs report if recovery itself fails.
State is kept in `~/.local/state/t3code-update`, including `deployed-nightly`, `deployed-commit`,
`failed-commit`, artifact backups, and the run lock. T3 conversation data stays in the existing T3
home.

```bash
journalctl --user -u t3code-update -n 200 --no-pager
systemctl --user status t3code.service t3code-update.service
# Retry after correcting a build, dependency, or health-check problem:
~/.local/lib/t3code-update/t3code-update.sh --force --verbose
# Disable automatic updates:
systemctl --user disable --now t3code-update.timer
```

Dirty checkout failures require committing or stashing edits. Network failures require checking git
and GitHub API access. Memory failures require tuning the heap cap or available memory. Health
failures require checking the server journal and configured bind address; override
`T3CODE_HEALTH_HOST` and `T3CODE_HEALTH_PORT` if they cannot be inferred from ExecStart.
