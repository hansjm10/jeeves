# Ralph Issue - Implement + PR Create

You are an autonomous coding agent working on a software project.

## Inputs

- Issue config: `ralph/issue.json`
- Progress log: `ralph/progress.txt`
- Design document: path in `ralph/issue.json` (`designDocPath`)

## Your Task

1. Read `ralph/issue.json` and `ralph/progress.txt`.
2. Check out the configured branch from `ralph/issue.json.branchName` (create from `main` if needed).
3. Read the design document and (optionally) `gh issue view` for the configured issue number.
4. If `ralph/issue.json.status.implemented` is not `true`:
   - Implement the issue according to the design doc.
   - Run quality checks (prefer `pnpm lint`, `pnpm typecheck`, `pnpm test` or targeted equivalents).
   - Commit changes with a Conventional Commit message that includes the issue number.
   - Set `ralph/issue.json.status.implemented=true`.
5. Ensure a PR exists and its description is compliant:
   - If `ralph/issue.json.status.prCreated` is not `true`:
     - Push the branch (e.g. `git push -u origin HEAD`).
     - Create a PR targeting `main`.
   - Ensure the PR body includes BOTH:
     - A short description of the changes (a few bullets or a short paragraph is fine).
     - A closing footer line: `Fixes #<issueNumber>` (use the issue number from `ralph/issue.json`).
   - If a PR already exists, update it with `gh pr edit` (do not create a duplicate PR).
   - Update `ralph/issue.json`:
     - Set `status.prCreated=true` and record `pullRequest.number` + `pullRequest.url` if available.
     - Set `status.prDescriptionReady=true` once the body meets the requirements.
6. Append a progress entry to `ralph/progress.txt` (what changed, checks run, PR created or not).
