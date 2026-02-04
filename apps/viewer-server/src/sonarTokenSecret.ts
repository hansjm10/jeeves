/**
 * Secret file persistence for Sonar token storage.
 *
 * This module implements atomic read/write/delete operations for the
 * issue-scoped Sonar token secret file at `.jeeves/.secrets/sonar-token.json`.
 *
 * IMPORTANT:
 * - Token values are stored ONLY in this secret file
 * - Token values must NEVER be logged or streamed to the viewer
 * - File permissions are set to 0600 where supported
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// ============================================================================
// Types
// ============================================================================

/**
 * Schema for the secret file content.
 */
export type SonarTokenSecretFile = Readonly<{
  schemaVersion: 1;
  token: string;
  updated_at: string;
}>;

/**
 * Result of reading the secret file.
 */
export type ReadSecretResult =
  | Readonly<{ exists: true; data: SonarTokenSecretFile }>
  | Readonly<{ exists: false }>;

// ============================================================================
// Constants
// ============================================================================

/** Name of the secrets directory within the issue state directory. */
const SECRETS_DIR_NAME = '.secrets';

/** Name of the secret file. */
const SECRET_FILE_NAME = 'sonar-token.json';

/** Standard temporary file suffix (for cleanup during recovery). */
const TEMP_FILE_SUFFIX = '.tmp';

/** Generate a unique temp file name per write operation to avoid conflicts. */
function generateUniqueTempPath(secretFilePath: string): string {
  return `${secretFilePath}.${process.pid}.${Date.now()}.tmp`;
}

/** Current schema version for the secret file. */
export const SECRET_FILE_SCHEMA_VERSION = 1;

/** File permissions for the secret file (owner read/write only). */
const SECRET_FILE_MODE = 0o600;

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Get the path to the secrets directory for an issue state directory.
 */
export function getSecretsDir(issueStateDir: string): string {
  return path.join(issueStateDir, SECRETS_DIR_NAME);
}

/**
 * Get the path to the sonar token secret file.
 */
export function getSonarTokenSecretPath(issueStateDir: string): string {
  return path.join(getSecretsDir(issueStateDir), SECRET_FILE_NAME);
}

/**
 * Get the path to the temporary file used during atomic writes.
 */
