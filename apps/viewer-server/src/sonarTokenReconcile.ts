/**
 * Worktree reconciliation helpers for Sonar token materialization.
 *
 * This module implements:
 * - Atomic write/remove of .env.jeeves in the worktree
 * - Escaping of token values for dotenv format
 * - Ensure .git/info/exclude ignores .env.jeeves and .env.jeeves.tmp
 * - Crash-safe cleanup of temporary files
 *
 * IMPORTANT:
 * - Token values must NEVER be logged
 * - All file writes use atomic temp+rename pattern
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { ensurePatternsExcluded } from './gitExclude.js';
import type { SonarSyncStatus } from './sonarTokenTypes.js';
import { sanitizeErrorForUi } from './sonarTokenTypes.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of a reconcile operation.
 */
export type ReconcileResult = Readonly<{
  sync_status: SonarSyncStatus;
  warnings: string[];
  last_error: string | null;
}>;

/**
 * Options for reconciling the worktree.
 */
export type ReconcileOptions = Readonly<{
  /** The root directory of the worktree */
  worktreeDir: string;
  /** Whether a token is present (determines write vs remove) */
  hasToken: boolean;
  /** The token value (only needed when hasToken is true) - NEVER LOG THIS */
  token?: string;
  /** The env var name to use (default: SONAR_TOKEN) */
  envVarName?: string;
}>;

// ============================================================================
// Constants
// ============================================================================

/** Default environment variable name. */
const DEFAULT_ENV_VAR_NAME = 'SONAR_TOKEN';

/** Name of the env file in the worktree. */
const ENV_FILE_NAME = '.env.jeeves';

/** Name of the temp file used for atomic writes. */
const ENV_TEMP_FILE_NAME = '.env.jeeves.tmp';

/** File permissions for the env file (owner read/write only). */
const ENV_FILE_MODE = 0o600;

// ============================================================================
// Escaping
// ============================================================================

/**
 * Escape a token value for use in dotenv format.
 *
 * Escaping rules (per design doc):
 * - Replace \ with \\
 * - Replace " with \"
 *
 * This produces a value safe to use inside double quotes: `KEY="<escaped>"`
 *
 * @param token - The raw token value
 * @returns The escaped token value
 */
