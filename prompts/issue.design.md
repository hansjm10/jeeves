# Jeeves Issue - Draft Design Doc

You are an autonomous coding agent working on a software project.

## Inputs

The `.jeeves/` directory is in your **current working directory**. Use relative paths only.

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
- Design doc template: `docs/design-document-template.md`
- Do not use absolute paths - always use relative paths starting with `.jeeves/`

## Your Task

1. Read `.jeeves/issue.json` and `.jeeves/progress.txt`.
2. Gather context for the issue:
   - Prefer `gh issue view` for the configured issue number (and `issue.repo` if present) to get the title, body, and relevant links.
   - If `gh` is unavailable, use whatever context is available in `.jeeves/issue.json` (including `notes`) and the codebase.
3. Determine the design doc output path:
   - If `.jeeves/issue.json.designDocPath` is set, use that path.
   - Otherwise, create a new doc under `docs/` named `issue-<issueNumber>-design.md` and set `.jeeves/issue.json.designDocPath` to that path.
4. Author the design document by following the structure in `docs/design-document-template.md`:
   - Keep the same section headings and overall structure.
   - Replace template guidance with project-specific details from the issue and codebase.
   - If a section is genuinely unknown, write `TBD` and capture the missing info in **Open Questions**.
5. Extract a task list from the **Work Breakdown & Delivery Plan** section:
   - Create/overwrite `.jeeves/issue.json.tasks` as an ordered list of tasks.
   - Each task should include:
     - `id` (short stable ID like `T1`, `T2`)
     - `title`
     - `summary`
     - `acceptanceCriteria` (array of strings)
     - `status` (set to `pending`)
6. Initialize task tracking in `.jeeves/issue.json.status` if tasks are present:
   - `taskStage`: `implement`
   - `currentTaskId`: the first task id
   - `tasksComplete`: `false`
7. Save the design doc at the chosen path, then update `.jeeves/issue.json` so `designDocPath` points to it (path relative to repo root).
8. Append a progress entry to `.jeeves/progress.txt` (design doc created/updated, tasks extracted, location, and any open questions).
