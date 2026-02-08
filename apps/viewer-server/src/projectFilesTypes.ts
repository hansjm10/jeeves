import path from 'node:path';

// ============================================================================
// Enums
// ============================================================================

export type ProjectFilesSyncStatus =
  | 'in_sync'
  | 'deferred_worktree_absent'
  | 'failed_conflict'
  | 'failed_link_create'
  | 'failed_source_missing'
  | 'failed_exclude'
  | 'never_attempted';

export type ProjectFilesOperation =
  | 'put'
  | 'delete'
  | 'reconcile'
  | 'auto_reconcile';

// ============================================================================
// Constants
// ============================================================================

export const PROJECT_FILES_SCHEMA_VERSION = 1;
export const PROJECT_FILE_ID_MAX_LENGTH = 64;
export const PROJECT_FILE_DISPLAY_NAME_MAX_LENGTH = 255;
export const PROJECT_FILE_TARGET_PATH_MAX_LENGTH = 512;
export const PROJECT_FILE_MAX_BYTES = 1024 * 1024; // 1 MiB
export const PROJECT_FILE_MAX_COUNT = 50;

const FORBIDDEN_CHARS = ['\0', '\n', '\r'];
const PROJECT_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ============================================================================
// Data Types
// ============================================================================

export type ProjectFileRecord = Readonly<{
  id: string;
  display_name: string;
  target_path: string;
  storage_relpath: string;
  size_bytes: number;
  sha256: string;
  updated_at: string;
}>;

export type ProjectFilePublic = Readonly<{
  id: string;
  display_name: string;
  target_path: string;
  size_bytes: number;
  sha256: string;
  updated_at: string;
}>;

export type ProjectFilesIndex = Readonly<{
  schemaVersion: 1;
  files: readonly ProjectFileRecord[];
}>;

export type ProjectFilesStatus = Readonly<{
  issue_ref: string;
  worktree_present: boolean;
  file_count: number;
  files: readonly ProjectFilePublic[];
  sync_status: ProjectFilesSyncStatus;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}>;

export type ProjectFilesStatusEvent = ProjectFilesStatus &
  Readonly<{
    operation: ProjectFilesOperation;
  }>;

export type ProjectFilesStatusResponse = Readonly<{
  ok: true;
}> &
  ProjectFilesStatus;

export type ProjectFilesMutateResponse = Readonly<{
  ok: true;
  updated: boolean;
  status: ProjectFilesStatus;
  warnings: string[];
  file?: ProjectFilePublic;
}>;

export type ProjectFilesErrorResponse = Readonly<{
  ok: false;
  error: string;
  code: string;
  field_errors?: Record<string, string>;
}>;

// ============================================================================
// Request Types
// ============================================================================

export type PutProjectFileRequest = Readonly<{
  id?: string;
  display_name?: string;
  target_path: string;
  content_base64: string;
  sync_now?: boolean;
}>;

export type PutProjectFileValidated = Readonly<{
  id?: string;
  display_name: string;
  target_path: string;
  content: Buffer;
  sync_now: boolean;
}>;

export type PutProjectFileValidationResult =
  | Readonly<{
      valid: true;
      value: PutProjectFileValidated;
    }>
  | Readonly<{
      valid: false;
      error: string;
      code: string;
      field_errors: Record<string, string>;
    }>;

export type DeleteProjectFileValidationResult =
  | Readonly<{
      valid: true;
      id: string;
    }>
  | Readonly<{
      valid: false;
      error: string;
      code: string;
      field_errors: Record<string, string>;
    }>;

export type ReconcileProjectFilesRequest = Readonly<{
  force?: boolean;
}>;

export type ReconcileProjectFilesValidationResult =
  | Readonly<{
      valid: true;
      value: Readonly<{ force: boolean }>;
    }>
  | Readonly<{
      valid: false;
      error: string;
      code: string;
      field_errors: Record<string, string>;
    }>;

// ============================================================================
// Validation helpers
// ============================================================================

function containsForbiddenChars(value: string): boolean {
  return FORBIDDEN_CHARS.some((c) => value.includes(c));
}

export function normalizeProjectTargetPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (containsForbiddenChars(trimmed)) return null;

  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return null;

  const slashNormalized = trimmed.replace(/\\+/g, '/');
  if (slashNormalized.startsWith('/')) return null;

  const normalized = path.posix.normalize(slashNormalized);
  if (!normalized || normalized === '.' || normalized === '..') return null;
  if (normalized.startsWith('../')) return null;
  if (normalized.includes('/../')) return null;

  if (normalized === '.git' || normalized.startsWith('.git/')) return null;

  return normalized;
}

export function validateProjectFileId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!PROJECT_FILE_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function parseBase64Content(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const compact = trimmed.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  if (compact.length % 4 !== 0) return null;

  try {
    const buf = Buffer.from(compact, 'base64');
    const recoded = buf.toString('base64');
    const withoutPadding = compact.replace(/=+$/, '');
    const recodedWithoutPadding = recoded.replace(/=+$/, '');
    if (withoutPadding !== recodedWithoutPadding) return null;
    return buf;
  } catch {
    return null;
  }
}

