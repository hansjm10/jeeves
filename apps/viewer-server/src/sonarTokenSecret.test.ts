import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readSonarTokenSecret,
  writeSonarTokenSecret,
  deleteSonarTokenSecret,
  hasToken,
  getSonarTokenSecretPath,
  getSecretsDir,
  SECRET_FILE_SCHEMA_VERSION,
} from './sonarTokenSecret.js';

describe('sonarTokenSecret', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonar-token-secret-test-'));
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

    it('getSonarTokenSecretPath returns correct path', () => {
      const result = getSonarTokenSecretPath('/issue/state/dir');
      expect(result).toBe(path.join('/issue/state/dir', '.secrets', 'sonar-token.json'));
    });
  });

  describe('writeSonarTokenSecret', () => {
    it('creates the secret file with correct content', async () => {
      const result = await writeSonarTokenSecret(tempDir, 'my-secret-token');

      expect(result.schemaVersion).toBe(SECRET_FILE_SCHEMA_VERSION);
      expect(result.token).toBe('my-secret-token');
      expect(result.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // Verify file was written
      const secretPath = getSonarTokenSecretPath(tempDir);
      const content = await fs.readFile(secretPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.token).toBe('my-secret-token');
      expect(parsed.updated_at).toBe(result.updated_at);
    });

    it('creates the .secrets directory if it does not exist', async () => {
      const secretsDir = getSecretsDir(tempDir);

      // Verify directory doesn't exist yet
      await expect(fs.stat(secretsDir)).rejects.toThrow();

      await writeSonarTokenSecret(tempDir, 'test-token');

      // Verify directory was created
      const stat = await fs.stat(secretsDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('overwrites existing secret file', async () => {
      // Write initial token
      const first = await writeSonarTokenSecret(tempDir, 'first-token');
      expect(first.token).toBe('first-token');

      // Overwrite with new token
      const second = await writeSonarTokenSecret(tempDir, 'second-token');
      expect(second.token).toBe('second-token');

      // Verify file contains updated content
      const secretPath = getSonarTokenSecretPath(tempDir);
      const content = await fs.readFile(secretPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.token).toBe('second-token');
      expect(new Date(parsed.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(first.updated_at).getTime(),
      );
    });

    it('writes atomically via temp file (cleans up leftover temp)', async () => {
      const secretPath = getSonarTokenSecretPath(tempDir);
      const tempPath = `${secretPath}.tmp`;

      // Create a leftover temp file
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(tempPath, 'leftover content');

      // Write should succeed and clean up the temp file
      await writeSonarTokenSecret(tempDir, 'new-token');

      // Verify temp file was cleaned up
      await expect(fs.stat(tempPath)).rejects.toThrow();

      // Verify actual file has correct content
      const content = await fs.readFile(secretPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.token).toBe('new-token');
    });

    it('sets file permissions to 0600 on POSIX', async () => {
      // Skip on Windows where chmod is not fully supported
      if (process.platform === 'win32') {
        return;
      }

      await writeSonarTokenSecret(tempDir, 'test-token');

      const secretPath = getSonarTokenSecretPath(tempDir);
      const stat = await fs.stat(secretPath);

      // Check mode is 0600 (owner read/write only)
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('updates updated_at timestamp on each write', async () => {
      const first = await writeSonarTokenSecret(tempDir, 'token');

      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await writeSonarTokenSecret(tempDir, 'token');

      expect(new Date(second.updated_at).getTime()).toBeGreaterThan(
        new Date(first.updated_at).getTime(),
      );
    });
  });

  describe('readSonarTokenSecret', () => {
    it('returns { exists: true } with data when file exists', async () => {
      await writeSonarTokenSecret(tempDir, 'my-token');

      const result = await readSonarTokenSecret(tempDir);

      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.schemaVersion).toBe(SECRET_FILE_SCHEMA_VERSION);
        expect(result.data.token).toBe('my-token');
        expect(typeof result.data.updated_at).toBe('string');
      }
    });

    it('returns { exists: false } when file does not exist', async () => {
      const result = await readSonarTokenSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when file has invalid JSON', async () => {
      const secretPath = getSonarTokenSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(secretPath, 'not valid json');

      const result = await readSonarTokenSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when file has wrong schema version', async () => {
      const secretPath = getSonarTokenSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(
        secretPath,
        JSON.stringify({ schemaVersion: 999, token: 'test', updated_at: new Date().toISOString() }),
      );

      const result = await readSonarTokenSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when file is missing token field', async () => {
      const secretPath = getSonarTokenSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(
        secretPath,
        JSON.stringify({ schemaVersion: 1, updated_at: new Date().toISOString() }),
      );

      const result = await readSonarTokenSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when file has empty token', async () => {
      const secretPath = getSonarTokenSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(
        secretPath,
        JSON.stringify({ schemaVersion: 1, token: '', updated_at: new Date().toISOString() }),
      );

      const result = await readSonarTokenSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when file is missing updated_at', async () => {
      const secretPath = getSonarTokenSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(secretPath, JSON.stringify({ schemaVersion: 1, token: 'test' }));

      const result = await readSonarTokenSecret(tempDir);

      expect(result.exists).toBe(false);
    });

    it('returns { exists: false } when secrets directory does not exist', async () => {
      const result = await readSonarTokenSecret(path.join(tempDir, 'nonexistent'));

      expect(result.exists).toBe(false);
    });
  });

  describe('deleteSonarTokenSecret', () => {
    it('deletes existing secret file and returns true', async () => {
      await writeSonarTokenSecret(tempDir, 'token-to-delete');

      const deleted = await deleteSonarTokenSecret(tempDir);

      expect(deleted).toBe(true);

      // Verify file is gone
      const secretPath = getSonarTokenSecretPath(tempDir);
      await expect(fs.stat(secretPath)).rejects.toThrow();
    });

    it('returns false when file does not exist (idempotent)', async () => {
      const deleted = await deleteSonarTokenSecret(tempDir);

      expect(deleted).toBe(false);
    });

    it('returns false on second delete (idempotent)', async () => {
      await writeSonarTokenSecret(tempDir, 'token');

      const first = await deleteSonarTokenSecret(tempDir);
      expect(first).toBe(true);

      const second = await deleteSonarTokenSecret(tempDir);
      expect(second).toBe(false);
    });

    it('cleans up leftover temp file during delete', async () => {
      const secretPath = getSonarTokenSecretPath(tempDir);
      const tempPath = `${secretPath}.tmp`;

      // Create secrets dir with leftover temp file only (no actual secret file)
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(tempPath, 'leftover');

      // Delete should clean up temp file and return false (no actual secret)
      const deleted = await deleteSonarTokenSecret(tempDir);

      expect(deleted).toBe(false);
      await expect(fs.stat(tempPath)).rejects.toThrow();
    });

    it('cleans up temp file even when secret file exists', async () => {
      await writeSonarTokenSecret(tempDir, 'token');

      // Simulate a crashed write leaving a temp file
      const secretPath = getSonarTokenSecretPath(tempDir);
      const tempPath = `${secretPath}.tmp`;
      await fs.writeFile(tempPath, 'crashed write');

      const deleted = await deleteSonarTokenSecret(tempDir);

      expect(deleted).toBe(true);
      await expect(fs.stat(tempPath)).rejects.toThrow();
      await expect(fs.stat(secretPath)).rejects.toThrow();
    });
  });

  describe('hasToken', () => {
    it('returns true when token exists', async () => {
      await writeSonarTokenSecret(tempDir, 'my-token');

      const result = await hasToken(tempDir);

      expect(result).toBe(true);
    });

    it('returns false when no token exists', async () => {
      const result = await hasToken(tempDir);

      expect(result).toBe(false);
    });

    it('returns false after token is deleted', async () => {
      await writeSonarTokenSecret(tempDir, 'my-token');
      expect(await hasToken(tempDir)).toBe(true);

      await deleteSonarTokenSecret(tempDir);

      expect(await hasToken(tempDir)).toBe(false);
    });

    it('returns false when secret file is corrupted', async () => {
      const secretPath = getSonarTokenSecretPath(tempDir);
      await fs.mkdir(getSecretsDir(tempDir), { recursive: true });
      await fs.writeFile(secretPath, 'corrupted content');

      const result = await hasToken(tempDir);

      expect(result).toBe(false);
    });
  });

  describe('atomic write behavior', () => {
    it('file is never partially written (simulated verification)', async () => {
      // This test verifies the pattern: write temp, then rename
      // By checking that if we read immediately after write, we get complete data

      const token = 'test-token-for-atomicity';
      await writeSonarTokenSecret(tempDir, token);

      // Read should always succeed with complete data
      const result = await readSonarTokenSecret(tempDir);
      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.token).toBe(token);
        expect(result.data.schemaVersion).toBe(SECRET_FILE_SCHEMA_VERSION);
        expect(result.data.updated_at).toBeTruthy();
      }
    });

    it('sequential rapid writes do not corrupt the file', async () => {
      // Write multiple times in rapid succession - file should never be corrupted
      // Note: true concurrent writes are protected by mutex in T4; this tests rapid sequential writes
      const tokens = ['token-a', 'token-b', 'token-c', 'token-d', 'token-e'];

      for (const token of tokens) {
        await writeSonarTokenSecret(tempDir, token);

        // Each write should leave the file in a valid state
        const result = await readSonarTokenSecret(tempDir);
        expect(result.exists).toBe(true);
        if (result.exists) {
          expect(result.data.token).toBe(token);
          expect(result.data.schemaVersion).toBe(SECRET_FILE_SCHEMA_VERSION);
        }
      }

      // Final state should have the last token
      const finalResult = await readSonarTokenSecret(tempDir);
      expect(finalResult.exists).toBe(true);
      if (finalResult.exists) {
        expect(finalResult.data.token).toBe('token-e');
      }
    });
  });

  describe('special characters in token', () => {
    it('preserves token with quotes', async () => {
      const token = 'token"with"quotes';
      await writeSonarTokenSecret(tempDir, token);

      const result = await readSonarTokenSecret(tempDir);
      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.token).toBe(token);
      }
    });

    it('preserves token with backslashes', async () => {
      const token = 'token\\with\\backslashes';
      await writeSonarTokenSecret(tempDir, token);

      const result = await readSonarTokenSecret(tempDir);
      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.token).toBe(token);
      }
    });

    it('preserves token with hash and special characters', async () => {
      const token = 'token#with$special@chars!';
      await writeSonarTokenSecret(tempDir, token);

      const result = await readSonarTokenSecret(tempDir);
      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.token).toBe(token);
      }
    });

    it('preserves token with unicode characters', async () => {
      const token = 'token-with-emoji-\u{1F600}';
      await writeSonarTokenSecret(tempDir, token);

      const result = await readSonarTokenSecret(tempDir);
      expect(result.exists).toBe(true);
      if (result.exists) {
        expect(result.data.token).toBe(token);
      }
    });
  });
});
