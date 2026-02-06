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

### Classification Gates (Explicit)
1. **What specific problem does this solve?**
   Jeeves only supports GitHub-native issue and PR flows today, so Azure DevOps teams cannot run end-to-end planning and delivery inside Jeeves without manual external steps.
2. **Who or what is affected by this problem today?**
   Viewer users and viewer-server workflows that depend on issue creation, issue initialization, credential sync, and PR preparation when the source of truth is Azure DevOps.
3. **What happens if we don't solve it?**
   Azure teams continue to split work across Jeeves and manual Azure CLI/UI operations, increasing setup friction, state drift risk, and inconsistent run outcomes.
4. **What MUST this solution do?**
   - Persist Azure org/PAT per issue with secret-safe handling and reconcile semantics.
   - Create Azure Boards work items from Create Issue for `User Story`, `Bug`, and `Task`.
   - Initialize from existing Azure items and capture parent/child hierarchy context.
   - Route PR preparation by provider so Azure-backed issues use Azure PR flows while GitHub behavior remains intact.
5. **What MUST this solution NOT do?**
   - It must not break or replace existing GitHub create-issue and PR preparation behavior.
   - It must not expose PAT values in API payloads, events, logs, or persisted non-secret status fields.
   - It must not introduce broad Azure administration/discovery workflows beyond required org/project/item/PR operations.
6. **What are the boundaries?**
   - **In scope**: Credential lifecycle, provider-aware ingest/create/init-from-existing, hierarchy context persistence for prompts, provider-aware PR creation/reuse, and contract-level tests.
   - **Out of scope**: Backlog synchronization, org/project provisioning, historical state migrations unrelated to new provider fields, and unrelated workflow phases.
7. **Does this change workflow/orchestration/state machines?**
   Yes. It adds provider-aware orchestration across credential sync, ingest/init, and PR preparation with additional state transitions and failure modes.
8. **Does this add/modify endpoints, events, CLI commands, or contracts?**
   Yes. It requires new/extended viewer-server routes, streamed status events, provider routing contracts, and Azure CLI command paths.
9. **Does this add/modify schemas, config fields, or storage?**
   Yes. It adds issue-scoped Azure secret storage and extends issue state with provider-aware source/hierarchy/PR metadata.
10. **Does this change UI components or user interactions?**
    Yes. Create Issue and provider credential UX must expose Azure-specific options and validations.
11. **Does this change build, deploy, or tooling?**
    Yes. Runtime tooling dependencies and failure handling expand to Azure CLI authentication/extension/permission conditions.

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
| `cred.reconciling_worktree` | Worktree reconcile warning (env/exclude update partially failed) | `cred.recording_status` | Continue with warning; record exact reconcile status code (`failed_exclude`, `failed_env_write`, or `failed_env_delete`) and warning list. |
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

This section defines all external and internal contracts added or changed by Azure DevOps provider integration.

### Conventions

**Envelope conventions**
- Provider-aware route success (`/api/issue/azure-devops`, `/api/issues/*`): `{ "ok": true, ... }`
- Provider-aware route error: `{ "ok": false, "error": string, "code": string, "field_errors"?: Record<string,string>, "run"?: RunStatus }`
- Legacy compatibility route error (`/api/github/issues/create`): `{ "ok": false, "error": string, "run": RunStatus }` (no `code`, no `field_errors`)

**Mutation gating**
- Mutating routes remain localhost-only unless `--allow-remote-run` is enabled.
- Origin validation continues to use the existing viewer-server policy.

**Issue scoping**
- `/api/issue/*` routes operate on the selected issue.
- `/api/issues/*` routes receive `repo` and then optionally select/init the new issue depending on flags.

**Secret handling**
- Azure PAT values are never returned in HTTP responses, stream events, or logs.

### Endpoints
| Method | Path | Input | Success | Errors |
|--------|------|-------|---------|--------|
| GET | `/api/issue/azure-devops` | none | `200` status payload (no PAT value) | `400`, `403`, `500` |
| PUT | `/api/issue/azure-devops` | full upsert body (`organization`, `project`, `pat`, optional `sync_now`) | `200` mutate payload | `400`, `403`, `409`, `500`, `503` |
| PATCH | `/api/issue/azure-devops` | partial update body (at least one mutable field) | `200` mutate payload | `400`, `403`, `409`, `500`, `503` |
| DELETE | `/api/issue/azure-devops` | none | `200` mutate payload (`updated` idempotent) | `400`, `403`, `409`, `500`, `503` |
| POST | `/api/issue/azure-devops/reconcile` | `{ force?: boolean }` | `200` mutate payload (`updated=false`) | `400`, `403`, `409`, `500`, `503` |
| POST | `/api/issues/create` | provider-aware create payload | `200` ingest payload (`outcome=success|partial`) | `400`, `401`, `403`, `404`, `409`, `422`, `500`, `503`, `504` |
| POST | `/api/issues/init-from-existing` | provider-aware existing-item payload | `200` ingest payload (`outcome=success|partial`) | `400`, `401`, `403`, `404`, `409`, `422`, `500`, `503`, `504` |
| POST | `/api/github/issues/create` | legacy GitHub create payload (`repo`, `title`, `body`, optional `labels`, `assignees`, `milestone`, `init`, `auto_select`, `auto_run`) | `200` legacy create payload | `400`, `401`, `403`, `404`, `409`, `422`, `500` |

#### Endpoint Schemas

**Azure status type**
```ts
type AzureDevopsStatus = {
  issue_ref: string;
  worktree_present: boolean;
  configured: boolean;
  organization: string | null;
  project: string | null;
  has_pat: boolean;
  pat_last_updated_at: string | null;
  pat_env_var_name: 'AZURE_DEVOPS_EXT_PAT';
  sync_status:
    | 'in_sync'
    | 'deferred_worktree_absent'
    | 'failed_exclude'
    | 'failed_env_write'
    | 'failed_env_delete'
    | 'failed_secret_read'
    | 'never_attempted';
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
};
```

**GET `/api/issue/azure-devops`**
- Success (`200`): `{ ok: true, ...AzureDevopsStatus }`
- Errors:
  - `400` `code=no_issue_selected`
  - `403` `code=forbidden`
  - `500` `code=io_error`

**PUT `/api/issue/azure-devops`**
- Request:
```ts
type PutAzureDevopsRequest = {
  organization: string;
  project: string;
  pat: string;
  sync_now?: boolean; // default true
};
```
- Success (`200`):
```ts
type AzureMutateResponse = {
  ok: true;
  updated: boolean;
  status: AzureDevopsStatus;
  warnings: string[];
};
```
- Errors:
  - `400` `code=validation_failed` with `field_errors`
  - `403` `code=forbidden`
  - `409` `code=conflict_running`
  - `500` `code=io_error`
  - `503` `code=busy`

**PATCH `/api/issue/azure-devops`**
- Request:
```ts
type PatchAzureDevopsRequest = {
  organization?: string;
  project?: string;
  pat?: string;
  clear_pat?: boolean;
  sync_now?: boolean; // default false
};
```
- Rules: at least one of `organization`, `project`, `pat`, `clear_pat=true` must be present; `pat` and `clear_pat=true` cannot be sent together.
- Success/error shape and status codes match PUT.

**DELETE `/api/issue/azure-devops`**
- Success (`200`): `AzureMutateResponse` where `updated` is `true` only if stored config or PAT existed.
- Errors: `400` no issue selected, `403` forbidden, `409` running conflict, `500` io error, `503` busy.

**POST `/api/issue/azure-devops/reconcile`**
- Request: `{ force?: boolean }`
- Success (`200`): `AzureMutateResponse` with `updated=false`.
- Errors: `400` validation/no issue, `403` forbidden, `409` running conflict, `500` io error, `503` busy.

**Common ingest response type**
```ts
type IngestResponse = {
  ok: true;
  provider: 'github' | 'azure_devops';
  mode: 'create' | 'init_existing';
  outcome: 'success' | 'partial';
  remote: {
    id: string;
    url: string;
    title: string;
    kind: 'issue' | 'work_item';
  };
  hierarchy?: {
    parent: { id: string; title: string; url: string } | null;
    children: Array<{ id: string; title: string; url: string }>;
  };
  init?: { ok: true; issue_ref: string; branch: string } | { ok: false; error: string };
  auto_select?: { requested: boolean; ok: boolean; error?: string };
  auto_run?: { requested: boolean; ok: boolean; error?: string };
  warnings: string[];
  run: RunStatus;
};
```

