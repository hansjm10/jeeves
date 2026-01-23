# Ralph Issue - Draft Design Doc

You are an autonomous coding agent working on a software project.

## Inputs

- Issue config: `ralph/issue.json`
- Progress log: `ralph/progress.txt`
- Design doc template: `docs/design-document-template.md`

## Your Task

1. Read `ralph/issue.json` and `ralph/progress.txt`.
2. Gather context for the issue:
   - Prefer `gh issue view` for the configured issue number (and `issue.repo` if present) to get the title, body, and relevant links.
   - If `gh` is unavailable, use whatever context is available in `ralph/issue.json` (including `notes`) and the codebase.
3. Determine the design doc output path:
   - If `ralph/issue.json.designDocPath` is set, use that path.
   - Otherwise, create a new doc under `docs/` named `issue-<issueNumber>-design.md` and set `ralph/issue.json.designDocPath` to that path.
4. Author the design document by following the structure in `docs/design-document-template.md`:
   - Keep the same section headings and overall structure.
   - Replace template guidance with project-specific details from the issue and codebase.
   - If a section is genuinely unknown, write `TBD` and capture the missing info in **Open Questions**.
5. Save the design doc at the chosen path, then update `ralph/issue.json` so `designDocPath` points to it (path relative to repo root).
6. Append a progress entry to `ralph/progress.txt` (design doc created/updated, location, and any open questions).

