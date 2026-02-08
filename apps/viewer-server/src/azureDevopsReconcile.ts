/**
 * Worktree reconciliation helpers for Azure DevOps PAT materialization.
 *
 * This module implements:
 * - Line-level management of AZURE_DEVOPS_EXT_PAT in the shared .env.jeeves file
 * - Coexistence with other env vars (e.g., SONAR_TOKEN) in the same file
 * - Ensure .git/info/exclude ignores .env.jeeves and .env.jeeves.tmp
 * - Crash-safe cleanup of temporary files
 *
 * IMPORTANT:
 * - PAT values must NEVER be logged
 * - All file writes use atomic temp+rename pattern
 * - This reconcile manages ONLY the AZURE_DEVOPS_EXT_PAT line
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { AzureDevopsSyncStatus } from './azureDevopsTypes.js';
import { AZURE_PAT_ENV_VAR_NAME, sanitizeErrorForUi } from './azureDevopsTypes.js';
import { ensurePatternsExcluded } from './gitExclude.js';
import { escapeTokenForEnv } from './sonarTokenReconcile.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of an Azure reconcile operation.
 */
export type AzureReconcileResult = Readonly<{
  sync_status: AzureDevopsSyncStatus;
  warnings: string[];
  last_error: string | null;
}>;

/**
 * Options for reconciling the Azure DevOps PAT to the worktree.
 */
export type AzureReconcileOptions = Readonly<{
  /** The root directory of the worktree */
  worktreeDir: string;
  /** Whether a PAT is present (determines write vs remove) */
  hasSecret: boolean;
  /** The PAT value (only needed when hasSecret is true) - NEVER LOG THIS */
  pat?: string;
}>;

// ============================================================================
// Constants
// ============================================================================

/** Name of the env file in the worktree. */
const ENV_FILE_NAME = '.env.jeeves';

/** Name of the temp file used for atomic writes. */
const ENV_TEMP_FILE_NAME = '.env.jeeves.tmp';

/** File permissions for the env file (owner read/write only). */
const ENV_FILE_MODE = 0o600;

// ============================================================================
// Reconcile Implementation
// ============================================================================

/**
 * Reconcile the worktree to match the desired Azure DevOps PAT state.
 *
 * When hasSecret is true:
 * - Upserts AZURE_DEVOPS_EXT_PAT="..." line in .env.jeeves (preserving other lines)
 * - Ensures .git/info/exclude contains the necessary patterns
 *
 * When hasSecret is false:
 * - Removes AZURE_DEVOPS_EXT_PAT line from .env.jeeves (preserving other lines)
 * - Removes .env.jeeves entirely if no lines remain
 * - Ensures .git/info/exclude contains the necessary patterns
 *
 * In both cases, cleans up any leftover .env.jeeves.tmp file.
 *
 * @param options - Reconcile options (PAT value must NEVER be logged)
 * @returns Reconcile result with status and any warnings
 */