**POST `/api/issues/create`**
- Request:
```ts
type CreateProviderIssueRequest = {
  provider: 'github' | 'azure_devops';
  repo: string;
  title: string;
  body: string;
  labels?: string[];          // github only
  assignees?: string[];       // github only
  milestone?: string;         // github only
  azure?: {
    organization?: string;    // override saved issue config
    project?: string;         // override saved issue config
    work_item_type?: 'User Story' | 'Bug' | 'Task';
    parent_id?: number;
    area_path?: string;
    iteration_path?: string;
    tags?: string[];
  };
  init?: {
    branch?: string;
    workflow?: string;
    phase?: string;
    design_doc?: string;
    force?: boolean;
  };
  auto_select?: boolean;
  auto_run?: {
    provider?: 'claude' | 'codex' | 'fake';
    workflow?: string;
    max_iterations?: number;
    inactivity_timeout_sec?: number;
    iteration_timeout_sec?: number;
  };
};
```
- Success (`200`): `IngestResponse`
- Errors:
  - `400` `validation_failed` or `unsupported_provider`
  - `401` `provider_auth_required`
  - `403` `forbidden` or `provider_permission_denied`
  - `404` `remote_not_found`
  - `409` `conflict_running`
  - `422` `remote_validation_failed`
  - `500` `io_error`
  - `503` `busy`
  - `504` `provider_timeout`

**POST `/api/issues/init-from-existing`**
- Request:
```ts
type InitFromExistingRequest = {
  provider: 'github' | 'azure_devops';
  repo: string;
  existing: {
    id?: number | string;
    url?: string;
  };
  azure?: {
    organization?: string;
    project?: string;
    fetch_hierarchy?: boolean; // default true
  };
  init?: {
    branch?: string;
    workflow?: string;
    phase?: string;
    design_doc?: string;
    force?: boolean;
  };
  auto_select?: boolean;
  auto_run?: {
    provider?: 'claude' | 'codex' | 'fake';
    workflow?: string;
    max_iterations?: number;
    inactivity_timeout_sec?: number;
    iteration_timeout_sec?: number;
  };
};
```
- Rules: exactly one of `existing.id` or `existing.url` is required.
- Success (`200`): `IngestResponse` with `mode=init_existing`.
- Errors: same status/code matrix as `/api/issues/create` plus `404 remote_not_found` for missing issue/work item.

**POST `/api/github/issues/create` (compatibility route)**
- Request:
```ts
type LegacyCreateIssueRequest = {
  repo: string;
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
  milestone?: string;
  init?: {
    branch?: string;
    workflow?: string;
    phase?: string;
    design_doc?: string;
    force?: boolean;
  };
  auto_select?: boolean;
  auto_run?: {
    provider?: 'claude' | 'codex' | 'fake';
    workflow?: string;
    max_iterations?: number;
    inactivity_timeout_sec?: number;
    iteration_timeout_sec?: number;
  };
};
```
- Success (`200`):
```ts
type LegacyCreateIssueResponse = {
  ok: true;
  created: true;
  issue_url: string;
  issue_ref?: string;
  run: RunStatus;
  init?: { ok: true; result: { state_dir: string; work_dir: string; repo_dir: string; branch: string } }
       | { ok: false; error: string };
  auto_run?: { ok: true; run_started: true } | { ok: false; run_started: false; error: string };
};
```
- Errors:
  - `400` invalid payload (`repo/title/body`, dependency rules for `init`/`auto_select`/`auto_run`, invalid array types)
  - `401`, `403`, `404`, `422` provider adapter passthrough (`CreateGitHubIssueError.status`)
  - `409` init requested while run is already active
  - `500` unhandled provider/init failure
- Internal routing: route delegates to `/api/issues/create` with `provider='github'` and maps the provider-aware result back into the legacy response fields/envelope.
- Deprecation: route remains supported through the next minor release after Azure provider rollout.

### CLI Commands (internal provider adapters)
| Command | Arguments | Options | Output |
|---------|-----------|---------|--------|
| `gh issue create` | `--repo <owner/repo> --title <title> --body <body>` | `--label <label>... --assignee <user>... --milestone <milestone>` | JSON parsed into `remote.id/url/title` |
| `gh issue view` | `<number> --repo <owner/repo> --json number,url,title` | none | Canonical existing GitHub issue metadata |
| `az boards work-item create` | `--organization <org-url> --project <project> --type <User Story|Bug|Task> --title <title> --description <body>` | `--fields` for parent/area/iteration/tags | JSON parsed into `remote.id/url/title` |
| `az boards work-item show` | `--organization <org-url> --project <project> --id <id>` | `--expand relations` | Existing work item metadata + hierarchy relations |
| `gh pr list` | `--head <branch> --repo <owner/repo> --json number,url,state` | none | Existing PR match (if any) |
| `gh pr create` | `--base <base> --head <branch> --title <title> --body <body> --repo <owner/repo>` | none | Created PR number/url |
| `az repos pr list` | `--organization <org-url> --project <project> --repository <repo> --source-branch <branch>` | `--status active --output json` | Existing Azure PR match (if any) |
| `az repos pr create` | `--organization <org-url> --project <project> --repository <repo> --source-branch <branch> --target-branch <branch> --title <title> --description <body>` | `--output json` | Created Azure PR id/url |

### Events
| Event | Trigger | Payload | Consumers |
|-------|---------|---------|-----------|
| `azure-devops-status` | After PUT/PATCH/DELETE/reconcile, and after issue select/init startup reconciliation | `AzureDevopsStatusEvent` | Viewer Azure settings UI, stream cache hydrator |
| `issue-ingest-status` | After provider-aware create/init-existing reaches `ingest.recording_status` | `IssueIngestStatusEvent` | Create Issue page, workflow/debug panels |

```ts
type AzureDevopsStatusEvent = AzureDevopsStatus & {
  operation: 'put' | 'patch' | 'delete' | 'reconcile' | 'auto_reconcile' | 'ingest';
};

type IssueIngestStatusEvent = {
  issue_ref: string | null;
  provider: 'github' | 'azure_devops';
  mode: 'create' | 'init_existing';
  outcome: 'success' | 'partial' | 'error';
  remote_id?: string;
  remote_url?: string;
  warnings: string[];
  auto_select: { requested: boolean; ok: boolean };
  auto_run: { requested: boolean; ok: boolean };
  error?: { code: string; message: string };
  occurred_at: string;
};
```

### Validation Rules
| Field | Type | Constraints | Error |
|-------|------|-------------|-------|
| `organization` | string | required for PUT; optional for PATCH/create override; trim; length `3..200`; `https://dev.azure.com/<org>` form or org slug chars `[A-Za-z0-9._-]` | `400 validation_failed` `field_errors.organization` |
| `project` | string | required for PUT; optional for PATCH/create override; trim; length `1..128`; must not include control chars | `400 validation_failed` `field_errors.project` |
| `pat` | string | required for PUT; optional for PATCH; trim; length `1..1024`; no `\0`, `\n`, `\r` | `400 validation_failed` `field_errors.pat` |
| `clear_pat` | boolean | optional; cannot be `true` when `pat` present | `400 validation_failed` `field_errors.clear_pat` |
| `sync_now` | boolean | optional; default PUT=`true`, PATCH=`false` | `400 validation_failed` `field_errors.sync_now` |
| `force` | boolean | optional for reconcile; default `false` | `400 validation_failed` `field_errors.force` |
| `provider` | enum | required for provider-aware ingest; one of `github`, `azure_devops` | `400 unsupported_provider` |
| `repo` | string | required; format `owner/repo`; trim; length `3..200` | `400 validation_failed` `field_errors.repo` |
| `title` | string | required for create; trim length `1..256` | `400 validation_failed` `field_errors.title` |
| `body` | string | required for create; trim length `1..20000` | `400 validation_failed` `field_errors.body` |
| `labels[]` | string[] | optional GitHub-only; each trim length `1..64`; max 20 items | `400 validation_failed` `field_errors.labels` |
| `assignees[]` | string[] | optional GitHub-only; each trim length `1..64`; max 20 items | `400 validation_failed` `field_errors.assignees` |
| `milestone` | string | optional GitHub-only; trim length `1..128` | `400 validation_failed` `field_errors.milestone` |
| `azure.work_item_type` | enum | required when `provider=azure_devops` and `mode=create`; `User Story|Bug|Task` | `400 validation_failed` `field_errors.azure.work_item_type` |
| `azure.parent_id` | integer | optional; positive integer | `400 validation_failed` `field_errors.azure.parent_id` |
| `existing.id` / `existing.url` | number/string | init-from-existing requires exactly one | `400 validation_failed` `field_errors.existing` |
| `auto_select` | boolean | optional; only valid when `init` present; default `true` when `init` present | `400 validation_failed` `field_errors.auto_select` |
| `auto_run` | object | optional; requires `init` and `auto_select=true` | `400 validation_failed` `field_errors.auto_run` |
| `auto_run.provider` | enum | optional; `claude|codex|fake` | `400 validation_failed` `field_errors.auto_run.provider` |
| `auto_run.max_iterations` | integer | optional; `1..100` | `400 validation_failed` `field_errors.auto_run.max_iterations` |
| `auto_run.inactivity_timeout_sec` | integer | optional; `10..7200` | `400 validation_failed` `field_errors.auto_run.inactivity_timeout_sec` |
| `auto_run.iteration_timeout_sec` | integer | optional; `30..14400` | `400 validation_failed` `field_errors.auto_run.iteration_timeout_sec` |

