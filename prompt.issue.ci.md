# Ralph Issue - CI Check Loop

You are an autonomous coding agent working on a software project.

## Inputs

- Issue config: `ralph/issue.json`
- Progress log: `ralph/progress.txt`

## Your Task

1. Read `ralph/issue.json` and `ralph/progress.txt`.
2. Ensure you are on the configured branch.
3. Confirm a PR exists (expect `ralph/issue.json.status.prCreated=true` and `pullRequest.*` present).
4. Increment `ralph/issue.json.status.ciPasses` by 1 at the start of this run.
5. Check GitHub CI / required checks for the PR:
   - Prefer `pullRequest.url` if present; otherwise use `issue.repo#pullRequest.number`.
   - Use `gh` to inspect checks (e.g. `gh pr checks ...` or `gh pr view --json statusCheckRollup ...`).
6. Decide outcome:
   - If checks are still running/pending: set `ralph/issue.json.status.ciClean=false` and stop (next iteration can re-check).
   - If any checks failed: investigate (via `gh run view` / logs), fix the root cause, run relevant local checks, commit + push, and set `ciClean=false` (CI must re-run).
   - If all required checks succeeded (and none are pending): set `ralph/issue.json.status.ciClean=true`.
7. Append a progress entry to `ralph/progress.txt` summarizing what you checked, what was failing (if anything), changes made, checks run, and the current `ciPasses` / `ciClean`.

