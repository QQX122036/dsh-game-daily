# dsh-game-daily · Game Daily

[简体中文](README.md) | **English**

A DSH desktop plugin that puts the daily automation of **Genshin Impact / Honkai Impact 3rd / Honkai: Star Rail** into one panel in Settings — switch games at the top, toggle a per-game daily-agent switch that is **off by default**, set a schedule per game, and once saved the plugin creates Windows Scheduled Tasks that run the daily routine unattended. When a run finishes you get a Windows notification and (optionally) a new session that reports the result.

## Install

**From source (recommended):** clone the repo to any local directory, then point Harness's `plugin_manager` at that directory (it performs the package install and bundle selection itself; do **not** hand-edit the profile's `package.json` / `cordis.patch.yml`):

```powershell
git clone https://github.com/gychen-NJU/dsh-game-daily.git
```

```
plugin_manager  action: install_bundle  target: <the cloned dsh-game-daily directory>
```

**Development** (link into a profile; code changes take effect after restarting the desktop app):

```powershell
dsh plugin --profile web add link:<this repo directory>
```

After installing: **Settings → Game Daily**. The package declares `dsh.bundle.patch` and `dsh.client`, so `dsh-game-daily` shows up in the profile's `dsh.profile.bundles`.

### Hand it to an agent (one sentence)

Send this to your DSH agent:

> Install https://github.com/gychen-NJU/dsh-game-daily into my DSH desktop app: clone it locally, run plugin_manager install_bundle against that directory, then confirm "Settings → Game Daily" shows up and run the dependency check — fix anything it reports as missing.

The agent will clone, install the bundle, verify activation, and use the built-in dependency check to fill in external requirements (BetterGI, computer-use, skills, ...).

## What the panel does

- **Game tabs**: Genshin Impact / Honkai Impact 3rd / Honkai: Star Rail / Zenless Zone Zero (paused, placeholder only).
- **Daily-agent switch (off by default)**: schedule and run settings appear only after you turn it on. Edits stay in a local draft; nothing is written and no task is (re)created until you press **Save & Apply**.
- **Schedule**: daily time, run days (every day / specific weekdays), timeout, mode (real run / dry-run diagnosis only), catch-up on missed runs, open a report session after each run, game path (Genshin can point at `BetterGI.exe`).
- **Dependency check**: dsh CLI, DSH version, headless runner (including the credentials patch), computer-use plugin, skill files, coordinate calibration, elevation helper, BetterGI, the bettergi-control skill, the bettergi-mcp script, and the bettergi MCP registration. Every missing item gets a **"Let DSH fix it"** button: one-click items (download bettergi-mcp, install bettergi-control, register the MCP row) run directly and the button turns into **Working…**; multi-step or privileged repairs open a new DSH session with the repair steps (including backup/read-back requirements) and switch the UI to it.
- **Run once / Stop / Disable all**: "Run once" uses the saved configuration; "Stop" kills that game's headless run; "Disable all" removes every scheduled task.
- **Recent runs**: reads `report.json` (status, mode, steps, evidence, conclusion) plus the tail of stdout.

## Execution pipeline

```
Settings panel ──POST /api/game-daily/apply──▶ state.json + automation/tasks.json
                                                  │
                                                  └─▶ automation/game-daily-register.ps1 (one UAC)
                                                         └─▶ Windows Scheduled Task game-daily-<game>
                                                                fires daily at HH:MM
                                                                │
                                                                ▼
                                                node automation/run-headless.mjs --game <id>
                                                                │  spawn
                                                                ▼
                                  dsh --profile headless --patch automation/headless-overlay.yml "<prompt>"
                                                                │
                                                                ▼
                             runs the skills (Genshin → bettergi-control; HI/SR → game-daily-*)
                                                                │
                                                                ▼
                             <stateDir>/runs/<game>/<runId>/{meta.json,report.json,stdout.log,screens/}
                                                                │  plugin reconciles every 60s
                                                                ▼
                                        record history → Windows toast → (optional) report session
```

- On the headless side, `--patch` layers an overlay that injects the bettergi MCP (needed by Genshin), and `DSH_PERMISSION_MODE=danger-full-access` makes the run unattended. HI/SR use the elevation helper (`scripts/run-step.mjs --ps`) when computer-use is unavailable.
- The report is the only source of truth: `report.json`'s `status` is `success / partial / failed`; the plugin never guesses from process exit codes.
- **Foreground guard**: each run starts a 1-second-poll guard process from `automation/keep-foreground.ps1`. If the game window loses foreground, it is pulled back immediately (four levels of fallback: `SetForegroundWindow` → `AttachThreadInput` → simulated Alt → `SwitchToThisWindow`). It exits when the run ends/stops via a `.stop` file; logs go to `<stateDir>/automation/guard-<game>.log`. There is a **Foreground guard** toggle in the schedule card (`ui.foregroundGuard`, on by default).
- **Process cleanup (real mode)**: when a run finishes, the plugin closes that game's process (for Genshin it also closes `BetterGI.exe`) to save background resources. Before a new run starts it closes any other game process (`Get-Process` + `Stop-Process -Force`); if the previous run is still active, the scheduled run waits for it to finish (up to 20 minutes by default, tunable via `DSH_GAME_DAILY_WAIT_MS`) instead of fighting over the game window. Dry mode never touches processes.