**Validation failure behavior**
- Synchronous validation: JSON type checks, enum checks, dependency checks, length/format checks.
- Asynchronous validation: mutex acquisition, run-state conflict checks, provider auth/permission checks, remote existence checks.
- Sync failures on provider-aware routes return `400` with `code=validation_failed` (or `unsupported_provider`) and `field_errors`.
- Sync failures on `/api/github/issues/create` return `400` with legacy `{ ok:false, error, run }` envelope to avoid a breaking contract change.
- Async failures map to endpoint-specific `401/403/404/409/422/503/504/500` with sanitized `error` text.

### UI Interactions
| Action | Request | Loading State | Success | Error |
|--------|---------|---------------|---------|-------|
| Open Azure DevOps settings panel | `GET /api/issue/azure-devops` | Spinner + inputs disabled | Status fields rendered (`configured`, `sync_status`) | Inline error banner + retry button |
| Save Azure settings | `PUT` or `PATCH /api/issue/azure-devops` | Form disabled; "Saving..." button text | Toast + refreshed status + latest `azure-devops-status` event applied | Field errors shown inline; toast with message |
| Remove Azure settings | `DELETE /api/issue/azure-devops` | Destructive action disabled while pending | Toast + status shows `configured=false` | Toast + retain previous visible status |
| Retry Azure reconcile | `POST /api/issue/azure-devops/reconcile` | "Syncing..." state | Status row updates; warnings banner if present | Banner with sanitized reconcile error |
| Create provider issue/work item | `POST /api/issues/create` | Submit disabled; progress indicator | Created remote link shown; optional init/select/autorun result cards | Error banner; retain form values |
| Initialize from existing item | `POST /api/issues/init-from-existing` | Submit disabled; progress indicator | Existing remote metadata and hierarchy summary shown | Error banner; highlight `existing` field |

UI state changes on success:
- Query cache invalidates issue list and selected issue status.
- If `auto_select=true`, active issue changes and stream `state` snapshot updates.
- If `auto_run.ok=true`, run status indicator transitions to running.

### Contract Gates (Explicit Answers)
1. **Exact paths/command signatures**: listed in `Endpoints` and `CLI Commands` tables.
2. **Method/invocation pattern**: each endpoint row includes HTTP method; each command row includes exact command.
3. **All input params**: fully enumerated in endpoint request types and validation table.
4. **Success responses**: each endpoint defines `200` response shape.
5. **All error responses**: each endpoint defines complete status/code mapping.
6. **Exact event names**: `azure-devops-status`, `issue-ingest-status`.
7. **Event triggers**: listed in `Events` table.
8. **Event payload shapes**: `AzureDevopsStatusEvent`, `IssueIngestStatusEvent` types above.
9. **Event consumers**: listed in `Events` table.
10. **Per-input validation rules**: listed in `Validation Rules` table.
11. **Validation failure behavior**: provider-aware routes use `400` + `code` + `field_errors`; legacy compatibility route preserves `{ ok:false, error, run }` on `400`; async failures use mapped status codes with sanitized error text.
12. **Sync vs async validation**: explicitly split in `Validation failure behavior`.
13. **Breaking change?** No required breaking change; changes are additive.
14. **Migration path**: viewer migrates from `/api/github/issues/create` to `/api/issues/create`; legacy route remains as compatibility shim for one minor release window.
15. **Versioning**: no URL version bump; keep v1 envelope and add new enum values/types in shared TS contracts.
16. **User actions triggering UI interactions**: each action is explicit in `UI Interactions` table.
17. **User feedback states**: loading/success/error are explicit for every UI action.
18. **UI state changes**: explicit cache/selection/run state updates listed under UI section.

## 4. Data

This feature adds issue-scoped Azure DevOps credential storage, provider-aware issue/work-item metadata, provider-aware PR metadata, and restart-safe operation journal artifacts.

