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

This feature adds three cooperating workflow/state machines:
1. Azure credential lifecycle (issue-scoped org/PAT secret + worktree sync)
2. Provider-aware issue ingestion (create new or init from existing item, with optional init/select/auto-run)
3. Provider-aware PR preparation (reuse-or-create PR and persist metadata)

All mutating operations run under a per-issue mutex so only one credential/ingest/PR mutation is active at a time.

### Gate Answers (Explicit)
1. **All states/phases involved (exhaustive)**: `wf.idle`, `cred.validating`, `cred.persisting_secret`, `cred.reconciling_worktree`, `cred.recording_status`, `cred.done_success`, `cred.done_error`, `ingest.validating`, `ingest.resolving_provider`, `ingest.creating_remote_item`, `ingest.resolving_existing_item`, `ingest.fetching_hierarchy`, `ingest.persisting_issue_state`, `ingest.initializing_worktree`, `ingest.auto_selecting_issue`, `ingest.auto_starting_run`, `ingest.recording_status`, `ingest.done_success`, `ingest.done_partial`, `ingest.done_error`, `pr.loading_context`, `pr.resolving_provider`, `pr.checking_existing`, `pr.creating_or_reusing`, `pr.persisting_issue_state`, `pr.done_success`, `pr.done_error`.
2. **Initial state**: `wf.idle`, entered when viewer-server is ready and no operation mutex is held.
3. **Terminal states**: `cred.done_success`, `cred.done_error`, `ingest.done_success`, `ingest.done_partial`, `ingest.done_error`, `pr.done_success`, `pr.done_error`. They are terminal because the request/phase response has been committed; further movement requires a new request/phase run that starts from `wf.idle`.
4. **For each non-terminal state, all possible next states**: Fully enumerated in the **Transitions** table below.
5. **Trigger condition for each transition**: Fully enumerated in the **Transitions** table (`Event/Condition`).
6. **Side effects for each transition**: Fully enumerated in the **Transitions** table (`Side Effects`), including status writes, secret/env writes, issue metadata writes, and run/selection updates.
7. **Reversibility**: No in-flight transition is reversible. Reversal is handled by new operations from `wf.idle` (for example: re-saving credentials, re-running ingest with `force`, or closing/recreating PRs via another prepare run).
8. **Errors per state**: Enumerated in **Error Handling** plus the per-state inventory under that table.
9. **Error -> next state mapping**: Enumerated in **Error Handling** (`Recovery State` column).
10. **Error logging/recording**: Enumerated in **Error Handling** (`Actions` column). All entries must be sanitized (no PAT/token values).
11. **Global vs per-state error handling**: Both. Per-state handling drives deterministic transitions; a global catch handler maps uncaught exceptions to the corresponding `*.done_error`/`ingest.done_partial` outcome and emits sanitized logs.
12. **Crash recovery model**: Operation journaling + idempotent replay (see **Crash Recovery**).
13. **Recovery state**: Depends on last durable checkpoint: credentials recover at `cred.reconciling_worktree`; ingest recovers at `ingest.persisting_issue_state` (or `ingest.recording_status` if remote side effects already happened); PR recoveries restart at `pr.checking_existing` to avoid duplicate PRs.
14. **Recovery detection**: Incomplete operation journal (`completed_at` missing), stale mutex lock, temp artifacts present, or mismatch between remote IDs and local issue metadata.
15. **Cleanup before resume**: Remove stale lock/temp files, reload remote state by saved external IDs/branch, then resume from recovery state.
16. **Subprocess state/context inputs**: Defined in **Subprocesses** (`Receives` column), including provider, operation id, repo/branch, and sanitized env wiring.
17. **Subprocess read/write scope**: Defined in **Subprocesses** (`Can Write` column).
18. **Subprocess result collection and merge**: CLI outputs are normalized into provider-agnostic objects (`external_id`, `url`, `title`, `hierarchy`, `pr_number`) and merged into `issue.json`, API responses, and progress/status records.
19. **Subprocess failure/hang/crash behavior**: Defined in **Subprocesses** (`Failure Handling`) and mapped to deterministic error/partial terminal states.

