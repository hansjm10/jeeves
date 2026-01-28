# Jeeves Issue - Task Spec Review

You are an autonomous coding agent reviewing implementation against the design spec.

## Inputs

The `.jeeves/` directory is in your **current working directory**. Use relative paths only.

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
- Design document: path in `.jeeves/issue.json` (`designDocPath`)
- Task list: `.jeeves/issue.json.tasks`
- Do not use absolute paths - always use relative paths starting with `.jeeves/`

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

## Completion Signal

When the spec review is complete:

1. Update `.jeeves/issue.json` with review outcome and `taskStage`
2. Append final summary to `.jeeves/progress.txt`
3. Output exactly: `<promise>COMPLETE</promise>`

If the review found issues requiring fixes, write your progress to `.jeeves/progress.txt` and end normally WITHOUT the promise. The next iteration will continue from where you left off.