export async function reconcileAzureDevopsToWorktree(
  options: AzureReconcileOptions,
): Promise<AzureReconcileResult> {
  const { worktreeDir, hasSecret, pat } = options;

  const warnings: string[] = [];
  let lastError: string | null = null;

  // First, ensure the worktree directory exists
  try {
    const stat = await fs.stat(worktreeDir);
    if (!stat.isDirectory()) {
      return {
        sync_status: 'deferred_worktree_absent',
        warnings: ['Worktree path exists but is not a directory.'],
        last_error: 'Worktree path exists but is not a directory.',
      };
    }
  } catch {
    return {
      sync_status: 'deferred_worktree_absent',
      warnings: ['Worktree directory does not exist.'],
      last_error: 'Worktree directory does not exist.',
    };
  }

  const envFilePath = path.join(worktreeDir, ENV_FILE_NAME);
  const tempFilePath = path.join(worktreeDir, ENV_TEMP_FILE_NAME);

  // Always clean up any leftover temp file first
  await cleanupTempFile(tempFilePath);

  // Ensure .git/info/exclude has the required patterns BEFORE writing the PAT
  const excludeSuccess = await ensurePatternsExcluded(worktreeDir, [ENV_FILE_NAME, ENV_TEMP_FILE_NAME]);
  if (!excludeSuccess) {
    // Failed to update exclude - treat as hard stop for PAT materialization
    // to prevent accidental secret commits (design §3 failure behavior)
    lastError = 'Failed to update .git/info/exclude';
    warnings.push('Failed to update .git/info/exclude; PAT not written to avoid potential secret exposure.');

    // Remove .env.jeeves if it exists to avoid stale unignored secrets
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
  if (hasSecret && pat !== undefined) {
    // Upsert the AZURE_DEVOPS_EXT_PAT line in .env.jeeves
    const writeResult = await upsertEnvVar(envFilePath, tempFilePath, AZURE_PAT_ENV_VAR_NAME, pat);
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
    // Remove the AZURE_DEVOPS_EXT_PAT line from .env.jeeves
    const removeResult = await removeEnvVar(envFilePath, AZURE_PAT_ENV_VAR_NAME);
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
 * Build a regex that matches a line defining the given env var.
 * Matches: VARNAME=... (with or without quotes, any value)
 */
function buildEnvVarLineRegex(varName: string): RegExp {
  // Match the var name followed by = at the start of a line
  // The value can be anything until end of line
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}=.*$`, 'gm');
}

/**
 * Upsert an env var line in the shared .env.jeeves file.
 *
 * - Reads existing content
 * - If the var already exists, replaces its line
 * - If not, appends a new line
 * - Writes back atomically via temp+rename
 * - Preserves all other lines (e.g., SONAR_TOKEN)
 */
async function upsertEnvVar(
  envFilePath: string,
  tempFilePath: string,
  varName: string,
  value: string,
): Promise<WriteResult> {
  try {
    const escaped = escapeTokenForEnv(value);
    const newLine = `${varName}="${escaped}"`;

    // Read existing content (empty string if file doesn't exist)
    let existing = '';
    try {
      existing = await fs.readFile(envFilePath, 'utf-8');
    } catch {
      // File doesn't exist yet - start with empty content
    }

    const lineRegex = buildEnvVarLineRegex(varName);
    let newContent: string;

    if (lineRegex.test(existing)) {
      // Replace the existing line
      // Reset regex state after test()
      lineRegex.lastIndex = 0;
      newContent = existing.replace(lineRegex, newLine);
    } else {
      // Append a new line
      if (existing.length > 0 && !existing.endsWith('\n')) {
        newContent = existing + '\n' + newLine + '\n';
      } else {
        newContent = existing + newLine + '\n';
      }
    }

    // Write atomically via temp+rename
    await fs.writeFile(tempFilePath, newContent, { encoding: 'utf-8', mode: ENV_FILE_MODE });

    try {
      await fs.chmod(tempFilePath, ENV_FILE_MODE);
    } catch {
      // Ignore permission errors on platforms that don't support chmod
    }

    try {
      await fs.rename(tempFilePath, envFilePath);
    } catch {
      // On Windows, rename can fail if target exists; remove and retry
      await fs.rm(envFilePath, { force: true }).catch(() => void 0);
      await fs.rename(tempFilePath, envFilePath);
    }

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
 * Remove an env var line from the shared .env.jeeves file.
 *
 * - Reads existing content
 * - Removes the matching line(s)
 * - If no content remains, removes the file entirely
 * - Otherwise writes back the remaining content
 * - Preserves all other lines (e.g., SONAR_TOKEN)
 */
async function removeEnvVar(envFilePath: string, varName: string): Promise<WriteResult> {
  try {
    let existing: string;
    try {
      existing = await fs.readFile(envFilePath, 'utf-8');
    } catch {
      // File doesn't exist - nothing to remove
      return { success: true };
    }

    const lineRegex = buildEnvVarLineRegex(varName);

    if (!lineRegex.test(existing)) {
      // Variable not present in file - nothing to do
      return { success: true };
    }

    // Reset regex state after test()
    lineRegex.lastIndex = 0;

    // Remove the matching line(s) and any resulting blank lines
    const newContent = existing
      .replace(lineRegex, '')
      .replace(/\n{2,}/g, '\n') // Collapse multiple blank lines
      .replace(/^\n/, ''); // Remove leading blank line

    // Check if any non-empty content remains
    const hasContent = newContent.trim().length > 0;

    if (!hasContent) {
      // No content left - remove the file entirely
      await fs.rm(envFilePath, { force: true });
    } else {
      // Write back remaining content
      const finalContent = newContent.endsWith('\n') ? newContent : newContent + '\n';
      await fs.writeFile(envFilePath, finalContent, { encoding: 'utf-8', mode: ENV_FILE_MODE });
      try {
        await fs.chmod(envFilePath, ENV_FILE_MODE);
      } catch {
        // Ignore permission errors
      }
    }

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