### States
| State | Description | Entry Condition |
|-------|-------------|-----------------|
| `wf.idle` | No Azure-provider mutation is active for the selected issue. | Viewer-server startup complete or previous operation reached terminal state. |
| `cred.validating` | Validate credential payload, resolve issue/worktree context, acquire per-issue mutex. | Credential mutation request received (`PUT/PATCH/DELETE` Azure settings). |
| `cred.persisting_secret` | Persist or delete issue-scoped Azure secret file (`org`, `project`, PAT metadata). | `cred.validating` passed. |
| `cred.reconciling_worktree` | Reconcile derived worktree artifacts (env file entries, git exclude) without exposing PAT. | `cred.persisting_secret` completed. |
| `cred.recording_status` | Persist sanitized sync status in `issue.json` and emit stream status event. | `cred.reconciling_worktree` completed (success or warning). |
| `cred.done_success` | Credential request completed successfully. | `cred.recording_status` succeeded. |
| `cred.done_error` | Credential request failed. | Validation/persistence/reconcile/status recording failed fatally. |
| `ingest.validating` | Validate create/init request, enforce run gating, verify required credentials for provider. | Ingest request received (`create` or `init_from_existing`). |
| `ingest.resolving_provider` | Choose provider path (`github` or `azure`) and operation mode (`create` vs `init_existing`). | `ingest.validating` passed. |
| `ingest.creating_remote_item` | Create remote issue/work item via provider adapter. | `ingest.resolving_provider` chose `mode=create`. |
| `ingest.resolving_existing_item` | Parse/resolve existing item ID or URL and fetch canonical remote metadata. | `ingest.resolving_provider` chose `mode=init_existing`. |
| `ingest.fetching_hierarchy` | Fetch Azure parent/child hierarchy context for downstream prompts. | Azure item reference is known (created or resolved existing). |
| `ingest.persisting_issue_state` | Persist provider metadata, item references, and hierarchy into issue state. | Remote item metadata ready. |
| `ingest.initializing_worktree` | Initialize issue state/worktree via `initIssue` path. | `ingest.persisting_issue_state` succeeded and `init=true`. |
| `ingest.auto_selecting_issue` | Select new issue and persist `active-issue.json`. | `ingest.initializing_worktree` succeeded and `auto_select=true`. |
| `ingest.auto_starting_run` | Start run automatically (`runManager.start`). | `ingest.auto_selecting_issue` succeeded and `auto_run=true`. |
| `ingest.recording_status` | Persist ingest summary/status and emit provider status event. | Ingest flow reached a successful post-remote checkpoint. |
| `ingest.done_success` | Ingest finished with full success. | `ingest.recording_status` succeeded with no warnings/partial flags. |
| `ingest.done_partial` | Ingest completed with partial success (remote side effect happened, local follow-up failed). | Hierarchy/persist/init/select/auto-run/status follow-up failed after remote mutation or init step. |
| `ingest.done_error` | Ingest failed with no acceptable completion. | Validation/provider/remote lookup failures before acceptable completion checkpoint. |
| `pr.loading_context` | Load issue context (branch/provider metadata/design/progress references). | `prepare_pr` phase begins. |
| `pr.resolving_provider` | Select PR backend (`github` vs `azure`) from issue metadata. | `pr.loading_context` succeeded. |
| `pr.checking_existing` | Query for existing PR by branch/provider. | `pr.resolving_provider` succeeded. |
| `pr.creating_or_reusing` | Create provider PR if no existing PR was found. | `pr.checking_existing` found no PR. |
| `pr.persisting_issue_state` | Persist PR metadata (`status.prCreated`, PR number/url/provider fields). | Existing PR found or new PR created. |
| `pr.done_success` | PR preparation completed successfully. | `pr.persisting_issue_state` succeeded. |
| `pr.done_error` | PR preparation failed. | Context/provider/query/create/persist step failed. |

