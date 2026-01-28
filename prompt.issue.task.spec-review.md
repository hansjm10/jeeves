# Jeeves Issue - Task Spec Review

You are an autonomous coding agent reviewing implementation against the design spec.

## Inputs

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
- Design document: path in `.jeeves/issue.json` (`designDocPath`)
- Task list: `.jeeves/issue.json.tasks`

## Your Task

1. Read `.jeeves/issue.json` and `.jeeves/progress.txt`.
2. Identify the current task via `status.currentTaskId`.
3. Review the code changes for spec compliance for **only** this task:
   - Compare implementation to the task’s acceptance criteria and design doc.
4. Write findings to `.jeeves/task-spec-review.md` (overwrite each run).
5. If issues are found:
   - Write them to `.jeeves/task-issues.md` (overwrite).
   - Set `status.taskStage=implement` and keep `currentTaskId` unchanged.
6. If clean:
   - Delete `.jeeves/task-issues.md` if it exists.
   - Set `status.taskStage=quality-review`.
7. Append a progress entry to `.jeeves/progress.txt` with the task id and review outcome.
