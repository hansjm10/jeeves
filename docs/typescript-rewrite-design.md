---
title: Rewrite Jeeves to TypeScript
sidebar_position: 99
---

# Rewrite Jeeves to TypeScript

## Document Control
- **Title**: Rewrite Jeeves to TypeScript
- **Authors**: Jeeves maintainers + agents
- **Reviewers**: Project maintainers
- **Status**: Draft
- **Last Updated**: 2026-01-30
- **Related Issues**: [#36](https://github.com/hansjm10/jeeves/issues/36)
- **Execution Mode**: Hybrid

## 1. Summary

Jeeves will be implemented as a TypeScript monorepo with a Node-based runner and a React-based viewer. The implementation will use the Claude Agent TypeScript SDK for agent execution, preserve the existing “fresh subprocess” iteration pattern, and use a single Node/PNPM toolchain across code, tests, tooling, and CI. The lint/typecheck + git hook workflow will match the patterns used in the `Idle-Game-Engine` repository (ESLint flat config, strict TS configs, and Lefthook-managed pre-commit checks).

## 2. Context & Problem Statement

- **Background**: Jeeves began as a single-stack implementation with a simple local viewer server and a runner that manages issue state, worktrees, workflows, prompt templates, and run artifacts.
- **Problem**: The desired ecosystem and SDK dependencies have shifted to TypeScript/Node (React viewer, Claude Agent TS SDK). Maintaining multiple stacks increases cost and complexity; a clean rewrite enables a unified toolchain and simpler onboarding.
- **Forces**:
  - Must preserve core product behavior (issue init/select, run control, streaming events/logs, workflow phases).
  - Must preserve state layout (XDG data dir, issues/worktrees layout) to avoid breaking existing local state.
  - Must converge on a single TypeScript/Node toolchain (“one stack”).
  - Must adopt lint/typecheck + hooks consistent with `Idle-Game-Engine`.

## 3. Goals & Non-Goals

### Goals
1. **100% TypeScript**: No non-TypeScript application code remains in the repository.
2. **Functional parity**: Viewer and runner support the same capabilities as the prior implementation (see Acceptance Criteria).
3. **Monorepo toolchain**: PNPM workspaces, strict TS configs, ESLint flat config, Lefthook hooks matching `Idle-Game-Engine` patterns.
4. **Claude Agent TS SDK**: Agent execution uses the TypeScript SDK as the primary integration point.
5. **Operational predictability**: Recreate the current “fresh subprocess” iteration pattern (viewer orchestrates repeated fresh-context runs; run handoff via files).

### Non-Goals
1. **Backwards-compatible legacy API**: No attempt to keep legacy modules importable.
2. **Perfect 1:1 internal architecture**: Preserve external behavior; internal refactors are expected.
3. **Feature expansion**: Avoid adding unrelated features during the rewrite (auth, multi-user, cloud execution, etc.) unless required for parity.

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**: Jeeves maintainers; contributors; users running local workflows.
- **Agent Roles**:
  - **Tooling Agent**: Monorepo, lint/typecheck, Lefthook, CI.
  - **Core Agent**: State model (issues/worktrees), workflow engine, prompt resolution.
  - **Runner Agent**: Claude Agent TS SDK integration, subprocess orchestration, artifacts.
  - **Viewer Agent**: Node API server + React UI, streaming logs/events, run control.
  - **Migration Agent**: Remove legacy code, translate docs, ensure parity and cleanup.
- **Affected Packages/Services**:
  - Replace the legacy implementation with `packages/**` and `apps/**`.
  - Replace the legacy viewer server with Node server + React app.
  - Replace legacy tests with TypeScript tests (Vitest) and (optionally) E2E tests for viewer.
- **Compatibility Considerations**:
  - Preserve on-disk state layout and filenames where feasible so existing local state remains usable.
  - Preserve workflow and prompt file formats (YAML workflows, Markdown prompts) unless explicitly migrated.

## 5. Current State

- **Language/tooling**: Prior implementation used a different toolchain and test stack.
- **Viewer**: A local viewer server provides a dashboard, state inspection, and log streaming.
- **State**: XDG-style data directory with `issues/<owner>/<repo>/<issue>/issue.json`, and `worktrees/<owner>/<repo>/issue-<N>/`.
- **Iteration pattern**: Viewer spawns fresh subprocess runs; handoff via `progress event log`; completion is signaled via a sentinel in output.

## 6. Proposed Solution

### 6.1 Architecture Overview

Adopt a PNPM workspace monorepo with:
- A Node “runner” package responsible for state, workflows, and invoking the Claude Agent TS SDK.
- A Node “viewer server” providing APIs for run control and streaming state/log updates.
- A React viewer UI consuming the server APIs.

### 6.2 Detailed Design

#### Repository Layout (proposed)
```
jeeves/
  apps/
    viewer/                 # React UI (Vite)
    viewer-server/          # Node server (HTTP + WS/SSE)
  packages/
    core/                   # paths, state model, workflows, prompt resolution
    runner/                 # SDK runner + subprocess orchestration
    shared/                 # shared types/schemas (zod), utilities
  prompts/                  # unchanged (markdown prompt templates)
  workflows/                # unchanged (yaml workflows)
  docs/
  scripts/
  lefthook.yml
  eslint.config.mjs
  tsconfig.base.json
  pnpm-workspace.yaml
  package.json
```

#### State and filesystem
- Keep XDG default behavior and `JEEVES_DATA_DIR` override.
- Keep state directories and filenames stable (issues, worktrees, run artifacts).
- Use Node libraries for XDG paths and filesystem watchers; avoid bespoke path logic where possible.

#### Workflow engine and prompts
- Parse workflows from YAML into a typed model (validate with Zod).
- Preserve phase selection semantics and transition guards.
- Keep prompt templates in `prompts/` and implement prompt resolution consistent with current behavior.

#### Runner
- Keep the “fresh context per iteration” pattern: viewer-server starts a runner process with minimal inputs, runner writes progress and artifacts, viewer-server streams updates.
- Integrate the Claude Agent TypeScript SDK behind a thin adapter so swapping providers later is possible.

#### Viewer (Node/React)
- Viewer UI: React (Vite) app with live log output, state inspection, workflow control.
- Viewer server: Node service that:
  - Manages run lifecycles (spawn/stop).
  - Streams logs/events via WebSocket (preferred) or SSE (fallback).
  - Exposes endpoints for issue init/select and workflow operations.

#### Tooling: match `Idle-Game-Engine`
Adopt the same *patterns* used in `Idle-Game-Engine`, including:
- **PNPM workspaces** with a root `package.json` and `prepare: lefthook install`.
- **ESLint flat config** via `eslint.config.mjs` using `@eslint/js` + `typescript-eslint` recommended configs.
- **Strict TS config** via `tsconfig.base.json` (strict, noUnusedLocals/Parameters, etc.) and per-package `tsconfig.json` extending base.
- **Lefthook** pre-commit hooks running `pnpm lint`, `pnpm typecheck`, and `pnpm build` (plus tests where applicable).

### 6.3 Operational Considerations

- **CI**: Use Node/PNPM CI. Add lint/typecheck/test/build steps mirroring local hooks.
- **Security**: Preserve path traversal protections on workflow/prompt file access, and ensure server endpoints are local-only by default.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| chore(ts): create monorepo skeleton | PNPM workspaces, base TS config, ESLint flat config, Lefthook | Tooling Agent | Approved design | `pnpm lint/typecheck/build` run; hooks installed |
| feat(core): port paths + state model | XDG paths, issue/worktree layout, JSON schemas | Core Agent | monorepo skeleton | Unit tests pass; parity with current file layout |
| feat(core): workflow engine + prompt resolution | YAML parsing/validation, phase transitions, prompt selection | Core Agent | state model | Workflow load + validation tests |
| feat(runner): Claude TS SDK runner | Adapter + run invocation, artifacts writing, progress handoff | Runner Agent | core/workflow | Can run a trivial workflow end-to-end |
| feat(viewer-server): run control + streaming | HTTP API + WS/SSE streaming, spawn/stop runner | Viewer Agent | runner | Live log stream + state updates in UI |
| feat(viewer): React UI | Run control, logs, prompt editing, workflow/issue selection | Viewer Agent | viewer-server | UI parity for core flows |
| chore: finalize TS-only repo | Delete legacy code/tests/tooling, update docs | Migration Agent | TS parity achieved | Repo contains no legacy tooling |

### 7.2 Milestones
- **Phase 1 — Toolchain + Core (foundation)**: Monorepo setup; core paths/state/workflows; baseline tests.
- **Phase 2 — Runner + Viewer (parity)**: Runner integration; viewer-server APIs; viewer UI parity.
- **Phase 3 — Cleanup + Hardening**: Remove legacy code; CI finalization; docs updates; perf/UX polish.

### 7.3 Coordination Notes
- This is an “epic” level change; expect multiple PRs and a project board/milestone.
- Keep PRs scoped: toolchain → core → runner → viewer → deletion pass.

## 8. Agent Guidance & Guardrails

- **Constraints**:
  - No partial migration that leaves legacy code in the final merged state.
  - Match lint/typecheck semantics from `Idle-Game-Engine` unless there is a clear Jeeves-specific reason.
- **Validation hooks** (must pass before merge):
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`

## 9. Alternatives Considered

1. **Incremental migration (mixed stacks)**: Reduces short-term risk but violates the “one stack” end-state and increases maintenance overhead.
2. **Split viewer + runner stacks**: Splits stacks and complicates deployment; rejects the “single toolchain” goal.

## 10. Testing & Validation Plan

- **Unit tests**: Vitest for core parsing/state/workflow logic.
- **Integration tests**: Minimal runner invocation tests using a local fixture workflow.
- **Viewer smoke**: Scripted “start viewer-server + run fixture” check; optional Playwright coverage later.

## 11. Risks & Mitigations

- **Parity gaps**: Maintain a parity checklist and test fixtures that reflect current behavior.
- **Large PRs**: Enforce scoped PRs and milestone gating to avoid unreviewable diffs.
- **State migration**: Keep state layout stable; add one-time migrations only if strictly necessary.

## 12. Rollout Plan

- Develop behind a `main`-compatible series of PRs.
- Only remove legacy code after TS runner + viewer are feature-complete and validated.

## 13. Open Questions

1. What exact package name/version is used for the “Claude Agent TypeScript SDK” integration?
2. Should the viewer-server be bundled with the UI (single process) or split into two processes in dev/production?
3. Which workflow formats must be supported on day 1 (current YAML only, or additional formats)?

## 14. Follow-Up Work

- Packaging strategy for distribution (single binary via `pkg`/`ncc`, Docker, or “run from source”).
- Telemetry/analytics (if any) and opt-in policy.

## 15. References

- `Idle-Game-Engine` toolchain patterns:
  - `eslint.config.mjs`, `tsconfig.base.json`, `lefthook.yml`, `package.json`
- Current Jeeves implementation:
  - `apps/viewer-server/src/server.ts`
  - `packages/core/src/**`

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-30 | Agent  | Initial draft |
