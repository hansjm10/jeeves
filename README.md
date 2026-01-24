# Ralph

![Ralph](ralph.webp)

Ralph is an autonomous AI agent loop that runs **fresh Codex CLI sessions** repeatedly until the configured work is complete. Memory persists via git history plus the state files under `ralph/` (e.g. `ralph/progress.txt` and `ralph/prd.json` or `ralph/issue.json`).

Based on [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/).

[Read my in-depth article on how I use Ralph](https://x.com/ryancarson/status/2008548371712135632)

## Prerequisites

- One of the following agent runners installed and authenticated:
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [Claude CLI](https://claude.ai) (`claude`)
  - [Opencode CLI](https://opencode.ai) (`opencode`)
- `jq` installed (`brew install jq` on macOS)
- A git repository for your project
- (Issue mode, optional) `gh` authenticated for fetching issue context
- (Issue mode, optional) `SONAR_TOKEN` (env or `.env.sonarcloud`) for SonarCloud issue fetching

## Setup

### Option 1: Copy to your project

Copy the ralph files into your project:

```bash
# From your project root
mkdir -p scripts/ralph
cp /path/to/ralph/ralph.sh scripts/ralph/
cp /path/to/ralph/prompt.md scripts/ralph/
cp /path/to/ralph/prompt.issue.design.md scripts/ralph/
cp /path/to/ralph/prompt.issue.implement.md scripts/ralph/
cp /path/to/ralph/prompt.issue.review.md scripts/ralph/
cp /path/to/ralph/prompt.issue.coverage.md scripts/ralph/
cp /path/to/ralph/prompt.issue.coverage.fix.md scripts/ralph/
cp /path/to/ralph/prompt.issue.questions.md scripts/ralph/
cp /path/to/ralph/prompt.issue.sonar.md scripts/ralph/
chmod +x scripts/ralph/ralph.sh
```

## Workflow

Ralph supports two modes:

### PRD Mode (existing)

1. Create a PRD (markdown)
2. Convert PRD → `ralph/prd.json`
3. Run Ralph until all stories have `passes: true`

### Issue Mode (new)

1. Create `ralph/issue.json` (or generate it):
   - `./scripts/ralph/init-issue.sh --issue <number> [--design-doc <path>]` (accepts `docs/<file>.md` or just the filename)
   - Use `--force` to overwrite an existing `ralph/issue.json`
2. Run Ralph; it advances phases automatically based on `ralph/issue.json.status`:
   - Draft design doc (runs when `designDocPath` is missing or points to a non-existent file; uses `docs/design-document-template.md` and updates `designDocPath`)
   - Implement + open PR (until `implemented=true`, `prCreated=true`, and `prDescriptionReady=true`; PR body must include a change summary + `Fixes #<issueNumber>`)
   - Review loop (until `reviewClean=true`; requires multiple clean passes and fixes all `P0–P3` issues)
   - CI loop (until `ciClean=true`; verifies GitHub CI checks are green for the PR)
   - Coverage/test loop (until `coverageClean=true`; adds edge-case tests and improves coverage without changing production code; may trigger a fix loop when tests expose bugs)
   - Open questions loop (runs whenever `ralph/open-questions.md` exists and is non-empty)
   - Sonar loop (until `sonarClean=true`)

Optional helper:
- Create a GitHub issue from a design doc: `./scripts/ralph/create-issue-from-design-doc.sh --design-doc <path>`

### Run Ralph

```bash
./scripts/ralph/ralph.sh [max_iterations]
```

Default is 10 iterations.

Ralph will:
1. Select a mode based on `ralph/issue.json` (Issue) or `ralph/prd.json` (PRD)
2. Spawn a fresh agent session per iteration (Codex, Claude, or Opencode)
3. Persist memory via git + `ralph/progress.txt` + the config file
4. Repeat until the stop condition is reached

## Tests

Smoke tests validate that `ralph.sh` invokes `codex exec` with the expected flags (sandbox vs dangerous bypass) and that the landlock fallback retry works:

```bash
bash scripts/ralph/ralph.test.sh
```

## Key Files

| File | Purpose |
|------|---------|
| `ralph.sh` | The bash loop that spawns fresh Codex sessions |
| `prompt.md` | Instructions given to each PRD-mode agent |
| `prompt.issue.design.md` | Issue-mode: draft a design doc from the template |
| `prompt.issue.implement.md` | Issue-mode: implement + open PR |
| `prompt.issue.review.md` | Issue-mode: review loop |
| `prompt.issue.coverage.md` | Issue-mode: coverage + edge-case tests loop |
| `prompt.issue.coverage.fix.md` | Issue-mode: fix bugs exposed by tests (then re-run coverage loop) |
| `prompt.issue.questions.md` | Issue-mode: resolve open questions |
| `prompt.issue.sonar.md` | Issue-mode: Sonar loop |
| `init-issue.sh` | Helper to generate `ralph/issue.json` |
| `create-issue-from-design-doc.sh` | Helper to create a GitHub issue from a design doc |
| `sonarcloud-issues.sh` | Helper to fetch SonarCloud issues for a branch/PR |
| `ralph/prd.json` | PRD user stories with `passes` status (task list) |
| `ralph/issue.json` | Issue-mode config and completion status |
| `ralph/open-questions.md` | Issue-mode: questions that must be resolved before review can be marked clean |
| `ralph/coverage-failures.md` | Issue-mode: failing tests + bug notes that trigger the coverage-fix phase |
| `prd.json.example` | Example PRD format for reference |
| `issue.json.example` | Example Issue-mode format for reference |
| `ralph/progress.txt` | Append-only learnings for future iterations |
| `skills/prd/` | Skill for generating PRDs |
| `skills/ralph/` | Skill for converting PRDs to JSON |
| `flowchart/` | Interactive visualization of how Ralph works |

## Flowchart

[![Ralph Flowchart](ralph-flowchart.png)](https://snarktank.github.io/ralph/)

**[View Interactive Flowchart](https://snarktank.github.io/ralph/)** - Click through to see each step with animations.

The `flowchart/` directory contains the source code. To run locally:

```bash
cd flowchart
npm install
npm run dev
```

## Critical Concepts

### Each Iteration = Fresh Context

Each iteration spawns a **new agent session** with clean context. The only memory between iterations is:
- Git history (commits from previous iterations)
- `ralph/progress.txt` (learnings and context)
- `ralph/prd.json` or `ralph/issue.json` (what work remains)

### Small Tasks

Each PRD item should be small enough to complete in one context window. If a task is too big, the LLM runs out of context before finishing and produces poor code.

Right-sized stories:
- Add a database column and migration
- Add a UI component to an existing page
- Update a server action with new logic
- Add a filter dropdown to a list

Too big (split these):
- "Build the entire dashboard"
- "Add authentication"
- "Refactor the API"

### AGENTS.md Updates Are Critical

After each iteration, Ralph may update the relevant `AGENTS.md` files with learnings. This is key because agents (and future human developers) benefit from discovered patterns, gotchas, and conventions.

Examples of what to add to AGENTS.md:
- Patterns discovered ("this codebase uses X for Y")
- Gotchas ("do not forget to update Z when changing W")
- Useful context ("the settings panel is in component X")

### Feedback Loops

Ralph only works if there are feedback loops:
- Typecheck catches type errors
- Tests verify behavior
- CI must stay green (broken code compounds across iterations)

### Browser Verification for UI Stories

Frontend stories must include "Verify in browser using dev-browser skill" in acceptance criteria. Ralph will use the dev-browser skill to navigate to the page, interact with the UI, and confirm changes work.

### Stop Condition

When all stories have `passes: true`, Ralph outputs `<promise>COMPLETE</promise>` and the loop exits.

## Debugging

Check current state:

```bash
# See which stories are done
cat ralph/prd.json | jq '.userStories[] | {id, title, passes}'

# See Issue-mode status
cat ralph/issue.json | jq .

# See learnings from previous iterations
cat ralph/progress.txt

# Check git history
git log --oneline -10
```

## Customizing prompt.md

Edit `prompt.md` to customize Ralph's behavior for your project:
- Add project-specific quality check commands
- Include codebase conventions
- Add common gotchas for your stack

## Runner Configuration

### Command line options

- `--runner RUNNER` – Set runner to 'codex', 'claude', or 'opencode' (overrides RALPH_RUNNER)
- `--codex` – Use Codex runner (same as `--runner codex`)
- `--claude` – Use Claude runner (same as `--runner claude`)
- `--opencode` – Use Opencode runner (same as `--runner opencode`)
- `--max-iterations N` – Set maximum iterations (default: 10)
- `--help` – Show help message

### Environment variables

- `RALPH_RUNNER=codex|claude|opencode|auto` (default: auto)
- `RALPH_MODE=issue|prd|auto` (default: auto)
- `RALPH_WORK_DIR=path/to/workspace` (default: git root if available, else `pwd`)
- `RALPH_STATE_DIR=path/to/state` (default: `$RALPH_WORK_DIR/ralph`)
- `RALPH_OUTPUT_MODE=compact|stream` (default: `compact`; `compact` prints the prompt once per phase + the final agent response, and saves full runner output to `ralph/last-run.log`)
- `RALPH_PRINT_PROMPT=1` to print the prompt in `compact` mode (default: `1`; set `0` to hide it)
- `RALPH_LAST_RUN_LOG_FILE=path/to/log` (default: `$RALPH_STATE_DIR/last-run.log`)
- `RALPH_CODEX_APPROVAL_POLICY=untrusted|on-failure|on-request|never` (default: `never`)
- `RALPH_CODEX_SANDBOX=workspace-write|read-only|danger-full-access` (default: `danger-full-access`)
- `RALPH_CODEX_DANGEROUS=1` to pass `--dangerously-bypass-approvals-and-sandbox` to Codex (default: `1`; set `0` to use the sandbox instead)
- `RALPH_CLAUDE_SANDBOX=1` to set `IS_SANDBOX` environment variable for Claude (default: `1`; set `0` to disable)
- `RALPH_CLAUDE_DANGEROUS_SKIP_PERMISSIONS=1` to add `--dangerously-skip-permissions` flag (default: `1`; set `0` to omit)

If you see `error running landlock: Sandbox(LandlockRestrict)` on Linux (only possible when running with `RALPH_CODEX_DANGEROUS=0`), set `RALPH_CODEX_DANGEROUS=1`.

## Archiving

Ralph automatically archives previous runs when you start a new feature (different `branchName`). Archives are saved to `ralph/.archive/YYYY-MM-DD-feature-name/`.

## References

- [Geoffrey Huntley's Ralph article](https://ghuntley.com/ralph/)
- [Codex CLI](https://github.com/openai/codex)
