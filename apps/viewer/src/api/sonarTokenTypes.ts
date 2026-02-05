/**
 * Types for Sonar token management API.
 *
 * These types mirror the viewer-server types for typed API calls.
 *
 * IMPORTANT: Token values are NEVER included in status, response, or event types.
 */

// ============================================================================
// Enums
// ============================================================================

/**
 * Sync status enum for worktree reconciliation state.
 */
export type SonarSyncStatus =
  | 'in_sync'
  | 'deferred_worktree_absent'
  | 'failed_exclude'
  | 'failed_env_write'
  | 'failed_env_delete'
  | 'failed_secret_read'
  | 'never_attempted';

// ============================================================================
// Status Types (never include token value)
// ============================================================================

/**
 * Status response returned by GET /api/issue/sonar-token.
 * Note: token value is NEVER included.
 */
export type SonarTokenStatusResponse = Readonly<{
  ok: true;
  issue_ref: string;
  worktree_present: boolean;
  has_token: boolean;
  env_var_name: string;
  sync_status: SonarSyncStatus;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}>;

/**
 * Status payload (without ok field) used in responses and events.
 * Note: token value is NEVER included.
 */
export type SonarTokenStatus = Readonly<{
  issue_ref: string;
  worktree_present: boolean;
  has_token: boolean;
  env_var_name: string;
  sync_status: SonarSyncStatus;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}>;

// ============================================================================
// Request Types
// ============================================================================

/**
 * Request body for PUT /api/issue/sonar-token.
 * At least one of token or env_var_name must be provided.
 */
export type PutSonarTokenRequest = Readonly<{
  token?: string;
  env_var_name?: string;
  sync_now?: boolean;
}>;

/**
 * Request body for POST /api/issue/sonar-token/reconcile.
 */
export type ReconcileSonarTokenRequest = Readonly<{
  force?: boolean;
}>;

// ============================================================================
// Response Types
// ============================================================================

/**
 * Response for mutating operations (PUT, DELETE, POST /reconcile).
 * Note: token value is NEVER included in status.
 */
export type SonarTokenMutateResponse = Readonly<{
  ok: true;
  updated: boolean;
  status: SonarTokenStatus;
  warnings: string[];
}>;

/**
 * Standard error response envelope.
 */
export type SonarTokenErrorResponse = Readonly<{
  ok: false;
  error: string;
  code?: string;
  field_errors?: Record<string, string>;
}>;

// ============================================================================
// Event Types
// ============================================================================

/**
 * Event payload for sonar-token-status SSE/WS event.
 * Note: token value is NEVER included.
 */
export type SonarTokenStatusEvent = Readonly<{
  issue_ref: string;
  worktree_present: boolean;
  has_token: boolean;
  env_var_name: string;
  sync_status: SonarSyncStatus;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}>;

// ============================================================================
// Constants
// ============================================================================

/** Default env var name when not specified. */
export const DEFAULT_ENV_VAR_NAME = 'SONAR_TOKEN';
