# Jeeves Agent Instructions

## Overview

Jeeves is an autonomous AI agent loop that runs **fresh agent runner sessions** repeatedly until the configured work is complete (Codex CLI, Claude CLI, or Opencode CLI). Each iteration is a fresh agent instance with clean context.

## Commands

```bash
# Run the flowchart dev server
cd flowchart && npm run dev

# Build the flowchart
cd flowchart && npm run build

# Run Jeeves (from your project that has `jeeves/issue.json`)
./jeeves.sh [--runner codex|claude|opencode] [--max-iterations N] [max_iterations]

# Start the real-time viewer dashboard
python3 viewer/server.py

# Start/stop Jeeves from the dashboard (allows non-localhost clients)
python3 viewer/server.py --allow-remote-run
```

## Key Files

- `jeeves.sh` - The bash loop that spawns fresh runner sessions (`--runner codex|claude|opencode`)
- `prompt.issue.*.md` - Issue-mode phase prompts (design/implement/review/coverage/sonar/etc.)
- `viewer/` - Real-time web dashboard for monitoring Jeeves runs
- `flowchart/` - Interactive React Flow diagram explaining how Jeeves works

## Flowchart

The `flowchart/` directory contains an interactive visualization built with React Flow. It's designed for presentations - click through to reveal each step with animations.

To run locally:
```bash
cd flowchart
npm install
npm run dev
```

## Real-time Viewer

The `viewer/` directory contains a web dashboard for monitoring Jeeves runs in real-time. It shows:
- Current phase and status indicators
- Live log output with color coding
- Progress tracking for issue phases
- Auto-refreshing updates via Server-Sent Events

To run locally:
```bash
# From your project directory
python3 viewer/server.py

# Then open http://localhost:8080 in your browser
```

Use the viewer while running Jeeves to see what's happening without scrolling through terminal output.

## Patterns

- Each iteration spawns a fresh runner session with clean context
- Memory persists via git history plus state files like `progress.txt` and `issue.json`
- Viewer can edit prompt templates (`prompt*.md`) directly from the dashboard (Prompt Templates card)
- Viewer can run `init-issue.sh` from the dashboard to generate/update `jeeves/issue.json` (Init Issue card)
- Codex needs `JEEVES_CODEX_DANGEROUS=1` to access skills and tools like `gh` (viewer forces this for Codex runs)
- Viewer streams `jeeves/last-run.log` (raw runner output); Codex emits `file update:` unified diffs + `exec` tool traces into this log (use the viewer's Hide diffs toggle to reduce noise)
- Jeeves writes JSONL metrics to `jeeves/metrics.jsonl` and also per-run under `jeeves/.runs/<runId>/metrics.jsonl` (latest run pointer: `jeeves/current-run.json`; disable with `JEEVES_METRICS=0`)
- Jeeves writes AI-parsable debug logs per phase to `jeeves/.runs/<runId>/debug-<phase>.jsonl` with a run index at `jeeves/.runs/<runId>/run-index.json` (disable with `JEEVES_DEBUG=0`, set `JEEVES_DEBUG_TRACE=summary` to skip per-line events)
- Debug event schema: `docs/jeeves-debug-schema.json` (schema version `jeeves.debug.v1`)
- Run index schema: `docs/jeeves-run-index-schema.json`
- Stream output is written to `jeeves/last-run.log` without storing multi-MB runner output in memory (completion checks read `last-message.txt` / `last-run.log`)
- Metrics `iteration_end.phase` records the phase that actually ran (captured at iteration start), not the next phase after status refresh
- Issue phase order runs Sonar before CI (CI comes after Sonar)
- For issue CI polling, prefer `gh pr checks --watch --interval 15` to avoid burning iterations on pending checks (use `--required` only if you intentionally want required checks)
- Keep `pnpm coverage:md` in the coverage phase (avoid running it during implement/review)
- Prefer `git commit --no-verify` in automation after running explicit checks (repo hooks can add ~5–10 minutes per commit)
- `docs/design-document-template.md` is synced from `/work/Idle-Game-Engine/docs/design-document-template.md`
- Always update AGENTS.md with discovered patterns for future iterations
