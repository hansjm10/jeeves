**Summary:** Add an interactive “Create Issue” workflow in the Viewer to draft (optionally via SDK), create GitHub issues, and immediately initialize/select the new issue’s Jeeves state/worktree (and optionally start a run).

## Problem

Jeeves assumes a GitHub Issue already exists (`owner/repo#N`) before a user can:
- initialize state (`POST /api/init/issue`)
- select an issue (`POST /api/issues/select`)
- run workflows against it (`POST /api/run`)

In practice, this means users must context-switch out of Jeeves to GitHub (or `gh`) to:
1) create the issue (title/body/labels/etc)
2) copy the issue number back into Jeeves
3) only then initialize a worktree + `.jeeves` state and start a run

This breaks flow, adds friction, and makes it harder to “capture” work quickly when the user’s starting point is an idea rather than an existing issue.

## Proposed solution (v1)

Add an **interactive “Create Issue” area** to the Viewer that:
1) collects GitHub issue fields (repo, title, body; optional labels/assignees)
2) creates the issue on GitHub
3) immediately initializes + selects the new issue state/worktree using the returned issue number
4) optionally starts the configured workflow run

This makes “idea → issue → worktree → run” a single, coherent workflow inside the Viewer.

## User experience / flow

### Viewer: Create Issue page (wizard-style)

Fields:
- Repo (`owner/repo`) with history/autocomplete (optional)
- Title (required)
- Body (Markdown, required; or required unless “Generate” fills it)
- Labels (optional)
- Assignees (optional)
- Milestone (optional; later if needed)

Actions:
- **Generate Draft** (optional, see “Draft generation”)
- **Preview** (renders GitHub-flavored Markdown locally)
- **Create Issue** (creates on GitHub)
- After success:
  - show Issue URL + number
  - **Initialize** (default on): calls existing init path and selects the issue
  - **Start run** (optional): immediately calls `POST /api/run`

### Expected happy path

1) User opens Viewer → “Create Issue”
2) User enters repo + title (+ body or Generate)
3) Clicks “Create Issue”
4) Viewer displays “Created: owner/repo#123” with link
5) Viewer auto-initializes local state/worktree, selects it, and optionally starts a run

## Backend/API changes (viewer-server)

### New endpoint: Create GitHub issue

Add a new mutating endpoint (local-only gating applies, same as other POST routes):
- `POST /api/github/issues/create`

Request body (v1):
```json
{
  "repo": "owner/repo",
  "title": "…",
  "body": "…",
  "labels": ["bug", "agent"],
  "assignees": ["octocat"],
  "init": {
    "branch": "issue/123",
    "workflow": "default",
    "phase": "design_draft",
    "force": false
  },
  "auto_select": true,
  "auto_run": {
    "provider": "openai",
    "workflow": "default",
    "max_iterations": 10
  }
}
```

Response body:
```json
{
  "issue_ref": "owner/repo#123",
  "issue_url": "https://github.com/owner/repo/issues/123",
  "created": true,
  "init_result": {
    "state_dir": "...",
    "work_dir": "...",
    "repo_dir": "...",
    "branch": "issue/123"
  },
  "run_started": false
}
```

Notes:
- `init`, `auto_select`, and `auto_run` are optional; v1 can support “create only” + “create+init”.
- Endpoint name explicitly includes `github` to avoid confusion with existing `/api/issues` which enumerates **local issue states**.

### Implementation detail: How to create the issue

Prefer a “don’t handle tokens ourselves” approach:
- **Option A (recommended):** spawn `gh issue create …` from viewer-server
  - Pros: uses existing local GitHub auth (`gh auth login`), avoids storing tokens, simpler scope
  - Cons: relies on `gh` availability in PATH
- **Option B:** use GitHub REST API via token (env var / config file)
  - Pros: no `gh` dependency
  - Cons: token handling/storage/logging risks; more code

Suggested v1: implement Option A with a clear error if `gh` isn’t installed/authenticated, plus a doc snippet on setup.

## Draft generation (optional, but high leverage)

Add an optional “Generate Draft” capability in the Viewer that uses the existing SDK runner to propose:
- title
- body (problem/solution/acceptance criteria)
- suggested labels

This should be **human-in-the-loop**:
- generation produces a draft only
- user edits/approves before “Create Issue”

Possible approaches:
- Add a small, dedicated prompt template (e.g. `prompts/issue.create.md`) used by the SDK runner to generate structured output (JSON or Markdown sections).
- Keep generation stateless: no worktree required, no `.jeeves` issue state required.

## State/data model changes

Minimum viable:
- No changes required to core state format; after creation we can call existing `initIssue()` with the returned issue number.

Nice-to-have:
- Store `issue_url` (and maybe created metadata) into the resulting `issue.json` so the Viewer can always link back to GitHub.

## Security considerations

- Reuse existing viewer-server security posture:
  - mutating endpoints local-only unless `--allow-remote-run` / `JEEVES_VIEWER_ALLOW_REMOTE_RUN=1`
  - Origin allowlist applies as usual
- If using `gh`:
  - never log command-line arguments that include issue body directly (body can contain secrets); use temp files or stdin
  - sanitize logs to avoid leaking tokens/credentials from stderr
- If using token-based REST:
  - never persist tokens into `issue.json` or logs
  - require an explicit env var (e.g. `JEEVES_GITHUB_TOKEN`) and document it

## Observability / UX

- Viewer should show:
  - auth status (e.g. “GitHub: authenticated via gh” or clear error state)
  - request progress and actionable error messages (missing auth, missing repo access, validation errors)
- After creation:
  - show URL
  - show initialized paths (optional advanced details)

## Acceptance criteria

- Viewer has a “Create Issue” area that can create an issue in a repo the user has access to.
- On success, Viewer can immediately initialize + select the new issue via existing init/select logic.
- Failures are handled with clear messages:
  - `gh` missing
  - `gh` not authenticated
  - repo not found / no permissions
  - validation errors (missing title/body)
- No GitHub credentials are stored in Jeeves state.
- Issue body/title are not accidentally leaked into `viewer-run.log`/`last-run.log` beyond what’s necessary.

## Implementation sketch

1) `apps/viewer-server/`:
   - add route `POST /api/github/issues/create`
   - implement a small wrapper that invokes `gh issue create` safely (stdin/tempfile)
   - parse output to extract issue URL/number (or request `--json` output if supported)
   - optionally call existing `initIssue()` and `RunManager.setIssue()`
2) `apps/viewer/`:
   - add “Create Issue” view + form state + validation
   - implement markdown preview
   - wire to the new endpoint and route to the created issue after init/select
3) Docs:
   - update `docs/viewer-server-api.md` with the new endpoint
   - add a short “GitHub auth” note (requires `gh auth login`)

## Open questions

- Should we support “create issue from template” by reading `.github/ISSUE_TEMPLATE/` from the repo?
- Should we support organizations/projects/milestones in v1, or defer?
- Should the workflow/phase defaults be configurable per repo?
- Do we want an “offline draft” mode that saves drafts locally without creating on GitHub?
