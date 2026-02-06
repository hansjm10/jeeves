# Design: Azure DevOps Provider Integration

**Issue**: #103
**Status**: Draft - Classification Complete
**Feature Types**: Primary: API, Secondary: Workflow, Data Model, UI, Infrastructure

---

## 1. Scope

### Problem
Jeeves is currently GitHub-centric, so teams that manage work in Azure DevOps cannot run the same issue-to-PR workflow inside the viewer. They must manage Azure credentials, work items, hierarchy context, and pull requests manually outside Jeeves.

### Goals
- [ ] Allow a selected issue/worktree to store Azure DevOps organization + PAT using issue-scoped secret handling that never exposes the PAT in API responses, events, or logs.
- [ ] Extend Create Issue so users can create Azure Boards work items (`User Story`, `Bug`, `Task`) and optionally init/select/auto-run in the same flow.
- [ ] Support initializing from an existing Azure work item (ID or URL) and persist parent/child hierarchy context for downstream planning/decomposition prompts.
- [ ] Add provider-aware PR preparation so Azure-backed issues can create or reuse Azure DevOps PRs while preserving existing GitHub behavior.

### Non-Goals
- Replacing or removing existing GitHub issue creation and GitHub PR flows.
- Implementing a generic multi-provider framework beyond the Azure DevOps requirements in this issue.
- Building full Azure DevOps project/repo discovery and administration UX beyond fields needed for this flow.
- Introducing non-PAT authentication mechanisms (OAuth/device-flow/service principals) in this phase.

### Boundaries
- **In scope**: Viewer + viewer-server contracts for Azure credential/config management, Azure Boards item creation, init-from-existing Azure item with hierarchy capture, provider-routed PR creation, provider-agnostic PR metadata persistence, prompt/context wiring for hierarchy-aware planning, and tests for endpoint behavior plus sanitized error handling.
- **Out of scope**: Azure DevOps org/project provisioning, broad backlog synchronization, migration of historical issue state beyond required new fields, and changes to unrelated workflow phases.

---

## 2. Workflow
[To be completed in design_workflow phase]

## 3. Interfaces
[To be completed in design_api phase]

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
