# Ralph Agent Instructions

## Overview

Ralph is an autonomous AI agent loop that runs fresh agent sessions (Codex, Claude, or Opencode) repeatedly until the configured work is complete. Each iteration is a fresh agent instance with clean context.

## Commands

```bash
# Run the flowchart dev server
cd flowchart && npm run dev

# Build the flowchart
cd flowchart && npm run build

# Run Ralph (from your project that has `ralph/prd.json` or `ralph/issue.json`)
./ralph.sh [max_iterations]

# Start the real-time viewer dashboard
python3 viewer/server.py
```

## Key Files

- `ralph.sh` - The bash loop that spawns fresh agent sessions
- `viewer/` - Real-time web dashboard for monitoring Ralph runs
- `prompt.md` - Instructions given to each PRD-mode agent instance
- `prompt.issue.design.md` - Issue-mode: draft a design doc from the template when missing
- `prompt.issue.implement.md` - Issue-mode: implement + open PR
- `prompt.issue.review.md` - Issue-mode: review loop
- `prompt.issue.coverage.md` - Issue-mode: coverage + edge-case tests loop
- `prompt.issue.coverage.fix.md` - Issue-mode: fix bugs exposed by tests, then re-run coverage loop
- `prompt.issue.questions.md` - Issue-mode: resolve open questions
- `prompt.issue.sonar.md` - Issue-mode: Sonar loop
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

- Each iteration spawns a fresh agent instance with clean context
- Memory persists via git history plus the state files under `ralph/`
- Stories should be small enough to complete in one context window
- Always update AGENTS.md with discovered patterns for future iterations
