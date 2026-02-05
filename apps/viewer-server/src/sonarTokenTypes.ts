/**
 * Types and validation helpers for Sonar token management.
 *
 * This module provides:
 * - Domain types for status, requests, responses, and events
 * - Input validation for token and env var name fields
 * - Error sanitization helpers
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
// Validation Constants
// ============================================================================

/** Minimum token length after trim. */
export const TOKEN_MIN_LENGTH = 1;

/** Maximum token length after trim. */
export const TOKEN_MAX_LENGTH = 1024;

/** Minimum env var name length after trim. */
export const ENV_VAR_NAME_MIN_LENGTH = 1;

/** Maximum env var name length after trim. */
export const ENV_VAR_NAME_MAX_LENGTH = 64;

/** Pattern for valid env var names: starts with A-Z or _, followed by A-Z, 0-9, or _. */
export const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Default env var name when not specified. */
export const DEFAULT_ENV_VAR_NAME = 'SONAR_TOKEN';

/** Characters that are forbidden in token and env var name values. */
const FORBIDDEN_CHARS = ['\0', '\n', '\r'];

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

export type PutValidationSuccess = Readonly<{
  valid: true;
  token: string | undefined;
  env_var_name: string | undefined;
  sync_now: boolean;
}>;

export type PutValidationFailure = Readonly<{
  valid: false;
  error: string;
  code: string;
  field_errors: Record<string, string>;
}>;

export type PutValidationResult = PutValidationSuccess | PutValidationFailure;

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
 * Validate a token value.
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 1..1024
 * - Must not contain \0, \n, or \r
 *
 * @param token - The token value to validate
 * @returns Validation result with trimmed token on success
 */
export function validateToken(token: unknown): ValidationResult<string> {
  if (typeof token !== 'string') {
    return { valid: false, error: 'Token must be a string.' };
  }

  const trimmed = token.trim();

  if (trimmed.length < TOKEN_MIN_LENGTH) {
    return { valid: false, error: 'Token must not be empty after trimming.' };
  }

  if (trimmed.length > TOKEN_MAX_LENGTH) {
    return {
      valid: false,
      error: `Token must be at most ${TOKEN_MAX_LENGTH} characters after trimming.`,
    };
  }

  if (containsForbiddenChars(trimmed)) {
    return { valid: false, error: 'Token must not contain null, newline, or carriage return characters.' };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate an environment variable name.
 *
 * Rules:
 * - Must be a string
 * - Trimmed length must be 1..64
 * - Must match pattern ^[A-Z_][A-Z0-9_]*$
 * - Must not contain \0, \n, or \r
 *
 * @param envVarName - The env var name to validate
 * @returns Validation result with trimmed env var name on success
 */
export function validateEnvVarName(envVarName: unknown): ValidationResult<string> {
  if (typeof envVarName !== 'string') {
    return { valid: false, error: 'Environment variable name must be a string.' };
  }

  const trimmed = envVarName.trim();

  if (trimmed.length < ENV_VAR_NAME_MIN_LENGTH) {
    return { valid: false, error: 'Environment variable name must not be empty after trimming.' };
  }

  if (trimmed.length > ENV_VAR_NAME_MAX_LENGTH) {
    return {
      valid: false,
      error: `Environment variable name must be at most ${ENV_VAR_NAME_MAX_LENGTH} characters after trimming.`,
    };
  }

  if (containsForbiddenChars(trimmed)) {
    return {
      valid: false,
      error: 'Environment variable name must not contain null, newline, or carriage return characters.',
    };
  }

  if (!ENV_VAR_NAME_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: 'Environment variable name must start with A-Z or underscore and contain only A-Z, 0-9, or underscore.',
    };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate a boolean field.
 *
 * @param value - The value to validate
 * @param fieldName - Name of the field for error messages
 * @returns Validation result with the boolean value on success
 */
export function validateBoolean(value: unknown, fieldName: string): ValidationResult<boolean> {
  if (typeof value !== 'boolean') {
    return { valid: false, error: `${fieldName} must be a boolean.` };
  }
  return { valid: true, value };
}

/**
 * Validate a PUT request body.
 *
 * Rules:
 * - At least one of token or env_var_name must be provided
 * - If token is provided, it must pass token validation
 * - If env_var_name is provided, it must pass env var name validation
 * - If sync_now is provided, it must be a boolean
 *
 * @param body - The request body to validate
 * @returns Validation result with validated fields on success
 */
export function validatePutRequest(body: unknown): PutValidationResult {
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

  // Check if at least one of token or env_var_name is provided
  const hasToken = 'token' in obj && obj.token !== undefined;
  const hasEnvVarName = 'env_var_name' in obj && obj.env_var_name !== undefined;

  if (!hasToken && !hasEnvVarName) {
    return {
      valid: false,
      error: 'At least one of token or env_var_name must be provided.',
      code: 'validation_failed',
      field_errors: {
        token: 'At least one of token or env_var_name is required.',
        env_var_name: 'At least one of token or env_var_name is required.',
      },
    };
  }

  let validatedToken: string | undefined;
  let validatedEnvVarName: string | undefined;
  let validatedSyncNow = true; // default

  // Validate token if provided
  if (hasToken) {
    const tokenResult = validateToken(obj.token);
    if (!tokenResult.valid) {
      fieldErrors.token = tokenResult.error;
    } else {
      validatedToken = tokenResult.value;
    }
  }

  // Validate env_var_name if provided
  if (hasEnvVarName) {
    const envVarResult = validateEnvVarName(obj.env_var_name);
    if (!envVarResult.valid) {
      fieldErrors.env_var_name = envVarResult.error;
    } else {
      validatedEnvVarName = envVarResult.value;
    }
  }

  // Validate sync_now if provided
  if ('sync_now' in obj && obj.sync_now !== undefined) {
    const syncNowResult = validateBoolean(obj.sync_now, 'sync_now');
    if (!syncNowResult.valid) {
      fieldErrors.sync_now = syncNowResult.error;
    } else {
      validatedSyncNow = syncNowResult.value;
    }
  }

  // If there are any field errors, return failure
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
    token: validatedToken,
    env_var_name: validatedEnvVarName,
    sync_now: validatedSyncNow,
  };
}

/**
 * Validate a RECONCILE request body.
 *
 * Rules:
 * - If force is provided, it must be a boolean
 *
 * @param body - The request body to validate
 * @returns Validation result with validated force flag on success
 */
export function validateReconcileRequest(
  body: unknown,
): ValidationResult<{ force: boolean }> & { code?: string; field_errors?: Record<string, string> } {
  // Allow null/undefined body (defaults to force=false)
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

  // Validate force if provided
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

// ============================================================================
// Error Sanitization
// ============================================================================

/** Maximum length for sanitized error strings. */
const MAX_ERROR_LENGTH = 2048;

/**
 * Sanitize an error for UI display.
 *
 * This ensures:
 * - Error is a string
 * - Truncated to max length
 * - No null, newline, or carriage return characters
 * - Never includes sensitive values (caller must ensure this)
 *
 * @param error - The error to sanitize (can be Error, string, or unknown)
 * @returns A sanitized error string safe for UI display and storage
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