### Schema Changes
| Location | Field | Type | Required | Default | Constraints |
|----------|-------|------|----------|---------|-------------|
| `.jeeves/issue.json` | `status.azureDevops` | `{ sync_status?: AzureDevopsSyncStatus; last_attempt_at?: string \| null; last_success_at?: string \| null; last_error?: string \| null; organization?: string \| null; project?: string \| null; pat_last_updated_at?: string \| null; }` | no | `{}` | if present, must be a JSON object |
| `.jeeves/issue.json` | `status.azureDevops.sync_status` | `"in_sync" \| "deferred_worktree_absent" \| "failed_exclude" \| "failed_env_write" \| "failed_env_delete" \| "failed_secret_read" \| "never_attempted"` | no | `"never_attempted"` | enum only |
| `.jeeves/issue.json` | `status.azureDevops.last_attempt_at` | `string \| null` | no | `null` | ISO-8601 UTC (`Date.toISOString()`) |
| `.jeeves/issue.json` | `status.azureDevops.last_success_at` | `string \| null` | no | `null` | ISO-8601 UTC; when present, `<= last_attempt_at` |
| `.jeeves/issue.json` | `status.azureDevops.last_error` | `string \| null` | no | `null` | sanitized; max 2048 chars; must not contain PAT; no `\0`, `\n`, `\r` |
| `.jeeves/issue.json` | `status.azureDevops.organization` | `string \| null` | no | `null` | canonical URL form `https://dev.azure.com/<orgSlug>`; total length `3..200` |
| `.jeeves/issue.json` | `status.azureDevops.project` | `string \| null` | no | `null` | trimmed length `1..128`; no control chars |
| `.jeeves/issue.json` | `status.azureDevops.pat_last_updated_at` | `string \| null` | no | `null` | ISO-8601 UTC; copied from secret `updated_at` |
| `.jeeves/.secrets/azure-devops.json` | `schemaVersion` | `1` | yes | `1` | literal `1` |
| `.jeeves/.secrets/azure-devops.json` | `organization` | `string` | yes | n/a | canonical URL `https://dev.azure.com/<orgSlug>`; total length `3..200` |
| `.jeeves/.secrets/azure-devops.json` | `project` | `string` | yes | n/a | trimmed length `1..128`; no control chars |
| `.jeeves/.secrets/azure-devops.json` | `pat` | `string` | yes | n/a | trimmed length `1..1024`; no `\0`, `\n`, `\r` |
| `.jeeves/.secrets/azure-devops.json` | `updated_at` | `string` | yes | n/a | ISO-8601 UTC |
| `.jeeves/issue.json` | `issue.source` | `{ provider?: "github" \| "azure_devops"; kind?: "issue" \| "work_item"; id?: string; url?: string \| null; title?: string; mode?: "create" \| "init_existing"; hierarchy?: { parent?: { id: string; title: string; url: string } \| null; children?: Array<{ id: string; title: string; url: string }>; fetched_at?: string \| null; }; }` | no | `{}` (read fallback from legacy `issue.number`, `issue.url`, `issue.title`) | if present, must be a JSON object |
| `.jeeves/issue.json` | `issue.source.provider` | `"github" \| "azure_devops"` | no | `"github"` | enum only |
| `.jeeves/issue.json` | `issue.source.kind` | `"issue" \| "work_item"` | no | `"issue"` | enum only |
| `.jeeves/issue.json` | `issue.source.id` | `string` | no | `String(issue.number)` when available | positive-integer string pattern `^[1-9][0-9]{0,18}$` |
| `.jeeves/issue.json` | `issue.source.url` | `string \| null` | no | `issue.url ?? null` | absolute `https://` URL, max 2048 chars |
| `.jeeves/issue.json` | `issue.source.title` | `string` | no | `issue.title ?? ""` | trimmed length `0..256` |
| `.jeeves/issue.json` | `issue.source.mode` | `"create" \| "init_existing"` | no | `"init_existing"` | enum only |
| `.jeeves/issue.json` | `issue.source.hierarchy.parent` | `{ id: string; title: string; url: string } \| null` | no | `null` | non-null object requires `id` numeric string + `url` absolute `https://` |
| `.jeeves/issue.json` | `issue.source.hierarchy.children` | `Array<{ id: string; title: string; url: string }>` | no | `[]` | each item `id` numeric string + `url` absolute `https://`; max 500 items |
| `.jeeves/issue.json` | `issue.source.hierarchy.fetched_at` | `string \| null` | no | `null` | ISO-8601 UTC |
| `.jeeves/issue.json` | `status.issueIngest` | `{ provider?: "github" \| "azure_devops"; mode?: "create" \| "init_existing"; outcome?: "success" \| "partial" \| "error"; remote_id?: string \| null; remote_url?: string \| null; warnings?: string[]; auto_select_ok?: boolean \| null; auto_run_ok?: boolean \| null; occurred_at?: string \| null; }` | no | `{}` | if present, must be a JSON object |
| `.jeeves/issue.json` | `status.issueIngest.provider` | `"github" \| "azure_devops"` | no | `null` (field absent) | enum only |
| `.jeeves/issue.json` | `status.issueIngest.mode` | `"create" \| "init_existing"` | no | `null` (field absent) | enum only |
| `.jeeves/issue.json` | `status.issueIngest.outcome` | `"success" \| "partial" \| "error"` | no | `null` (field absent) | enum only |
| `.jeeves/issue.json` | `status.issueIngest.remote_id` | `string \| null` | no | `null` | positive-integer string pattern `^[1-9][0-9]{0,18}$` |
| `.jeeves/issue.json` | `status.issueIngest.remote_url` | `string \| null` | no | `null` | absolute `https://` URL, max 2048 chars |
| `.jeeves/issue.json` | `status.issueIngest.warnings` | `string[]` | no | `[]` | each warning max 512 chars; max 50 warnings |
| `.jeeves/issue.json` | `status.issueIngest.auto_select_ok` | `boolean \| null` | no | `null` | boolean semantics only |
| `.jeeves/issue.json` | `status.issueIngest.auto_run_ok` | `boolean \| null` | no | `null` | boolean semantics only |
| `.jeeves/issue.json` | `status.issueIngest.occurred_at` | `string \| null` | no | `null` | ISO-8601 UTC |
| `.jeeves/issue.json` | `pullRequest.provider` | `"github" \| "azure_devops"` | no | `"github"` when `pullRequest.number/url` already exist | enum only |
| `.jeeves/issue.json` | `pullRequest.external_id` | `string` | no | `String(pullRequest.number)` when available | positive-integer string pattern `^[1-9][0-9]{0,18}$` |
| `.jeeves/issue.json` | `pullRequest.source_branch` | `string` | no | `branch` | trimmed length `1..255`; must satisfy git branch-name rules |
| `.jeeves/issue.json` | `pullRequest.target_branch` | `string` | no | `"main"` | trimmed length `1..255`; must satisfy git branch-name rules |
| `.jeeves/issue.json` | `pullRequest.updated_at` | `string \| null` | no | `null` | ISO-8601 UTC |
| `.jeeves/issue.json` | `status.prCreated` (modified semantics) | `boolean` | no | `false` | now provider-agnostic; true only after `pullRequest` metadata persistence |
| `.jeeves/issue.json` | `issue.number` (modified semantics) | `number` | yes | existing value | positive integer; for Azure-backed issues this stores work item ID |
| `.jeeves/issue.json` | `issue.url` (modified semantics) | `string \| undefined` | no | existing value | absolute remote item URL when set |
| `.jeeves/issue.json` | `issue.title` (modified semantics) | `string \| undefined` | no | existing value | trimmed length `1..256` when set |
| `.jeeves/.ops/provider-operation.json` | `schemaVersion` | `1` | yes | `1` | literal `1` |
| `.jeeves/.ops/provider-operation.json` | `operation_id` | `string` | yes | n/a | UUID-like ID (`^[a-zA-Z0-9._:-]{8,128}$`) |
| `.jeeves/.ops/provider-operation.json` | `kind` | `"credentials" \| "ingest" \| "pr_prepare"` | yes | n/a | enum only |
| `.jeeves/.ops/provider-operation.json` | `state` | `string` | yes | n/a | state name pattern `^(cred|ingest|pr)\\.[a-z_]+$` |
| `.jeeves/.ops/provider-operation.json` | `issue_ref` | `string` | yes | n/a | format `<owner>/<repo>#<number>` |
| `.jeeves/.ops/provider-operation.json` | `provider` | `"github" \| "azure_devops" \| null` | no | `null` | enum/null |
| `.jeeves/.ops/provider-operation.json` | `started_at` | `string` | yes | n/a | ISO-8601 UTC |
| `.jeeves/.ops/provider-operation.json` | `updated_at` | `string` | yes | n/a | ISO-8601 UTC |
| `.jeeves/.ops/provider-operation.json` | `completed_at` | `string \| null` | no | `null` | ISO-8601 UTC when terminal |
| `.jeeves/.ops/provider-operation.json` | `checkpoint.remote_id` | `string \| null` | no | `null` | positive-integer string pattern |
| `.jeeves/.ops/provider-operation.json` | `checkpoint.remote_url` | `string \| null` | no | `null` | absolute `https://` URL |
| `.jeeves/.ops/provider-operation.json` | `checkpoint.pr_id` | `string \| null` | no | `null` | positive-integer string pattern |
| `.jeeves/.ops/provider-operation.json` | `checkpoint.issue_state_persisted` | `boolean` | no | `false` | boolean semantics only |
| `.jeeves/.ops/provider-operation.json` | `checkpoint.init_completed` | `boolean` | no | `false` | boolean semantics only |
| `.jeeves/.ops/provider-operation.json` | `checkpoint.auto_selected` | `boolean` | no | `false` | boolean semantics only |
| `.jeeves/.ops/provider-operation.json` | `checkpoint.auto_run_started` | `boolean` | no | `false` | boolean semantics only |
| `.jeeves/.ops/provider-operation.json` | `checkpoint.warnings` | `string[]` | no | `[]` | each warning max 512 chars; max 50 warnings |
| `.jeeves/.ops/provider-operation.lock` | `schemaVersion` | `1` | yes | `1` | literal `1` |
| `.jeeves/.ops/provider-operation.lock` | `operation_id` | `string` | yes | n/a | must match current journal `operation_id` |
| `.jeeves/.ops/provider-operation.lock` | `issue_ref` | `string` | yes | n/a | format `<owner>/<repo>#<number>` |
| `.jeeves/.ops/provider-operation.lock` | `acquired_at` | `string` | yes | n/a | ISO-8601 UTC |
| `.jeeves/.ops/provider-operation.lock` | `expires_at` | `string` | yes | n/a | ISO-8601 UTC; must be `>= acquired_at` |
| `.jeeves/.ops/provider-operation.lock` | `pid` | `number` | yes | n/a | integer `>= 1` |

**Secret storage invariant**:
- `pat` MUST never be stored in `.jeeves/issue.json`, SSE/WS payloads, or logs.
- `pat` exists only in `.jeeves/.secrets/azure-devops.json` (and short-lived temp files during atomic write).

### Field Definitions
**`status.azureDevops.*`**
- Purpose: Store non-secret Azure credential sync state and non-secret org/project context for selected issue.
- Set by: `/api/issue/azure-devops` PUT/PATCH/DELETE/reconcile and startup/issue-select auto-reconcile.
- Read by: `GET /api/issue/azure-devops`, `azure-devops-status` event emission, provider ingress validation.
- Relationships:
  - `organization`/`project` mirror secret-file values (non-secret copy) and must stay in sync after successful secret writes.
  - `pat_last_updated_at` references `.jeeves/.secrets/azure-devops.json.updated_at`.
- Ordering dependencies: secret write/delete must complete before these status fields are updated.

