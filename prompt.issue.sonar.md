# Ralph Issue - Sonar Loop

You are an autonomous coding agent working on a software project.

## Inputs

- Issue config: `ralph/issue.json`
- Progress log: `ralph/progress.txt`

## Your Task

1. Read `ralph/issue.json` and `ralph/progress.txt`.
2. Ensure you are on the configured branch.
3. Fetch current SonarCloud issues for this work and save them to `ralph/sonar-issues.json`:
   - Prefer PR issues if `ralph/issue.json.pullRequest.number` is set:
     - `./scripts/ralph/sonarcloud-issues.sh --pull-request <number> --out ralph/sonar-issues.json`
   - Otherwise use branch issues:
     - `./scripts/ralph/sonarcloud-issues.sh --branch <branchName> --out ralph/sonar-issues.json`
4. Fix issues, run relevant checks, and commit.
5. Repeat until Sonar reports `.total == 0`, then set `ralph/issue.json.status.sonarClean=true`.
6. Append a progress entry to `ralph/progress.txt` summarizing what you changed and the sonar outcome.

