<INSTRUCTIONS>
# Jeeves Agent Instructions

## Overview

Jeeves is a proof-of-concept, SDK-only agent runner with a real-time viewer. The viewer is the primary interface for init, run control, and prompt editing.

## Repository Structure

```
jeeves/
├── src/jeeves/              # Core Python package
│   ├── core/                # Core logic modules
│   ├── runner/              # SDK runner
│   └── viewer/              # Web dashboard (server.py, static/)
├── prompts/                 # Prompt templates (issue.*.md)
├── scripts/                 # Helper scripts
├── tests/                   # All test files
├── docs/                    # Documentation
└── examples/                # Example configurations
```

## Commands

```bash
# Start the real-time viewer dashboard
python -m jeeves.viewer.server
```

## Viewer

The viewer provides:
- Run control (SDK-only)
- Live log output
- SDK streaming events
- Prompt template editing
- Issue init/select

## State and Data

- State is stored in the XDG data directory (override with `JEEVES_DATA_DIR`).
- Issue state lives at `.../issues/<owner>/<repo>/<issue>/issue.json`.
- Worktrees live under `.../worktrees/<owner>/<repo>/issue-<N>/`.

## Patterns

- SDK-only runs; no Codex/Claude/Opencode runners.
- Viewer controls phase selection: `design`, `implement`, `review`, `complete`.
- Prompts are in `prompts/issue.*.md` and can be edited in the viewer.
- Minimal run artifacts: `issue.json`, `progress.txt`, `last-run.log`, `viewer-run.log`, `sdk-output.json`.

## Iteration Pattern (Ralph Wiggum)

The viewer implements the "Ralph Wiggum" iteration pattern for fresh context runs:

```
┌─────────────────────────────────────────────────────┐
│  Outer Loop (JeevesRunManager in viewer/server.py)  │
│  for i in range(max_iterations):                    │
│      spawn sdk_runner subprocess (fresh context)    │
│      if output contains <promise>COMPLETE</promise>:│
│          break                                      │
│      # Handoff via progress.txt (agent writes it)   │
└─────────────────────────────────────────────────────┘
```

**Key concepts:**
- Each iteration is a **fresh subprocess** with a new context window (no context bloat)
- The SDK runner stays simple: one run, no retry logic
- Handoff between iterations happens via **files** (`progress.txt`)
- Agents read `progress.txt` at the start of each iteration to understand prior work
- Completion is signaled by outputting `<promise>COMPLETE</promise>`

**API parameters:**
- `max_iterations` (default: 10): Total fresh-context iterations allowed

**Why this pattern:**
1. True fresh context - no context window bloat from retries
2. Simple SDK runner - just runs once, cleanly
3. File-based handoff - already works (prompts read `progress.txt`)
4. Agent-agnostic - the orchestrator doesn't care what agent runs

## Skills
A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.
### Available skills
- pr-audit: Audit a PR review for false positives, overstated claims, and unsubstantiated assertions. Use when: (1) User runs `/pr-audit`, (2) User asks to "audit" or "check" a review, (3) User wants to find false positives or verify claims in a review, (4) User provides a review and asks if claims are justified. Does NOT re-review the PR; evaluates whether the review's claims are supported by evidence. (file: /codex/skills/pr-audit/SKILL.md)
- pr-evidence: Extract factual evidence from a PR diff without interpretation or judgment. Use when: (1) User runs `/pr-evidence`, (2) User asks to "extract evidence" from a PR, (3) User wants a facts-only summary of PR changes, (4) User provides a PR reference and asks what changed without asking for review/opinions. Produces an evidence_pack XML artifact with changed files, code changes, design decisions, tests, and docs. (file: /codex/skills/pr-evidence/SKILL.md)
- pr-requirements: Extract acceptance criteria and requirements from a GitHub issue. Use when: (1) User runs `/pr-requirements`, (2) User asks to "extract requirements" from an issue, (3) User wants to know what a PR should accomplish based on its linked issue, (4) User provides an issue URL and asks what the acceptance criteria are. Produces a requirements_pack XML artifact with acceptance criteria, constraints, and ambiguities. (file: /codex/skills/pr-requirements/SKILL.md)
- pr-review: Orchestrated PR review workflow producing evidence-based, audited technical reviews. Use when: (1) User requests a PR review with `/pr-review`, (2) User provides a PR URL or reference like `owner/repo#123`, (3) User asks for a "full review" or "technical review" of a pull request. Default output is a human-readable Markdown review + a short plain-text summary (no XML). Use `--show-xml` to also emit XML artifacts for each phase (retrieval_plan, evidence_pack, requirements_pack, draft_review, audit_report, final_review, comment_posted). (file: /codex/skills/pr-review/SKILL.md)
- pr-review-comment: Convert <final_review> XML from the pr-review workflow into a human-readable Markdown comment and post it to GitHub via gh. Use when: (1) the orchestrator or user requests `/pr-review-comment`, (2) a non-XML PR review comment must be published from a <final_review> payload, or (3) a follow-up step needs to post review results directly to a PR. (file: /codex/skills/pr-review-comment/SKILL.md)
- pr-review-summary: Produce a short, human-readable, non-XML summary from a <final_review> XML artifact. Use when: (1) a pr-review workflow completes, (2) a user asks for a brief PR review summary without XML, (3) an orchestrator needs a plain-text recap of review outcomes. (file: /codex/skills/pr-review-summary/SKILL.md)
- sonarqube: Access SonarQube or SonarCloud issues and quality gate data via API using tokens. Use when fetching PR/branch issue lists, leak-period problems, or quality gate status for a project. (file: /codex/skills/sonarqube/SKILL.md)
- skill-creator: Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Codex's capabilities with specialized knowledge, workflows, or tool integrations. (file: /codex/skills/.system/skill-creator/SKILL.md)
- skill-installer: Install Codex skills into $CODEX_HOME/skills from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo (including private repos). (file: /codex/skills/.system/skill-installer/SKILL.md)
### How to use skills
- Discovery: The list above is the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow.
  2) If `SKILL.md` points to extra folders such as `references/`, load only the specific files needed for the request; don't bulk-load everything.
  3) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.
  4) If `assets/` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.
</INSTRUCTIONS>
