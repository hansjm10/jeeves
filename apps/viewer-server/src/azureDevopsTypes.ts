/**
 * Types and validation helpers for Azure DevOps provider integration.
 *
 * This module provides:
 * - Domain types for status, requests, responses, and events
 * - Input validation for credential, ingest, and init fields
 * - Error sanitization helpers
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

/** Valid issue providers. */
export const VALID_ISSUE_PROVIDERS: readonly IssueProvider[] = [
  'github',
  'azure_devops',
];

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
 * All fields required for full upsert.
 */
export type PutAzureDevopsRequest = Readonly<{
  organization: string;
  project: string;
  pat: string;
  sync_now?: boolean; // default true
}>;

/**
 * Request body for PATCH /api/issue/azure-devops.
 * At least one mutable field required.
 */
export type PatchAzureDevopsRequest = Readonly<{
  organization?: string;
  project?: string;
  pat?: string;
  clear_pat?: boolean;
  sync_now?: boolean; // default false
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
  fetch_hierarchy?: boolean; // default true
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

/**
 * Legacy request body for POST /api/github/issues/create.
 */
export type LegacyCreateIssueRequest = Readonly<{
  repo: string;
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
  milestone?: string;
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

/**
 * Minimal run status reference for response payloads.
 * Matches the existing RunStatus type shape.
 */
export type RunStatusRef = Readonly<{
  running: boolean;
  runId?: string;
}>;

/**
 * Legacy create issue response for backward compatibility.
 */
export type LegacyCreateIssueResponse = Readonly<{
  ok: true;
  created: true;
  issue_url: string;
  issue_ref?: string;
  run: RunStatusRef;
  init?:
    | Readonly<{
        ok: true;
        result: Readonly<{
          state_dir: string;
          work_dir: string;
          repo_dir: string;
          branch: string;
        }>;
      }>
    | Readonly<{ ok: false; error: string }>;
  auto_run?:
    | Readonly<{ ok: true; run_started: true }>
    | Readonly<{ ok: false; run_started: false; error: string }>;
}>;

/**
 * Legacy create issue error response.
 */
export type LegacyCreateIssueErrorResponse = Readonly<{
  ok: false;
  error: string;
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
// Validation Constants
// ============================================================================

/** Minimum organization length after trim. */
export const ORG_MIN_LENGTH = 3;

/** Maximum organization length after trim. */
export const ORG_MAX_LENGTH = 200;

/** Pattern for valid Azure DevOps org slug (not full URL). */
export const ORG_SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Prefix for Azure DevOps org URLs. */
export const ORG_URL_PREFIX = 'https://dev.azure.com/';

/** Minimum project length after trim. */
export const PROJECT_MIN_LENGTH = 1;

/** Maximum project length after trim. */
export const PROJECT_MAX_LENGTH = 128;

/**
 * Check if a character code is a control character (0x00-0x1f or 0x7f).
 */
function isControlCharCode(code: number): boolean {
  return (code >= 0x00 && code <= 0x1f) || code === 0x7f;
}

/** Minimum PAT length after trim. */
export const PAT_MIN_LENGTH = 1;

/** Maximum PAT length after trim. */
export const PAT_MAX_LENGTH = 1024;

/** Characters forbidden in PAT values. */
const FORBIDDEN_CHARS = ['\0', '\n', '\r'];

/** Minimum repo length after trim. */
export const REPO_MIN_LENGTH = 3;

/** Maximum repo length after trim. */
export const REPO_MAX_LENGTH = 200;

/** Pattern for valid repo: owner/repo format. */
export const REPO_PATTERN = /^[^\s/]+\/[^\s/]+$/;

/** Minimum title length after trim. */
export const TITLE_MIN_LENGTH = 1;

/** Maximum title length after trim. */
export const TITLE_MAX_LENGTH = 256;

/** Minimum body length after trim. */
export const BODY_MIN_LENGTH = 1;

/** Maximum body length after trim. */
export const BODY_MAX_LENGTH = 20_000;

/** Maximum items in labels array. */
export const LABELS_MAX_ITEMS = 20;

/** Maximum items in assignees array. */
export const ASSIGNEES_MAX_ITEMS = 20;

/** Maximum single label/assignee length after trim. */
export const LABEL_ASSIGNEE_MAX_LENGTH = 64;

/** Maximum milestone length after trim. */
export const MILESTONE_MAX_LENGTH = 128;

/** Valid Azure DevOps work item types. */
export const VALID_WORK_ITEM_TYPES: readonly AzureWorkItemType[] = [
  'User Story',
  'Bug',
  'Task',
];

/** Maximum Azure tags. */
export const AZURE_TAGS_MAX_ITEMS = 50;

/** Maximum tag length after trim. */
export const AZURE_TAG_MAX_LENGTH = 64;

/** Maximum area/iteration path length after trim. */
export const AZURE_PATH_MAX_LENGTH = 256;

/** Maximum branch name length after trim. */
export const BRANCH_MAX_LENGTH = 255;

/** Branch name invalid patterns (leading slash, trailing slash, double dots). */
const BRANCH_INVALID_PATTERNS = [/^\//, /\/$/, /\.\./];

/**
 * Check if branch name contains whitespace or control characters.
 */
function branchHasInvalidChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Check for whitespace (space, tab, etc.) or control characters
    if (isControlCharCode(code) || code === 0x20 || code === 0x09) {
      return true;
    }
  }
  return false;
}

/** Maximum workflow/phase ID length after trim. */
export const WORKFLOW_MAX_LENGTH = 64;

/** Pattern for valid workflow names: starts with alphanumeric, then alphanumeric/underscore/hyphen. */
export const WORKFLOW_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Valid init phases. */
export const VALID_INIT_PHASES: readonly InitPhase[] = [
  'design',
  'implement',
  'review',
  'complete',
];

/** Maximum design doc path length after trim. */
export const DESIGN_DOC_MAX_LENGTH = 260;

/** Valid auto-run providers. */
export const VALID_AUTO_RUN_PROVIDERS: readonly AutoRunProvider[] = [
  'claude',
  'codex',
  'fake',
];

/** Auto-run max_iterations range. */
export const MAX_ITERATIONS_MIN = 1;
export const MAX_ITERATIONS_MAX = 100;

/** Auto-run inactivity_timeout_sec range. */
export const INACTIVITY_TIMEOUT_MIN = 10;
export const INACTIVITY_TIMEOUT_MAX = 7200;

/** Auto-run iteration_timeout_sec range. */
export const ITERATION_TIMEOUT_MIN = 30;
export const ITERATION_TIMEOUT_MAX = 14_400;

/** Fixed Azure PAT env var name. */
export const AZURE_PAT_ENV_VAR_NAME = 'AZURE_DEVOPS_EXT_PAT';

/** Maximum length for sanitized error strings. */
const MAX_ERROR_LENGTH = 2048;

// ============================================================================
// Validation Result Types
// ============================================================================

export type ValidationSuccess<T> = Readonly<{
  valid: true;
  value: T;
}>;

export type ValidationFailure = Readonly<{
  valid: false;
  error: string;
}>;

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export type CompoundValidationSuccess<T> = Readonly<{
  valid: true;
  value: T;
}>;

export type CompoundValidationFailure = Readonly<{
  valid: false;
  error: string;
  code: string;
  field_errors: Record<string, string>;
}>;

export type CompoundValidationResult<T> =
  | CompoundValidationSuccess<T>
  | CompoundValidationFailure;

// ============================================================================
// Validated Request Shapes
// ============================================================================

export type ValidatedPutAzureDevops = Readonly<{
  organization: string;
  project: string;
  pat: string;
  sync_now: boolean;
}>;

export type ValidatedPatchAzureDevops = Readonly<{
  organization?: string;
  project?: string;
  pat?: string;
  clear_pat?: boolean;
  sync_now: boolean;
}>;

export type ValidatedReconcileAzureDevops = Readonly<{
  force: boolean;
}>;

export type ValidatedExistingItemRef = Readonly<{
  id?: number | string;
  url?: string;
}>;

export type ValidatedCreateProviderIssueRequest = Readonly<{
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

export type ValidatedInitFromExistingRequest = Readonly<{
  provider: IssueProvider;
  repo: string;
  existing: ValidatedExistingItemRef;
  azure?: AzureInitFromExistingOptions;
  init?: IngestInitParams;
  auto_select?: boolean;
  auto_run?: IngestAutoRunParams;
}>;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Check if a string contains any forbidden characters (\0, \n, \r).
 */
function containsForbiddenChars(value: string): boolean {
  return FORBIDDEN_CHARS.some((c) => value.includes(c));
}

/**
 * Check if a string contains control characters.
 */
function containsControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isControlCharCode(value.charCodeAt(i))) {
      return true;
    }
  }
  return false;
}

