/**
 * Provider operation lock/journal primitives and recovery hooks.
 *
 * This module provides crash-safe, per-issue locking and checkpoint-based
 * operation journaling for provider mutations (credentials, ingest, PR prep).
 *
 * Artifact layout:
 *   .jeeves/.ops/provider-operation.lock   - per-issue mutex
 *   .jeeves/.ops/provider-operation.json   - checkpoint journal
 *
 * Lifecycle ordering:
 *   1. Acquire lock
 *   2. Create/update journal
 *   3. Perform side effects
 *   4. Mark completed_at and remove lock
 *
 * Recovery:
 *   On startup, detect stale lock / incomplete journal / temp artifacts,
 *   clean up, and return resumable checkpoint state.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { IssueProvider } from './azureDevopsTypes.js';

// ============================================================================
// Types
// ============================================================================

/** Kind of provider operation being tracked. */
export type ProviderOperationKind = 'credentials' | 'ingest' | 'pr_prepare';

/** Checkpoint fields persisted for crash recovery. */
export type JournalCheckpoint = Readonly<{
  remote_id: string | null;
  remote_url: string | null;
  pr_id: string | null;
  issue_state_persisted: boolean;
  init_completed: boolean;
  auto_selected: boolean;
  auto_run_started: boolean;
  warnings: readonly string[];
}>;

/** Full journal file schema (Section 4). */
export type ProviderOperationJournal = Readonly<{
  schemaVersion: 1;
  operation_id: string;
  kind: ProviderOperationKind;
  state: string;
  issue_ref: string;
  provider: IssueProvider | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  checkpoint: JournalCheckpoint;
}>;

/** Lock file schema (Section 4). */
export type ProviderOperationLock = Readonly<{
  schemaVersion: 1;
  operation_id: string;
  issue_ref: string;
  acquired_at: string;
  expires_at: string;
  pid: number;
}>;

/** Result of attempting to acquire a lock. */
export type AcquireLockResult =
  | Readonly<{ acquired: true; operation_id: string }>
  | Readonly<{ acquired: false; reason: 'busy' | 'stale_cleaned' }>;

/** Result of startup recovery detection. */
export type RecoveryResult =
  | Readonly<{ needed: false }>
  | Readonly<{ needed: true; journal: ProviderOperationJournal; recovery_state: string }>;

/** Input parameters for creating a new journal entry. */
export type CreateJournalParams = Readonly<{
  operation_id: string;
  kind: ProviderOperationKind;
  state: string;
  issue_ref: string;
  provider: IssueProvider | null;
}>;

/** Result of stale artifact cleanup. */
export type CleanupResult = Readonly<{
  lock_removed: boolean;
  journal_removed: boolean;
  temp_files_removed: number;
}>;

// ============================================================================
// Constants
// ============================================================================

/** Name of the ops directory within the issue state directory. */
const OPS_DIR_NAME = '.ops';

/** Name of the journal file. */
const JOURNAL_FILE_NAME = 'provider-operation.json';

/** Name of the lock file. */
const LOCK_FILE_NAME = 'provider-operation.lock';

/** Current lock schema version. */
const LOCK_SCHEMA_VERSION = 1;

/** Current journal schema version. */
const JOURNAL_SCHEMA_VERSION = 1;

/** Default lock timeout in milliseconds (30 seconds). */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** Pattern for valid operation IDs. */
export const OPERATION_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;

/** Pattern for valid state names. */
export const STATE_PATTERN = /^(cred|ingest|pr)\.[a-z_]+$/;

/** Pattern for valid issue refs: owner/repo#number. */
export const ISSUE_REF_PATTERN = /^[^\s/]+\/[^\s/]+#\d+$/;

/** Maximum number of warnings in a checkpoint. */
export const MAX_WARNINGS = 50;

/** Maximum length of a single warning string. */
export const MAX_WARNING_LENGTH = 512;

/** Valid operation kinds. */
const VALID_KINDS: readonly ProviderOperationKind[] = ['credentials', 'ingest', 'pr_prepare'];

/** Valid provider values. */
const VALID_PROVIDERS: readonly (IssueProvider | null)[] = ['github', 'azure_devops', null];

/** File permissions for lock and journal files (owner read/write only). */
const FILE_MODE = 0o600;

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Get the path to the ops directory for an issue state directory.
 */
export function getOpsDir(issueStateDir: string): string {
  return path.join(issueStateDir, OPS_DIR_NAME);
}

/**
 * Get the path to the journal file.
 */
export function getJournalPath(issueStateDir: string): string {
  return path.join(getOpsDir(issueStateDir), JOURNAL_FILE_NAME);
}

