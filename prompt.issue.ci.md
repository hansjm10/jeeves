# Jeeves Issue - CI Check Loop (Lightweight)

You are an autonomous coding agent working on a software project.

## Inputs

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`

## Your Task

1. Read `.jeeves/issue.json` and `.jeeves/progress.txt`.
2. Ensure you are on the configured branch.
3. Confirm a PR exists (expect `.jeeves/issue.json.status.prCreated=true` and `pullRequest.*` present).
4. Increment `.jeeves/issue.json.status.ciPasses` by 1 at the start of this run.
5. Validate the PR description (this should be cheap and *not* a deep-dive):
   - PR body must include BOTH:
     - A short summary of changes (a few bullets or short paragraph; non-empty).
     - A closing footer line on its own line: `Fixes #<issueNumber>`.
   - If the description is missing/invalid, update it with `gh pr edit` (do **not** change code here just to satisfy a description check).
6. Check GitHub CI status for the PR:
   - Prefer `pullRequest.url` if present; otherwise use `issue.repo#pullRequest.number`.
   - Use `gh pr checks <pr> --watch --interval 15` to watch *all* checks (avoid extra JSON parsing/sorting).
   - For any **failed** check, run `gh run view <runId>` to see which step failed.
   - Classify the failure:
     - **Sonar failure**: The failure is in a step named `SonarCloud Scan`, `SonarQube`, or similar AND the error is about Sonar issues/quality gate conditions. Do **NOT** fix these here - they are handled in the Sonar phase.
     - **Build failure**: Any other failure (type-check, lint, build, test, etc.) even if the job is named "Quality Gate". These MUST be fixed in this phase.
   - IMPORTANT: A job named "Quality Gate" may contain many steps (lint, type-check, build, test, sonar). If it fails on a non-Sonar step (e.g., type-check), that is a **build failure** that must be fixed here.
7. Decide outcome:
   - If **any checks** are still running/pending: set `.jeeves/issue.json.status.ciClean=false` and stop (next iteration can re-check).
   - If **any build failures** exist (non-Sonar failures):
     - Investigate with `gh run view <runId>` and `gh run view <runId> --log-failed`.
     - Fix the root cause, run relevant local checks, commit + push.
     - Set `ciClean=false` and stop (CI must re-run).
   - If **all checks** succeeded OR the only failures are Sonar-specific (SonarCloud Scan step with quality gate issues):
     - Set `.jeeves/issue.json.status.ciClean=true` (Sonar issues are handled in the Sonar phase).
8. Append a progress entry to `.jeeves/progress.txt` summarizing what you checked (description + checks), what was failing (if anything), any PR description edits made, and the current `ciPasses` / `ciClean`.