/**
 * Validate an organization value.
 *
 * Accepts either an org slug (e.g. "my-org") or a full URL
 * (e.g. "https://dev.azure.com/my-org"). Returns the canonical
 * https://dev.azure.com/<slug> form on success.
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 3..200
 * - Org slug chars: [A-Za-z0-9._-]
 */
export function validateOrganization(
  value: unknown,
): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Organization must be a string.' };
  }

  const trimmed = value.trim();

  if (trimmed.length < ORG_MIN_LENGTH) {
    return {
      valid: false,
      error: `Organization must be at least ${ORG_MIN_LENGTH} characters after trimming.`,
    };
  }

  if (trimmed.length > ORG_MAX_LENGTH) {
    return {
      valid: false,
      error: `Organization must be at most ${ORG_MAX_LENGTH} characters after trimming.`,
    };
  }

  // Extract slug from URL if provided
  let slug: string;
  if (trimmed.toLowerCase().startsWith(ORG_URL_PREFIX.toLowerCase())) {
    slug = trimmed.slice(ORG_URL_PREFIX.length).replace(/\/+$/, '');
    if (slug.length === 0) {
      return {
        valid: false,
        error: 'Organization URL must include an organization name after the prefix.',
      };
    }
  } else {
    slug = trimmed;
  }

  if (!ORG_SLUG_PATTERN.test(slug)) {
    return {
      valid: false,
      error:
        'Organization must contain only letters, digits, dots, hyphens, or underscores.',
    };
  }

  // Return canonical URL form
  return { valid: true, value: `${ORG_URL_PREFIX}${slug}` };
}

/**
 * Validate a project name.
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 1..128
 * - Must not contain control characters
 */