/**
 * Get the path to the lock file.
 */
export function getLockPath(issueStateDir: string): string {
  return path.join(getOpsDir(issueStateDir), LOCK_FILE_NAME);
}

// ============================================================================
// Lock Operations
// ============================================================================

/**
 * Attempt to acquire the per-issue provider operation lock.
 *
 * If a valid, non-stale lock is held by a live process, returns busy.
 * If a stale lock is found (expired or PID dead), cleans it up and
 * returns stale_cleaned so the caller can retry.
 * Otherwise, creates a new lock file atomically.
 */
export async function acquireLock(
  issueStateDir: string,
  params: {
    operation_id: string;
    issue_ref: string;
    timeout_ms?: number;
  },
): Promise<AcquireLockResult> {
  if (!OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new Error(`Invalid operation_id: must match ${OPERATION_ID_PATTERN.source}`);
  }
  if (!ISSUE_REF_PATTERN.test(params.issue_ref)) {
    throw new Error(`Invalid issue_ref: must match ${ISSUE_REF_PATTERN.source}`);
  }

  const opsDir = getOpsDir(issueStateDir);
  const lockPath = getLockPath(issueStateDir);
  const timeoutMs = params.timeout_ms ?? DEFAULT_LOCK_TIMEOUT_MS;

  // Ensure .ops directory exists
  await fs.mkdir(opsDir, { recursive: true });

  // Check for existing lock
  const existingLock = await readLock(issueStateDir);
  if (existingLock) {
    if (isLockStale(existingLock)) {
      // Stale lock: clean up and signal caller to retry
      await fs.rm(lockPath, { force: true }).catch(() => void 0);
      return { acquired: false, reason: 'stale_cleaned' };
    }
    // Lock held by a live process
    return { acquired: false, reason: 'busy' };
  }

  // No lock or cleaned: create new lock atomically
  const now = new Date();
  const lock: ProviderOperationLock = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    operation_id: params.operation_id,
    issue_ref: params.issue_ref,
    acquired_at: now.toISOString(),
    expires_at: new Date(now.getTime() + timeoutMs).toISOString(),
    pid: process.pid,
  };

  await writeAtomicWithPermissions(lockPath, lock);

  return { acquired: true, operation_id: params.operation_id };
}

/**
 * Release the per-issue provider operation lock.
 * Idempotent: succeeds even if the lock file doesn't exist.
 */
export async function releaseLock(issueStateDir: string): Promise<void> {
  const lockPath = getLockPath(issueStateDir);
  await fs.rm(lockPath, { force: true }).catch(() => void 0);
}

/**
 * Refresh the lock timeout by updating expires_at.
 * Returns false if no lock file exists.
 */
export async function refreshLock(
  issueStateDir: string,
  params?: { timeout_ms?: number },
): Promise<boolean> {
  const existing = await readLock(issueStateDir);
  if (!existing) return false;

  const timeoutMs = params?.timeout_ms ?? DEFAULT_LOCK_TIMEOUT_MS;
  const refreshed: ProviderOperationLock = {
    ...existing,
    expires_at: new Date(Date.now() + timeoutMs).toISOString(),
  };

  await writeAtomicWithPermissions(getLockPath(issueStateDir), refreshed);
  return true;
}

/**
 * Read and validate the lock file.
 * Returns null if absent, invalid JSON, or wrong schema.
 */
