# Ralph Viewer - Real-time Dashboard

A beautiful, production-ready web dashboard for monitoring Ralph agent runs in real-time.

## Features

- **Real-time Log Streaming**: Logs update as they're written, with intelligent file watching
- **Phase Timeline**: Visual workflow progress showing all phases (Design > Implement > Review > Coverage > Sonar > Complete)
- **Iteration Tracking**: Shows current iteration (e.g., "2 of 10") in the header
- **Status Checks Grid**: Visual checklist showing implemented, PR created, review clean, coverage, sonar status
- **Log Filtering**: Search/filter logs in real-time with Ctrl+F
- **Completion Notifications**: Browser notifications + audio alert when workflow completes
- **Keyboard Shortcuts**: Ctrl+F to filter, Esc to clear, End to jump to bottom
- **Auto-scroll**: Smart auto-scroll that pauses when you scroll up
- **SSE Streaming**: Real-time updates via Server-Sent Events with automatic reconnection

## Quick Start

```bash
# From your project directory (must contain ralph/issue.json or ralph/prd.json)
python3 /path/to/ralph/viewer/server.py

# Custom port
python3 /path/to/ralph/viewer/server.py --port 9000

# Explicit state directory
python3 /path/to/ralph/viewer/server.py --state-dir /path/to/ralph
```

Then open: **http://localhost:8080**

## Usage

1. Start the viewer in one terminal
2. Run `./ralph.sh` in another terminal
3. Watch the dashboard update in real-time

The viewer will:
- Auto-detect your Ralph state directory
- Stream logs as they're written
- Update phase/status as issue.json changes
- Notify you when the workflow completes

## Dashboard Layout

### Header
- **Brand**: Ralph Viewer logo
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
Design → Implement → Review → Coverage → Sonar → Complete
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
- Check that Ralph is running and writing to `ralph/last-run.log`
- Verify the state directory path is correct
- Check browser console for connection errors

### Connection keeps dropping?
- SSE has automatic reconnection with exponential backoff
- Check for proxy/firewall issues
- Ensure the server is running

### Notifications not working?
- Allow notifications when prompted
- Click anywhere on the page to enable audio (browser autoplay policy)
