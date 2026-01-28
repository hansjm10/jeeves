---
title: Fix .jeeves path resolution
sidebar_position: 5
---

# Fix .jeeves Path Resolution - Agent Occasionally Looks in Made-up Locations

## Document Control
- **Title**: Fix .jeeves path resolution - prevent agent from hallucinating absolute paths
- **Authors**: Jeeves Agent
- **Reviewers**: hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-28
- **Related Issues**: [#14](https://github.com/hansjm10/jeeves/issues/14)
- **Execution Mode**: AI-led

## 1. Summary

The Jeeves agent occasionally attempts to read `.jeeves/issue.json` and `.jeeves/progress.txt` from hallucinated absolute paths (e.g., `/Users/ksawant/code/anthropic/claude-code/.jeeves/`) instead of the actual working directory. This is caused by prompts using relative paths without explicit working directory context, allowing Claude to "guess" paths based on training data patterns. The fix involves updating all prompts (`CLAUDE.md` and `prompt.issue.*.md`) to explicitly state that `.jeeves/` is always relative to the current working directory and potentially injecting the actual path at runtime.

## 2. Context & Problem Statement

- **Background**: Jeeves is an autonomous coding agent that manages issue state via files in a `.jeeves/` directory. The CLI sets `cwd=worktree_path` and creates a symlink `{worktree}/.jeeves` → `{state_dir}`. Prompts reference `.jeeves/issue.json` and `.jeeves/progress.txt` as relative paths.

- **Problem**: The agent occasionally attempts to read from incorrect absolute paths like `/Users/ksawant/code/anthropic/claude-code/.jeeves/issue.json` - a path that doesn't exist and appears to be hallucinated from Claude's training data. When this bug occurs:
  - The agent fails to execute the intended task
  - Agent turns are wasted trying incorrect paths
  - Errors are reported about missing files

- **Forces**:
  - Claude may pattern-match to common paths from training data
  - The current working directory is set correctly by the CLI/SDK but not explicitly communicated in prompts
  - Environment variables (`JEEVES_STATE_DIR`, `JEEVES_WORK_DIR`) are set but not referenced in prompts

## 3. Goals & Non-Goals

### Goals
1. Eliminate path hallucination by making prompts explicit about `.jeeves/` location
2. Ensure all prompt files consistently communicate that `.jeeves/` is relative to cwd
3. Optionally provide runtime-injected absolute path context as a fallback
4. Maintain backward compatibility - no changes to CLI or SDK required

### Non-Goals
- Changing the underlying symlink architecture
- Modifying the CLI or SDK runner implementation
- Adding new environment variables
- Changing how worktrees are created or managed

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**: Jeeves users, maintainers

- **Agent Roles**:
  - Implementation Agent: Updates all prompt files and CLAUDE.md

- **Affected Packages/Services**:
  - `CLAUDE.md` - Main agent instructions
  - `prompt.issue.ci.md`
  - `prompt.issue.coverage.fix.md`
  - `prompt.issue.coverage.md`
  - `prompt.issue.design.md`
  - `prompt.issue.implement.md`
  - `prompt.issue.questions.md`
  - `prompt.issue.review.md`
  - `prompt.issue.sonar.md`
  - `prompt.issue.task.implement.md`
  - `prompt.issue.task.quality-review.md`
  - `prompt.issue.task.spec-review.md`

- **Compatibility Considerations**: Pure prompt changes - no API or behavioral changes

## 5. Current State

### Current Architecture
1. **CLI** (`jeeves/cli.py`): Sets `cwd=worktree_path`, `JEEVES_STATE_DIR`, `JEEVES_WORK_DIR` env vars
2. **SDK Runner** (`jeeves/runner/sdk_runner.py`): Passes `cwd=str(self.config.work_dir)` to `ClaudeAgentOptions`
3. **Worktree** (`jeeves/worktree.py`): Creates a symlink `{worktree}/.jeeves` → `{state_dir}` (function: `_create_state_symlink`)
4. **Prompts**: Reference `.jeeves/issue.json` and `.jeeves/progress.txt` as relative paths without explicit cwd context

### Current Prompt Pattern (problematic)
```markdown
## Inputs
- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
```

This pattern doesn't explicitly tell the agent that these paths are relative to the current working directory.

## 6. Proposed Solution

### 6.1 Architecture Overview

Add explicit path guidance to all prompts to prevent hallucination. No changes to the underlying CLI or SDK - this is purely a prompt engineering fix.

### 6.2 Detailed Design

#### 6.2.1 Add Path Guidance Section to CLAUDE.md

Add a new section near the top of `CLAUDE.md` after the "Your Task" section:

```markdown
## File Paths

The `.jeeves/` directory is **always** in your current working directory.

**IMPORTANT:**
- Use relative paths: `.jeeves/issue.json`, `.jeeves/progress.txt`
- NEVER guess or construct absolute paths like `/Users/.../.jeeves/`
- If a Read fails, verify you're using the relative path `.jeeves/...`
```

#### 6.2.2 Update All prompt.issue.*.md Files

Update the "Inputs" section in each prompt file to be explicit:

**Before:**
```markdown
## Inputs

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
```

**After:**
```markdown
## Inputs

The `.jeeves/` directory is in your **current working directory**. Use relative paths only.

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
- Do not use absolute paths - always use relative paths starting with `.jeeves/`
```

#### 6.2.3 Files to Update

| File | Change Required |
|------|-----------------|
| `CLAUDE.md` | Add "File Paths" section with explicit guidance |
| `prompt.issue.ci.md` | Update Inputs section |
| `prompt.issue.coverage.fix.md` | Update Inputs section |
| `prompt.issue.coverage.md` | Update Inputs section |
| `prompt.issue.design.md` | Update Inputs section |
| `prompt.issue.implement.md` | Update Inputs section |
| `prompt.issue.questions.md` | Update Inputs section |
| `prompt.issue.review.md` | Update Inputs section |
| `prompt.issue.sonar.md` | Update Inputs section |
| `prompt.issue.task.implement.md` | Update Inputs section |
| `prompt.issue.task.quality-review.md` | Update Inputs section |
| `prompt.issue.task.spec-review.md` | Update Inputs section |

### 6.3 Operational Considerations

- **Deployment**: Prompt changes take effect immediately on next agent run
- **Telemetry & Observability**: Monitor for continued path resolution errors in agent logs
- **Security & Compliance**: No impact - prompts are text files with no secrets

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| T1: Add path guidance to CLAUDE.md | Add explicit `.jeeves/` path guidance section | Implementation Agent | None | CLAUDE.md contains clear path guidance; no absolute paths mentioned |
| T2: Update prompt.issue.design.md | Update Inputs section with path guidance | Implementation Agent | T1 | Inputs section explicitly states relative paths only |
| T3: Update prompt.issue.implement.md | Update Inputs section with path guidance | Implementation Agent | T1 | Inputs section explicitly states relative paths only |
| T4: Update remaining prompt files | Update all other prompt.issue.*.md files | Implementation Agent | T1 | All 9 remaining prompt files updated with consistent guidance |
| T5: Verify and test | Manually verify all changes are consistent | Implementation Agent | T1-T4 | All files updated; grep confirms no hallucinated paths in prompts |

### 7.2 Milestones

- **Phase 1**: Update CLAUDE.md and all prompt files (Tasks T1-T4)
- **Phase 2**: Verify consistency and test (Task T5)

### 7.3 Coordination Notes

- **Hand-off Package**: List of 12 files to update (1 CLAUDE.md + 11 prompt files)
- **Communication Cadence**: Single PR with all changes

## 8. Agent Guidance & Guardrails

- **Context Packets**:
  - Read current `CLAUDE.md` and all `prompt.issue.*.md` files before editing
  - Understand the symlink architecture from `jeeves/worktree.py`

- **Prompting & Constraints**:
  - Use consistent wording across all files
  - Keep guidance concise - don't over-explain
  - Preserve existing file structure and formatting

- **Safety Rails**:
  - Do not modify any Python files
  - Do not change CLI or SDK behavior
  - Do not remove any existing content from prompts

- **Validation Hooks**:
  - `grep -r "\.jeeves/" *.md` to verify all references are relative
  - Manual review of changes for consistency

## 9. Alternatives Considered

### Alternative 1: Runtime Path Injection
Inject the actual working directory path into the system prompt at runtime.

**Rejected because:**
- Requires code changes to the SDK runner
- More complex to maintain
- Prompt-only fix is simpler and sufficient

### Alternative 2: Use Environment Variables in Prompts
Reference `$JEEVES_STATE_DIR` in prompts instead of `.jeeves/`.

**Rejected because:**
- Less intuitive for prompt authors
- Adds complexity to prompts
- The symlink already provides a clean relative path

### Alternative 3: Add a Pre-read Validation Step
Have the agent verify the working directory before reading files.

**Rejected because:**
- Adds complexity and extra turns
- Doesn't address the root cause (prompt ambiguity)
- Band-aid rather than fix

## 10. Testing & Validation Plan

- **Unit / Integration**: No automated tests needed - these are prompt files
- **Manual Testing**:
  1. Run Jeeves on a test issue
  2. Verify agent correctly reads `.jeeves/issue.json` using relative path
  3. Verify no path hallucination in agent logs
- **Validation Criteria**:
  - Zero instances of hallucinated absolute paths in next 10 agent runs

## 11. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Prompt changes don't fully prevent hallucination | Low | Medium | Monitor agent behavior; add stronger wording if needed |
| Inconsistent wording across files | Low | Low | Use copy-paste for consistency; review before commit |
| Accidental removal of existing content | Low | High | Careful editing; git diff review |

## 12. Rollout Plan

- **Milestones**: Single PR, immediate merge after review
- **Migration Strategy**: N/A - no data migration needed
- **Communication**: PR description documents the change; no user-facing announcements needed

## 13. Open Questions

1. ~~Should we also add the actual cwd path to runtime prompts?~~ Deferred - try prompt-only fix first
2. Should we add a similar note to `AGENTS.md`? (TBD - review during implementation)

## 14. Follow-Up Work

- Monitor agent behavior after deployment
- If hallucination persists, consider runtime path injection as Phase 2
- Consider adding path validation to agent output parsing

## 15. References

- GitHub Issue: [#14 - Fix .jeeves path resolution](https://github.com/hansjm10/jeeves/issues/14)
- `jeeves/cli.py` - CLI implementation setting cwd and env vars
- `jeeves/worktree.py` - Worktree and symlink management
- `jeeves/runner/sdk_runner.py` - SDK runner passing cwd to agent

## Appendix A - Glossary

- **cwd**: Current working directory
- **Worktree**: Git worktree - isolated working directory for a branch
- **Symlink**: Symbolic link from `.jeeves/` in worktree to actual state directory
- **Path hallucination**: When the agent generates an incorrect path based on training data patterns

## Appendix B - Change Log

| Date       | Author       | Change Summary |
|------------|--------------|----------------|
| 2026-01-28 | Jeeves Agent | Initial draft |

---
