# Ralph Agent Instructions

## Overview

Ralph is an autonomous AI agent loop that runs **fresh agent runner sessions** repeatedly until the configured work is complete (Codex CLI, Claude CLI, or Opencode CLI). Each iteration is a fresh agent instance with clean context.

## Commands

```bash
# Run the flowchart dev server
cd flowchart && npm run dev

# Build the flowchart
cd flowchart && npm run build

# Run Ralph (from your project that has `ralph/prd.json` or `ralph/issue.json`)
./ralph.sh [--runner codex|claude|opencode] [--max-iterations N] [max_iterations]

# Start the real-time viewer dashboard
python3 viewer/server.py

# Start/stop Ralph from the dashboard (allows non-localhost clients)
python3 viewer/server.py --allow-remote-run
```

## Key Files

- `ralph.sh` - The bash loop that spawns fresh runner sessions (`--runner codex|claude|opencode`)
- `prompt.md` - PRD-mode instructions given to the agent runner
- `prompt.issue.*.md` - Issue-mode phase prompts (design/implement/review/coverage/sonar/etc.)
- `viewer/` - Real-time web dashboard for monitoring Ralph runs
- `prd.json.example` - Example PRD format
- `flowchart/` - Interactive React Flow diagram explaining how Ralph works

## Flowchart

The `flowchart/` directory contains an interactive visualization built with React Flow. It's designed for presentations - click through to reveal each step with animations.

To run locally:
```bash
cd flowchart
npm install
npm run dev
```

## Real-time Viewer

The `viewer/` directory contains a web dashboard for monitoring Ralph runs in real-time. It shows:
- Current phase and status indicators
- Live log output with color coding
- Progress tracking for PRD stories or issue phases
- Auto-refreshing updates via Server-Sent Events

To run locally:
```bash
# From your project directory
python3 viewer/server.py

# Then open http://localhost:8080 in your browser
```

Use the viewer while running Ralph to see what's happening without scrolling through terminal output.

## Patterns

- Each iteration spawns a fresh runner session with clean context
- Memory persists via git history plus state files like `progress.txt`, `prd.json`, and `issue.json`
- Viewer can edit prompt templates (`prompt*.md`) directly from the dashboard (Prompt Templates card)
- Viewer can run `init-issue.sh` from the dashboard to generate/update `ralph/issue.json` (Init Issue card)
- Codex needs `RALPH_CODEX_DANGEROUS=1` to access skills and tools like `gh` (viewer forces this for Codex runs)
- Viewer streams `ralph/last-run.log` (raw runner output); Codex emits `file update:` unified diffs + `exec` tool traces into this log (use the viewer’s Hide diffs toggle to reduce noise)
- Stories should be small enough to complete in one context window
- Always update AGENTS.md with discovered patterns for future iterations