function deriveDisplayName(input: unknown, targetPath: string): { value: string | null; error?: string } {
  if (input === undefined) {
    const leaf = targetPath.split('/').pop() ?? targetPath;
    return { value: leaf };
  }

  if (typeof input !== 'string') {
    return { value: null, error: 'display_name must be a string.' };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { value: null, error: 'display_name must not be empty.' };
  }

  if (trimmed.length > PROJECT_FILE_DISPLAY_NAME_MAX_LENGTH) {
    return {
      value: null,
      error: `display_name must be at most ${PROJECT_FILE_DISPLAY_NAME_MAX_LENGTH} characters.`,
    };
  }

  if (containsForbiddenChars(trimmed)) {
    return {
      value: null,
      error: 'display_name must not contain null, newline, or carriage return characters.',
    };
  }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return { value: null, error: 'display_name must not contain path separators.' };
  }

  return { value: trimmed };
}

export function toProjectFilePublic(record: ProjectFileRecord): ProjectFilePublic {
  return {
    id: record.id,
    display_name: record.display_name,
    target_path: record.target_path,
    size_bytes: record.size_bytes,
    sha256: record.sha256,
    updated_at: record.updated_at,
  };
}

export function validatePutProjectFileRequest(body: unknown): PutProjectFileValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      valid: false,
      error: 'Request body must be an object.',
      code: 'validation_failed',
      field_errors: {},
    };
  }

  const obj = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};

  let id: string | undefined;
  if (obj.id !== undefined) {
    const validatedId = validateProjectFileId(obj.id);
    if (!validatedId) {
      fieldErrors.id = 'id must match ^[A-Za-z0-9_-]{1,64}$.';
    } else {
      id = validatedId;
    }
  }

  let targetPath: string | undefined;
  if (typeof obj.target_path !== 'string') {
    fieldErrors.target_path = 'target_path is required and must be a string.';
  } else if (obj.target_path.trim().length > PROJECT_FILE_TARGET_PATH_MAX_LENGTH) {
    fieldErrors.target_path = `target_path must be at most ${PROJECT_FILE_TARGET_PATH_MAX_LENGTH} characters.`;
  } else {
    const normalized = normalizeProjectTargetPath(obj.target_path);
    if (!normalized) {
      fieldErrors.target_path = 'target_path must be a safe relative path and must not target .git.';
    } else {
      targetPath = normalized;
    }
  }

  const content = parseBase64Content(obj.content_base64);
  if (!content) {
    fieldErrors.content_base64 = 'content_base64 must be valid base64.';
  } else if (content.length > PROJECT_FILE_MAX_BYTES) {
    fieldErrors.content_base64 = `File content must be at most ${PROJECT_FILE_MAX_BYTES} bytes.`;
  }

  let displayName: string | undefined;
  if (targetPath) {
    const displayResult = deriveDisplayName(obj.display_name, targetPath);
    if (!displayResult.value) {
      fieldErrors.display_name = displayResult.error ?? 'Invalid display_name.';
    } else {
      displayName = displayResult.value;
    }
  }

  let syncNow = true;
  if (obj.sync_now !== undefined) {
    if (typeof obj.sync_now !== 'boolean') {
      fieldErrors.sync_now = 'sync_now must be a boolean.';
    } else {
      syncNow = obj.sync_now;
    }
  }

  if (Object.keys(fieldErrors).length > 0 || !targetPath || !content || !displayName) {
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
      ...(id ? { id } : {}),
      display_name: displayName,
      target_path: targetPath,
      content,
      sync_now: syncNow,
    },
  };
}

export function validateDeleteProjectFileId(input: unknown): DeleteProjectFileValidationResult {
  const id = validateProjectFileId(input);
  if (!id) {
    return {
      valid: false,
      error: 'Invalid id.',
      code: 'validation_failed',
      field_errors: { id: 'id must match ^[A-Za-z0-9_-]{1,64}$.' },
    };
  }
  return { valid: true, id };
}

export function validateReconcileProjectFilesRequest(body: unknown): ReconcileProjectFilesValidationResult {
  if (body === undefined || body === null || body === '') {
    return { valid: true, value: { force: false } };
  }

  if (typeof body !== 'object' || Array.isArray(body)) {
    return {
      valid: false,
      error: 'Request body must be an object.',
      code: 'validation_failed',
      field_errors: {},
    };
  }

  const obj = body as Record<string, unknown>;
  if (obj.force !== undefined && typeof obj.force !== 'boolean') {
    return {
      valid: false,
      error: 'force must be a boolean.',
      code: 'validation_failed',
      field_errors: { force: 'force must be a boolean.' },
    };
  }

  return {
    valid: true,
    value: {
      force: obj.force === true,
    },
  };
}
