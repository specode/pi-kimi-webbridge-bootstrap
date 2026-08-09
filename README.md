# pi-kimi-webbridge-bootstrap

[中文](./README.zh-CN.md)

A thin Pi-side bootstrap proxy that installs and keeps the official Kimi WebBridge daemon and Pi skill aligned without requiring Kimi Code. It is not a browser-control implementation of its own.

The package does not vendor Moonshot AI's proprietary skill or runtime. It downloads release metadata, binaries, and skills directly from `https://cdn.kimi.com/webbridge`.

## What it does

- Installs the platform-specific WebBridge CLI into `~/.kimi-webbridge/bin/` when missing.
- Verifies new CLI binaries against the SHA-256 published in the official `latest/version.json`.
- Repairs an existing CLI that can no longer report status or start, restoring the previous binary if activation fails.
- Starts the local daemon when it is down.
- Checks for updates every six hours when Pi starts, reloads, or opens a new session.
- Uses the official CLI's `upgrade` command for existing runtimes, preserving its version matching, rollback, and daemon restart behavior.
- Downloads the skill matching the active daemon version into Pi's cache and exposes it through `resources_discover`.
- Keeps the previous skill active until the new archive has passed path, entry-type, expanded-size, and frontmatter/version validation, then atomically switches a pointer to the staged release.
- Guides the user to install the browser extension when the first bootstrap cannot detect a connection.

The periodic check is session-triggered. This package does not install a cron job or launch agent. When a cached skill exists, the check runs in the background so an unavailable CDN or slow upgrade does not delay Pi resource discovery. If that check changes the skill, Pi reloads its resources after the update completes. If a concurrent first-time bootstrap still owns the shared lock after the initial wait, this session warns immediately and retries in the background for up to five minutes before reloading the newly available skill.

## Requirements

- Pi with package and `resources_discover` support (tested against Pi `0.84.1`).
- Node.js 20 or newer.
- macOS or Linux on arm64/x64. Windows metadata is recognized, but skill extraction currently requires a compatible `tar` command and has not been validated by this project.
- The [Kimi WebBridge browser extension](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc) for actual browser control.

## Install

From npm:

```bash
pi install npm:@specode/pi-kimi-webbridge-bootstrap
```

From GitHub:

```bash
pi install git:github.com/specode/pi-kimi-webbridge-bootstrap
```

For local development:

```bash
pi install /absolute/path/to/pi-kimi-webbridge-bootstrap
```

Run `/reload` after the first installation. The first session may take longer because it downloads the CLI and skill.

Do not pin the Git source to a tag or commit if you want `pi update --extensions` to update this bootstrap package itself.

### Browser extension

The CLI and skill can be installed automatically, but Chrome and Edge require the user to approve browser-extension installation.

1. Install [Kimi WebBridge from the Chrome Web Store](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc).
2. Make sure the extension is enabled.
3. Run `/webbridge-status` in Pi and confirm that `Browser extension` reports `connected`.

The first bootstrap displays this link automatically when no extension connection is detected. Run `/webbridge-setup` to show the guidance again at any time.

## Commands

- `/webbridge-status` — show daemon, browser extension, skill cache, and last updater error.
- `/webbridge-setup` — show browser-extension installation guidance or confirm that it is connected.
- `/webbridge-update` — force a release check and refresh the Pi skill, then reload Pi resources.

## Configuration

- `PI_WEBBRIDGE_AUTO_UPDATE=0` disables automatic setup and periodic checks. Manual commands remain available.
- `PI_WEBBRIDGE_UPDATE_INTERVAL_HOURS=<number>` changes the default six-hour interval.

A failed check becomes eligible for retry after 15 minutes on a later Pi session event. A process-owned cross-process lock at `~/.kimi-webbridge/pi-bootstrap-update.lock` prevents Pi sessions using different agent directories from updating the shared runtime at the same time and only reclaims stale locks whose owner process is no longer alive.

## Update boundaries

The WebBridge daemon is global to the user account. The official `kimi-webbridge upgrade` command may refresh WebBridge skills already installed in other supported agent runtimes, and it briefly restarts the daemon. Automatic checks run at session start before Pi begins a browser task, but another application using the daemon can still observe that restart.

The active Pi skill is selected by an atomic cache pointer:

```text
~/.pi/agent/cache/pi-kimi-webbridge-bootstrap/skills/active.json
~/.pi/agent/cache/pi-kimi-webbridge-bootstrap/skills/current -> releases/<version>-<archive-sha256>/
~/.pi/agent/cache/pi-kimi-webbridge-bootstrap/skills/releases/<version>-<archive-sha256>/
```

On macOS and Linux, Pi discovers the stable `skills/current` path, whose link target is replaced atomically after validation. On Windows, where an existing directory junction cannot be atomically replaced, `active.json` atomically selects an immutable release and Pi reloads that release path after an update. Older validated releases are retained as rollback-safe cache entries. A legacy `skills/kimi-webbridge/` directory remains a valid fallback during migration.

If `PI_CODING_AGENT_DIR` is configured, Pi's resolved agent directory is used instead.

## Development

```bash
npm test
npm run check
```

## License

MIT