**`.jeeves/.secrets/azure-devops.json`**
- Purpose: Issue-scoped persistence of Azure organization/project/PAT used by `az` commands and worktree env materialization.
- Set by: `/api/issue/azure-devops` PUT/PATCH (write), DELETE (remove).
- Read by: Azure ingest and PR provider adapters; status endpoint; reconcile logic.
- Relationships:
  - Primary source for credential truth; `status.azureDevops.*` is derived/summary metadata.
  - Deleting this file means no configured PAT (`has_pat=false` on read).
- Ordering dependencies: written atomically before any worktree-side `.env.jeeves` mutation.

**`issue.source.*` and `issue.number/url/title` (modified semantics)**
- Purpose: Provider-agnostic canonical reference to the remote source artifact (GitHub issue or Azure work item) plus optional hierarchy context.
- Set by: `/api/issues/create` and `/api/issues/init-from-existing` after remote create/resolve/hierarchy fetch.
- Read by: prompt context generation, provider-aware `prepare_pr`, viewer issue details.
- Relationships:
  - `issue.source.id` must correspond to remote source ID and match `issue.number` (numeric parse) for compatibility.
  - `issue.source.hierarchy.parent/children` reference remote work items; they are snapshots (not live foreign keys).
  - If remote parent/child items are deleted later, local snapshot remains until next ingest/re-sync.
- Ordering dependencies: remote create/resolve must succeed before writing `issue.source.*`; hierarchy fields are written only after hierarchy fetch attempt.

**`status.issueIngest.*`**
- Purpose: Persist last ingest attempt summary for deterministic UI/state replay and post-crash diagnostics.
- Set by: `ingest.recording_status` in both create/init-existing flows.
- Read by: create-issue UI state, status stream/cache hydration, support diagnostics.
- Relationships:
  - `remote_id`/`remote_url` must match `issue.source.id`/`issue.source.url` for the same completed ingest operation.
- Ordering dependencies: set after `issue.source.*` persistence attempt so partial outcomes can be represented safely.

**`pullRequest.*` extensions and `status.prCreated` (modified semantics)**
- Purpose: Keep provider-agnostic PR metadata while preserving existing workflow gating on `status.prCreated`.
- Set by: provider-aware `prepare_pr` flow after existing-PR lookup or create.
- Read by: workflow transition guard (`status.prCreated`), prompts, viewer links.
- Relationships:
  - `pullRequest.provider` must match the backend used in the same operation.
  - `pullRequest.external_id` maps to GitHub PR number or Azure PR ID string.
  - If remote PR is closed/deleted externally, local metadata remains until next `prepare_pr` refresh.
- Ordering dependencies: PR lookup/create must complete before writing `pullRequest.*`; `status.prCreated=true` is written only in the same commit as PR metadata.

**`.jeeves/.ops/provider-operation.json` + `.jeeves/.ops/provider-operation.lock`**
- Purpose: Restart-safe operation checkpoints for credential, ingest, and PR operations.
- Set by: entry to `cred.validating` / `ingest.validating` / `pr.loading_context`; updated each transition checkpoint; finalized in terminal state.
- Read by: startup recovery path before accepting new provider mutations.
- Relationships:
  - `lock.operation_id` must equal journal `operation_id`.
  - `checkpoint.remote_id`/`pr_id` reference remote artifacts for idempotent resume.
- Ordering dependencies:
  - Acquire lock file first.
  - Create/update journal second.
  - Perform side effects.
  - Mark `completed_at` and then remove lock.

### Data Gates (Explicit Answers)
1. Exact field names/paths are listed exhaustively in `Schema Changes`.
2. Exact types are listed for every field in `Schema Changes` (no `any`/untyped objects).
3. Required vs optional is explicit in the `Required` column.
4. Default when absent is explicit in the `Default` column for every optional field.
5. Constraints are explicit in the `Constraints` column.
6. Reference relationships:
   - `issue.source.*` references remote issue/work-item IDs and URLs.
   - `pullRequest.*` references remote PR IDs/URLs.
   - operation journal checkpoint fields reference remote IDs/URLs and local state persistence checkpoints.
7. Referenced-data deletion behavior:
   - If remote issue/work-item/PR is deleted externally, local metadata is retained as last-known snapshot and refreshed on next provider operation.
   - If issue state directory is deleted, secret/journal/lock artifacts are deleted with it.
8. Ordering dependencies:
   - lock acquire -> journal write -> remote/local mutation -> status persistence -> journal `completed_at` -> lock removal.
   - secret persistence precedes worktree `.env.jeeves` writes.
   - remote resolve/create precedes `issue.source.*` and `pullRequest.*` writes.
9. Breaking change? No hard breaking schema change; changes are additive plus semantic broadening of existing fields (`issue.number/url/title`, `status.prCreated`).
10. Existing records without fields:
   - treated with defaults listed above (e.g., missing `status.azureDevops.sync_status` => `"never_attempted"`).
   - legacy PR records (`pullRequest.number/url` only) derive `pullRequest.provider="github"` and `pullRequest.external_id=String(number)`.
11. Migration script needed? No offline one-time script is required; lazy defaults and on-write normalization are sufficient.
12. Rollback:
   - stop writing new fields/files;
   - ignore/remove `status.azureDevops.*`, `issue.source.*`, `status.issueIngest.*`, `pullRequest` extensions;
   - delete `.jeeves/.secrets/azure-devops.json`, `.jeeves/.ops/provider-operation.json`, and `.jeeves/.ops/provider-operation.lock`.
13. Derived fields:
   - API response fields `configured`, `has_pat`, and `worktree_present` are derived at read time from secret existence/worktree state.
   - `pat_env_var_name` is constant (`AZURE_DEVOPS_EXT_PAT`) and not persisted.
14. Computation timing:
   - derived status fields above compute on read;
   - sync/journal/ingest/PR metadata compute on write at operation checkpoints.
15. Source-data change handling:
   - remote hierarchy/PR/source snapshots can become stale; next ingest or PR-prep refresh overwrites them.
   - secret file changes immediately affect derived `has_pat/configured` on next read.
16. Artifacts created are listed in `Artifacts`.
17. Storage location for each artifact is listed in `Artifacts`.
18. Create/update/delete timing for each artifact is listed in `Artifacts`.
19. Success/failure/crash outcomes are defined in `Artifact Lifecycle`.

### Migrations
| Change | Existing Data | Migration | Rollback |
|--------|---------------|-----------|----------|
| Add Azure non-secret status fields under `status.azureDevops.*` | Fields absent | Treat absent as defaults; first successful credential/reconcile operation writes canonical values | Remove these fields and fall back to defaults |
| Add Azure credential secret file `.jeeves/.secrets/azure-devops.json` | File absent | No-op until first PUT/PATCH with PAT; then atomic create with restrictive perms (`0600` where supported) | Delete file and ignore PAT-dependent flows |
| Add provider source metadata `issue.source.*` | Field absent | Fallback to legacy `issue.number/url/title` at read; on first ingest write canonical `issue.source.*` | Remove `issue.source.*`; continue using legacy fields |
| Add ingest summary `status.issueIngest.*` | Field absent | No-op until first provider ingest operation completes/partially completes/errors | Remove field |
| Extend `pullRequest` with provider-aware fields | Legacy objects may only have `number/url` | On read derive `provider="github"` and `external_id=String(number)` when missing | Remove extensions; keep `number/url` only |
| Add restart artifacts `.jeeves/.ops/provider-operation.json` and `.jeeves/.ops/provider-operation.lock` | Files absent | Create on first provider mutation; remove lock at terminal states | Stop creating files and delete residual files |

