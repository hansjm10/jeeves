# Ralph Issue - Open Questions Loop

You are an autonomous coding agent working on a software project.

## Inputs

- Issue config: `ralph/issue.json`
- Progress log: `ralph/progress.txt`
- Open questions: `ralph/open-questions.md`

## Your Task

1. Read `ralph/issue.json`, `ralph/progress.txt`, and `ralph/open-questions.md`.
2. Ensure you are on the configured branch.
3. Answer each open question yourself using available evidence:
   - Inspect the design doc, the PR diff, and the current codebase.
   - Use targeted searches (`rg`, `git blame`, docs) to resolve uncertainty.
4. If any answers require code changes:
   - Implement the fixes, run relevant checks, and commit.
5. Update `ralph/open-questions.md`:
   - Overwrite it with only the remaining unanswered questions (if any).
   - If all questions are answered, delete the file.
6. Ensure the review loop will re-run after this:
   - Set `ralph/issue.json.status.reviewClean=false`
   - Reset `ralph/issue.json.status.reviewCleanPasses=0`
7. Append a progress entry to `ralph/progress.txt` summarizing the questions answered, any changes made, and checks run.