### Transitions
| From | Event/Condition | To | Side Effects |
|------|-----------------|-----|--------------|
| `wf.idle` | Credential mutation API call received | `cred.validating` | Acquire per-issue mutex; open operation journal entry (`kind=credentials`, state=`cred.validating`). |
| `cred.validating` | Payload invalid, context missing, or mutex timeout | `cred.done_error` | Return 4xx/503; log sanitized validation/concurrency error; mark operation failed. |
| `cred.validating` | Payload valid and mutex acquired | `cred.persisting_secret` | Normalize org/project values; prepare atomic secret write/remove plan. |
| `cred.persisting_secret` | Secret file write/remove fails | `cred.done_error` | Log sanitized FS error; mark operation failed; never log PAT. |
| `cred.persisting_secret` | Secret persistence succeeded | `cred.reconciling_worktree` | Write/remove derived env entries and update ignore metadata idempotently. |
| `cred.reconciling_worktree` | Fatal reconcile failure (cannot resolve worktree paths or fatal FS exception) | `cred.done_error` | Record sanitized fatal error; mark operation failed. |
| `cred.reconciling_worktree` | Reconcile completed (success or warning) | `cred.recording_status` | Capture `sync_status`, `last_attempt_at`, optional warning list. |
| `cred.recording_status` | Issue status write fails | `cred.done_error` | Log sanitized `issue.json` write failure; emit fallback error event. |
| `cred.recording_status` | Issue status write succeeds | `cred.done_success` | Emit `azure-devops-status` event; close operation journal as success. |
| `wf.idle` | Ingest API call received (`create` or `init_from_existing`) | `ingest.validating` | Acquire per-issue mutex; open operation journal entry (`kind=ingest`). |
| `ingest.validating` | Invalid payload, run conflict, missing required credentials, or mutex timeout | `ingest.done_error` | Return 4xx/409/503; log sanitized reason; mark operation failed. |
| `ingest.validating` | Request accepted | `ingest.resolving_provider` | Normalize mode/provider and optional flags (`init`, `auto_select`, `auto_run`). |
| `ingest.resolving_provider` | `provider` in `{github, azure}` and `mode=create` | `ingest.creating_remote_item` | Build provider adapter request + deterministic operation id marker. |
| `ingest.resolving_provider` | `provider` in `{github, azure}` and `mode=init_existing` | `ingest.resolving_existing_item` | Parse existing ID/URL input and build provider lookup request. |
| `ingest.resolving_provider` | Unsupported provider | `ingest.done_error` | Return 400; log unsupported provider error. |
| `ingest.creating_remote_item` | Provider command/API fails before remote ID is obtained | `ingest.done_error` | Return mapped provider error; log sanitized adapter stderr/details. |
| `ingest.creating_remote_item` | Remote item created (`provider=github`) | `ingest.persisting_issue_state` | Capture `issue_ref/url/title` from create response. |
| `ingest.creating_remote_item` | Remote item created (`provider=azure`) | `ingest.fetching_hierarchy` | Capture `work_item_id/url/title`; start hierarchy fetch. |
| `ingest.resolving_existing_item` | ID/URL parse fails or remote item not found | `ingest.done_error` | Return 400/404; log sanitized lookup failure. |
| `ingest.resolving_existing_item` | Existing GitHub issue resolved | `ingest.persisting_issue_state` | Capture canonical issue metadata for state persistence. |
| `ingest.resolving_existing_item` | Existing Azure work item resolved | `ingest.fetching_hierarchy` | Capture canonical Azure work item metadata for hierarchy fetch. |
| `ingest.fetching_hierarchy` | Hierarchy fetch succeeds | `ingest.persisting_issue_state` | Store parent/child IDs, titles, and relation URLs in memory for persistence. |
| `ingest.fetching_hierarchy` | Hierarchy fetch fails and this request already created a remote item | `ingest.done_partial` | Return partial result (remote created, hierarchy missing); log sanitized warning with remote ID. |
| `ingest.fetching_hierarchy` | Hierarchy fetch fails with no new remote item created | `ingest.done_error` | Return error; log sanitized failure. |
| `ingest.persisting_issue_state` | `issue.json` persistence fails and remote item exists | `ingest.done_partial` | Return partial result; include remote reference so user can retry persistence safely. |
| `ingest.persisting_issue_state` | `issue.json` persistence fails and no remote item exists | `ingest.done_error` | Return 500; log sanitized state-write failure. |
| `ingest.persisting_issue_state` | Persistence succeeds and `init` not requested | `ingest.recording_status` | Build response payload without worktree initialization. |
| `ingest.persisting_issue_state` | Persistence succeeds and `init=true` | `ingest.initializing_worktree` | Invoke `initIssue` with repo/issue/branch/workflow/phase params. |
| `ingest.initializing_worktree` | Init fails (clone/fetch/worktree/state-link failure) | `ingest.done_partial` | Return partial result (remote item + persisted metadata may exist); log sanitized git/init error. |
| `ingest.initializing_worktree` | Init succeeds and `auto_select=false` | `ingest.recording_status` | Keep current selected issue unchanged; include init result in response. |
| `ingest.initializing_worktree` | Init succeeds and `auto_select=true` | `ingest.auto_selecting_issue` | Prepare selection update to run manager + active-issue file. |
| `ingest.auto_selecting_issue` | `setIssue`/`saveActiveIssue` fails | `ingest.done_partial` | Return partial result; log sanitized selection failure. |
| `ingest.auto_selecting_issue` | Selection succeeds and `auto_run=false` | `ingest.recording_status` | Refresh file targets and continue without run start. |
| `ingest.auto_selecting_issue` | Selection succeeds and `auto_run=true` | `ingest.auto_starting_run` | Invoke `runManager.start` with provider/workflow/run params. |
| `ingest.auto_starting_run` | Run start fails | `ingest.done_partial` | Return partial result with `auto_run.ok=false`; log sanitized run-start failure. |
| `ingest.auto_starting_run` | Run start succeeds | `ingest.recording_status` | Include run status snapshot in response. |
| `ingest.recording_status` | Status write succeeds and no warnings/partial flags | `ingest.done_success` | Emit `azure-devops-status` event; close journal as success. |
| `ingest.recording_status` | Status write succeeds but warnings/partial flags exist | `ingest.done_partial` | Emit status event with warnings; close journal as partial. |
| `ingest.recording_status` | Status write fails | `ingest.done_partial` | Return partial result with fallback warning; log status-write failure. |
| `wf.idle` | `prepare_pr` phase starts | `pr.loading_context` | Open operation journal entry (`kind=pr_prepare`); load selected issue state paths. |
| `pr.loading_context` | Required context missing/unreadable (`issue.json`, branch, repo, or prompt inputs) | `pr.done_error` | Return/record failure; log sanitized context error. |
| `pr.loading_context` | Context loaded | `pr.resolving_provider` | Determine PR backend from issue metadata/provider fields. |
| `pr.resolving_provider` | Provider missing or unsupported | `pr.done_error` | Mark phase failed with explicit provider error. |
| `pr.resolving_provider` | Provider resolved (`github` or `azure`) | `pr.checking_existing` | Build provider-specific list query by branch/head. |
| `pr.checking_existing` | Existing-PR query command/API fails | `pr.done_error` | Log sanitized query failure and stderr summary. |
| `pr.checking_existing` | Existing PR found | `pr.persisting_issue_state` | Normalize existing PR metadata for persistence. |
| `pr.checking_existing` | No existing PR found | `pr.creating_or_reusing` | Build provider-specific create payload/title/body. |
| `pr.creating_or_reusing` | PR create command/API fails | `pr.done_error` | Log sanitized provider create error; leave `status.prCreated` unchanged. |
| `pr.creating_or_reusing` | PR created successfully | `pr.persisting_issue_state` | Normalize created PR metadata (`number`, `url`, provider IDs). |
| `pr.persisting_issue_state` | `issue.json` update fails | `pr.done_error` | Log sanitized state-write error; do not claim PR creation in status. |
| `pr.persisting_issue_state` | `issue.json` update succeeds | `pr.done_success` | Set `status.prCreated=true`, persist PR metadata, append progress entry. |