function getTempFilePath(secretFilePath: string): string {
  return `${secretFilePath}${TEMP_FILE_SUFFIX}`;
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Read the sonar token secret file.
 *
 * @param issueStateDir - The issue state directory containing .secrets/
 * @returns The secret file data if it exists, or { exists: false } if not
 */
export async function readSonarTokenSecret(issueStateDir: string): Promise<ReadSecretResult> {
  const secretPath = getSonarTokenSecretPath(issueStateDir);

  try {
    const content = await fs.readFile(secretPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    // Validate the parsed content has the expected shape
    if (!isValidSecretFile(parsed)) {
      // Invalid schema - treat as non-existent
      return { exists: false };
    }

    return { exists: true, data: parsed };
  } catch (error) {
    // File doesn't exist or can't be read
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { exists: false };
    }
    // For other errors (permissions, etc.), treat as non-existent
    // to avoid leaking error details that might include paths
    return { exists: false };
  }
}

/**
 * Write the sonar token secret file atomically with restrictive permissions.
 *
 * The write is performed atomically:
 * 1. Write to a temporary file
 * 2. Set permissions on the temp file
 * 3. Rename temp file to final path
 *
 * This ensures the secret file is never partially written.
 *
 * @param issueStateDir - The issue state directory containing .secrets/
 * @param token - The trimmed, validated token value (NEVER log this)
 * @returns The written secret file data (for verification)
 */
export async function writeSonarTokenSecret(
  issueStateDir: string,
  token: string,
): Promise<SonarTokenSecretFile> {
  const secretsDir = getSecretsDir(issueStateDir);
  const secretPath = getSonarTokenSecretPath(issueStateDir);
  const uniqueTempPath = generateUniqueTempPath(secretPath);
  const legacyTempPath = getTempFilePath(secretPath);

  // Ensure the secrets directory exists
  await fs.mkdir(secretsDir, { recursive: true });

  // Clean up any leftover temp file from a previous crashed write (legacy temp path)
  await cleanupTempFile(legacyTempPath);
  // Also clean up any leftover temp files with glob pattern
  await cleanupStaleTemps(secretsDir, SECRET_FILE_NAME);

  // Create the secret file content
  const data: SonarTokenSecretFile = {
    schemaVersion: SECRET_FILE_SCHEMA_VERSION,
    token,
    updated_at: new Date().toISOString(),
  };

  // Write to temp file with unique name
  const content = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(uniqueTempPath, content, { encoding: 'utf-8', mode: SECRET_FILE_MODE });

  // Set permissions explicitly (some systems ignore mode in writeFile)
  try {
    await fs.chmod(uniqueTempPath, SECRET_FILE_MODE);
  } catch {
    // Ignore permission errors on platforms that don't support chmod (e.g., Windows)
  }

  // Atomic rename: remove existing file first if needed (Windows compatibility)
  try {
    await fs.rename(uniqueTempPath, secretPath);
  } catch {
    // On Windows, rename can fail if target exists; remove and retry
    await fs.rm(secretPath, { force: true }).catch(() => void 0);
    try {
      await fs.rename(uniqueTempPath, secretPath);
    } catch {
      // Second rename also failed - clean up temp file and check if secret file exists
      await fs.rm(uniqueTempPath, { force: true }).catch(() => void 0);

      // Verify the final file exists and contains valid content
      // (another concurrent write may have succeeded)
      try {
        const content = await fs.readFile(secretPath, 'utf-8');
        const parsed = JSON.parse(content) as unknown;
        if (isValidSecretFile(parsed)) {
          // Another concurrent write succeeded - return its data
          return parsed;
        }
      } catch {
        // File doesn't exist or is invalid
      }

      // Final file missing or invalid - this is an actual failure
      throw new Error('Failed to write secret file: atomic rename failed');
    }
  }

  // Ensure final file has correct permissions
  try {
    await fs.chmod(secretPath, SECRET_FILE_MODE);
  } catch {
    // Ignore permission errors on platforms that don't support chmod
  }

  return data;
}

/**
 * Delete the sonar token secret file.
 *
 * This operation is idempotent - it succeeds even if the file doesn't exist.
 *
 * On delete, also cleans up ALL unique temp files (sonar-token.json.<pid>.<timestamp>.tmp)
 * that could have been left behind by crashed atomic writes. This ensures that
 * even if a process crashed mid-write, the token value won't persist in temp files.
 *
 * @param issueStateDir - The issue state directory containing .secrets/
 * @returns true if a file was deleted, false if it didn't exist
 */
export async function deleteSonarTokenSecret(issueStateDir: string): Promise<boolean> {
  const secretsDir = getSecretsDir(issueStateDir);
  const secretPath = getSonarTokenSecretPath(issueStateDir);
  const tempPath = getTempFilePath(secretPath);

  // Clean up any leftover legacy temp file (sonar-token.json.tmp)
  await cleanupTempFile(tempPath);

  // Clean up ALL unique temp files (sonar-token.json.<pid>.<timestamp>.tmp)
  // On delete, we remove ALL temp files immediately (not just stale ones)
  // to ensure no token values persist in crash-temp files after DELETE.
  await cleanupAllUniqueTempFiles(secretsDir, SECRET_FILE_NAME);

  try {
    await fs.rm(secretPath, { force: false });
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    // Re-throw other errors (permissions, etc.)
    throw error;
  }
}

/**
 * Check if a token exists without reading its value.
 *
 * This is useful for determining has_token status without loading the secret.
 *
 * @param issueStateDir - The issue state directory containing .secrets/
 * @returns true if the secret file exists and is valid
 */
export async function hasToken(issueStateDir: string): Promise<boolean> {
  const result = await readSonarTokenSecret(issueStateDir);
  return result.exists;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Validate that a parsed object matches the expected secret file schema.
 */
function isValidSecretFile(value: unknown): value is SonarTokenSecretFile {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const obj = value as Record<string, unknown>;

  return (
    obj.schemaVersion === SECRET_FILE_SCHEMA_VERSION &&
    typeof obj.token === 'string' &&
    obj.token.length > 0 &&
    typeof obj.updated_at === 'string'
  );
}

/**
 * Clean up a temporary file if it exists.
 */
async function cleanupTempFile(tempPath: string): Promise<void> {
  await fs.rm(tempPath, { force: true }).catch(() => void 0);
}

/**
 * Escape a string for use in a regular expression.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Clean up any stale temp files from previous crashed writes.
 * Matches files like: sonar-token.json.*.tmp
 * Only removes files older than 5 seconds to avoid race conditions with concurrent writes.
 */
async function cleanupStaleTemps(secretsDir: string, baseName: string): Promise<void> {
  const staleThresholdMs = 5000; // 5 seconds
  const now = Date.now();

  try {
    const entries = await fs.readdir(secretsDir);
    // Escape baseName for regex (e.g., "sonar-token.json" has a literal dot)
    const tempPattern = new RegExp(`^${escapeRegex(baseName)}\\.(\\d+)\\.(\\d+)\\.tmp$`);

    await Promise.all(
      entries
        .filter((entry) => {
          const match = tempPattern.exec(entry);
          if (!match) return false;
          // Extract timestamp from filename and check if it's stale
          const fileTimestamp = parseInt(match[2], 10);
          return now - fileTimestamp > staleThresholdMs;
        })
        .map((entry) => fs.rm(path.join(secretsDir, entry), { force: true }).catch(() => void 0)),
    );
  } catch {
    // Directory may not exist or be readable; ignore
  }
}

/**
 * Clean up ALL unique temp files (not just stale ones).
 * Used on DELETE to ensure no token values persist in crash-temp files.
 * Matches files like: sonar-token.json.<pid>.<timestamp>.tmp
 */
async function cleanupAllUniqueTempFiles(secretsDir: string, baseName: string): Promise<void> {
  try {
    const entries = await fs.readdir(secretsDir);
    // Escape baseName for regex (e.g., "sonar-token.json" has a literal dot)
    const tempPattern = new RegExp(`^${escapeRegex(baseName)}\\.(\\d+)\\.(\\d+)\\.tmp$`);

    await Promise.all(
      entries
        .filter((entry) => tempPattern.test(entry))
        .map((entry) => fs.rm(path.join(secretsDir, entry), { force: true }).catch(() => void 0)),
    );
  } catch {
    // Directory may not exist or be readable; ignore
  }
}

/**
 * Type guard for Node.js errors with a code property.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