export function validateProject(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Project must be a string.' };
  }

  const trimmed = value.trim();

  if (trimmed.length < PROJECT_MIN_LENGTH) {
    return {
      valid: false,
      error: 'Project must not be empty after trimming.',
    };
  }

  if (trimmed.length > PROJECT_MAX_LENGTH) {
    return {
      valid: false,
      error: `Project must be at most ${PROJECT_MAX_LENGTH} characters after trimming.`,
    };
  }

  if (containsControlChars(trimmed)) {
    return {
      valid: false,
      error: 'Project must not contain control characters.',
    };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate a PAT value.
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 1..1024
 * - Must not contain \0, \n, \r
 */
export function validatePat(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: 'PAT must be a string.' };
  }

  const trimmed = value.trim();

  if (trimmed.length < PAT_MIN_LENGTH) {
    return {
      valid: false,
      error: 'PAT must not be empty after trimming.',
    };
  }

  if (trimmed.length > PAT_MAX_LENGTH) {
    return {
      valid: false,
      error: `PAT must be at most ${PAT_MAX_LENGTH} characters after trimming.`,
    };
  }

  if (containsForbiddenChars(trimmed)) {
    return {
      valid: false,
      error: 'PAT must not contain null, newline, or carriage return characters.',
    };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate a boolean field.
 */
export function validateBoolean(
  value: unknown,
  fieldName: string,
): ValidationResult<boolean> {
  if (typeof value !== 'boolean') {
    return { valid: false, error: `${fieldName} must be a boolean.` };
  }
  return { valid: true, value };
}

/**
 * Validate a repo string (owner/repo format).
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 3..200
 * - Must match owner/repo format
 */
export function validateRepo(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Repo must be a string.' };
  }

  const trimmed = value.trim();

  if (trimmed.length < REPO_MIN_LENGTH) {
    return {
      valid: false,
      error: `Repo must be at least ${REPO_MIN_LENGTH} characters after trimming.`,
    };
  }

  if (trimmed.length > REPO_MAX_LENGTH) {
    return {
      valid: false,
      error: `Repo must be at most ${REPO_MAX_LENGTH} characters after trimming.`,
    };
  }

  if (!REPO_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: 'Repo must be in owner/repo format.',
    };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate a title string.
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 1..256
 */
export function validateTitle(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Title must be a string.' };
  }

  const trimmed = value.trim();

  if (trimmed.length < TITLE_MIN_LENGTH) {
    return {
      valid: false,
      error: 'Title must not be empty after trimming.',
    };
  }

  if (trimmed.length > TITLE_MAX_LENGTH) {
    return {
      valid: false,
      error: `Title must be at most ${TITLE_MAX_LENGTH} characters after trimming.`,
    };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate a body string.
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 1..20000
 */
export function validateBody(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Body must be a string.' };
  }

  const trimmed = value.trim();

  if (trimmed.length < BODY_MIN_LENGTH) {
    return {
      valid: false,
      error: 'Body must not be empty after trimming.',
    };
  }

  if (trimmed.length > BODY_MAX_LENGTH) {
    return {
      valid: false,
      error: `Body must be at most ${BODY_MAX_LENGTH} characters after trimming.`,
    };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate an array of short strings (labels, assignees).
 *
 * Rules:
 * - Must be an array if provided
 * - Max item count
 * - Each item trimmed length must be 1..maxItemLength
 */
export function validateStringArray(
  value: unknown,
  fieldName: string,
  maxItems: number,
  maxItemLength: number,
): ValidationResult<string[]> {
  if (!Array.isArray(value)) {
    return { valid: false, error: `${fieldName} must be an array.` };
  }

  if (value.length > maxItems) {
    return {
      valid: false,
      error: `${fieldName} must have at most ${maxItems} items.`,
    };
  }

  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== 'string') {
      return {
        valid: false,
        error: `${fieldName}[${i}] must be a string.`,
      };
    }
    const trimmed = item.trim();
    if (trimmed.length < 1) {
      return {
        valid: false,
        error: `${fieldName}[${i}] must not be empty after trimming.`,
      };
    }
    if (trimmed.length > maxItemLength) {
      return {
        valid: false,
        error: `${fieldName}[${i}] must be at most ${maxItemLength} characters after trimming.`,
      };
    }
    result.push(trimmed);
  }

  return { valid: true, value: result };
}

/**
 * Validate an array of Azure DevOps tags.
 *
 * Rules:
 * - Must be an array if provided
 * - Max 50 tags
 * - Each tag trimmed length must be 1..64
 * - Tags must not contain control characters
 */
export function validateAzureTags(
  value: unknown,
): ValidationResult<string[]> {
  const baseResult = validateStringArray(
    value,
    'tags',
    AZURE_TAGS_MAX_ITEMS,
    AZURE_TAG_MAX_LENGTH,
  );

  if (!baseResult.valid) {
    return baseResult;
  }

  // Check for control characters
  for (let i = 0; i < baseResult.value.length; i++) {
    if (containsControlChars(baseResult.value[i])) {
      return {
        valid: false,
        error: `tags[${i}] must not contain control characters.`,
      };
    }
  }

  return baseResult;
}

/**
 * Validate a milestone string.
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 1..128
 */
export function validateMilestone(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Milestone must be a string.' };
  }

  const trimmed = value.trim();

  if (trimmed.length < 1) {
    return {
      valid: false,
      error: 'Milestone must not be empty after trimming.',
    };
  }

  if (trimmed.length > MILESTONE_MAX_LENGTH) {
    return {
      valid: false,
      error: `Milestone must be at most ${MILESTONE_MAX_LENGTH} characters after trimming.`,
    };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate an Azure path (area_path or iteration_path).
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 1..256
 * - Must not contain control characters
 */
export function validateAzurePath(
  value: unknown,
  fieldName: string,
): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: `${fieldName} must be a string.` };
  }

  const trimmed = value.trim();

  if (trimmed.length < 1) {
    return {
      valid: false,
      error: `${fieldName} must not be empty after trimming.`,
    };
  }

  if (trimmed.length > AZURE_PATH_MAX_LENGTH) {
    return {
      valid: false,
      error: `${fieldName} must be at most ${AZURE_PATH_MAX_LENGTH} characters after trimming.`,
    };
  }

  if (containsControlChars(trimmed)) {
    return {
      valid: false,
      error: `${fieldName} must not contain control characters.`,
    };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate a branch name.
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 1..255
 * - No leading/trailing /
 * - No ..
 * - No whitespace or control characters
 */
export function validateBranch(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Branch must be a string.' };
  }

  const trimmed = value.trim();

  if (trimmed.length < 1) {
    return {
      valid: false,
      error: 'Branch must not be empty after trimming.',
    };
  }

  if (trimmed.length > BRANCH_MAX_LENGTH) {
    return {
      valid: false,
      error: `Branch must be at most ${BRANCH_MAX_LENGTH} characters after trimming.`,
    };
  }

  for (const pattern of BRANCH_INVALID_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        error:
          'Branch must not start/end with /, contain .., or include whitespace or control characters.',
      };
    }
  }

  if (branchHasInvalidChars(trimmed)) {
    return {
      valid: false,
      error:
        'Branch must not start/end with /, contain .., or include whitespace or control characters.',
    };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate a workflow ID.
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 1..64
 */
export function validateWorkflow(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Workflow must be a string.' };
  }

  const trimmed = value.trim();

  if (trimmed.length < 1) {
    return {
      valid: false,
      error: 'Workflow must not be empty after trimming.',
    };
  }

  if (trimmed.length > WORKFLOW_MAX_LENGTH) {
    return {
      valid: false,
      error: `Workflow must be at most ${WORKFLOW_MAX_LENGTH} characters after trimming.`,
    };
  }

  if (!WORKFLOW_NAME_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error:
        'Workflow must start with an alphanumeric character and contain only letters, digits, hyphens, or underscores.',
    };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate a design doc path.
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 1..260
 * - Must end in .md
 * - Must be workspace-relative (no absolute paths, no .. traversal)
 */
export function validateDesignDoc(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Design doc must be a string.' };
  }

  const trimmed = value.trim();

  if (trimmed.length < 1) {
    return {
      valid: false,
      error: 'Design doc must not be empty after trimming.',
    };
  }

  if (trimmed.length > DESIGN_DOC_MAX_LENGTH) {
    return {
      valid: false,
      error: `Design doc must be at most ${DESIGN_DOC_MAX_LENGTH} characters after trimming.`,
    };
  }

  if (!trimmed.endsWith('.md')) {
    return {
      valid: false,
      error: 'Design doc must end in .md.',
    };
  }

  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return {
      valid: false,
      error: 'Design doc must be a workspace-relative path (no absolute paths).',
    };
  }

  if (trimmed.includes('..')) {
    return {
      valid: false,
      error: 'Design doc must not contain .. path traversal.',
    };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate an integer within a range.
 */
export function validateIntegerRange(
  value: unknown,
  fieldName: string,
  min: number,
  max: number,
): ValidationResult<number> {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { valid: false, error: `${fieldName} must be an integer.` };
  }

  if (value < min || value > max) {
    return {
      valid: false,
      error: `${fieldName} must be between ${min} and ${max}.`,
    };
  }

  return { valid: true, value };
}