### Error Handling
| State | Error | Recovery State | Actions |
|-------|-------|----------------|---------|
| `cred.validating` | Invalid org/project/PAT payload | `cred.done_error` | Return 400 with field-level validation errors; log sanitized details. |
| `cred.validating` | Per-issue mutex timeout | `cred.done_error` | Return 503 `busy`; log concurrency timeout and operation id. |
| `cred.persisting_secret` | Secret file write/delete permission or IO failure | `cred.done_error` | Abort operation; log sanitized FS error; keep old secret unchanged. |
| `cred.reconciling_worktree` | Worktree reconcile warning (env/exclude update partially failed) | `cred.recording_status` | Continue with warning; record `sync_status=warning` and warning list. |
| `cred.reconciling_worktree` | Fatal reconcile exception (path resolution or unrecoverable FS failure) | `cred.done_error` | Abort; log sanitized fatal error. |
| `cred.recording_status` | `issue.json` status update failure | `cred.done_error` | Emit fallback error event and leave prior status as last known good. |
| `ingest.validating` | Invalid payload, run conflict, missing Azure credentials | `ingest.done_error` | Return 400/409; log sanitized validation/conflict reason. |
| `ingest.validating` | Per-issue mutex timeout | `ingest.done_error` | Return 503 `busy`; log concurrency timeout and operation id. |
| `ingest.resolving_provider` | Unsupported provider | `ingest.done_error` | Return 400 unsupported provider. |
| `ingest.creating_remote_item` | Provider CLI missing/auth/permission/validation error | `ingest.done_error` | Map provider error to safe message; log sanitized stderr/error code. |
| `ingest.resolving_existing_item` | Existing item parse failure or not found | `ingest.done_error` | Return 400/404; log sanitized lookup error. |
| `ingest.fetching_hierarchy` | Hierarchy fetch failed after creating remote item | `ingest.done_partial` | Return partial success with remote reference; record hierarchy warning. |
| `ingest.fetching_hierarchy` | Hierarchy fetch failed with no remote mutation in this request | `ingest.done_error` | Return failure; no partial success emitted. |
| `ingest.persisting_issue_state` | `issue.json` write failed after remote item known | `ingest.done_partial` | Return partial with remote ID/url so user can retry persist/init safely. |
| `ingest.persisting_issue_state` | `issue.json` write failed before any remote side effect | `ingest.done_error` | Return 500 and abort flow. |
| `ingest.initializing_worktree` | Clone/fetch/worktree/link failure | `ingest.done_partial` | Keep remote item + metadata; mark init failed with retry instructions. |
| `ingest.auto_selecting_issue` | `runManager.setIssue`/`saveActiveIssue` failure | `ingest.done_partial` | Keep init artifacts; mark auto-select failed. |
| `ingest.auto_starting_run` | `runManager.start` failure | `ingest.done_partial` | Keep create/init/select result; mark auto-run failed in response/status. |
| `ingest.recording_status` | Status write failure | `ingest.done_partial` | Return partial and log status recording failure. |
| `pr.loading_context` | Missing/unreadable branch/provider/design/progress context | `pr.done_error` | Fail phase; log sanitized context resolution error. |
| `pr.resolving_provider` | Provider missing/unsupported for PR backend | `pr.done_error` | Fail phase with explicit unsupported-provider message. |
| `pr.checking_existing` | Existing PR lookup command/API failure | `pr.done_error` | Fail phase; log sanitized list-query error. |
| `pr.creating_or_reusing` | PR create command/API failure | `pr.done_error` | Fail phase; preserve previous PR metadata if present. |
| `pr.persisting_issue_state` | `issue.json` PR metadata/status write failure | `pr.done_error` | Fail phase; log sanitized persistence error. |

