# Jeeves Issue - Review Loop

You are an autonomous coding agent working on a software project.

## Inputs

The `.jeeves/` directory is in your **current working directory**. Use relative paths only.

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
- Do not use absolute paths - always use relative paths starting with `.jeeves/`

## Your Task

1. Read `.jeeves/issue.json` and `.jeeves/progress.txt`.
2. Ensure you are on the configured branch.
3. Confirm a PR exists (expect `.jeeves/issue.json.status.prCreated=true` and `pullRequest.*` present).
4. Increment `.jeeves/issue.json.status.reviewPasses` by 1 at the start of this run.
5. Run the `pr-review` skill against the PR from `.jeeves/issue.json`:
   - Prefer `pullRequest.url` if present; otherwise use `issue.repo#pullRequest.number`.
   - Use `/pr-review ...` so the orchestrated workflow runs.
6. Save the rendered Markdown review output (not the plain-text summary) to `.jeeves/review.md` (overwrite each run).
7. If you have any open questions that prevent concluding:
   - Write them to `.jeeves/open-questions.md` (overwrite; delete if none).
   - Set `.jeeves/issue.json.status.reviewClean=false` and `reviewCleanPasses=0`.
8. Determine “clean” from the `pr-review` output:
   - Clean = merge recommendation is `APPROVE`, blockers are `None`, and you have no open questions.
9. If not clean:
   - Apply fixes you agree with, run relevant checks, and commit.
   - Re-run `/pr-review ...` in this same session and overwrite `.jeeves/review.md`.
10. Update `.jeeves/issue.json.status`:
   - If you made any code changes in this run: set `reviewCleanPasses=0` first.
   - If clean: increment `reviewCleanPasses` by 1; otherwise set `reviewCleanPasses=0`.
   - Set `reviewClean=true` only when `reviewCleanPasses >= $JEEVES_CONFIG_REVIEW_CLEAN_PASSES_REQUIRED` (default: 3, check `.jeeves/issue.json.config.reviewCleanPassesRequired`).
11. Append a progress entry to `.jeeves/progress.txt` summarizing changes (if any), checks run, and the current `reviewPasses` / `reviewCleanPasses` / `reviewClean`.

## Completion Signal

When the review phase is complete (`reviewClean=true` with required passes):

1. Ensure all changes are committed and pushed
2. Update `.jeeves/issue.json` with final status (`status.reviewClean=true`)
3. Append final summary to `.jeeves/progress.txt`
4. Output exactly: `<promise>COMPLETE</promise>`

If the review is not yet clean or you need more passes, write your progress to `.jeeves/progress.txt` and end normally WITHOUT the promise. The next iteration will continue from where you left off.