/**
 * Validate a provider value.
 *
 * Rules:
 * - Must be a string
 * - Must be one of the valid issue providers
 */
export function validateProvider(
  value: unknown,
): ValidationResult<IssueProvider> {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Provider must be a string.' };
  }

  if (!(VALID_ISSUE_PROVIDERS as readonly string[]).includes(value)) {
    return {
      valid: false,
      error: `Provider must be one of: ${VALID_ISSUE_PROVIDERS.join(', ')}.`,
    };
  }

  return { valid: true, value: value as IssueProvider };
}

/**
 * Validate an existing item reference (for init-from-existing).
 *
 * Rules:
 * - Must be an object
 * - Exactly one of id or url must be present
 * - id must be a positive integer or non-empty string
 * - url must be a non-empty trimmed string
 */
export function validateExistingItemRef(
  value: unknown,
  fieldErrors: Record<string, string>,
): ValidatedExistingItemRef | null {
  if (value === null || value === undefined || typeof value !== 'object') {
    fieldErrors['existing'] = 'Existing must be an object.';
    return null;
  }

  const obj = value as Record<string, unknown>;
  const hasId = 'id' in obj && obj.id !== undefined;
  const hasUrl = 'url' in obj && obj.url !== undefined;

  if (hasId && hasUrl) {
    fieldErrors['existing'] =
      'Exactly one of existing.id or existing.url must be provided, not both.';
    return null;
  }

  if (!hasId && !hasUrl) {
    fieldErrors['existing'] =
      'Exactly one of existing.id or existing.url must be provided.';
    return null;
  }

  if (hasId) {
    const id = obj.id;
    if (typeof id === 'number') {
      if (!Number.isInteger(id) || id <= 0) {
        fieldErrors['existing'] =
          'existing.id must be a positive integer when numeric.';
        return null;
      }
      return { id };
    }
    if (typeof id === 'string') {
      const trimmed = id.trim();
      if (trimmed.length === 0) {
        fieldErrors['existing'] =
          'existing.id must not be empty after trimming.';
        return null;
      }
      return { id: trimmed };
    }
    fieldErrors['existing'] = 'existing.id must be a number or string.';
    return null;
  }

  // hasUrl
  const url = obj.url;
  if (typeof url !== 'string') {
    fieldErrors['existing'] = 'existing.url must be a string.';
    return null;
  }
  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    fieldErrors['existing'] =
      'existing.url must not be empty after trimming.';
    return null;
  }
  return { url: trimmedUrl };
}

/**
 * Validate Azure init-from-existing options sub-object.
 */
export function validateAzureInitFromExistingOptions(
  azure: unknown,
  fieldErrors: Record<string, string>,
): AzureInitFromExistingOptions | null {
  if (azure === null || typeof azure !== 'object') {
    fieldErrors['azure'] = 'Azure options must be an object.';
    return null;
  }

  const obj = azure as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  if ('organization' in obj && obj.organization !== undefined) {
    const r = validateOrganization(obj.organization);
    if (!r.valid) {
      fieldErrors['azure.organization'] = r.error;
    } else {
      result.organization = r.value;
    }
  }

  if ('project' in obj && obj.project !== undefined) {
    const r = validateProject(obj.project);
    if (!r.valid) {
      fieldErrors['azure.project'] = r.error;
    } else {
      result.project = r.value;
    }
  }

  if ('fetch_hierarchy' in obj && obj.fetch_hierarchy !== undefined) {
    const r = validateBoolean(obj.fetch_hierarchy, 'azure.fetch_hierarchy');
    if (!r.valid) {
      fieldErrors['azure.fetch_hierarchy'] = r.error;
    } else {
      result.fetch_hierarchy = r.value;
    }
  }

  return result as unknown as AzureInitFromExistingOptions;
}

// ============================================================================
// Compound Validators
// ============================================================================

/**
 * Validate a PUT /api/issue/azure-devops request body.
 *
 * Rules:
 * - organization, project, pat required
 * - sync_now optional (default true)
 */