Per-state error inventory (explicit):
- `wf.idle`: no direct runtime errors (errors begin when an operation request enters a non-idle state).
- `cred.validating`: validation errors, context resolution errors, mutex timeout.
- `cred.persisting_secret`: secret file IO/permission errors.
- `cred.reconciling_worktree`: reconcile warnings or fatal path/FS errors.
- `cred.recording_status`: issue status write errors.
- `cred.done_success`: none.
- `cred.done_error`: none.
- `ingest.validating`: payload/credential/conflict/mutex errors.
- `ingest.resolving_provider`: unsupported provider errors.
- `ingest.creating_remote_item`: provider command/API/auth/permission/timeout errors.
- `ingest.resolving_existing_item`: parse/not-found/provider lookup errors.
- `ingest.fetching_hierarchy`: provider hierarchy query failures.
- `ingest.persisting_issue_state`: issue metadata persistence errors.
- `ingest.initializing_worktree`: git clone/fetch/worktree/link errors.
- `ingest.auto_selecting_issue`: issue selection persistence errors.
- `ingest.auto_starting_run`: run start errors.
- `ingest.recording_status`: status persistence errors.
- `ingest.done_success`: none.
- `ingest.done_partial`: none.
- `ingest.done_error`: none.
- `pr.loading_context`: missing/unreadable context errors.
- `pr.resolving_provider`: provider resolution errors.
- `pr.checking_existing`: PR lookup command/API errors.
- `pr.creating_or_reusing`: PR creation command/API errors.
- `pr.persisting_issue_state`: PR metadata persistence errors.
- `pr.done_success`: none.
- `pr.done_error`: none.

