import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readAzureDevopsSecret,
  writeAzureDevopsSecret,
  deleteAzureDevopsSecret,
  hasAzureDevopsSecret,
  getAzureDevopsSecretPath,
  getSecretsDir,
  SECRET_FILE_SCHEMA_VERSION,
  AzureDevopsSecretReadError,
} from './azureDevopsSecret.js';

/** Canonical org URL used across tests. */
const TEST_ORG = 'https://dev.azure.com/my-org';
/** Valid project name. */
const TEST_PROJECT = 'my-project';
/** Valid PAT value. */
const TEST_PAT = 'my-secret-pat-value';

describe('azureDevopsSecret', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'azure-devops-secret-test-'));
  });

  afterEach(async () => {
    // Clean up the temp directory
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => void 0);
  });

  describe('path helpers', () => {
    it('getSecretsDir returns correct path', () => {
      const result = getSecretsDir('/issue/state/dir');
      expect(result).toBe(path.join('/issue/state/dir', '.secrets'));
    });

    it('getAzureDevopsSecretPath returns correct path', () => {
      const result = getAzureDevopsSecretPath('/issue/state/dir');
      expect(result).toBe(path.join('/issue/state/dir', '.secrets', 'azure-devops.json'));
    });
  });

  describe('writeAzureDevopsSecret', () => {
    it('creates the secret file with correct content (all 5 fields)', async () => {
      const result = await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);

      expect(result.schemaVersion).toBe(SECRET_FILE_SCHEMA_VERSION);
      expect(result.organization).toBe(TEST_ORG);
      expect(result.project).toBe(TEST_PROJECT);
      expect(result.pat).toBe(TEST_PAT);
      expect(result.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // Verify file was written
      const secretPath = getAzureDevopsSecretPath(tempDir);
      const content = await fs.readFile(secretPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.organization).toBe(TEST_ORG);
      expect(parsed.project).toBe(TEST_PROJECT);
      expect(parsed.pat).toBe(TEST_PAT);
      expect(parsed.updated_at).toBe(result.updated_at);

      // Verify ONLY these 5 fields exist
      const keys = Object.keys(parsed);
      expect(keys).toHaveLength(5);
      expect(keys.sort()).toEqual(['organization', 'pat', 'project', 'schemaVersion', 'updated_at']);
    });

    it('creates the .secrets directory if it does not exist', async () => {
      const secretsDir = getSecretsDir(tempDir);

      // Verify directory doesn't exist yet
      await expect(fs.stat(secretsDir)).rejects.toThrow();

      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);

      // Verify directory was created
      const stat = await fs.stat(secretsDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('overwrites existing secret file', async () => {
      // Write initial
      const first = await writeAzureDevopsSecret(tempDir, TEST_ORG, 'project-1', 'pat-1');
      expect(first.project).toBe('project-1');
      expect(first.pat).toBe('pat-1');

      // Overwrite with new values
      const second = await writeAzureDevopsSecret(
        tempDir,
        'https://dev.azure.com/other-org',
        'project-2',
        'pat-2',
      );
      expect(second.organization).toBe('https://dev.azure.com/other-org');
      expect(second.project).toBe('project-2');
      expect(second.pat).toBe('pat-2');

      // Verify file contains updated content
      const secretPath = getAzureDevopsSecretPath(tempDir);
      const content = await fs.readFile(secretPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.organization).toBe('https://dev.azure.com/other-org');
      expect(parsed.project).toBe('project-2');
      expect(parsed.pat).toBe('pat-2');
      expect(new Date(parsed.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(first.updated_at).getTime(),
      );
    });

    it('writes atomically via temp file (cleans up leftover temp)', async () => {
      const secretPath = getAzureDevopsSecretPath(tempDir);
      const tempPath = `${secretPath}.tmp`;

      // Create a leftover temp file
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(tempPath, 'leftover content');

      // Write should succeed and clean up the temp file
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);

      // Verify temp file was cleaned up
      await expect(fs.stat(tempPath)).rejects.toThrow();

      // Verify actual file has correct content
      const content = await fs.readFile(secretPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.pat).toBe(TEST_PAT);
    });

    it('sets file permissions to 0600 on POSIX', async () => {
      // Skip on Windows where chmod is not fully supported
      if (process.platform === 'win32') {
        return;
      }

      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);

      const secretPath = getAzureDevopsSecretPath(tempDir);
      const stat = await fs.stat(secretPath);

      // Check mode is 0600 (owner read/write only)
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('updates updated_at timestamp on each write', async () => {
      const first = await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, 'pat');

      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, 'pat');

      expect(new Date(second.updated_at).getTime()).toBeGreaterThan(
        new Date(first.updated_at).getTime(),
      );
    });
  });

  describe('readAzureDevopsSecret', () => {
    it('returns { exists: true } with data when file exists', async () => {
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);

      const result = await readAzureDevopsSecret(tempDir);

      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.schemaVersion).toBe(SECRET_FILE_SCHEMA_VERSION);
        expect(result.data.organization).toBe(TEST_ORG);
        expect(result.data.project).toBe(TEST_PROJECT);
        expect(result.data.pat).toBe(TEST_PAT);
        expect(typeof result.data.updated_at).toBe('string');
      }
    });

    it('returns { exists: false } when file does not exist', async () => {
      const result = await readAzureDevopsSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when file has invalid JSON', async () => {
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(secretPath, 'not valid json');

      const result = await readAzureDevopsSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when file has wrong schema version', async () => {
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(
        secretPath,
        JSON.stringify({
          schemaVersion: 999,
          organization: TEST_ORG,
          project: TEST_PROJECT,
          pat: TEST_PAT,
          updated_at: new Date().toISOString(),
        }),
      );

      const result = await readAzureDevopsSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when file is missing organization field', async () => {
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(
        secretPath,
        JSON.stringify({
          schemaVersion: 1,
          project: TEST_PROJECT,
          pat: TEST_PAT,
          updated_at: new Date().toISOString(),
        }),
      );

      const result = await readAzureDevopsSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when file is missing project field', async () => {
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(
        secretPath,
        JSON.stringify({
          schemaVersion: 1,
          organization: TEST_ORG,
          pat: TEST_PAT,
          updated_at: new Date().toISOString(),
        }),
      );

      const result = await readAzureDevopsSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when file is missing pat field', async () => {
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(
        secretPath,
        JSON.stringify({
          schemaVersion: 1,
          organization: TEST_ORG,
          project: TEST_PROJECT,
          updated_at: new Date().toISOString(),
        }),
      );

      const result = await readAzureDevopsSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when file has empty pat', async () => {
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(
        secretPath,
        JSON.stringify({
          schemaVersion: 1,
          organization: TEST_ORG,
          project: TEST_PROJECT,
          pat: '',
          updated_at: new Date().toISOString(),
        }),
      );

      const result = await readAzureDevopsSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when file is missing updated_at', async () => {
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(
        secretPath,
        JSON.stringify({
          schemaVersion: 1,
          organization: TEST_ORG,
          project: TEST_PROJECT,
          pat: TEST_PAT,
        }),
      );

      const result = await readAzureDevopsSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when organization is not in canonical URL form', async () => {
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(
        secretPath,
        JSON.stringify({
          schemaVersion: 1,
          organization: 'just-a-slug',
          project: TEST_PROJECT,
          pat: TEST_PAT,
          updated_at: new Date().toISOString(),
        }),
      );

      const result = await readAzureDevopsSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when project contains control characters', async () => {
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(
        secretPath,
        JSON.stringify({
          schemaVersion: 1,
          organization: TEST_ORG,
          project: 'project\x00name',
          pat: TEST_PAT,
          updated_at: new Date().toISOString(),
        }),
      );

      const result = await readAzureDevopsSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when secrets directory does not exist', async () => {
      const result = await readAzureDevopsSecret(path.join(tempDir, 'nonexistent'));

      expect(result.exists).toBe(false);
    });

    it('throws AzureDevopsSecretReadError for non-ENOENT errors (e.g., EACCES)', async () => {
      // Skip on Windows where chmod doesn't fully control read permissions
      if (process.platform === 'win32') {
        return;
      }

      // Write a valid secret file
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);
      const secretPath = getAzureDevopsSecretPath(tempDir);

      // Remove read permission to cause EACCES
      await fs.chmod(secretPath, 0o000);

      try {
        // Should throw AzureDevopsSecretReadError, NOT return { exists: false }
        await expect(readAzureDevopsSecret(tempDir)).rejects.toThrow(AzureDevopsSecretReadError);
        await expect(readAzureDevopsSecret(tempDir)).rejects.toThrow(/EACCES/);
      } finally {
        // Restore permissions for cleanup
        await fs.chmod(secretPath, 0o600);
      }
    });

    it('throws AzureDevopsSecretReadError with sanitized message (no PAT value)', async () => {
      // Skip on Windows where chmod doesn't fully control read permissions
      if (process.platform === 'win32') {
        return;
      }

      // Write a valid secret file
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, 'super-secret-pat-value');
      const secretPath = getAzureDevopsSecretPath(tempDir);

      // Remove read permission to cause EACCES
      await fs.chmod(secretPath, 0o000);

      try {
        const error = await readAzureDevopsSecret(tempDir).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AzureDevopsSecretReadError);
        // Error message should NOT contain the PAT value
        expect((error as Error).message).not.toContain('super-secret-pat-value');
        // Error message should contain the error code
        expect((error as Error).message).toContain('EACCES');
      } finally {
        // Restore permissions for cleanup
        await fs.chmod(secretPath, 0o600);
      }
    });
  });

  describe('deleteAzureDevopsSecret', () => {
    it('deletes existing secret file and returns true', async () => {
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);

      const deleted = await deleteAzureDevopsSecret(tempDir);

      expect(deleted).toBe(true);

      // Verify file is gone
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await expect(fs.stat(secretPath)).rejects.toThrow();
    });

    it('returns false when file does not exist (idempotent)', async () => {
      const deleted = await deleteAzureDevopsSecret(tempDir);

      expect(deleted).toBe(false);
    });

    it('returns false on second delete (idempotent)', async () => {
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);

      const first = await deleteAzureDevopsSecret(tempDir);
      expect(first).toBe(true);

      const second = await deleteAzureDevopsSecret(tempDir);
      expect(second).toBe(false);
    });

    it('cleans up leftover temp file during delete', async () => {
      const secretPath = getAzureDevopsSecretPath(tempDir);
      const tempPath = `${secretPath}.tmp`;

      // Create secrets dir with leftover temp file only (no actual secret file)
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(tempPath, 'leftover');

      // Delete should clean up temp file and return false (no actual secret)
      const deleted = await deleteAzureDevopsSecret(tempDir);

      expect(deleted).toBe(false);
      await expect(fs.stat(tempPath)).rejects.toThrow();
    });

    it('cleans up temp file even when secret file exists', async () => {
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);

      // Simulate a crashed write leaving a temp file
      const secretPath = getAzureDevopsSecretPath(tempDir);
      const tempPath = `${secretPath}.tmp`;
      await fs.writeFile(tempPath, 'crashed write');

      const deleted = await deleteAzureDevopsSecret(tempDir);

      expect(deleted).toBe(true);
      await expect(fs.stat(tempPath)).rejects.toThrow();
      await expect(fs.stat(secretPath)).rejects.toThrow();
    });

    it('cleans up unique temp files from crashed atomic writes', async () => {
      const secretsDir = getSecretsDir(tempDir);
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await fs.mkdir(secretsDir, { recursive: true });

      // Create the actual secret file
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);

      // Simulate crashed atomic writes with unique temp file names
      const uniqueTempPath1 = `${secretPath}.12345.1700000000000.tmp`;
      const uniqueTempPath2 = `${secretPath}.67890.1700000001000.tmp`;
      await fs.writeFile(
        uniqueTempPath1,
        JSON.stringify({ schemaVersion: 1, organization: TEST_ORG, project: 'p', pat: 'leaked-1', updated_at: '2023-01-01' }),
      );
      await fs.writeFile(
        uniqueTempPath2,
        JSON.stringify({ schemaVersion: 1, organization: TEST_ORG, project: 'p', pat: 'leaked-2', updated_at: '2023-01-01' }),
      );

      // Verify temp files exist before delete
      await expect(fs.stat(uniqueTempPath1)).resolves.toBeDefined();
      await expect(fs.stat(uniqueTempPath2)).resolves.toBeDefined();

      // Delete should clean up ALL unique temp files
      const deleted = await deleteAzureDevopsSecret(tempDir);

      expect(deleted).toBe(true);
      await expect(fs.stat(secretPath)).rejects.toThrow();
      await expect(fs.stat(uniqueTempPath1)).rejects.toThrow();
      await expect(fs.stat(uniqueTempPath2)).rejects.toThrow();
    });

    it('cleans up unique temp files even when no secret file exists', async () => {
      const secretsDir = getSecretsDir(tempDir);
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await fs.mkdir(secretsDir, { recursive: true });

      // Simulate crashed atomic write with unique temp file name
      const uniqueTempPath = `${secretPath}.99999.1700000002000.tmp`;
      await fs.writeFile(
        uniqueTempPath,
        JSON.stringify({ schemaVersion: 1, organization: TEST_ORG, project: 'p', pat: 'orphaned', updated_at: '2023-01-01' }),
      );

      // Delete should clean up the unique temp file and return false (no actual secret)
      const deleted = await deleteAzureDevopsSecret(tempDir);

      expect(deleted).toBe(false);
      await expect(fs.stat(uniqueTempPath)).rejects.toThrow();
    });
  });

  describe('hasAzureDevopsSecret', () => {
    it('returns true when secret exists', async () => {
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);

      const result = await hasAzureDevopsSecret(tempDir);

      expect(result).toBe(true);
    });

    it('returns false when no secret exists', async () => {
      const result = await hasAzureDevopsSecret(tempDir);

      expect(result).toBe(false);
    });

    it('returns false after secret is deleted', async () => {
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);
      expect(await hasAzureDevopsSecret(tempDir)).toBe(true);

      await deleteAzureDevopsSecret(tempDir);

      expect(await hasAzureDevopsSecret(tempDir)).toBe(false);
    });

    it('returns false when secret file is corrupted', async () => {
      const secretPath = getAzureDevopsSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(secretPath, 'corrupted content');

      const result = await hasAzureDevopsSecret(tempDir);

      expect(result).toBe(false);
    });

    it('throws AzureDevopsSecretReadError for non-ENOENT errors (e.g., EACCES)', async () => {
      // Skip on Windows where chmod doesn't fully control read permissions
      if (process.platform === 'win32') {
        return;
      }

      // Write a valid secret file
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);
      const secretPath = getAzureDevopsSecretPath(tempDir);

      // Remove read permission to cause EACCES
      await fs.chmod(secretPath, 0o000);

      try {
        // hasAzureDevopsSecret should propagate the error, NOT return false
        await expect(hasAzureDevopsSecret(tempDir)).rejects.toThrow(AzureDevopsSecretReadError);
      } finally {
        // Restore permissions for cleanup
        await fs.chmod(secretPath, 0o600);
      }
    });
  });

  describe('atomic write behavior', () => {
    it('file is never partially written (simulated verification)', async () => {
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, TEST_PAT);

      // Read should always succeed with complete data
      const result = await readAzureDevopsSecret(tempDir);
      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.organization).toBe(TEST_ORG);
        expect(result.data.project).toBe(TEST_PROJECT);
        expect(result.data.pat).toBe(TEST_PAT);
        expect(result.data.schemaVersion).toBe(SECRET_FILE_SCHEMA_VERSION);
        expect(result.data.updated_at).toBeTruthy();
      }
    });

    it('sequential rapid writes do not corrupt the file', async () => {
      const pats = ['pat-a', 'pat-b', 'pat-c', 'pat-d', 'pat-e'];

      for (const pat of pats) {
        await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, pat);

        // Each write should leave the file in a valid state
        const result = await readAzureDevopsSecret(tempDir);
        expect(result.exists).toBe(true);
        if (result.exists) {
          expect(result.data.pat).toBe(pat);
          expect(result.data.schemaVersion).toBe(SECRET_FILE_SCHEMA_VERSION);
        }
      }

      // Final state should have the last PAT
      const finalResult = await readAzureDevopsSecret(tempDir);
      expect(finalResult.exists).toBe(true);
      if (finalResult.exists) {
        expect(finalResult.data.pat).toBe('pat-e');
      }
    });
  });

  describe('special characters', () => {
    it('preserves PAT with quotes', async () => {
      const pat = 'pat"with"quotes';
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, pat);

      const result = await readAzureDevopsSecret(tempDir);
      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.pat).toBe(pat);
      }
    });

    it('preserves PAT with backslashes', async () => {
      const pat = 'pat\\with\\backslashes';
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, pat);

      const result = await readAzureDevopsSecret(tempDir);
      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.pat).toBe(pat);
      }
    });

    it('preserves PAT with hash and special characters', async () => {
      const pat = 'pat#with$special@chars!';
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, pat);

      const result = await readAzureDevopsSecret(tempDir);
      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.pat).toBe(pat);
      }
    });

    it('preserves PAT with unicode characters', async () => {
      const pat = 'pat-with-emoji-\u{1F600}';
      await writeAzureDevopsSecret(tempDir, TEST_ORG, TEST_PROJECT, pat);

      const result = await readAzureDevopsSecret(tempDir);
      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.pat).toBe(pat);
      }
    });

    it('preserves project with spaces and dots', async () => {
      const project = 'My Project.Name';
      await writeAzureDevopsSecret(tempDir, TEST_ORG, project, TEST_PAT);

      const result = await readAzureDevopsSecret(tempDir);
      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.project).toBe(project);
      }
    });

    it('preserves organization with dots, hyphens, and underscores', async () => {
      const org = 'https://dev.azure.com/my.org_name-2';
      await writeAzureDevopsSecret(tempDir, org, TEST_PROJECT, TEST_PAT);

      const result = await readAzureDevopsSecret(tempDir);
      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.organization).toBe(org);
      }
    });
  });
});
