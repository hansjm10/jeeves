# Jeeves Issue - Sonar Loop

You are an autonomous coding agent working on a software project.

## Inputs

- Issue config: `jeeves/issue.json`
- Progress log: `jeeves/progress.txt`

## Your Task

1. Read `jeeves/issue.json` and `jeeves/progress.txt`.
2. Ensure you are on the configured branch.
3. Fetch current SonarCloud issues for this work and save them to `jeeves/sonar-issues.json`:
   - Prefer PR issues if `jeeves/issue.json.pullRequest.number` is set:
     - `./scripts/jeeves/sonarcloud-issues.sh --pull-request <number> --out jeeves/sonar-issues.json`
   - Otherwise use branch issues:
     - `./scripts/jeeves/sonarcloud-issues.sh --branch <branchName> --out jeeves/sonar-issues.json`
4. Fix issues, run relevant checks, and commit. Use `git commit --no-verify` (hooks are redundant and slow when checks were run explicitly).
5. Repeat until Sonar reports `.total == 0`, then set `jeeves/issue.json.status.sonarClean=true`.
6. Append a progress entry to `jeeves/progress.txt` summarizing what you changed and the sonar outcome.