### Artifacts
| Artifact | Location | Created | Updated | Deleted |
|----------|----------|---------|---------|---------|
| Azure credential secret | `.jeeves/.secrets/azure-devops.json` | successful PUT/PATCH with PAT | successful PUT/PATCH with PAT | successful DELETE or issue-state removal |
| Azure secret temp file | `.jeeves/.secrets/azure-devops.json.<pid>.<ts>.tmp` | during atomic secret write | per write attempt | after successful rename; cleanup on delete/startup recovery |
| Azure status metadata | `.jeeves/issue.json` (`status.azureDevops.*`) | first credential/reconcile write | each credential/reconcile attempt | issue-state removal only |
| Provider source metadata | `.jeeves/issue.json` (`issue.source.*`, plus compatible `issue.number/url/title`) | first create/init-existing success or partial-with-remote | each subsequent create/init-existing persistence | issue-state removal only |
| Ingest summary metadata | `.jeeves/issue.json` (`status.issueIngest.*`) | first ingest terminal state | each ingest terminal state | issue-state removal only |
| Provider PR metadata | `.jeeves/issue.json` (`pullRequest.*`, `status.prCreated`) | first successful provider PR persist | each subsequent PR reuse/create persist | issue-state removal only |
| Operation journal | `.jeeves/.ops/provider-operation.json` | entry to credentials/ingest/pr_prepare op | every state checkpoint | explicit cleanup after terminal write or issue-state removal |
| Operation lock | `.jeeves/.ops/provider-operation.lock` | before journal open | refreshed while operation active | terminal success/failure; stale-lock cleanup on recovery |
| Worktree env file | `<worktreeRoot>/.env.jeeves` | first successful reconcile with PAT/worktree | each reconcile while worktree present | PAT delete with worktree present or worktree removal |
| Worktree env temp | `<worktreeRoot>/.env.jeeves.tmp` | during atomic env write | per reconcile attempt | after rename; cleanup on startup/reconcile |
| Git exclude entries | `<worktreeRoot>/.git/info/exclude` | first reconcile with worktree | idempotent append/dedupe | never explicitly removed |

### Artifact Lifecycle
| Scenario | Artifact Behavior |
|----------|-------------------|
| Success | Secret file converges to desired organization/project/PAT; `status.azureDevops.*` records success timestamps and `sync_status=in_sync`; `issue.source.*` and `status.issueIngest.*` match remote result; `pullRequest.*` and `status.prCreated=true` persist together; journal `completed_at` written; lock removed. |
| Failure | If lock or journal creation fails, abort before remote mutation. If remote mutation fails before remote IDs, mark journal failed and keep prior `issue.json` metadata. If remote mutation succeeds but local persistence/init/select/auto-run fails, keep remote ID in journal + `status.issueIngest.outcome="partial"`, preserve retry context, and remove lock. Secret/read/reconcile failures update `status.azureDevops.last_error` with sanitized message. |
| Crash recovery | On startup, detect stale lock (`expires_at`), incomplete journal (`completed_at=null`), or temp files; remove stale lock/temp files; reload remote state by checkpoint IDs; resume from journal `state` (`cred.reconciling_worktree`, `ingest.persisting_issue_state`/`ingest.recording_status`, or `pr.checking_existing`); ensure idempotent writes before marking journal complete. |

## 5. Tasks

### Inputs From Sections 1-4 (Traceability)
- **Goals (Section 1)**:
  1. Add issue-scoped Azure DevOps credential management without leaking PAT values.
  2. Add provider-aware Create Issue flow that supports Azure Boards item creation plus optional init/select/auto-run.
  3. Add init-from-existing for Azure work items (ID or URL) and persist hierarchy context.
  4. Add provider-aware PR preparation while preserving existing GitHub behavior.
- **Workflow (Section 2)**:
  - Implement credential, ingest, and PR state-machine transitions under per-issue serialization.
  - Implement partial-success terminals (`ingest.done_partial`) and deterministic crash recovery using operation checkpoints.
- **Interfaces (Section 3)**:
  - Build/extend 8 HTTP endpoints, 2 stream events, and provider CLI adapter paths for `gh` and `az`.
  - Preserve `/api/github/issues/create` compatibility envelope while introducing `/api/issues/create` and `/api/issues/init-from-existing`.
- **Data (Section 4)**:
  - Add Azure secret/status fields, provider source/ingest/PR metadata, and operation journal/lock artifacts.
  - Use additive/lazy migration behavior with backward-compatible defaults.

### Planning Gates (Explicit Answers)
1. **Smallest independently testable unit**: a single pure validator/helper module (for example, Azure request validation or operation-journal checkpoint transition) validated by unit tests.
2. **Dependencies between tasks**: yes; provider adapters and persistence helpers must exist before provider-aware ingest endpoints can be wired.
3. **Parallelizable tasks**: yes; secret/reconcile primitives, operation journaling, and provider adapter work can proceed in parallel once contracts are fixed.
4. **Specific files per task**: explicitly listed in each Task Details section under `Files`.
5. **Acceptance criteria per task**: explicitly listed in each Task Details section under `Acceptance Criteria`.
6. **Verification command per task**: explicitly listed in each Task Details section under `Verification`.
7. **Must be done first**: provider contract/types (T1) and operation-journal locking primitives (T3), because downstream routes and UI need stable contracts + checkpoint semantics.
8. **Can only be done last**: provider-aware prompt/doc updates plus full-system quality pass (T10) after endpoint/UI behavior is stable.
9. **Circular dependencies**: none; the graph is a DAG (server primitives -> server routes -> viewer wiring -> prompt/docs).
10. **Build/config changes needed**: no TypeScript project-reference changes are required; existing workspace build graph is sufficient.
11. **New dependencies to install**: no new npm dependencies are required; implementation uses existing runtime/tooling plus external CLIs (`gh`, `az`).
12. **Environment variables or secrets needed**: Azure PAT is issue-scoped in `.jeeves/.secrets/azure-devops.json`; worktree reconciliation materializes `AZURE_DEVOPS_EXT_PAT` in `.env.jeeves`; runtime requires authenticated `gh` and `az` (with Azure DevOps extension available).

### Goal-to-Task Mapping
| Goal | Mapped Tasks |
|------|---------------|
| G1. Azure credential storage + PAT safety | T1, T2, T5 |
| G2. Provider-aware create issue/work item flow | T4, T6, T8, T9 |
| G3. Init-from-existing + hierarchy persistence | T4, T6, T7, T9, T10 |
| G4. Provider-aware PR preparation | T4, T7, T10 |

### Task Dependency Graph
```
T1 (no deps)
T3 (no deps)
T2 -> depends on T1
T4 -> depends on T1
T7 -> depends on T1, T3
T5 -> depends on T1, T2, T3
T6 -> depends on T1, T3, T4, T7
T8 -> depends on T5, T6
T9 -> depends on T8
T10 -> depends on T6, T9
```

