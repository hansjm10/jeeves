# Jeeves Issue - Implement + PR Create

You are an autonomous coding agent working on a software project.

## Inputs

The `.jeeves/` directory is in your **current working directory**. Use relative paths only.

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
- Design document: path in `.jeeves/issue.json` (`designDocPath`)
- Do not use absolute paths - always use relative paths starting with `.jeeves/`

## Your Task

1. Read `.jeeves/issue.json` and `.jeeves/progress.txt`.
2. Check out the configured branch from `.jeeves/issue.json.branchName` (create from `main` if needed).
3. Read the design document and (optionally) `gh issue view` for the configured issue number.
4. If `.jeeves/issue.json.status.implemented` is not `true`:
   - Implement the issue according to the design doc.
   - Run quality checks (prefer `pnpm lint`, `pnpm typecheck`, `pnpm test` or targeted equivalents). Do **NOT** run `pnpm coverage:md` here (reserved for the coverage phase).
   - Commit changes with a Conventional Commit message that includes the issue number. Use `git commit --no-verify -m ...` (you already ran checks; repo hooks can add ~5–10 minutes).
   - Set `.jeeves/issue.json.status.implemented=true`.
5. Ensure a PR exists and its description is compliant:
   - If `.jeeves/issue.json.status.prCreated` is not `true`:
     - Push the branch (e.g. `git push -u origin HEAD`).
     - Create a PR targeting `main`.
   - Ensure the PR body includes BOTH:
     - A short description of the changes (a few bullets or a short paragraph is fine).
     - A closing footer line on its own line: `Fixes #<issueNumber>` (use the issue number from `.jeeves/issue.json`).
   - Avoid literal `\n` sequences in the PR body; use real newlines (use `gh pr edit --body-file <path>` if needed).
   - If a PR already exists, update it with `gh pr edit` (do not create a duplicate PR).
   - Update `.jeeves/issue.json`:
     - Set `status.prCreated=true` and record `pullRequest.number` + `pullRequest.url` if available.
     - Set `status.prDescriptionReady=true` once the body meets the requirements.
6. Append a progress entry to `.jeeves/progress.txt` (what changed, checks run, PR created or not).

## Completion Signal

When ALL tasks for this phase are complete (implementation done, checks pass, PR created/updated with proper description):

1. Ensure all changes are committed and pushed
2. Update `.jeeves/issue.json` with final status (`status.implemented=true`, `status.prCreated=true`, `status.prDescriptionReady=true`)
3. Append final summary to `.jeeves/progress.txt`
4. Output exactly: `<promise>COMPLETE</promise>`

If you cannot complete all tasks in this iteration (e.g., tests failing, need fixes, blocked), write your progress to `.jeeves/progress.txt` and end normally WITHOUT the promise. The next iteration will continue from where you left off.
