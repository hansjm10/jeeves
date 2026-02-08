/**
 * Secret file persistence for Azure DevOps credential storage.
 *
 * This module implements atomic read/write/delete operations for the
 * issue-scoped Azure DevOps secret file at `.jeeves/.secrets/azure-devops.json`.
 *
 * The secret file stores organization, project, and PAT values needed for
 * Azure DevOps CLI operations and worktree env materialization.
 *
 * IMPORTANT:
 * - PAT values are stored ONLY in this secret file
 * - PAT values must NEVER be logged or streamed to the viewer
 * - File permissions are set to 0600 where supported
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ORG_URL_PREFIX,
  ORG_SLUG_PATTERN,
  ORG_MIN_LENGTH,
  ORG_MAX_LENGTH,
  PROJECT_MIN_LENGTH,
  PROJECT_MAX_LENGTH,
  PAT_MIN_LENGTH,
  PAT_MAX_LENGTH,
} from './azureDevopsTypes.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Schema for the Azure DevOps secret file content.
 */
export type AzureDevopsSecretFile = Readonly<{
  schemaVersion: 1;
  organization: string;
  project: string;
  pat: string;
  updated_at: string;
}>;

/**
 * Result of reading the secret file.
 */
export type ReadAzureSecretResult =
  | Readonly<{ exists: true; data: AzureDevopsSecretFile }>
  | Readonly<{ exists: false }>;

/**
 * Error thrown when reading the secret file fails due to a non-ENOENT error.
 * The message is sanitized to avoid leaking sensitive information.
 */
export class AzureDevopsSecretReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AzureDevopsSecretReadError';
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, AzureDevopsSecretReadError.prototype);
  }
}

// ============================================================================
// Constants
// ============================================================================

/** Name of the secrets directory within the issue state directory. */
const SECRETS_DIR_NAME = '.secrets';

/** Name of the Azure DevOps secret file. */
const SECRET_FILE_NAME = 'azure-devops.json';

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

/** Characters that are forbidden in PAT values (\0, \n, \r). */
const FORBIDDEN_PAT_CHARS = ['\0', '\n', '\r'];

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
 * Get the path to the Azure DevOps secret file.
 */
export function getAzureDevopsSecretPath(issueStateDir: string): string {
  return path.join(getSecretsDir(issueStateDir), SECRET_FILE_NAME);
}

/**
 * Get the path to the temporary file used during atomic writes (legacy).
 */
function getTempFilePath(secretFilePath: string): string {
  return `${secretFilePath}${TEMP_FILE_SUFFIX}`;
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Read the Azure DevOps secret file.
 *
 * @param issueStateDir - The issue state directory containing .secrets/
 * @returns The secret file data if it exists and is valid, or { exists: false } if not
 * @throws {AzureDevopsSecretReadError} For non-ENOENT errors (e.g., EACCES, I/O errors)
 */
export async function readAzureDevopsSecret(issueStateDir: string): Promise<ReadAzureSecretResult> {
  const secretPath = getAzureDevopsSecretPath(issueStateDir);

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
    // File doesn't exist - expected case
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { exists: false };
    }
    // JSON parse error - treat as corrupted/non-existent
    if (error instanceof SyntaxError) {
      return { exists: false };
    }
    // For other errors (EACCES, I/O errors, etc.), throw a sanitized error
    // so callers can return 500 io_error instead of incorrectly reporting has_pat=false
    const code = isNodeError(error) ? error.code : 'UNKNOWN';
    throw new AzureDevopsSecretReadError(`Failed to read secret file: ${code}`);
  }
}

/**
 * Write the Azure DevOps secret file atomically with restrictive permissions.
 *
 * The write is performed atomically:
 * 1. Write to a temporary file
 * 2. Set permissions on the temp file
 * 3. Rename temp file to final path
 *
 * This ensures the secret file is never partially written.
 *
 * @param issueStateDir - The issue state directory containing .secrets/
 * @param organization - The canonical organization URL (NEVER log this alongside PAT)
 * @param project - The project name
 * @param pat - The trimmed, validated PAT value (NEVER log this)
 * @returns The written secret file data (for verification)
 */