### Crash Recovery
- **Detection**: Recovery is required when any of the following is true: an operation journal entry exists with `completed_at` missing, a per-issue lock is stale beyond timeout, temp artifacts exist (`.env.jeeves.tmp`, `.jeeves/.secrets/azure-devops.json.tmp`), or remote references exist without matching local metadata.
- **Recovery state**:
  - Credential ops resume at `cred.reconciling_worktree` if secret persistence completed; otherwise restart at `cred.validating`.
  - Ingest ops resume at `ingest.persisting_issue_state` when remote item IDs are known; if status-only finalization is pending, resume at `ingest.recording_status`.
  - PR ops resume at `pr.checking_existing` so duplicates are avoided by re-querying before create.
- **Cleanup**: Remove stale locks/temp files, reload latest remote metadata by external IDs/branch, recompute warnings, and then continue from the recovery state using idempotent writes.

### Subprocesses (if applicable)
| Subprocess | Receives | Can Write | Failure Handling |
|------------|----------|-----------|------------------|
| `gh issue create` | Repo, title/body, labels/assignees/milestone, operation id marker. | Creates GitHub issue remotely. | Failure in `ingest.creating_remote_item` -> `ingest.done_error` with mapped safe error. |
| `az boards work-item create` | Organization/project, work item type/title/description, optional parent link, operation id marker. | Creates Azure Boards work item remotely. | Failure in `ingest.creating_remote_item` -> `ingest.done_error`; timeout/hang is killed and reported as provider timeout. |
| `az boards work-item show` / relation query | Organization/project + work item ID. | Read-only remote queries. | Failure in `ingest.resolving_existing_item` or `ingest.fetching_hierarchy` -> `ingest.done_error` or `ingest.done_partial` (if remote create already occurred). |
| `git clone/fetch/worktree` (via `initIssue`) | Repo URL, branch, base ref, data/worktree paths. | Writes local repo cache/worktree/state link files. | Failure in `ingest.initializing_worktree` -> `ingest.done_partial` (remote item remains created/resolved). |
| Runner subprocess (via `runManager.start`) | Provider/workflow/max-iteration settings and selected issue context. | Writes run artifacts/logs and can execute workflow phases. | Failure in `ingest.auto_starting_run` -> `ingest.done_partial` with `auto_run.ok=false`. |
| `gh pr list/create` | Branch/head, base branch, title/body, repo context. | Queries/creates GitHub PR remotely. | Lookup/create failure in `pr.checking_existing`/`pr.creating_or_reusing` -> `pr.done_error`. |
| `az repos pr list/create` | Azure org/project/repo, source/target branch, title/description. | Queries/creates Azure DevOps PR remotely. | Lookup/create failure in `pr.checking_existing`/`pr.creating_or_reusing` -> `pr.done_error`; timeouts are treated as create/query failures. |

## 3. Interfaces
[To be completed in design_api phase]

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