export async function readLock(issueStateDir: string): Promise<ProviderOperationLock | null> {
  const lockPath = getLockPath(issueStateDir);
  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (!isValidLock(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Determine whether a lock is stale.
 * A lock is stale if expires_at is in the past OR the owning process is dead.
 */
export function isLockStale(lock: ProviderOperationLock): boolean {
  const now = Date.now();
  const expiresAt = new Date(lock.expires_at).getTime();
  if (expiresAt < now) return true;
  if (!isProcessAlive(lock.pid)) return true;
  return false;
}

// ============================================================================
// Journal Operations
// ============================================================================

/**
 * Create a new journal file for a provider operation.
 * The journal starts with completed_at = null and empty checkpoint defaults.
 */
export async function createJournal(
  issueStateDir: string,
  params: CreateJournalParams,
): Promise<ProviderOperationJournal> {
  if (!OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new Error(`Invalid operation_id: must match ${OPERATION_ID_PATTERN.source}`);
  }
  if (!VALID_KINDS.includes(params.kind)) {
    throw new Error(`Invalid kind: must be one of ${VALID_KINDS.join(', ')}`);
  }
  if (!STATE_PATTERN.test(params.state)) {
    throw new Error(`Invalid state: must match ${STATE_PATTERN.source}`);
  }
  if (!ISSUE_REF_PATTERN.test(params.issue_ref)) {
    throw new Error(`Invalid issue_ref: must match ${ISSUE_REF_PATTERN.source}`);
  }
  if (!VALID_PROVIDERS.includes(params.provider)) {
    throw new Error(`Invalid provider: must be one of ${VALID_PROVIDERS.join(', ')}`);
  }

  const opsDir = getOpsDir(issueStateDir);
  await fs.mkdir(opsDir, { recursive: true });

  const now = new Date().toISOString();
  const journal: ProviderOperationJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    operation_id: params.operation_id,
    kind: params.kind,
    state: params.state,
    issue_ref: params.issue_ref,
    provider: params.provider,
    started_at: now,
    updated_at: now,
    completed_at: null,
    checkpoint: {
      remote_id: null,
      remote_url: null,
      pr_id: null,
      issue_state_persisted: false,
      init_completed: false,
      auto_selected: false,
      auto_run_started: false,
      warnings: [],
    },
  };

  await writeAtomicWithPermissions(getJournalPath(issueStateDir), journal);
  return journal;
}

/**
 * Update the journal state and timestamp.
 * Preserves all other fields.
 */
export async function updateJournalState(
  issueStateDir: string,
  state: string,
): Promise<ProviderOperationJournal> {
  if (!STATE_PATTERN.test(state)) {
    throw new Error(`Invalid state: must match ${STATE_PATTERN.source}`);
  }

  const existing = await readJournal(issueStateDir);
  if (!existing) {
    throw new Error('No journal file exists to update');
  }

  const updated: ProviderOperationJournal = {
    ...existing,
    state,
    updated_at: new Date().toISOString(),
  };

  await writeAtomicWithPermissions(getJournalPath(issueStateDir), updated);
  return updated;
}

/**
 * Update checkpoint fields in the journal.
 * Merges provided fields; preserves fields not in the update.
 * Enforces MAX_WARNINGS and MAX_WARNING_LENGTH on warnings.
 */
export async function updateJournalCheckpoint(
  issueStateDir: string,
  checkpoint: Partial<{
    remote_id: string | null;
    remote_url: string | null;
    pr_id: string | null;
    issue_state_persisted: boolean;
    init_completed: boolean;
    auto_selected: boolean;
    auto_run_started: boolean;
    warnings: string[];
  }>,
): Promise<ProviderOperationJournal> {
  const existing = await readJournal(issueStateDir);
  if (!existing) {
    throw new Error('No journal file exists to update');
  }

  // Merge checkpoint, enforcing warning limits
  let mergedWarnings = checkpoint.warnings !== undefined
    ? checkpoint.warnings
    : [...existing.checkpoint.warnings];

  // Truncate individual warnings
  mergedWarnings = mergedWarnings.map((w) =>
    w.length > MAX_WARNING_LENGTH ? w.slice(0, MAX_WARNING_LENGTH) : w,
  );
  // Truncate total count
  if (mergedWarnings.length > MAX_WARNINGS) {
    mergedWarnings = mergedWarnings.slice(0, MAX_WARNINGS);
  }

  const mergedCheckpoint: JournalCheckpoint = {
    remote_id: checkpoint.remote_id !== undefined ? checkpoint.remote_id : existing.checkpoint.remote_id,
    remote_url: checkpoint.remote_url !== undefined ? checkpoint.remote_url : existing.checkpoint.remote_url,
    pr_id: checkpoint.pr_id !== undefined ? checkpoint.pr_id : existing.checkpoint.pr_id,
    issue_state_persisted: checkpoint.issue_state_persisted !== undefined
      ? checkpoint.issue_state_persisted
      : existing.checkpoint.issue_state_persisted,
    init_completed: checkpoint.init_completed !== undefined
      ? checkpoint.init_completed
      : existing.checkpoint.init_completed,
    auto_selected: checkpoint.auto_selected !== undefined
      ? checkpoint.auto_selected
      : existing.checkpoint.auto_selected,
    auto_run_started: checkpoint.auto_run_started !== undefined
      ? checkpoint.auto_run_started
      : existing.checkpoint.auto_run_started,
    warnings: mergedWarnings,
  };

  const updated: ProviderOperationJournal = {
    ...existing,
    checkpoint: mergedCheckpoint,
    updated_at: new Date().toISOString(),
  };

  await writeAtomicWithPermissions(getJournalPath(issueStateDir), updated);
  return updated;
}

/**
 * Finalize the journal by setting completed_at and terminal state.
 */
export async function finalizeJournal(
  issueStateDir: string,
  state: string,
): Promise<ProviderOperationJournal> {
  if (!STATE_PATTERN.test(state)) {
    throw new Error(`Invalid state: must match ${STATE_PATTERN.source}`);
  }

  const existing = await readJournal(issueStateDir);
  if (!existing) {
    throw new Error('No journal file exists to finalize');
  }

  const now = new Date().toISOString();
  const finalized: ProviderOperationJournal = {
    ...existing,
    state,
    updated_at: now,
    completed_at: now,
  };

  await writeAtomicWithPermissions(getJournalPath(issueStateDir), finalized);
  return finalized;
}

/**
 * Read and validate the journal file.
 * Returns null if absent, invalid JSON, or wrong schema.
 */
export async function readJournal(issueStateDir: string): Promise<ProviderOperationJournal | null> {
  const journalPath = getJournalPath(issueStateDir);
  try {
    const content = await fs.readFile(journalPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (!isValidJournal(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Delete the journal file.
 * Idempotent: returns whether the file existed.
 */
export async function deleteJournal(issueStateDir: string): Promise<boolean> {
  const journalPath = getJournalPath(issueStateDir);
  try {
    await fs.rm(journalPath, { force: false });
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Delete both lock and journal files.
 * Idempotent.
 */
export async function deleteOpsArtifacts(issueStateDir: string): Promise<void> {
  const lockPath = getLockPath(issueStateDir);
  const journalPath = getJournalPath(issueStateDir);
  await fs.rm(lockPath, { force: true }).catch(() => void 0);
  await fs.rm(journalPath, { force: true }).catch(() => void 0);
}

// ============================================================================
// Recovery
// ============================================================================

/**
 * Detect whether recovery is needed based on incomplete journal state.
 *
 * Recovery rules (Section 2):
 * - Credential ops: if state is past cred.persisting_secret -> cred.reconciling_worktree; else cred.validating
 * - Ingest ops: if checkpoint.remote_id known -> ingest.persisting_issue_state;
 *               if checkpoint.issue_state_persisted -> ingest.recording_status; else ingest.validating
 * - PR ops: always pr.checking_existing
 */
export async function detectRecovery(issueStateDir: string): Promise<RecoveryResult> {
  const journal = await readJournal(issueStateDir);
  if (!journal) return { needed: false };
  if (journal.completed_at !== null) return { needed: false };

  // Journal present and incomplete -> recovery needed
  const recoveryState = computeRecoveryState(journal);
  return { needed: true, journal, recovery_state: recoveryState };
}

/**
 * Clean up stale artifacts on startup.
 *
 * - Removes stale lock files (expired or PID dead)
 * - Removes completed journals (completed_at is set)
 * - Removes .tmp files in .ops/ directory
 */
export async function cleanupStaleArtifacts(issueStateDir: string): Promise<CleanupResult> {
  const opsDir = getOpsDir(issueStateDir);
  let lockRemoved = false;
  let journalRemoved = false;
  let tempFilesRemoved = 0;

  // Check for stale lock
  const lock = await readLock(issueStateDir);
  if (lock && isLockStale(lock)) {
    await fs.rm(getLockPath(issueStateDir), { force: true }).catch(() => void 0);
    lockRemoved = true;
  }

  // Check for completed journal
  const journal = await readJournal(issueStateDir);
  if (journal && journal.completed_at !== null) {
    await fs.rm(getJournalPath(issueStateDir), { force: true }).catch(() => void 0);
    journalRemoved = true;
  }

  // Clean up .tmp files in .ops/ directory
  try {
    const entries = await fs.readdir(opsDir);
    for (const entry of entries) {
      if (entry.endsWith('.tmp')) {
        await fs.rm(path.join(opsDir, entry), { force: true }).catch(() => void 0);
        tempFilesRemoved++;
      }
    }
  } catch {
    // .ops/ directory may not exist; ignore
  }

  return {
    lock_removed: lockRemoved,
    journal_removed: journalRemoved,
    temp_files_removed: tempFilesRemoved,
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Credential states that are "after" persisting_secret (past the point of no return). */
const CREDENTIAL_POST_PERSIST_STATES = new Set([
  'cred.persisting_secret',
  'cred.reconciling_worktree',
  'cred.recording_status',
  'cred.emitting_event',
]);

/**
 * Compute the recovery state based on journal kind and checkpoint.
 */
function computeRecoveryState(journal: ProviderOperationJournal): string {
  switch (journal.kind) {
    case 'credentials':
      // If state is at or after cred.persisting_secret -> recover at cred.reconciling_worktree
      if (CREDENTIAL_POST_PERSIST_STATES.has(journal.state)) {
        return 'cred.reconciling_worktree';
      }
      // Otherwise restart
      return 'cred.validating';

    case 'ingest':
      // If remote_id is known -> recovery at ingest.persisting_issue_state
      if (journal.checkpoint.remote_id !== null) {
        return 'ingest.persisting_issue_state';
      }
      // If issue_state_persisted -> recovery at ingest.recording_status
      if (journal.checkpoint.issue_state_persisted) {
        return 'ingest.recording_status';
      }
      // Otherwise restart
      return 'ingest.validating';

    case 'pr_prepare':
      // PR recoveries always restart at pr.checking_existing
      return 'pr.checking_existing';

    default:
      // Should not happen given validation, but be safe
      return 'unknown.recovery';
  }
}

/**
 * Validate that a parsed value is a valid lock file.
 */
function isValidLock(value: unknown): value is ProviderOperationLock {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;

  if (obj.schemaVersion !== LOCK_SCHEMA_VERSION) return false;
  if (typeof obj.operation_id !== 'string' || !OPERATION_ID_PATTERN.test(obj.operation_id)) return false;
  if (typeof obj.issue_ref !== 'string' || !ISSUE_REF_PATTERN.test(obj.issue_ref)) return false;
  if (typeof obj.acquired_at !== 'string') return false;
  if (typeof obj.expires_at !== 'string') return false;
  if (typeof obj.pid !== 'number' || !Number.isInteger(obj.pid) || obj.pid < 1) return false;

  return true;
}

/**
 * Validate that a parsed value is a valid journal file.
 */
function isValidJournal(value: unknown): value is ProviderOperationJournal {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;

  if (obj.schemaVersion !== JOURNAL_SCHEMA_VERSION) return false;
  if (typeof obj.operation_id !== 'string' || !OPERATION_ID_PATTERN.test(obj.operation_id)) return false;
  if (typeof obj.kind !== 'string' || !VALID_KINDS.includes(obj.kind as ProviderOperationKind)) return false;
  if (typeof obj.state !== 'string' || !STATE_PATTERN.test(obj.state)) return false;
  if (typeof obj.issue_ref !== 'string' || !ISSUE_REF_PATTERN.test(obj.issue_ref)) return false;
  if (obj.provider !== null && (typeof obj.provider !== 'string' || !VALID_PROVIDERS.includes(obj.provider as IssueProvider))) return false;
  if (typeof obj.started_at !== 'string') return false;
  if (typeof obj.updated_at !== 'string') return false;
  if (obj.completed_at !== null && typeof obj.completed_at !== 'string') return false;

  // Validate checkpoint
  if (obj.checkpoint === null || typeof obj.checkpoint !== 'object') return false;
  const cp = obj.checkpoint as Record<string, unknown>;
  if (cp.remote_id !== null && typeof cp.remote_id !== 'string') return false;
  if (cp.remote_url !== null && typeof cp.remote_url !== 'string') return false;
  if (cp.pr_id !== null && typeof cp.pr_id !== 'string') return false;
  if (typeof cp.issue_state_persisted !== 'boolean') return false;
  if (typeof cp.init_completed !== 'boolean') return false;
  if (typeof cp.auto_selected !== 'boolean') return false;
  if (typeof cp.auto_run_started !== 'boolean') return false;
  if (!Array.isArray(cp.warnings)) return false;
  if (!cp.warnings.every((w: unknown) => typeof w === 'string')) return false;

  return true;
}

/**
 * Check if a process with the given PID is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a unique operation ID (UUID v4).
 */
export function generateOperationId(): string {
  return crypto.randomUUID();
}

/**
 * Type guard for Node.js errors with a code property.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Write a file atomically with 0600 permissions.
 * Uses temp+rename pattern for crash safety.
 */
async function writeAtomicWithPermissions(filePath: string, data: object): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const content = JSON.stringify(data, null, 2) + '\n';
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  await fs.writeFile(tmp, content, { encoding: 'utf-8', mode: FILE_MODE });

  // Set permissions explicitly (some systems ignore mode in writeFile)
  try {
    await fs.chmod(tmp, FILE_MODE);
  } catch {
    // Ignore on platforms that don't support chmod
  }

  try {
    await fs.rename(tmp, filePath);
  } catch {
    // On Windows, rename can fail if target exists; remove and retry
    await fs.rm(filePath, { force: true }).catch(() => void 0);
    await fs.rename(tmp, filePath);
  }
}
