# Jeeves Issue - Open Questions Loop

You are an autonomous coding agent working on a software project.

## Inputs

The `.jeeves/` directory is in your **current working directory**. Use relative paths only.

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
- Open questions: `.jeeves/open-questions.md`
- Do not use absolute paths - always use relative paths starting with `.jeeves/`

## Your Task

1. Read `.jeeves/issue.json`, `.jeeves/progress.txt`, and `.jeeves/open-questions.md`.
2. Ensure you are on the configured branch.
3. Answer each open question yourself using available evidence:
   - Inspect the design doc, the PR diff, and the current codebase.
   - Use targeted searches (`rg`, `git blame`, docs) to resolve uncertainty.
4. If any answers require code changes:
   - Implement the fixes, run relevant checks, and commit.
5. Update `.jeeves/open-questions.md`:
   - Overwrite it with only the remaining unanswered questions (if any).
   - If all questions are answered, delete the file.
6. Ensure the review loop will re-run after this:
   - Set `.jeeves/issue.json.status.reviewClean=false`
   - Reset `.jeeves/issue.json.status.reviewCleanPasses=0`
7. Append a progress entry to `.jeeves/progress.txt` summarizing the questions answered, any changes made, and checks run.