export function escapeTokenForEnv(token: string): string {
  // First escape backslashes, then escape quotes
  return token.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ============================================================================
// File Paths
// ============================================================================

/**
 * Get the path to the .env.jeeves file in the worktree.
 */
export function getEnvFilePath(worktreeDir: string): string {
  return path.join(worktreeDir, ENV_FILE_NAME);
}

/**
 * Get the path to the .env.jeeves.tmp file in the worktree.
 */
export function getEnvTempFilePath(worktreeDir: string): string {
  return path.join(worktreeDir, ENV_TEMP_FILE_NAME);
}

// ============================================================================
// Reconcile Implementation
// ============================================================================

/**
 * Reconcile the worktree to match the desired Sonar token state.
 *
 * When hasToken is true:
 * - Writes .env.jeeves with the escaped token
 * - Ensures .git/info/exclude contains the necessary patterns
 *
 * When hasToken is false:
 * - Removes .env.jeeves if present
 * - Ensures .git/info/exclude contains the necessary patterns
 *
 * In both cases, cleans up any leftover .env.jeeves.tmp file.
 *
 * @param options - Reconcile options (token value must NEVER be logged)
 * @returns Reconcile result with status and any warnings
 */
export async function reconcileSonarTokenToWorktree(options: ReconcileOptions): Promise<ReconcileResult> {
  const { worktreeDir, hasToken, token, envVarName = DEFAULT_ENV_VAR_NAME } = options;

  const warnings: string[] = [];
  let lastError: string | null = null;

  // First, ensure the worktree directory exists
  try {
    const stat = await fs.stat(worktreeDir);
    if (!stat.isDirectory()) {
      return {
        sync_status: hasToken ? 'deferred_worktree_absent' : 'in_sync',
        warnings: ['Worktree path exists but is not a directory.'],
        last_error: 'Worktree path exists but is not a directory.',
      };
    }
  } catch {
    return {
      sync_status: hasToken ? 'deferred_worktree_absent' : 'in_sync',
      warnings: ['Worktree directory does not exist.'],
      last_error: 'Worktree directory does not exist.',
    };
  }

  // Treat non-git directories as "worktree absent" for sync semantics.
  // Some code paths create the directory skeleton (e.g. `.jeeves/`) without a real git worktree.
  const gitMarkerExists = await fs
    .stat(path.join(worktreeDir, '.git'))
    .then((s) => s.isFile() || s.isDirectory())
    .catch(() => false);
  if (!gitMarkerExists) {
    return {
      sync_status: hasToken ? 'deferred_worktree_absent' : 'in_sync',
      warnings: ['Worktree directory is not a git worktree.'],
      last_error: hasToken ? 'Worktree directory is not a git worktree.' : null,
    };
  }

  const envFilePath = getEnvFilePath(worktreeDir);
  const tempFilePath = getEnvTempFilePath(worktreeDir);

  // Always clean up any leftover temp file first
  await cleanupTempFile(tempFilePath);

  // Ensure .git/info/exclude has the required patterns BEFORE writing the token
  const excludeSuccess = await ensurePatternsExcluded(worktreeDir, [ENV_FILE_NAME, ENV_TEMP_FILE_NAME]);
  if (!excludeSuccess) {
    // Failed to update exclude - treat as hard stop for token materialization
    // to prevent accidental secret commits (design §3 failure behavior)
    lastError = 'Failed to update .git/info/exclude';
    warnings.push('Failed to update .git/info/exclude; token not written to avoid potential secret exposure.');

    // Optionally remove .env.jeeves if it exists to avoid stale unignored secrets
    try {
      await fs.rm(envFilePath, { force: true });
    } catch {
      // Ignore removal errors
    }

    return {
      sync_status: 'failed_exclude',
      warnings,
      last_error: lastError,
    };
  }

  // Now reconcile the env file itself (exclude is guaranteed to be in place)
  if (hasToken && token !== undefined) {
    // Write the env file atomically
    const writeResult = await writeEnvFileAtomic(envFilePath, tempFilePath, envVarName, token);
    if (!writeResult.success) {
      lastError = sanitizeErrorForUi(writeResult.error);
      warnings.push(`Failed to write ${ENV_FILE_NAME}: ${lastError}`);

      return {
        sync_status: 'failed_env_write',
        warnings,
        last_error: lastError,
      };
    }
  } else {
    // Remove the env file if present
    const removeResult = await removeEnvFile(envFilePath);
    if (!removeResult.success) {
      lastError = sanitizeErrorForUi(removeResult.error);
      warnings.push(`Failed to remove ${ENV_FILE_NAME}: ${lastError}`);

      return {
        sync_status: 'failed_env_delete',
        warnings,
        last_error: lastError,
      };
    }
  }

  // Full success
  return {
    sync_status: 'in_sync',
    warnings,
    last_error: null,
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

type WriteResult = { success: true } | { success: false; error: string };

/**
 * Write the env file atomically using temp+rename pattern.
 */
async function writeEnvFileAtomic(
  envFilePath: string,
  tempFilePath: string,
  envVarName: string,
  token: string,
): Promise<WriteResult> {
  try {
    // Format: KEY="escaped_value"\n
    const escaped = escapeTokenForEnv(token);
    const content = `${envVarName}="${escaped}"\n`;

    // Write to temp file
    await fs.writeFile(tempFilePath, content, { encoding: 'utf-8', mode: ENV_FILE_MODE });

    // Set permissions explicitly (some systems ignore mode in writeFile)
    try {
      await fs.chmod(tempFilePath, ENV_FILE_MODE);
    } catch {
      // Ignore permission errors on platforms that don't support chmod
    }

    // Atomic rename
    try {
      await fs.rename(tempFilePath, envFilePath);
    } catch {
      // On Windows, rename can fail if target exists; remove and retry
      await fs.rm(envFilePath, { force: true }).catch(() => void 0);
      await fs.rename(tempFilePath, envFilePath);
    }

    // Ensure final file has correct permissions
    try {
      await fs.chmod(envFilePath, ENV_FILE_MODE);
    } catch {
      // Ignore permission errors
    }

    return { success: true };
  } catch (error) {
    // Clean up temp file on failure
    await fs.rm(tempFilePath, { force: true }).catch(() => void 0);

    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Remove the env file if it exists. Idempotent.
 */
async function removeEnvFile(envFilePath: string): Promise<WriteResult> {
  try {
    await fs.rm(envFilePath, { force: true });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Clean up a leftover temp file if it exists.
 */
async function cleanupTempFile(tempFilePath: string): Promise<void> {
  await fs.rm(tempFilePath, { force: true }).catch(() => void 0);
}