### Task Breakdown
| ID | Title | Summary | Files | Acceptance Criteria |
|----|-------|---------|-------|---------------------|
| T1 | Provider Contracts and Validation | Add typed Azure/provider request-response contracts and validation helpers that match Section 3. | `apps/viewer-server/src/azureDevopsTypes.ts`, `apps/viewer-server/src/azureDevopsTypes.test.ts`, `apps/viewer/src/api/azureDevopsTypes.ts`, `apps/viewer/src/api/types.ts` | Contracts match endpoint/event schemas and validation returns deterministic `code` + `field_errors`. |
| T2 | Azure Secret and Reconcile Primitives | Implement issue-scoped Azure secret persistence and worktree reconcile behavior. | `apps/viewer-server/src/azureDevopsSecret.ts`, `apps/viewer-server/src/azureDevopsSecret.test.ts`, `apps/viewer-server/src/azureDevopsReconcile.ts`, `apps/viewer-server/src/azureDevopsReconcile.test.ts`, `apps/viewer-server/src/gitExclude.ts` | Secret writes are atomic and reconcile returns expected sync statuses without exposing PAT. |
| T3 | Operation Journal and Locking | Add provider-operation journal/lock primitives and startup stale-artifact recovery hooks. | `apps/viewer-server/src/providerOperationJournal.ts`, `apps/viewer-server/src/providerOperationJournal.test.ts`, `apps/viewer-server/src/server.ts` | Lock/journal lifecycle is crash-safe and resumable checkpoints are persisted exactly once per transition checkpoint. |
| T4 | Provider CLI Adapters | Add provider adapters for GitHub/Azure create/init/hierarchy and PR query/create operations. | `apps/viewer-server/src/providerIssueAdapter.ts`, `apps/viewer-server/src/providerIssueAdapter.test.ts`, `apps/viewer-server/src/providerPrAdapter.ts`, `apps/viewer-server/src/providerPrAdapter.test.ts`, `apps/viewer-server/src/githubIssueCreate.ts` | Adapter outputs are normalized and errors map to Section 3 status/code contracts. |
| T5 | Azure Credential Endpoints and Events | Implement `/api/issue/azure-devops*` endpoints plus `azure-devops-status` event emission and auto-reconcile hooks. | `apps/viewer-server/src/server.ts`, `apps/viewer-server/src/init.ts`, `apps/viewer-server/src/server.test.ts` | All Azure credential endpoints honor validation/error matrix, mutex behavior, PAT redaction, and event emission rules. |
| T6 | Provider-Aware Ingest Endpoints | Implement `/api/issues/create` and `/api/issues/init-from-existing` plus legacy route compatibility shim behavior. | `apps/viewer-server/src/server.ts`, `apps/viewer-server/src/types.ts`, `apps/viewer-server/src/issueJson.ts`, `apps/viewer-server/src/server.test.ts` | Provider-aware endpoints produce `IngestResponse` (`success|partial`) and legacy route preserves existing envelope semantics. |
| T7 | Provider Metadata Persistence | Implement helpers/defaults for `issue.source.*`, `status.issueIngest.*`, and provider-aware `pullRequest.*` persistence. | `apps/viewer-server/src/providerIssueState.ts`, `apps/viewer-server/src/providerIssueState.test.ts`, `packages/core/src/issueState.ts`, `packages/core/src/issueState.test.ts` | Provider metadata persists with additive defaults and legacy records remain readable without offline migration. |
| T8 | Viewer Contracts and Stream Wiring | Add viewer-side contract types and stream reducers for new Azure and ingest events. | `apps/viewer/src/api/types.ts`, `apps/viewer/src/api/azureDevopsTypes.ts`, `apps/viewer/src/stream/streamTypes.ts`, `apps/viewer/src/stream/streamReducer.ts`, `apps/viewer/src/stream/ViewerStreamProvider.tsx`, `apps/viewer/src/stream/streamReducer.test.ts` | Streamed `azure-devops-status` and `issue-ingest-status` updates are reflected in viewer state/cache without SDK-event regression. |
| T9 | Viewer Azure + Provider Create UI | Implement Azure settings UI and provider-aware Create Issue / init-from-existing UX. | `apps/viewer/src/features/azureDevops/api.ts`, `apps/viewer/src/features/azureDevops/queries.ts`, `apps/viewer/src/pages/AzureDevopsPage.tsx`, `apps/viewer/src/pages/AzureDevopsPage.css`, `apps/viewer/src/pages/AzureDevopsPage.test.tsx`, `apps/viewer/src/pages/CreateIssuePage.tsx`, `apps/viewer/src/pages/CreateIssuePage.test.ts`, `apps/viewer/src/features/mutations.ts`, `apps/viewer/src/app/router.tsx`, `apps/viewer/src/layout/AppShell.tsx` | Users can configure Azure credentials and run provider-aware create/init flows with clear loading/success/error states. |
| T10 | Provider-Aware PR Prompting and Docs | Update PR-preparation/prompt context wiring and documentation, then run full quality checks. | `prompts/pr.prepare.md`, `prompts/task.plan.md`, `prompts/task.decompose.md`, `docs/viewer-server-api.md`, `apps/viewer-server/CLAUDE.md` | PR prep is provider-aware (`gh`/`az`), hierarchy context is referenced in planning prompts, and workspace quality checks pass. |

### Task Details

**T1: Provider Contracts and Validation**
- Summary: Introduce shared Azure/provider contract and validation definitions so backend and viewer agree on exact request/response/event shapes.
- Files:
  - `apps/viewer-server/src/azureDevopsTypes.ts` - Azure status/mutate/ingest contract types, validator functions, and sanitized error helpers.
  - `apps/viewer-server/src/azureDevopsTypes.test.ts` - validation/error-sanitization tests for all Section 3 rule branches.
  - `apps/viewer/src/api/azureDevopsTypes.ts` - viewer type mirror for Azure credential and ingest/event contracts.
  - `apps/viewer/src/api/types.ts` - re-export/union updates for new event and request types.
- Acceptance Criteria:
  1. Validation rules in Section 3 (`organization`, `project`, `pat`, provider enums, existing ID/URL rules) are implemented with deterministic field-level errors.
  2. Types cover all new endpoint payloads and events (`azure-devops-status`, `issue-ingest-status`) with no `any`.
  3. Sanitized error helpers strip forbidden characters and never include PAT text.
- Dependencies: None
- Verification: `pnpm test -- apps/viewer-server/src/azureDevopsTypes.test.ts`

**T2: Azure Secret and Reconcile Primitives**
- Summary: Implement atomic Azure credential secret storage and worktree reconcile behavior modeled after the Sonar token lifecycle.
- Files:
  - `apps/viewer-server/src/azureDevopsSecret.ts` - read/write/delete helpers for `.jeeves/.secrets/azure-devops.json`.
  - `apps/viewer-server/src/azureDevopsSecret.test.ts` - atomic write/delete/cleanup and schema-validation tests.
  - `apps/viewer-server/src/azureDevopsReconcile.ts` - reconcile `.env.jeeves` + `.git/info/exclude` for `AZURE_DEVOPS_EXT_PAT`.
  - `apps/viewer-server/src/azureDevopsReconcile.test.ts` - sync-status and warning-path tests (`in_sync`, deferred, failed_*).
  - `apps/viewer-server/src/gitExclude.ts` - shared exclude helper updates for Azure env patterns.
- Acceptance Criteria:
  1. Secret persistence is atomic and writes only `{ schemaVersion, organization, project, pat, updated_at }`.
  2. PAT deletion removes secret state idempotently and reconcile removes stale `.env.jeeves` when applicable.
  3. Reconcile result status and warnings match the Section 4 sync-status semantics.
- Dependencies: T1
- Verification: `pnpm test -- apps/viewer-server/src/azureDevopsSecret.test.ts apps/viewer-server/src/azureDevopsReconcile.test.ts`

**T3: Operation Journal and Locking**
- Summary: Add crash-safe lock/journal primitives for credentials, ingest, and PR operations.
- Files:
  - `apps/viewer-server/src/providerOperationJournal.ts` - lock acquire/release, journal checkpoint write/update/finalize helpers.
  - `apps/viewer-server/src/providerOperationJournal.test.ts` - stale lock, incomplete journal, and checkpoint-resume tests.
  - `apps/viewer-server/src/server.ts` - startup recovery integration for stale lock/temp cleanup and resume checkpoints.
- Acceptance Criteria:
  1. `.jeeves/.ops/provider-operation.lock` and `.jeeves/.ops/provider-operation.json` follow Section 4 schema and ordering.
  2. Lock timeout/cleanup behavior is deterministic and prevents concurrent mutation races.
  3. Startup recovery detects stale/incomplete artifacts and returns a resumable checkpoint state.
- Dependencies: None
- Verification: `pnpm test -- apps/viewer-server/src/providerOperationJournal.test.ts`

**T4: Provider CLI Adapters**
- Summary: Implement provider adapter modules for GitHub and Azure issue/work-item creation, existing-item lookup, hierarchy lookup, and PR lookup/create.
- Files:
  - `apps/viewer-server/src/providerIssueAdapter.ts` - `gh issue create/view` and `az boards work-item create/show` adapters.
  - `apps/viewer-server/src/providerIssueAdapter.test.ts` - success/error mapping and output-normalization tests.
  - `apps/viewer-server/src/providerPrAdapter.ts` - `gh pr list/create` and `az repos pr list/create` adapters.
  - `apps/viewer-server/src/providerPrAdapter.test.ts` - existing-PR and create-path behavior tests.
  - `apps/viewer-server/src/githubIssueCreate.ts` - shared GitHub parser/error mapping reuse.
- Acceptance Criteria:
  1. Adapter output is normalized to provider-agnostic objects (`id`, `url`, `title`, `kind`, hierarchy/pr metadata).
  2. Adapter failures map to documented status/code categories (`provider_auth_required`, `provider_permission_denied`, `provider_timeout`, etc.).
  3. No adapter path logs or returns PAT values.
- Dependencies: T1
- Verification: `pnpm test -- apps/viewer-server/src/providerIssueAdapter.test.ts apps/viewer-server/src/providerPrAdapter.test.ts`

**T5: Azure Credential Endpoints and Events**
- Summary: Add Azure credential lifecycle endpoints, event emission, and auto-reconcile triggers around startup/issue selection/init.
- Files:
  - `apps/viewer-server/src/server.ts` - implement `GET/PUT/PATCH/DELETE /api/issue/azure-devops` and `POST /api/issue/azure-devops/reconcile`.
  - `apps/viewer-server/src/init.ts` - invoke post-init auto-reconcile for selected issue when Azure credentials are configured.
  - `apps/viewer-server/src/server.test.ts` - endpoint contract tests, mutex behavior, PAT redaction checks, and event emission tests.