## HTTP API (host side, prefix `/api/game-daily`)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/state` | All game states + task summaries (scheduled-task info is cached and never blocks) |
| GET | `/probe?games=genshin,hi` | Dependency check results |
| POST | `/ui` | Save UI preferences (e.g. `lastGame`, `reportSessions`) |
| POST | `/apply` | Save schedules and rebuild scheduled tasks; `{dryRun:true}` only prints what would be registered |
| POST | `/disable` | Remove one game's (or all) scheduled tasks and turn the switch off |
| POST | `/run` | Run once now: `{game, mode:'real'|'dry'}` |
| POST | `/stop` | Stop that game's running process |
| POST | `/run-task` | Fire the registered scheduled task immediately (via Task Scheduler, not the plugin) |
| POST | `/install` | Create a repair session: `{check:'bettergi'}` or `{action:'fix-headless-credentials'}` |
| GET | `/runs?game=genshin` | Run history summaries |
| GET | `/run?id=<runId>` | Full report/meta/stdout of one run |
| POST | `/reconcile` | Trigger one reconciliation manually (normally every 60s) |

## Data location

- State and run artifacts: `$DSH_HOME/game-daily/` (default `%USERPROFILE%\.dsh\game-daily`)
  - `state.json` (atomic writes), `runs/<game>/<runId>/`, `automation/{tasks.json,game-daily-register.ps1,register-result.json,headless-overlay.yml,run-headless.log}`, `notifications.log`

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DSH_HOME` | `%USERPROFILE%\.dsh` | DSH home directory |
| `DSH_PROFILE` | `desktop` | Profile used to check headless / plugins |
| `DSH_SKILLS_ROOT` | `%USERPROFILE%\.agents\skills` | Skill directory (game-daily family) |
| `DSH_GAME_DAILY_DEV` | — | `1` = dev isolation: state dir gains `/dev`, task prefix `game-daily-dev-` |
| `DSH_GAME_DAILY_STATE_DIR` | `$DSH_HOME/game-daily` | Override the state directory |
| `DSH_GAME_DAILY_TASK_PREFIX` | `game-daily-` | Override the scheduled-task name prefix |
| `DSH_GAME_DAILY_BETTERGI_MCP` | auto-resolved (see below) | Explicit path to the bettergi MCP server script (highest priority) |
| `DSH_GAME_DAILY_BETTERGI` | `D:\software\BetterGI\BetterGI.exe` | BetterGI install path (used by the dependency check) |

## Where bettergi-mcp comes from

The Genshin `bgi_*` tools are served by a separate repository, [`gychen-NJU/bettergi-mcp`](https://github.com/gychen-NJU/bettergi-mcp) — a single-file, dependency-free MCP server. This plugin does **not** bundle it; resolution order:

1. the script pointed to by `DSH_GAME_DAILY_BETTERGI_MCP`;
2. the downloaded copy at `$DSH_HOME/game-daily/vendor/bettergi-mcp/bettergi-mcp.mjs`;
3. `dsh-betterGI/tools/bettergi-mcp/bettergi-mcp.mjs` next to this plugin (a developer machine layout).

When the dependency check finds nothing, the panel shows a **Download bettergi-mcp (from GitHub)** button that fetches the single file into (2). Enabling the Genshin schedule and pressing **Save & apply** also fills it in. Cloning it yourself works too:

```powershell
git clone https://github.com/gychen-NJU/bettergi-mcp
# then set DSH_GAME_DAILY_BETTERGI_MCP=<clone dir>\bettergi-mcp.mjs
```

After the script exists, **Register bettergi MCP** appends a `dsh-mcp-client` entry to the current profile's `cordis.patch.yml` (backed up as `cordis.patch.yml.bak-gd-<timestamp>`, read back and verified, and skipped when already present). Restart DSH to load it. Enabling the Genshin schedule and pressing **Save & apply** also downloads and registers it automatically.

## Where the bettergi-control skill comes from

Genshin's daily execution relies on a separate skill repository, [`gychen-NJU/bettergi-control`](https://github.com/gychen-NJU/bettergi-control) (`SKILL.md` + 15 `bgi-*.ps1` scripts, also pure PowerShell). The plugin does **not** bundle it either:

- when `%USERPROFILE%\.agents\skills\bettergi-control\SKILL.md` is missing (or has fewer than 10 scripts), the panel shows **Install bettergi-control from GitHub**;
- one click downloads the zip, extracts, verifies and atomically replaces the skill directory (the old one is backed up as `bettergi-control.bak-<timestamp>`), no session needed;
- you can also clone it manually:

```powershell
git clone https://github.com/gychen-NJU/bettergi-control "$env:USERPROFILE\.agents\skills\bettergi-control"
```

The skill directory can be overridden with `DSH_SKILLS_ROOT`.

## Dependencies and boundaries

- Genshin: BetterGI (default `D:\software\BetterGI`, editable in the panel) + the bettergi-control skill + bettergi-mcp (above). BetterGI has no HTTP API — it can only be driven by command line / script groups.
- HI / SR: the `game-daily` skill family + the elevation helper (switch to computer-use per the skill docs when synthetic clicks are filtered).
- There is **no background/AFK mode**: Genshin must be visible and in the foreground at 16:9 ≥ 1920×1080; a locked screen will fail.
- Registering scheduled tasks and running BetterGI require one UAC confirmation; the panel says so next to the button.
- Account risk depends on how you use it: the official terms list third-party software / simulated input as grounds for a ban. Use it discreetly.

## Development

```powershell
node test/smoke.mjs          # pure-Node smoke test (no network, no UAC)
node --check index.js        # syntax check
```

`lib/` is pure Node with no third-party dependencies; `client.js` is a Harness lazy client factory (`window.__ModuleLoader__.load`) that registers exactly one slot: `settings.section`.

## License

[MIT](LICENSE) © 2026 gychen-NJU
