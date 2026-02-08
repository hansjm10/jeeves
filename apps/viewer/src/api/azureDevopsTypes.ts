/**
 * Types for Azure DevOps provider integration API.
 *
 * These types mirror the viewer-server types for typed API calls.
 *
 * IMPORTANT: PAT values are NEVER included in status, response, or event types.
 */

// ============================================================================
// Enums
// ============================================================================

/**
 * Sync status enum for Azure DevOps worktree reconciliation state.
 */
export type AzureDevopsSyncStatus =
  | 'in_sync'
  | 'deferred_worktree_absent'
  | 'failed_exclude'
  | 'failed_env_write'
  | 'failed_env_delete'
  | 'failed_secret_read'
  | 'never_attempted';

/**
 * Provider identifiers for issue ingestion.
 */
export type IssueProvider = 'github' | 'azure_devops';

/**
 * Ingest operation mode.
 */
export type IngestMode = 'create' | 'init_existing';

/**
 * Ingest outcome.
 */
export type IngestOutcome = 'success' | 'partial';

/**
 * Azure DevOps work item types supported by create flow.
 */
export type AzureWorkItemType = 'User Story' | 'Bug' | 'Task';

/**
 * Remote item kind.
 */
export type RemoteItemKind = 'issue' | 'work_item';

/**
 * Azure credential mutation operation types.
 */
export type AzureDevopsOperation =
  | 'put'
  | 'patch'
  | 'delete'
  | 'reconcile'
  | 'auto_reconcile'
  | 'ingest';

/**
 * Ingest event outcome (includes error for event payloads).
 */
export type IngestEventOutcome = 'success' | 'partial' | 'error';

/**
 * Init phase values.
 */
export type InitPhase = 'design' | 'implement' | 'review' | 'complete';

/**
 * Auto-run provider values.
 */
export type AutoRunProvider = 'claude' | 'codex' | 'fake';

// ============================================================================
// Status Types (never include PAT value)
// ============================================================================

/**
 * Azure DevOps status payload used in responses and events.
 * Note: PAT value is NEVER included.
 */
export type AzureDevopsStatus = Readonly<{
  issue_ref: string;
  worktree_present: boolean;
  configured: boolean;
  organization: string | null;
  project: string | null;
  has_pat: boolean;
  pat_last_updated_at: string | null;
  pat_env_var_name: 'AZURE_DEVOPS_EXT_PAT';
  sync_status: AzureDevopsSyncStatus;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}>;

// ============================================================================
// Request Types
// ============================================================================

/**
 * Request body for PUT /api/issue/azure-devops.
 */
export type PutAzureDevopsRequest = Readonly<{
  organization: string;
  project: string;
  pat: string;
  sync_now?: boolean;
}>;

/**
 * Request body for PATCH /api/issue/azure-devops.
 */
export type PatchAzureDevopsRequest = Readonly<{
  organization?: string;
  project?: string;
  pat?: string;
  clear_pat?: boolean;
  sync_now?: boolean;
}>;

/**
 * Request body for POST /api/issue/azure-devops/reconcile.
 */
export type ReconcileAzureDevopsRequest = Readonly<{
  force?: boolean;
}>;

/**
 * Azure-specific fields for provider-aware create.
 */
export type AzureCreateOptions = Readonly<{
  organization?: string;
  project?: string;
  pat?: string;
  work_item_type?: AzureWorkItemType;
  parent_id?: number;
  area_path?: string;
  iteration_path?: string;
  tags?: string[];
}>;

/**
 * Init params for worktree initialization.
 */
export type IngestInitParams = Readonly<{
  branch?: string;
  workflow?: string;
  phase?: InitPhase;
  design_doc?: string;
  force?: boolean;
}>;

/**
 * Auto-run params.
 */
export type IngestAutoRunParams = Readonly<{
  provider?: AutoRunProvider;
  workflow?: string;
  max_iterations?: number;
  inactivity_timeout_sec?: number;
  iteration_timeout_sec?: number;
}>;

/**
 * Request body for POST /api/issues/create.
 */
export type CreateProviderIssueRequest = Readonly<{
  provider: IssueProvider;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
  milestone?: string;
  azure?: AzureCreateOptions;
  init?: IngestInitParams;
  auto_select?: boolean;
  auto_run?: IngestAutoRunParams;
}>;

