# Ralph Issue - Review Loop

You are an autonomous coding agent working on a software project.

## Inputs

- Issue config: `ralph/issue.json`
- Progress log: `ralph/progress.txt`

## Your Task

1. Read `ralph/issue.json` and `ralph/progress.txt`.
2. Ensure you are on the configured branch.
3. Confirm a PR exists (expect `ralph/issue.json.status.prCreated=true` and `pullRequest.*` present).
4. Increment `ralph/issue.json.status.reviewPasses` by 1 at the start of this run.
5. Run the `pr-review` skill against the PR from `ralph/issue.json`:
   - Prefer `pullRequest.url` if present; otherwise use `issue.repo#pullRequest.number`.
   - Use `/pr-review ...` so the orchestrated workflow runs.
6. Save the rendered Markdown review output (not the plain-text summary) to `ralph/review.md` (overwrite each run).
7. If you have any open questions that prevent concluding:
   - Write them to `ralph/open-questions.md` (overwrite; delete if none).
   - Set `ralph/issue.json.status.reviewClean=false` and `reviewCleanPasses=0`.
8. Determine “clean” from the `pr-review` output:
   - Clean = merge recommendation is `APPROVE`, blockers are `None`, and you have no open questions.
9. If not clean:
   - Apply fixes you agree with, run relevant checks, and commit.
   - Re-run `/pr-review ...` in this same session and overwrite `ralph/review.md`.
10. Update `ralph/issue.json.status`:
   - If you made any code changes in this run: set `reviewCleanPasses=0` first.
   - If clean: increment `reviewCleanPasses` by 1; otherwise set `reviewCleanPasses=0`.
   - Set `reviewClean=true` only when `reviewCleanPasses >= 3` (otherwise set `reviewClean=false`).
11. Append a progress entry to `ralph/progress.txt` summarizing changes (if any), checks run, and the current `reviewPasses` / `reviewCleanPasses` / `reviewClean`.