export async function writeAzureDevopsSecret(
  issueStateDir: string,
  organization: string,
  project: string,
  pat: string,
): Promise<AzureDevopsSecretFile> {
  const secretsDir = getSecretsDir(issueStateDir);
  const secretPath = getAzureDevopsSecretPath(issueStateDir);
  const uniqueTempPath = generateUniqueTempPath(secretPath);
  const legacyTempPath = getTempFilePath(secretPath);

  // Ensure the secrets directory exists
  await fs.mkdir(secretsDir, { recursive: true });

  // Clean up any leftover temp file from a previous crashed write (legacy temp path)
  await cleanupTempFile(legacyTempPath);
  // Also clean up any leftover temp files with glob pattern
  await cleanupStaleTemps(secretsDir, SECRET_FILE_NAME);

  // Create the secret file content
  const data: AzureDevopsSecretFile = {
    schemaVersion: SECRET_FILE_SCHEMA_VERSION,
    organization,
    project,
    pat,
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
        const verifyContent = await fs.readFile(secretPath, 'utf-8');
        const parsed = JSON.parse(verifyContent) as unknown;
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
 * Delete the Azure DevOps secret file.
 *
 * This operation is idempotent - it succeeds even if the file doesn't exist.
 *
 * On delete, also cleans up ALL unique temp files (azure-devops.json.<pid>.<timestamp>.tmp)
 * that could have been left behind by crashed atomic writes. This ensures that
 * even if a process crashed mid-write, the PAT value won't persist in temp files.
 *
 * @param issueStateDir - The issue state directory containing .secrets/
 * @returns true if a file was deleted, false if it didn't exist
 */
export async function deleteAzureDevopsSecret(issueStateDir: string): Promise<boolean> {
  const secretsDir = getSecretsDir(issueStateDir);
  const secretPath = getAzureDevopsSecretPath(issueStateDir);
  const tempPath = getTempFilePath(secretPath);

  // Clean up any leftover legacy temp file (azure-devops.json.tmp)
  await cleanupTempFile(tempPath);

  // Clean up ALL unique temp files (azure-devops.json.<pid>.<timestamp>.tmp)
  // On delete, we remove ALL temp files immediately (not just stale ones)
  // to ensure no PAT values persist in crash-temp files after DELETE.
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
 * Check if Azure DevOps credentials exist without reading PAT value.
 *
 * This is useful for determining has_pat status without loading the secret.
 *
 * @param issueStateDir - The issue state directory containing .secrets/
 * @returns true if the secret file exists and is valid
 * @throws {AzureDevopsSecretReadError} For non-ENOENT errors (e.g., EACCES, I/O errors)
 */
export async function hasAzureDevopsSecret(issueStateDir: string): Promise<boolean> {
  const result = await readAzureDevopsSecret(issueStateDir);
  return result.exists;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Check if a PAT string is valid according to PAT constraints.
 * This enforces the same rules as PUT validation to prevent materialization
 * of corrupted/hand-edited secrets into .env.jeeves.
 */
function isValidPatValue(pat: string): boolean {
  if (pat.length < PAT_MIN_LENGTH || pat.length > PAT_MAX_LENGTH) {
    return false;
  }
  if (FORBIDDEN_PAT_CHARS.some((c) => pat.includes(c))) {
    return false;
  }
  return true;
}

/**
 * Check if an organization URL is valid.
 * Must be in canonical form: https://dev.azure.com/<slug>
 */
function isValidOrganization(org: string): boolean {
  if (org.length < ORG_MIN_LENGTH || org.length > ORG_MAX_LENGTH) {
    return false;
  }
  if (!org.startsWith(ORG_URL_PREFIX)) {
    return false;
  }
  const slug = org.slice(ORG_URL_PREFIX.length);
  if (slug.length === 0) {
    return false;
  }
  return ORG_SLUG_PATTERN.test(slug);
}

/**
 * Check if a project name is valid.
 */
function isValidProject(project: string): boolean {
  if (project.length < PROJECT_MIN_LENGTH || project.length > PROJECT_MAX_LENGTH) {
    return false;
  }
  // Check for control characters
  for (let i = 0; i < project.length; i++) {
    const code = project.charCodeAt(i);
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * Validate that a parsed object matches the expected Azure DevOps secret file schema.
 * Also validates field constraints to prevent invalid secrets from being materialized.
 */
function isValidSecretFile(value: unknown): value is AzureDevopsSecretFile {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (
    obj.schemaVersion !== SECRET_FILE_SCHEMA_VERSION ||
    typeof obj.organization !== 'string' ||
    typeof obj.project !== 'string' ||
    typeof obj.pat !== 'string' ||
    typeof obj.updated_at !== 'string'
  ) {
    return false;
  }

  // Validate field constraints to prevent corrupted secrets from being materialized
  if (!isValidOrganization(obj.organization)) {
    return false;
  }
  if (!isValidProject(obj.project)) {
    return false;
  }
  if (!isValidPatValue(obj.pat)) {
    return false;
  }

  return true;
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
 * Matches files like: azure-devops.json.*.tmp
 * Only removes files older than 5 seconds to avoid race conditions with concurrent writes.
 */
async function cleanupStaleTemps(secretsDir: string, baseName: string): Promise<void> {
  const staleThresholdMs = 5000; // 5 seconds
  const now = Date.now();

  try {
    const entries = await fs.readdir(secretsDir);
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
 * Used on DELETE to ensure no PAT values persist in crash-temp files.
 * Matches files like: azure-devops.json.<pid>.<timestamp>.tmp
 */
async function cleanupAllUniqueTempFiles(secretsDir: string, baseName: string): Promise<void> {
  try {
    const entries = await fs.readdir(secretsDir);
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
