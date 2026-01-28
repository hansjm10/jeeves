---
title: Add GitHub Login for Repo and Issue Selection
sidebar_position: 5
---

# Add GitHub Login for Repo and Issue Selection

Use this document as the canonical design for implementing interactive GitHub repository and issue browsing in the Jeeves CLI.

## Document Control
- **Title**: Add GitHub Login for Repo and Issue Selection
- **Authors**: Jeeves Agent
- **Reviewers**: TBD
- **Status**: Draft
- **Last Updated**: 2026-01-28
- **Related Issues**: [#7](https://github.com/hansjm10/jeeves/pull/7), [#6](https://github.com/hansjm10/jeeves/issues/6)
- **Execution Mode**: AI-led

## 1. Summary

This design introduces interactive repository and issue selection to the Jeeves CLI, enabling users to browse their GitHub repositories and issues rather than requiring exact `owner/repo#123` input. The feature leverages the GitHub CLI (`gh`) for authentication and API access, providing a streamlined onboarding experience. PR #7 has completed the foundational authentication layer (T1); remaining tasks implement the interactive CLI flows.

## 2. Context & Problem Statement

- **Background**: Jeeves currently requires users to know the exact `owner/repo` and issue number when initializing a session via `jeeves init --repo owner/repo --issue 123`. This demands that users have pre-existing knowledge of repository paths and issue numbers.
- **Problem**: The manual specification requirement creates friction:
  - Users must look up repository paths in their browser
  - Issue numbers must be copied from GitHub
  - No discovery mechanism for repositories or issues
- **Forces**:
  - Must integrate with existing `gh` CLI authentication
  - Should not break existing non-interactive workflows
  - Must work in both rich terminal environments and basic TTYs

## 3. Goals & Non-Goals

### Goals
1. Enable interactive repository selection via `jeeves init --browse`
2. Enable interactive issue selection via `jeeves init --repo owner/repo --browse-issues`
3. Provide combined interactive flow via `jeeves init --interactive` or `jeeves init -i`
4. Verify GitHub authentication before browse operations (completed in T1)
5. Support filtering/searching repositories and issues
6. Remember recent selections for quick access

### Non-Goals
- Implementing OAuth flows (leverage existing `gh auth login`)
- Supporting non-GitHub platforms (GitLab, Bitbucket)
- Building a full TUI application (basic selection menus suffice)
- Real-time notifications or webhooks

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**: Jeeves users, Jeeves maintainers
- **Agent Roles**:
  - **Implementation Agent**: Builds CLI commands and selection logic
  - **Test Agent**: Writes and validates unit/integration tests
- **Affected Packages/Services**:
  - `jeeves/cli.py` - New CLI options and commands
  - `jeeves/repo.py` - Repository listing functions (partially complete)
  - `jeeves/issue.py` - Issue listing functions (partially complete)
  - `jeeves/__init__.py` - Exports
- **Compatibility Considerations**:
  - Existing `jeeves init --repo --issue` interface remains unchanged
  - New flags are additive; no breaking changes

## 5. Current State

### Implemented (PR #7 / T1 Complete)
- `check_gh_auth_for_browse()` - Verifies `gh` authentication status
- `AuthenticationError` - User-friendly error with actionable message
- `is_gh_authenticated()` - Boolean auth check
- `list_user_repos(limit)` - Lists repositories owned by user
- `list_contributed_repos(limit)` - Lists repositories user has contributed to
- `list_github_issues(owner, repo, state, limit)` - Lists issues from a repository
- `list_assigned_issues(owner, repo, limit)` - Lists issues assigned to current user
- Unit tests for authentication checking

### Not Yet Implemented
- CLI `--browse` flag for repository selection
- CLI `--browse-issues` flag for issue selection
- CLI `--interactive` / `-i` combined flow
- Interactive selection UI (numbered menus or fuzzy search)
- Recent selections caching
- Branch selection/creation in interactive flow

### Relevant Source Files
- `jeeves/cli.py` (lines 55-163) - `init` command
- `jeeves/repo.py` (lines 110-215) - Auth and repo listing
- `jeeves/issue.py` (lines 534-625) - Issue listing

## 6. Proposed Solution

### 6.1 Architecture Overview

The interactive flow adds three new CLI modes to `jeeves init`:

```
jeeves init --browse              # Select repo, then issue
jeeves init --repo X --browse-issues  # Select issue only
jeeves init -i                    # Full interactive walkthrough
```

All modes invoke the existing `gh` CLI for data retrieval and use simple numbered-choice selection for portability across terminal environments.

### 6.2 Detailed Design

#### 6.2.1 CLI Changes (`jeeves/cli.py`)

Add new options to `init` command:

```python
@click.option(
    "--browse",
    is_flag=True,
    help="Interactively browse and select repository.",
)
@click.option(
    "--browse-issues",
    is_flag=True,
    help="Interactively browse and select issue from repository.",
)
@click.option(
    "--interactive",
    "-i",
    "interactive_mode",
    is_flag=True,
    help="Full interactive setup: repo, issue, and branch selection.",
)
```

#### 6.2.2 Selection Module (`jeeves/browse.py` - new file)

Create a new module for interactive selection:

```python
def select_repository() -> tuple[str, str]:
    """Interactive repository selection.

    Returns:
        Tuple of (owner, repo_name).
    """

def select_issue(owner: str, repo: str) -> int:
    """Interactive issue selection.

    Returns:
        Issue number.
    """

def select_branch(owner: str, repo: str, issue_number: int) -> str:
    """Interactive branch selection/creation.

    Returns:
        Branch name.
    """

def prompt_choice(options: list[str], prompt: str) -> int:
    """Display numbered options and get user selection.

    Returns:
        0-based index of selection.
    """
```

#### 6.2.3 Recent Selections Cache

Store recent selections in `~/.local/share/jeeves/recent.json`:

```json
{
  "repos": [
    {"owner": "anthropics", "repo": "claude-code", "lastUsed": "2026-01-28T12:00:00Z"},
    {"owner": "hansjm10", "repo": "jeeves", "lastUsed": "2026-01-27T10:00:00Z"}
  ],
  "maxRecent": 10
}
```

### 6.3 Operational Considerations

- **Deployment**: No infrastructure changes; pure CLI enhancement
- **Telemetry & Observability**: None required for MVP
- **Security & Compliance**: Relies on `gh` authentication; no additional credentials stored

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| ID | Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|----|-------------|---------------|-------------------------|--------------|---------------------|
| T1 | Add auth check for browse operations | Implement `check_gh_auth_for_browse()` and `AuthenticationError` | Implementation Agent | None | Auth check works; helpful error on failure (COMPLETE) |
| T2 | Create browse module with selection utilities | New `jeeves/browse.py` with `prompt_choice`, `select_repository`, `select_issue` | Implementation Agent | T1 | Functions work in isolation; unit tests pass |
| T3 | Add `--browse` flag to init command | Integrate repo selection into CLI | Implementation Agent | T2 | `jeeves init --browse` completes full flow |
| T4 | Add `--browse-issues` flag to init command | Integrate issue selection into CLI | Implementation Agent | T2 | `jeeves init --repo X --browse-issues` works |
| T5 | Add `--interactive` / `-i` flag | Combined repo + issue + branch flow | Implementation Agent | T3, T4 | `jeeves init -i` walks through all selections |
| T6 | Implement recent selections cache | Store and prioritize recent repos/issues | Implementation Agent | T3 | Recent repos shown first; cache persists |
| T7 | Add integration tests for browse flows | End-to-end tests with mocked gh | Test Agent | T3, T4, T5 | CI passes; coverage meets threshold |

### 7.2 Milestones

- **Phase 1 (Complete)**: T1 - Authentication foundation
- **Phase 2 (Current)**: T2, T3, T4 - Core browse functionality
- **Phase 3**: T5, T6 - Enhanced UX with combined flow and caching
- **Phase 4**: T7 - Test coverage and stabilization

### 7.3 Coordination Notes

- **Hand-off Package**: This design doc, existing `repo.py` and `issue.py` implementations
- **Communication Cadence**: Update `progress.txt` after each task completion
- **Escalation Path**: Open questions in this doc; user feedback via GitHub issues

## 8. Agent Guidance & Guardrails

### 8.1 Context Packets
- Load `jeeves/cli.py`, `jeeves/repo.py`, `jeeves/issue.py` before implementation
- Review `click` library documentation for option handling
- Check `gh` CLI JSON output formats for repo/issue list commands

### 8.2 Prompting & Constraints
- Follow existing code style (type hints, docstrings, dataclasses)
- Use `click.echo()` for output, `click.prompt()` for input
- Commit messages: `feat(cli): add --browse flag for repo selection`

### 8.3 Safety Rails
- Do not modify `gh` authentication or store credentials
- Do not use `subprocess.run(..., shell=True)`
- Do not remove or break existing `--repo`/`--issue` flags

### 8.4 Validation Hooks
- Run `python -m pytest jeeves/` before marking task complete
- Verify `jeeves init --help` shows new options

## 9. Alternatives Considered

| Alternative | Pros | Cons | Decision |
|------------|------|------|----------|
| Use `rich` TUI library | Beautiful UI, advanced selection | Extra dependency, complexity | Rejected - keep minimal |
| Use `fzf` for fuzzy search | Powerful search | External dependency, not portable | Deferred - consider in future |
| GraphQL API directly | More control | Duplicates `gh` functionality | Rejected - leverage `gh` |

## 10. Testing & Validation Plan

- **Unit Tests**: Mock `subprocess.run` calls to `gh` commands; test selection logic
- **Integration Tests**: Use `monkeypatch` or fixtures to simulate interactive input
- **Manual QA**:
  - Test on macOS Terminal, Linux gnome-terminal, Windows Terminal
  - Test with unauthenticated `gh` (verify helpful error)
  - Test with no repos / no issues (verify graceful handling)

## 11. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `gh` CLI not installed | Medium | High | Clear error message with install link |
| Large repo lists slow to load | Low | Medium | Implement pagination, limit defaults |
| Interactive prompts fail in non-TTY | Low | Medium | Detect TTY; fall back to error with guidance |

## 12. Rollout Plan

- **Milestones**:
  - v0.2.0: T2, T3, T4 - Basic browse functionality
  - v0.3.0: T5, T6 - Full interactive flow with caching
- **Migration Strategy**: None required; additive feature
- **Communication**: Update README with new usage examples

## 13. Open Questions

1. Should `--browse` require `--repo` to be unset, or should it override?
2. What's the maximum number of repos/issues to display before pagination?
3. Should branch selection be included in MVP or deferred?
4. Consider adding `--filter` or `--label` options for issue browsing?

## 14. Follow-Up Work

- Add `textual` TUI for enhanced experience (separate issue)
- Implement repo/issue search/filter flags
- Add `jeeves recent` command to show/clear recent selections
- Consider `jeeves browse` as standalone command

## 15. References

- [GitHub CLI Documentation](https://cli.github.com/manual/)
- [Click Library Docs](https://click.palletsprojects.com/)
- [Issue #6 - Original Feature Request](https://github.com/hansjm10/jeeves/issues/6)
- [PR #7 - T1 Implementation](https://github.com/hansjm10/jeeves/pull/7)
- `jeeves/repo.py` - Repository functions
- `jeeves/issue.py` - Issue functions
- `jeeves/cli.py` - CLI entry points

## Appendix A — Glossary

| Term | Definition |
|------|------------|
| `gh` | GitHub CLI tool for interacting with GitHub from the command line |
| TTY | Terminal/teletype - a terminal device for interactive input/output |
| TUI | Text User Interface - rich terminal-based UI |

## Appendix B — Change Log

| Date       | Author       | Change Summary |
|------------|--------------|----------------|
| 2026-01-28 | Jeeves Agent | Initial draft |