export function validatePutAzureDevopsRequest(
  body: unknown,
): CompoundValidationResult<ValidatedPutAzureDevops> {
  if (body === null || typeof body !== 'object') {
    return {
      valid: false,
      error: 'Request body must be an object.',
      code: 'validation_failed',
      field_errors: {},
    };
  }

  const obj = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};

  // Validate organization (required)
  let validatedOrg: string | undefined;
  if (!('organization' in obj) || obj.organization === undefined) {
    fieldErrors.organization = 'Organization is required.';
  } else {
    const orgResult = validateOrganization(obj.organization);
    if (!orgResult.valid) {
      fieldErrors.organization = orgResult.error;
    } else {
      validatedOrg = orgResult.value;
    }
  }

  // Validate project (required)
  let validatedProject: string | undefined;
  if (!('project' in obj) || obj.project === undefined) {
    fieldErrors.project = 'Project is required.';
  } else {
    const projectResult = validateProject(obj.project);
    if (!projectResult.valid) {
      fieldErrors.project = projectResult.error;
    } else {
      validatedProject = projectResult.value;
    }
  }

  // Validate pat (required)
  let validatedPat: string | undefined;
  if (!('pat' in obj) || obj.pat === undefined) {
    fieldErrors.pat = 'PAT is required.';
  } else {
    const patResult = validatePat(obj.pat);
    if (!patResult.valid) {
      fieldErrors.pat = patResult.error;
    } else {
      validatedPat = patResult.value;
    }
  }

  // Validate sync_now (optional, default true)
  let validatedSyncNow = true;
  if ('sync_now' in obj && obj.sync_now !== undefined) {
    const syncResult = validateBoolean(obj.sync_now, 'sync_now');
    if (!syncResult.valid) {
      fieldErrors.sync_now = syncResult.error;
    } else {
      validatedSyncNow = syncResult.value;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      valid: false,
      error: 'Validation failed.',
      code: 'validation_failed',
      field_errors: fieldErrors,
    };
  }

  return {
    valid: true,
    value: {
      organization: validatedOrg!,
      project: validatedProject!,
      pat: validatedPat!,
      sync_now: validatedSyncNow,
    },
  };
}

/**
 * Validate a PATCH /api/issue/azure-devops request body.
 *
 * Rules:
 * - At least one of organization, project, pat, or clear_pat must be present
 * - pat and clear_pat=true cannot coexist
 * - sync_now optional (default false)
 */
export function validatePatchAzureDevopsRequest(
  body: unknown,
): CompoundValidationResult<ValidatedPatchAzureDevops> {
  if (body === null || typeof body !== 'object') {
    return {
      valid: false,
      error: 'Request body must be an object.',
      code: 'validation_failed',
      field_errors: {},
    };
  }

  const obj = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};

  const hasOrg = 'organization' in obj && obj.organization !== undefined;
  const hasProject = 'project' in obj && obj.project !== undefined;
  const hasPat = 'pat' in obj && obj.pat !== undefined;
  const hasClearPat = 'clear_pat' in obj && obj.clear_pat !== undefined;

  // At least one mutable field required
  if (!hasOrg && !hasProject && !hasPat && !hasClearPat) {
    return {
      valid: false,
      error:
        'At least one of organization, project, pat, or clear_pat must be provided.',
      code: 'validation_failed',
      field_errors: {
        organization: 'At least one mutable field is required.',
      },
    };
  }

  // pat and clear_pat=true conflict
  if (hasPat && hasClearPat && obj.clear_pat === true) {
    fieldErrors.clear_pat =
      'clear_pat cannot be true when pat is provided.';
  }

  let validatedOrg: string | undefined;
  if (hasOrg) {
    const orgResult = validateOrganization(obj.organization);
    if (!orgResult.valid) {
      fieldErrors.organization = orgResult.error;
    } else {
      validatedOrg = orgResult.value;
    }
  }

  let validatedProject: string | undefined;
  if (hasProject) {
    const projectResult = validateProject(obj.project);
    if (!projectResult.valid) {
      fieldErrors.project = projectResult.error;
    } else {
      validatedProject = projectResult.value;
    }
  }

  let validatedPat: string | undefined;
  if (hasPat) {
    const patResult = validatePat(obj.pat);
    if (!patResult.valid) {
      fieldErrors.pat = patResult.error;
    } else {
      validatedPat = patResult.value;
    }
  }

  let validatedClearPat: boolean | undefined;
  if (hasClearPat) {
    const clearPatResult = validateBoolean(obj.clear_pat, 'clear_pat');
    if (!clearPatResult.valid) {
      fieldErrors.clear_pat = clearPatResult.error;
    } else {
      validatedClearPat = clearPatResult.value;
    }
  }

  let validatedSyncNow = false; // default for PATCH
  if ('sync_now' in obj && obj.sync_now !== undefined) {
    const syncResult = validateBoolean(obj.sync_now, 'sync_now');
    if (!syncResult.valid) {
      fieldErrors.sync_now = syncResult.error;
    } else {
      validatedSyncNow = syncResult.value;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      valid: false,
      error: 'Validation failed.',
      code: 'validation_failed',
      field_errors: fieldErrors,
    };
  }

  return {
    valid: true,
    value: {
      organization: validatedOrg,
      project: validatedProject,
      pat: validatedPat,
      clear_pat: validatedClearPat,
      sync_now: validatedSyncNow,
    },
  };
}

/**
 * Validate a POST /api/issue/azure-devops/reconcile request body.
 *
 * Rules:
 * - force optional (default false)
 */
export function validateReconcileAzureDevopsRequest(
  body: unknown,
): CompoundValidationResult<ValidatedReconcileAzureDevops> {
  if (body === null || body === undefined) {
    return { valid: true, value: { force: false } };
  }

  if (typeof body !== 'object') {
    return {
      valid: false,
      error: 'Request body must be an object.',
      code: 'validation_failed',
      field_errors: {},
    };
  }

  const obj = body as Record<string, unknown>;

  if ('force' in obj && obj.force !== undefined) {
    const forceResult = validateBoolean(obj.force, 'force');
    if (!forceResult.valid) {
      return {
        valid: false,
        error: 'Validation failed.',
        code: 'validation_failed',
        field_errors: { force: forceResult.error },
      };
    }
    return { valid: true, value: { force: forceResult.value } };
  }

  return { valid: true, value: { force: false } };
}

/**
 * Validate init params sub-object.
 */
