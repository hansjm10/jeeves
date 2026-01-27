# Jeeves

Jeeves is an autonomous AI agent loop that runs **fresh agent sessions** repeatedly until the configured work is complete. Memory persists via git history plus the state files under `jeeves/` (e.g. `jeeves/progress.txt` and `jeeves/issue.json`).

Inspired by [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/).

## Prerequisites

- One of the following agent runners installed and authenticated:
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [Claude CLI](https://claude.ai) (`claude`)
  - [Opencode CLI](https://opencode.ai) (`opencode`)
- `jq` installed (`brew install jq` on macOS)
- A git repository for your project
- (Optional) `gh` authenticated for fetching issue context
- (Optional) `SONAR_TOKEN` (env or `.env.sonarcloud`) for SonarCloud issue fetching

## Setup

### Option 1: Copy to your project

Copy the jeeves files into your project:

```bash
# From your project root
mkdir -p scripts/jeeves
mkdir -p docs
cp /path/to/jeeves/jeeves.sh scripts/jeeves/
cp /path/to/jeeves/prompt.issue.design.md scripts/jeeves/
cp /path/to/jeeves/prompt.issue.implement.md scripts/jeeves/
cp /path/to/jeeves/prompt.issue.review.md scripts/jeeves/
cp /path/to/jeeves/prompt.issue.coverage.md scripts/jeeves/
cp /path/to/jeeves/prompt.issue.coverage.fix.md scripts/jeeves/
cp /path/to/jeeves/prompt.issue.ci.md scripts/jeeves/
cp /path/to/jeeves/prompt.issue.questions.md scripts/jeeves/
cp /path/to/jeeves/prompt.issue.sonar.md scripts/jeeves/
cp /path/to/jeeves/docs/design-document-template.md docs/
chmod +x scripts/jeeves/jeeves.sh
```

## Workflow

1. Create `jeeves/issue.json` (or generate it):
   - `./scripts/jeeves/init-issue.sh --issue <number> [--design-doc <path>]` (accepts `docs/<file>.md` or just the filename)
   - Use `--force` to overwrite an existing `jeeves/issue.json`
2. Run Jeeves; it advances phases automatically based on `jeeves/issue.json.status`:
   - Draft design doc (runs when `designDocPath` is missing or points to a non-existent file; uses `docs/design-document-template.md` and updates `designDocPath`)
   - Task loop (if `jeeves/issue.json.tasks` is present and not complete):
     - Task implement (TDD) → task spec review → task quality review
   - Implement + open PR (until `implemented=true`, `prCreated=true`, and `prDescriptionReady=true`; PR body must include a change summary + `Fixes #<issueNumber>`)
   - Review loop (until `reviewClean=true`; requires multiple clean passes and fixes all `P0–P3` issues)
   - Coverage/test loop (until `coverageClean=true`; adds edge-case tests and improves coverage without changing production code; may trigger a fix loop when tests expose bugs)
   - Sonar loop (until `sonarClean=true`)
   - CI loop (until `ciClean=true`; verifies GitHub CI checks are green for the PR)
   - Open questions loop (runs whenever `jeeves/open-questions.md` exists and is non-empty)

Optional helper:
- Create a GitHub issue from a design doc: `./scripts/jeeves/create-issue-from-design-doc.sh --design-doc <path>`

### Run Jeeves

```bash
./scripts/jeeves/jeeves.sh [max_iterations]
```

Default is 10 iterations.

Jeeves will:
1. Read the config from `jeeves/issue.json`
2. Spawn a fresh agent session per iteration (Codex, Claude, or Opencode)
3. Persist memory via git + `jeeves/progress.txt` + the config file
4. Repeat until the stop condition is reached

## Tests

Smoke tests validate that `jeeves.sh` invokes `codex exec` with the expected flags (sandbox vs dangerous bypass) and that the landlock fallback retry works:

```bash
bash scripts/jeeves/jeeves.test.sh
```

## Key Files

| File | Purpose |
|------|---------|
| `jeeves.sh` | The bash loop that spawns fresh agent sessions |
| `prompt.issue.design.md` | Draft a design doc from the template |
| `prompt.issue.implement.md` | Implement + open PR |
| `prompt.issue.review.md` | Review loop |
| `prompt.issue.task.implement.md` | Per-task implementation (TDD) |
| `prompt.issue.task.spec-review.md` | Per-task spec compliance review |
| `prompt.issue.task.quality-review.md` | Per-task code quality review |
| `prompt.issue.coverage.md` | Coverage + edge-case tests loop |
| `prompt.issue.coverage.fix.md` | Fix bugs exposed by tests (then re-run coverage loop) |
| `prompt.issue.ci.md` | CI loop |
| `prompt.issue.questions.md` | Resolve open questions |
| `prompt.issue.sonar.md` | Sonar loop |
| `init-issue.sh` | Helper to generate `jeeves/issue.json` |
| `create-issue-from-design-doc.sh` | Helper to create a GitHub issue from a design doc |
| `sonarcloud-issues.sh` | Helper to fetch SonarCloud issues for a branch/PR |
| `jeeves/issue.json` | Config and completion status |
| `jeeves/open-questions.md` | Questions that must be resolved before review can be marked clean |
| `jeeves/coverage-failures.md` | Failing tests + bug notes that trigger the coverage-fix phase |
| `issue.json.example` | Example format for reference |
| `jeeves/progress.txt` | Append-only learnings for future iterations |
| `flowchart/` | Interactive visualization of how Jeeves works |

## Critical Concepts

### Each Iteration = Fresh Context

Each iteration spawns a **new agent session** with clean context. The only memory between iterations is:
- Git history (commits from previous iterations)
- `jeeves/progress.txt` (learnings and context)
- `jeeves/issue.json` (what work remains)

### AGENTS.md Updates Are Critical

After each iteration, Jeeves may update the relevant `AGENTS.md` files with learnings. This is key because agents (and future human developers) benefit from discovered patterns, gotchas, and conventions.

Examples of what to add to AGENTS.md:
- Patterns discovered ("this codebase uses X for Y")
- Gotchas ("do not forget to update Z when changing W")
- Useful context ("the settings panel is in component X")

### Feedback Loops

Jeeves only works if there are feedback loops:
- Typecheck catches type errors
- Tests verify behavior
- CI must stay green (broken code compounds across iterations)

### Browser Verification for UI Stories

Frontend stories must include "Verify in browser using dev-browser skill" in acceptance criteria. Jeeves will use the dev-browser skill to navigate to the page, interact with the UI, and confirm changes work.

### Stop Condition

When all phases are complete, Jeeves outputs `<promise>COMPLETE</promise>` and the loop exits.

## Debugging

Check current state:

```bash
# See Issue status
cat jeeves/issue.json | jq .

# See learnings from previous iterations
cat jeeves/progress.txt

# Check git history
git log --oneline -10
```

## Runner Configuration

### Command line options

- `--runner RUNNER` – Set runner to 'codex', 'claude', or 'opencode' (overrides JEEVES_RUNNER)
- `--codex` – Use Codex runner (same as `--runner codex`)
- `--claude` – Use Claude runner (same as `--runner claude`)
- `--opencode` – Use Opencode runner (same as `--runner opencode`)
- `--max-iterations N` – Set maximum iterations (default: 10)
- `--metrics` – Enable JSONL metrics (default: on)
- `--no-metrics` – Disable JSONL metrics
- `--metrics-file PATH` – Override metrics output path (default: `$JEEVES_STATE_DIR/metrics.jsonl`)
- `--help` – Show help message

### Environment variables

- `JEEVES_RUNNER=codex|claude|opencode|auto` (default: auto)
- `JEEVES_WORK_DIR=path/to/workspace` (default: git root if available, else `pwd`)
- `JEEVES_STATE_DIR=path/to/state` (default: `$JEEVES_WORK_DIR/jeeves`)
- `JEEVES_OUTPUT_MODE=compact|stream` (default: `compact`; `compact` prints the prompt once per phase + the final agent response, and saves full runner output to `jeeves/last-run.log`)
- `JEEVES_PRINT_PROMPT=1` to print the prompt in `compact` mode (default: `1`; set `0` to hide it)
- `JEEVES_LAST_RUN_LOG_FILE=path/to/log` (default: `$JEEVES_STATE_DIR/last-run.log`)
- `JEEVES_RUNS_DIR=path/to/.runs` (default: `$JEEVES_STATE_DIR/.runs`)
- `JEEVES_METRICS=1` to write JSONL metrics (default: `1`; set `0` to disable)
- `JEEVES_METRICS_FILE=path/to/metrics.jsonl` (default: `$JEEVES_STATE_DIR/metrics.jsonl`)
- `JEEVES_DEBUG=1` to write per-phase debug JSONL (default: `1`; set `0` to disable)
- `JEEVES_DEBUG_TRACE=full|summary` (default: `full`; `summary` skips per-line log events)
- `JEEVES_CODEX_APPROVAL_POLICY=untrusted|on-failure|on-request|never` (default: `never`)
- `JEEVES_CODEX_SANDBOX=workspace-write|read-only|danger-full-access` (default: `danger-full-access`)
- `JEEVES_CODEX_DANGEROUS=1` to pass `--dangerously-bypass-approvals-and-sandbox` to Codex (default: `1`; set `0` to use the sandbox instead)
- `JEEVES_CLAUDE_SANDBOX=1` to set `IS_SANDBOX` environment variable for Claude (default: `1`; set `0` to disable)
- `JEEVES_CLAUDE_DANGEROUS_SKIP_PERMISSIONS=1` to add `--dangerously-skip-permissions` flag (default: `1`; set `0` to omit)

If you see `error running landlock: Sandbox(LandlockRestrict)` on Linux (only possible when running with `JEEVES_CODEX_DANGEROUS=0`), set `JEEVES_CODEX_DANGEROUS=1`.

## Archiving

Jeeves automatically archives previous runs when you start a new feature (different `branchName`). Archives are saved to `jeeves/.archive/YYYY-MM-DD-feature-name/`.

## Metrics

Each `jeeves.sh` invocation creates a unique run folder under `jeeves/.runs/<runId>/`, with per-run metrics + per-iteration runner logs for analysis. Jeeves also appends all events to `jeeves/metrics.jsonl` (or `$JEEVES_METRICS_FILE`) so you can aggregate across runs.

Key files:
- Latest run pointer: `jeeves/current-run.json`
- Per-run metrics: `jeeves/.runs/<runId>/metrics.jsonl`
- Per-iteration runner logs: `jeeves/.runs/<runId>/iterations/iter-<n>.last-run.log`

## Debug JSONL (AI Parsing)

Jeeves writes AI-friendly debug logs per phase for each run:

- Per-phase debug logs: `jeeves/.runs/<runId>/debug-<phase>.jsonl`
- Run index: `jeeves/.runs/<runId>/run-index.json`
- Schemas: `docs/jeeves-debug-schema.json`, `docs/jeeves-run-index-schema.json`

Set `JEEVES_DEBUG_TRACE=summary` to skip per-line log events and reduce file size.

Examples:

```bash
# Show the slowest iterations (latest run)
RUN_METRICS="$(jq -r '.metricsFile' jeeves/current-run.json)"
jq -r 'select(.event=="iteration_end") | [.iteration, .phase, .duration_s, .runner.execCount] | @tsv' "$RUN_METRICS" | sort -k3 -nr | head

# Average duration by phase
jq -s '[.[] | select(.event=="iteration_end")] | group_by(.phase) | map({phase:.[0].phase, iterations:length, avg_s:(map(.duration_s)|add/length)})' jeeves/metrics.jsonl
```

## References

- [Geoffrey Huntley's Ralph article](https://ghuntley.com/ralph/)
- [Codex CLI](https://github.com/openai/codex)