- Acceptance Criteria:
  1. Endpoint envelopes and status/code matrix match Section 3 exactly.
  2. `azure-devops-status` is emitted after successful mutate/reconcile and auto-reconcile paths.
  3. All responses/events/logs exclude PAT while preserving non-secret status details.
- Dependencies: T1, T2, T3
- Verification: `pnpm test -- apps/viewer-server/src/server.test.ts`

**T6: Provider-Aware Ingest Endpoints**
- Summary: Add provider-aware create/init-from-existing endpoints and preserve legacy GitHub create route compatibility.
- Files:
  - `apps/viewer-server/src/server.ts` - implement `/api/issues/create`, `/api/issues/init-from-existing`, and legacy shim mapping.
  - `apps/viewer-server/src/types.ts` - route-level type updates for provider-aware payload/result wiring.
  - `apps/viewer-server/src/issueJson.ts` - helper updates used by ingest persistence flow.
  - `apps/viewer-server/src/server.test.ts` - create/init-existing success/partial/error and legacy-envelope regression tests.
- Acceptance Criteria:
  1. Provider-aware endpoints accept GitHub/Azure payloads and return `IngestResponse` with `outcome=success|partial`.
  2. Legacy `/api/github/issues/create` behavior remains backward-compatible while internally delegating to provider-aware logic.
  3. Partial-success handling preserves remote references and warnings per workflow design.
- Dependencies: T1, T3, T4, T7
- Verification: `pnpm test -- apps/viewer-server/src/server.test.ts`

**T7: Provider Metadata Persistence**
- Summary: Persist provider-aware source/ingest/PR metadata and additive defaults without requiring offline migration.
- Files:
  - `apps/viewer-server/src/providerIssueState.ts` - helpers to read/write `issue.source.*`, `status.issueIngest.*`, and `pullRequest.*`.
  - `apps/viewer-server/src/providerIssueState.test.ts` - persistence, fallback-default, and partial-outcome consistency tests.
  - `packages/core/src/issueState.ts` - additive parsing/normalization updates for provider-aware fields.
  - `packages/core/src/issueState.test.ts` - legacy compatibility and new-field normalization coverage.
- Acceptance Criteria:
  1. Metadata writes enforce Section 4 constraints (ID patterns, URL shape, timestamps, enum values).
  2. Legacy records still load with documented defaults (`issue.source` fallback, legacy PR derivation).
  3. `status.prCreated` semantics are provider-agnostic and only set after PR metadata persistence.
- Dependencies: T1, T3
- Verification: `pnpm test -- apps/viewer-server/src/providerIssueState.test.ts packages/core/src/issueState.test.ts`

**T8: Viewer Contracts and Stream Wiring**
- Summary: Update viewer request/response/event contracts and stream reducers for Azure credential and ingest status events.
- Files:
  - `apps/viewer/src/api/types.ts` - provider-aware create/init payload/result and event typings.
  - `apps/viewer/src/api/azureDevopsTypes.ts` - Azure status/mutate payload and event definitions.
  - `apps/viewer/src/stream/streamTypes.ts` - add stream action/state types for `azure-devops-status` and `issue-ingest-status`.
  - `apps/viewer/src/stream/streamReducer.ts` - reduce new events into state.
  - `apps/viewer/src/stream/ViewerStreamProvider.tsx` - route websocket events to new reducer actions/cache updates.
  - `apps/viewer/src/stream/streamReducer.test.ts` - event-handling behavior tests.
- Acceptance Criteria:
  1. Viewer stream layer handles new events without adding noise to existing SDK event timelines.
  2. Incoming event payloads update relevant cached state for the active issue.
  3. Typecheck passes with no duplicate/incompatible contract definitions.
- Dependencies: T5, T6
- Verification: `pnpm test -- apps/viewer/src/stream/streamReducer.test.ts && pnpm typecheck`

**T9: Viewer Azure + Provider Create UI**
- Summary: Add Azure settings page and provider-aware Create Issue UX (including init-from-existing path).
- Files:
  - `apps/viewer/src/features/azureDevops/api.ts` - Azure settings endpoint wrappers.
  - `apps/viewer/src/features/azureDevops/queries.ts` - query/mutation hooks for Azure settings.
  - `apps/viewer/src/pages/AzureDevopsPage.tsx` - Azure credentials status/save/remove/reconcile UI.
  - `apps/viewer/src/pages/AzureDevopsPage.css` - page styles using design tokens.
  - `apps/viewer/src/pages/AzureDevopsPage.test.tsx` - UI behavior tests for loading/success/error states.
  - `apps/viewer/src/pages/CreateIssuePage.tsx` - provider selector, Azure fields, and init-from-existing controls/results.
  - `apps/viewer/src/pages/CreateIssuePage.test.ts` - request-building and local validation tests.
  - `apps/viewer/src/features/mutations.ts` - provider-aware mutations for `/api/issues/create` and `/api/issues/init-from-existing`.
  - `apps/viewer/src/app/router.tsx` - route registration for Azure settings.
  - `apps/viewer/src/layout/AppShell.tsx` - navigation entry for Azure settings.
- Acceptance Criteria:
  1. Users can configure Azure credentials with inline validation errors and no PAT echo.
  2. Create Issue supports both `create` and `init-from-existing` provider-aware flows.
  3. UI displays remote links, hierarchy summaries, warnings, and auto-select/auto-run outcomes.
- Dependencies: T8
- Verification: `pnpm test -- apps/viewer/src/pages/CreateIssuePage.test.ts apps/viewer/src/features/mutations.test.ts apps/viewer/src/pages/AzureDevopsPage.test.tsx && pnpm typecheck`

**T10: Provider-Aware PR Prompting and Docs**
- Summary: Update prompt/docs behavior for provider-aware PR preparation and hierarchy-aware planning context, then run full quality checks.
- Files:
  - `prompts/pr.prepare.md` - provider-routed PR lookup/create instructions (`gh` vs `az`) and provider-aware persistence fields.
  - `prompts/task.plan.md` - hierarchy-aware planning context guidance.
  - `prompts/task.decompose.md` - hierarchy-aware decomposition context guidance.
  - `docs/viewer-server-api.md` - API + event documentation for new provider-aware endpoints/contracts.
  - `apps/viewer-server/CLAUDE.md` - reusable module-level notes for Azure credential/ingest lifecycle conventions.
- Acceptance Criteria:
  1. PR prep prompt selects provider commands from issue metadata and persists provider-aware PR fields.
  2. Planning/decompose prompts instruct agents to use `issue.source.hierarchy` when available.
  3. API docs describe new endpoints/events and legacy compatibility route behavior.
  4. Repository quality checks pass.
- Dependencies: T6, T9
- Verification: `pnpm lint && pnpm typecheck && pnpm test`

## 6. Validation

### Pre-Implementation Checks
- [ ] All dependencies installed: `pnpm install`
- [ ] Types check: `pnpm typecheck`
- [ ] Existing tests pass: `pnpm test`

### Post-Implementation Checks
- [ ] Types check: `pnpm typecheck`
- [ ] Lint passes: `pnpm lint`
- [ ] All tests pass: `pnpm test`
- [ ] New tests added for: `apps/viewer-server/src/azureDevopsTypes.test.ts`, `apps/viewer-server/src/azureDevopsSecret.test.ts`, `apps/viewer-server/src/azureDevopsReconcile.test.ts`, `apps/viewer-server/src/providerOperationJournal.test.ts`, `apps/viewer-server/src/providerIssueAdapter.test.ts`, `apps/viewer-server/src/providerPrAdapter.test.ts`, `apps/viewer-server/src/providerIssueState.test.ts`, `apps/viewer/src/pages/AzureDevopsPage.test.tsx`

### Manual Verification (if applicable)
- [ ] Verify Azure settings UI can GET/PUT/PATCH/DELETE/reconcile credentials without exposing PAT.
- [ ] Verify Create Issue supports provider-aware create and init-from-existing, including Azure hierarchy rendering.
- [ ] Verify stream-driven UI updates for `azure-devops-status` and `issue-ingest-status` without page refresh.
- [ ] Verify `prepare_pr` on a GitHub-backed issue still uses `gh` flow and preserves existing behavior.
- [ ] Verify `prepare_pr` on an Azure-backed issue uses `az repos pr` flow and persists provider-aware PR metadata.