export function validateInitParams(
  init: unknown,
  fieldErrors: Record<string, string>,
): IngestInitParams | null {
  if (init === null || typeof init !== 'object') {
    fieldErrors['init'] = 'Init must be an object.';
    return null;
  }

  const obj = init as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  if ('branch' in obj && obj.branch !== undefined) {
    const r = validateBranch(obj.branch);
    if (!r.valid) {
      fieldErrors['init.branch'] = r.error;
    } else {
      result.branch = r.value;
    }
  }

  if ('workflow' in obj && obj.workflow !== undefined) {
    const r = validateWorkflow(obj.workflow);
    if (!r.valid) {
      fieldErrors['init.workflow'] = r.error;
    } else {
      result.workflow = r.value;
    }
  }

  if ('phase' in obj && obj.phase !== undefined) {
    if (
      typeof obj.phase !== 'string' ||
      !(VALID_INIT_PHASES as readonly string[]).includes(obj.phase)
    ) {
      fieldErrors['init.phase'] =
        `Phase must be one of: ${VALID_INIT_PHASES.join(', ')}.`;
    } else {
      result.phase = obj.phase;
    }
  }

  if ('design_doc' in obj && obj.design_doc !== undefined) {
    const r = validateDesignDoc(obj.design_doc);
    if (!r.valid) {
      fieldErrors['init.design_doc'] = r.error;
    } else {
      result.design_doc = r.value;
    }
  }

  if ('force' in obj && obj.force !== undefined) {
    const r = validateBoolean(obj.force, 'init.force');
    if (!r.valid) {
      fieldErrors['init.force'] = r.error;
    } else {
      result.force = r.value;
    }
  }

  return result as unknown as IngestInitParams;
}

/**
 * Validate auto_run params sub-object.
 */
export function validateAutoRunParams(
  autoRun: unknown,
  fieldErrors: Record<string, string>,
): IngestAutoRunParams | null {
  if (autoRun === null || typeof autoRun !== 'object') {
    fieldErrors['auto_run'] = 'auto_run must be an object.';
    return null;
  }

  const obj = autoRun as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  if ('provider' in obj && obj.provider !== undefined) {
    if (
      typeof obj.provider !== 'string' ||
      !(VALID_AUTO_RUN_PROVIDERS as readonly string[]).includes(obj.provider)
    ) {
      fieldErrors['auto_run.provider'] =
        `Provider must be one of: ${VALID_AUTO_RUN_PROVIDERS.join(', ')}.`;
    } else {
      result.provider = obj.provider;
    }
  }

  if ('workflow' in obj && obj.workflow !== undefined) {
    const r = validateWorkflow(obj.workflow);
    if (!r.valid) {
      fieldErrors['auto_run.workflow'] = r.error;
    } else {
      result.workflow = r.value;
    }
  }

  if ('max_iterations' in obj && obj.max_iterations !== undefined) {
    const r = validateIntegerRange(
      obj.max_iterations,
      'auto_run.max_iterations',
      MAX_ITERATIONS_MIN,
      MAX_ITERATIONS_MAX,
    );
    if (!r.valid) {
      fieldErrors['auto_run.max_iterations'] = r.error;
    } else {
      result.max_iterations = r.value;
    }
  }

  if (
    'inactivity_timeout_sec' in obj &&
    obj.inactivity_timeout_sec !== undefined
  ) {
    const r = validateIntegerRange(
      obj.inactivity_timeout_sec,
      'auto_run.inactivity_timeout_sec',
      INACTIVITY_TIMEOUT_MIN,
      INACTIVITY_TIMEOUT_MAX,
    );
    if (!r.valid) {
      fieldErrors['auto_run.inactivity_timeout_sec'] = r.error;
    } else {
      result.inactivity_timeout_sec = r.value;
    }
  }

  if (
    'iteration_timeout_sec' in obj &&
    obj.iteration_timeout_sec !== undefined
  ) {
    const r = validateIntegerRange(
      obj.iteration_timeout_sec,
      'auto_run.iteration_timeout_sec',
      ITERATION_TIMEOUT_MIN,
      ITERATION_TIMEOUT_MAX,
    );
    if (!r.valid) {
      fieldErrors['auto_run.iteration_timeout_sec'] = r.error;
    } else {
      result.iteration_timeout_sec = r.value;
    }
  }

  return result as unknown as IngestAutoRunParams;
}

/**
 * Validate Azure-specific create options.
 */
export function validateAzureCreateOptions(
  azure: unknown,
  isCreate: boolean,
  fieldErrors: Record<string, string>,
): AzureCreateOptions | null {
  if (azure === null || typeof azure !== 'object') {
    fieldErrors['azure'] = 'Azure options must be an object.';
    return null;
  }

  const obj = azure as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  if ('organization' in obj && obj.organization !== undefined) {
    const r = validateOrganization(obj.organization);
    if (!r.valid) {
      fieldErrors['azure.organization'] = r.error;
    } else {
      result.organization = r.value;
    }
  }

  if ('project' in obj && obj.project !== undefined) {
    const r = validateProject(obj.project);
    if (!r.valid) {
      fieldErrors['azure.project'] = r.error;
    } else {
      result.project = r.value;
    }
  }

  if ('work_item_type' in obj && obj.work_item_type !== undefined) {
    if (
      typeof obj.work_item_type !== 'string' ||
      !(VALID_WORK_ITEM_TYPES as readonly string[]).includes(
        obj.work_item_type,
      )
    ) {
      fieldErrors['azure.work_item_type'] =
        `Work item type must be one of: ${VALID_WORK_ITEM_TYPES.join(', ')}.`;
    } else {
      result.work_item_type = obj.work_item_type;
    }
  } else if (isCreate) {
    fieldErrors['azure.work_item_type'] =
      'Work item type is required for Azure create.';
  }

  if ('parent_id' in obj && obj.parent_id !== undefined) {
    if (
      typeof obj.parent_id !== 'number' ||
      !Number.isInteger(obj.parent_id) ||
      obj.parent_id <= 0
    ) {
      fieldErrors['azure.parent_id'] =
        'Parent ID must be a positive integer.';
    } else {
      result.parent_id = obj.parent_id;
    }
  }

  if ('area_path' in obj && obj.area_path !== undefined) {
    const r = validateAzurePath(obj.area_path, 'area_path');
    if (!r.valid) {
      fieldErrors['azure.area_path'] = r.error;
    } else {
      result.area_path = r.value;
    }
  }

  if ('iteration_path' in obj && obj.iteration_path !== undefined) {
    const r = validateAzurePath(obj.iteration_path, 'iteration_path');
    if (!r.valid) {
      fieldErrors['azure.iteration_path'] = r.error;
    } else {
      result.iteration_path = r.value;
    }
  }

  if ('tags' in obj && obj.tags !== undefined) {
    const r = validateAzureTags(obj.tags);
    if (!r.valid) {
      fieldErrors['azure.tags'] = r.error;
    } else {
      result.tags = r.value;
    }
  }

  return result as unknown as AzureCreateOptions;
}