/**
 * Existing item reference for init-from-existing.
 */
export type ExistingItemRef = Readonly<{
  id?: number | string;
  url?: string;
}>;

/**
 * Azure-specific options for init-from-existing.
 */
export type AzureInitFromExistingOptions = Readonly<{
  organization?: string;
  project?: string;
  pat?: string;
  fetch_hierarchy?: boolean;
}>;

/**
 * Request body for POST /api/issues/init-from-existing.
 */
export type InitFromExistingRequest = Readonly<{
  provider: IssueProvider;
  repo: string;
  existing: ExistingItemRef;
  azure?: AzureInitFromExistingOptions;
  init?: IngestInitParams;
  auto_select?: boolean;
  auto_run?: IngestAutoRunParams;
}>;

// ============================================================================
// Response Types
// ============================================================================

/**
 * Azure status response for GET endpoint.
 */
export type AzureDevopsStatusResponse = Readonly<{
  ok: true;
}> &
  AzureDevopsStatus;

/**
 * Response for credential mutating operations (PUT, PATCH, DELETE, reconcile).
 * Note: PAT value is NEVER included in status.
 */
export type AzureMutateResponse = Readonly<{
  ok: true;
  updated: boolean;
  status: AzureDevopsStatus;
  warnings: string[];
}>;

/**
 * Standard error response envelope for provider-aware routes.
 */
export type AzureDevopsErrorResponse = Readonly<{
  ok: false;
  error: string;
  code: string;
  field_errors?: Record<string, string>;
}>;

/**
 * Remote item reference in ingest response.
 */
export type IngestRemoteRef = Readonly<{
  id: string;
  url: string;
  title: string;
  kind: RemoteItemKind;
}>;

/**
 * Hierarchy item reference.
 */
export type HierarchyItemRef = Readonly<{
  id: string;
  title: string;
  url: string;
}>;

/**
 * Hierarchy data in ingest response.
 */
export type IngestHierarchy = Readonly<{
  parent: HierarchyItemRef | null;
  children: readonly HierarchyItemRef[];
}>;

/**
 * Init result in ingest response.
 */
export type IngestInitResult =
  | Readonly<{ ok: true; issue_ref: string; branch: string }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Auto-select result in ingest response.
 */
export type IngestAutoSelectResult = Readonly<{
  requested: boolean;
  ok: boolean;
  error?: string;
}>;

/**
 * Auto-run result in ingest response.
 */
export type IngestAutoRunResult = Readonly<{
  requested: boolean;
  ok: boolean;
  error?: string;
}>;

/**
 * Minimal run status reference for response payloads.
 */
export type RunStatusRef = Readonly<{
  running: boolean;
  runId?: string;
}>;

/**
 * Common ingest response for provider-aware create/init-from-existing.
 */
export type IngestResponse = Readonly<{
  ok: true;
  provider: IssueProvider;
  mode: IngestMode;
  outcome: IngestOutcome;
  remote: IngestRemoteRef;
  hierarchy?: IngestHierarchy;
  init?: IngestInitResult;
  auto_select?: IngestAutoSelectResult;
  auto_run?: IngestAutoRunResult;
  warnings: string[];
  run: RunStatusRef;
}>;

// ============================================================================
// Event Types
// ============================================================================

/**
 * Event payload for azure-devops-status SSE/WS event.
 * Note: PAT value is NEVER included.
 */
export type AzureDevopsStatusEvent = AzureDevopsStatus &
  Readonly<{
    operation: AzureDevopsOperation;
  }>;

/**
 * Event payload for issue-ingest-status SSE/WS event.
 */
export type IssueIngestStatusEvent = Readonly<{
  issue_ref: string | null;
  provider: IssueProvider;
  mode: IngestMode;
  outcome: IngestEventOutcome;
  remote_id?: string;
  remote_url?: string;
  warnings: string[];
  auto_select: Readonly<{ requested: boolean; ok: boolean }>;
  auto_run: Readonly<{ requested: boolean; ok: boolean }>;
  error?: Readonly<{ code: string; message: string }>;
  occurred_at: string;
}>;

// ============================================================================
// Constants
// ============================================================================

/** Fixed Azure PAT env var name. */
export const AZURE_PAT_ENV_VAR_NAME = 'AZURE_DEVOPS_EXT_PAT';
