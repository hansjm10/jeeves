# Jeeves Viewer - Real-time Dashboard

A beautiful, production-ready web dashboard for monitoring Jeeves agent runs in real-time.

## Features

- **Real-time Log Streaming**: Logs update as they're written, with intelligent file watching
- **Phase Timeline**: Visual workflow progress showing all phases (Design > Task Implement > Task Spec Review > Task Quality Review > Implement > Review > CI > Coverage > Sonar > Complete)
- **Iteration Tracking**: Shows current iteration (e.g., "2 of 10") in the header
- **Status Checks Grid**: Visual checklist showing implemented, PR created, review clean, coverage, sonar status
- **Manual Overrides**: Click status checks to toggle (localhost-only by default; use `--allow-remote-run` to enable remotely)
- **Prompt Template Editor**: Edit `prompt*.md` files used by `jeeves.sh` directly from the dashboard
- **Issue Init**: Run `init-issue.sh` from the dashboard to generate/update `jeeves/issue.json`
- **Log Filtering**: Search/filter logs in real-time with Ctrl+F
- **Diff Toggle**: Hide/show Codex `file update` diff blocks to reduce log noise
- **Completion Notifications**: Browser notifications + audio alert when workflow completes
- **Keyboard Shortcuts**: Ctrl+F to filter, Esc to clear, End to jump to bottom
- **Auto-scroll**: Smart auto-scroll that pauses when you scroll up
- **SSE Streaming**: Real-time updates via Server-Sent Events with automatic reconnection

## Quick Start

```bash
# From your project directory
python3 /path/to/jeeves/viewer/server.py

# Custom port
python3 /path/to/jeeves/viewer/server.py --port 9000

# Explicit state directory
python3 /path/to/jeeves/viewer/server.py --state-dir /path/to/jeeves
```

Then open: **http://localhost:8080**

## Usage

1. Start the viewer in one terminal
2. Either:
   - Run `./jeeves.sh` in another terminal, or
   - Use the **Controls** card in the dashboard to start/stop Jeeves
   - If you don't have `jeeves/issue.json` yet, use the **Init Issue** card (runs `init-issue.sh`)
3. Watch the dashboard update in real-time

The viewer will:
- Auto-detect your Jeeves state directory
- Stream logs as they're written
- Update phase/status as issue.json changes
- Notify you when the workflow completes

## Dashboard Layout

### Header
- **Brand**: Jeeves Viewer logo
- **Iteration Badge**: Shows "2 of 10" style iteration counter
- **Connection Status**: Green pulsing dot when connected
- **Status Badge**: Running (green), Complete (blue), or Idle (gray)

### Sidebar (Left)
- **Workflow Progress**: Phase timeline showing current position
- **Details**: Mode, Issue #, PR #, Branch, Design Doc
- **Status Checks**: Visual grid of completion states

### Log Panel (Right)
- **Search Bar**: Filter logs in real-time
- **Auto-scroll Toggle**: Pause/resume auto-scroll
- **Clear Button**: Clear all logs
- **Color-coded Output**:
  - Red: Errors
  - Yellow: Warnings
  - Blue: Info messages
  - Purple: Iteration headers
  - Green: Success messages
  - Gray: Debug messages

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+F` | Focus search/filter input |
| `Esc` | Clear filter and unfocus |
| `End` | Jump to bottom of logs |

## Phase Flow

```
Design → Implement → Questions → Review → CI → Coverage → Sonar → Complete
   ↳ coverage-fix ↲
```

Each phase shows:
- Gray dot: Pending
- Blue pulsing dot: Active
- Green checkmark: Complete

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard HTML |
| `GET /api/state` | Current state as JSON |
| `GET /api/stream` | SSE stream for real-time updates |
| `GET /api/logs` | All logs as JSON |
| `GET /api/run` | Current run status (pid, started_at, etc.) |
| `GET /api/run/logs` | Viewer-runner log tail (stdout/stderr of `jeeves.sh`) |
| `POST /api/run` | Start `jeeves.sh` (localhost-only by default) |
| `POST /api/run/stop` | Stop the running `jeeves.sh` process |
| `POST /api/issue/status` | Update `jeeves/issue.json.status` (localhost-only by default) |
| `POST /api/git/update-main` | Checkout + fast-forward a branch (defaults to `main`) (localhost-only by default) |
| `GET /api/prompts` | List editable prompt templates (`prompt*.md`) |
| `GET /api/prompts/<name>` | Read a prompt template |
| `POST /api/prompts/<name>` | Save a prompt template (localhost-only by default) |
| `POST /api/init/issue` | Run `init-issue.sh` to write `jeeves/issue.json` (localhost-only by default) |

### Run Control Security

For safety, endpoints that modify local state (run control, status overrides, git operations, prompt editing, init) are **localhost-only** by default (so you can still view remotely, but only trigger changes from the same machine).

To allow start/stop from non-localhost clients, launch the server with:

```bash
python3 /path/to/jeeves/viewer/server.py --allow-remote-run
```

You can also enable this via environment variable (useful for Docker):

```bash
export JEEVES_VIEWER_ALLOW_REMOTE_RUN=1
python3 /path/to/jeeves/viewer/server.py
```

### SSE Events

| Event | Description |
|-------|-------------|
| `state` | Full state update |
| `logs` | New log lines (incremental) |
| `heartbeat` | Keep-alive ping |

## Requirements

- Python 3.6+
- No external dependencies (stdlib only)
- Modern browser with SSE support

## Troubleshooting

### No logs appearing?
- Check that Jeeves is running and writing to `jeeves/last-run.log`
- Verify the state directory path is correct
- Check browser console for connection errors

### Connection keeps dropping?
- SSE has automatic reconnection with exponential backoff
- Check for proxy/firewall issues
- Ensure the server is running

### Notifications not working?
- Allow notifications when prompted
- Click anywhere on the page to enable audio (browser autoplay policy)

### Codex can't run `gh` / can't read skills?
- Ensure Codex is running in dangerous mode (no sandbox). `jeeves.sh` defaults to this, and the viewer forces it for Codex runs via `JEEVES_CODEX_DANGEROUS=1`.