/**
 * Validate a POST /api/issues/create request body.
 *
 * Provider validation failure returns code 'unsupported_provider' immediately.
 * All other validation failures return code 'validation_failed' with field_errors.
 */
export function validateCreateProviderIssueRequest(
  body: unknown,
): CompoundValidationResult<ValidatedCreateProviderIssueRequest> {
  if (body === null || typeof body !== 'object') {
    return {
      valid: false,
      error: 'Request body must be an object.',
      code: 'validation_failed',
      field_errors: {},
    };
  }

  const obj = body as Record<string, unknown>;

  // Validate provider first — unsupported_provider is a separate error code
  if (!('provider' in obj) || obj.provider === undefined) {
    return {
      valid: false,
      error: 'Provider is required.',
      code: 'unsupported_provider',
      field_errors: { provider: 'Provider is required.' },
    };
  }

  const providerResult = validateProvider(obj.provider);
  if (!providerResult.valid) {
    return {
      valid: false,
      error: providerResult.error,
      code: 'unsupported_provider',
      field_errors: { provider: providerResult.error },
    };
  }

  const validatedProvider = providerResult.value;
  const fieldErrors: Record<string, string> = {};

  // Validate repo (required)
  let validatedRepo: string | undefined;
  if (!('repo' in obj) || obj.repo === undefined) {
    fieldErrors.repo = 'Repo is required.';
  } else {
    const r = validateRepo(obj.repo);
    if (!r.valid) {
      fieldErrors.repo = r.error;
    } else {
      validatedRepo = r.value;
    }
  }

  // Validate title (required)
  let validatedTitle: string | undefined;
  if (!('title' in obj) || obj.title === undefined) {
    fieldErrors.title = 'Title is required.';
  } else {
    const r = validateTitle(obj.title);
    if (!r.valid) {
      fieldErrors.title = r.error;
    } else {
      validatedTitle = r.value;
    }
  }

  // Validate body (required)
  let validatedBody: string | undefined;
  if (!('body' in obj) || obj.body === undefined) {
    fieldErrors.body = 'Body is required.';
  } else {
    const r = validateBody(obj.body);
    if (!r.valid) {
      fieldErrors.body = r.error;
    } else {
      validatedBody = r.value;
    }
  }

  // Validate labels (optional)
  let validatedLabels: string[] | undefined;
  if ('labels' in obj && obj.labels !== undefined) {
    const r = validateStringArray(
      obj.labels,
      'labels',
      LABELS_MAX_ITEMS,
      LABEL_ASSIGNEE_MAX_LENGTH,
    );
    if (!r.valid) {
      fieldErrors.labels = r.error;
    } else {
      validatedLabels = r.value;
    }
  }

  // Validate assignees (optional)
  let validatedAssignees: string[] | undefined;
  if ('assignees' in obj && obj.assignees !== undefined) {
    const r = validateStringArray(
      obj.assignees,
      'assignees',
      ASSIGNEES_MAX_ITEMS,
      LABEL_ASSIGNEE_MAX_LENGTH,
    );
    if (!r.valid) {
      fieldErrors.assignees = r.error;
    } else {
      validatedAssignees = r.value;
    }
  }

  // Validate milestone (optional)
  let validatedMilestone: string | undefined;
  if ('milestone' in obj && obj.milestone !== undefined) {
    const r = validateMilestone(obj.milestone);
    if (!r.valid) {
      fieldErrors.milestone = r.error;
    } else {
      validatedMilestone = r.value;
    }
  }

  // Validate azure sub-object (optional)
  let validatedAzure: AzureCreateOptions | undefined;
  if ('azure' in obj && obj.azure !== undefined) {
    const isCreate = true;
    const result = validateAzureCreateOptions(obj.azure, isCreate, fieldErrors);
    if (result !== null) {
      validatedAzure = result;
    }
  }

  // Validate init sub-object (optional)
  let validatedInit: IngestInitParams | undefined;
  const hasInit = 'init' in obj && obj.init !== undefined;
  if (hasInit) {
    const result = validateInitParams(obj.init, fieldErrors);
    if (result !== null) {
      validatedInit = result;
    }
  }

  // Validate auto_select dependency
  let validatedAutoSelect: boolean | undefined;
  if ('auto_select' in obj && obj.auto_select !== undefined) {
    if (!hasInit) {
      fieldErrors.auto_select =
        'auto_select requires init to be present.';
    } else {
      const r = validateBoolean(obj.auto_select, 'auto_select');
      if (!r.valid) {
        fieldErrors.auto_select = r.error;
      } else {
        validatedAutoSelect = r.value;
      }
    }
  } else if (hasInit) {
    // Default auto_select to true when init is present
    validatedAutoSelect = true;
  }

  // Validate auto_run dependency and sub-object
  let validatedAutoRun: IngestAutoRunParams | undefined;
  if ('auto_run' in obj && obj.auto_run !== undefined) {
    if (!hasInit) {
      fieldErrors.auto_run =
        'auto_run requires init to be present.';
    } else if (validatedAutoSelect === false) {
      fieldErrors.auto_run =
        'auto_run requires auto_select to not be false.';
    } else {
      const result = validateAutoRunParams(obj.auto_run, fieldErrors);
      if (result !== null) {
        validatedAutoRun = result;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      valid: false,
      error: 'Validation failed.',
      code: 'validation_failed',
      field_errors: fieldErrors,
    };
  }

  const value: ValidatedCreateProviderIssueRequest = {
    provider: validatedProvider,
    repo: validatedRepo!,
    title: validatedTitle!,
    body: validatedBody!,
    ...(validatedLabels !== undefined && { labels: validatedLabels }),
    ...(validatedMilestone !== undefined && { milestone: validatedMilestone }),
    ...(validatedAssignees !== undefined && { assignees: validatedAssignees }),
    ...(validatedAzure !== undefined && { azure: validatedAzure }),
    ...(validatedInit !== undefined && { init: validatedInit }),
    ...(validatedAutoSelect !== undefined && {
      auto_select: validatedAutoSelect,
    }),
    ...(validatedAutoRun !== undefined && { auto_run: validatedAutoRun }),
  };

  return { valid: true, value };
}

/**
 * Validate a POST /api/issues/init-from-existing request body.
 *
 * Provider validation failure returns code 'unsupported_provider' immediately.
 * All other validation failures return code 'validation_failed' with field_errors.
 */
export function validateInitFromExistingRequest(
  body: unknown,
): CompoundValidationResult<ValidatedInitFromExistingRequest> {
  if (body === null || typeof body !== 'object') {
    return {
      valid: false,
      error: 'Request body must be an object.',
      code: 'validation_failed',
      field_errors: {},
    };
  }

  const obj = body as Record<string, unknown>;

  // Validate provider first — unsupported_provider is a separate error code
  if (!('provider' in obj) || obj.provider === undefined) {
    return {
      valid: false,
      error: 'Provider is required.',
      code: 'unsupported_provider',
      field_errors: { provider: 'Provider is required.' },
    };
  }

  const providerResult = validateProvider(obj.provider);
  if (!providerResult.valid) {
    return {
      valid: false,
      error: providerResult.error,
      code: 'unsupported_provider',
      field_errors: { provider: providerResult.error },
    };
  }

  const validatedProvider = providerResult.value;
  const fieldErrors: Record<string, string> = {};

  // Validate repo (required)
  let validatedRepo: string | undefined;
  if (!('repo' in obj) || obj.repo === undefined) {
    fieldErrors.repo = 'Repo is required.';
  } else {
    const r = validateRepo(obj.repo);
    if (!r.valid) {
      fieldErrors.repo = r.error;
    } else {
      validatedRepo = r.value;
    }
  }

  // Validate existing (required)
  let validatedExisting: ValidatedExistingItemRef | undefined;
  if (!('existing' in obj) || obj.existing === undefined) {
    fieldErrors.existing = 'Existing item reference is required.';
  } else {
    const result = validateExistingItemRef(obj.existing, fieldErrors);
    if (result !== null) {
      validatedExisting = result;
    }
  }

  // Validate azure sub-object (optional, init-from-existing variant)
  let validatedAzure: AzureInitFromExistingOptions | undefined;
  if ('azure' in obj && obj.azure !== undefined) {
    const result = validateAzureInitFromExistingOptions(
      obj.azure,
      fieldErrors,
    );
    if (result !== null) {
      validatedAzure = result;
    }
  }

  // Validate init sub-object (optional)
  let validatedInit: IngestInitParams | undefined;
  const hasInit = 'init' in obj && obj.init !== undefined;
  if (hasInit) {
    const result = validateInitParams(obj.init, fieldErrors);
    if (result !== null) {
      validatedInit = result;
    }
  }

  // Validate auto_select dependency
  let validatedAutoSelect: boolean | undefined;
  if ('auto_select' in obj && obj.auto_select !== undefined) {
    if (!hasInit) {
      fieldErrors.auto_select =
        'auto_select requires init to be present.';
    } else {
      const r = validateBoolean(obj.auto_select, 'auto_select');
      if (!r.valid) {
        fieldErrors.auto_select = r.error;
      } else {
        validatedAutoSelect = r.value;
      }
    }
  } else if (hasInit) {
    // Default auto_select to true when init is present
    validatedAutoSelect = true;
  }

  // Validate auto_run dependency and sub-object
  let validatedAutoRun: IngestAutoRunParams | undefined;
  if ('auto_run' in obj && obj.auto_run !== undefined) {
    if (!hasInit) {
      fieldErrors.auto_run =
        'auto_run requires init to be present.';
    } else if (validatedAutoSelect === false) {
      fieldErrors.auto_run =
        'auto_run requires auto_select to not be false.';
    } else {
      const result = validateAutoRunParams(obj.auto_run, fieldErrors);
      if (result !== null) {
        validatedAutoRun = result;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      valid: false,
      error: 'Validation failed.',
      code: 'validation_failed',
      field_errors: fieldErrors,
    };
  }

  const value: ValidatedInitFromExistingRequest = {
    provider: validatedProvider,
    repo: validatedRepo!,
    existing: validatedExisting!,
    ...(validatedAzure !== undefined && { azure: validatedAzure }),
    ...(validatedInit !== undefined && { init: validatedInit }),
    ...(validatedAutoSelect !== undefined && {
      auto_select: validatedAutoSelect,
    }),
    ...(validatedAutoRun !== undefined && { auto_run: validatedAutoRun }),
  };

  return { valid: true, value };
}

// ============================================================================
// Error Sanitization
// ============================================================================

/**
 * Sanitize an error for UI display.
 *
 * This ensures:
 * - Error is a string
 * - Truncated to max length
 * - No null, newline, or carriage return characters
 * - Never includes sensitive values (caller must ensure this)
 */
export function sanitizeErrorForUi(error: unknown): string {
  let message: string;

  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  } else {
    message = 'Unknown error';
  }

  // Replace forbidden characters with spaces
  message = message.replace(/[\0\n\r]/g, ' ');

  // Truncate if too long
  if (message.length > MAX_ERROR_LENGTH) {
    message = message.slice(0, MAX_ERROR_LENGTH - 3) + '...';
  }

  return message;
}

/**
 * Sanitize an error message to ensure no PAT values leak.
 * Strips any occurrence of a known PAT value from the message.
 */
export function sanitizePatFromMessage(
  message: string,
  patValue?: string,
): string {
  if (!patValue || patValue.length === 0) {
    return message;
  }

  // Replace any occurrence of the PAT with a redacted marker
  return message.split(patValue).join('[REDACTED]');
}
