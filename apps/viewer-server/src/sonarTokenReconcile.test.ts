import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  reconcileSonarTokenToWorktree,
  escapeTokenForEnv,
  getEnvFilePath,
  getEnvTempFilePath,
} from './sonarTokenReconcile.js';

describe('sonarTokenReconcile', () => {
  let tempDir: string;
  let worktreeDir: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonar-reconcile-test-'));

    // Create a mock worktree directory and init a real git repo
    worktreeDir = path.join(tempDir, 'worktree');
    await fs.mkdir(worktreeDir, { recursive: true });

    // Initialize a real git repository so git commands work
    execSync('git init', { cwd: worktreeDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    // Clean up the temp directory
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => void 0);
  });

  describe('escapeTokenForEnv', () => {
    it('returns unchanged token with no special characters', () => {
      expect(escapeTokenForEnv('simple-token-123')).toBe('simple-token-123');
    });

    it('escapes backslashes', () => {
      expect(escapeTokenForEnv('token\\with\\backslashes')).toBe('token\\\\with\\\\backslashes');
    });

    it('escapes double quotes', () => {
      expect(escapeTokenForEnv('token"with"quotes')).toBe('token\\"with\\"quotes');
    });

    it('escapes both backslashes and quotes', () => {
      expect(escapeTokenForEnv('token\\"mixed')).toBe('token\\\\\\"mixed');
    });

    it('handles consecutive backslashes', () => {
      expect(escapeTokenForEnv('token\\\\double')).toBe('token\\\\\\\\double');
    });

    it('handles consecutive quotes', () => {
      expect(escapeTokenForEnv('token""double')).toBe('token\\"\\"double');
    });

    it('preserves hash character (no escaping needed inside quotes)', () => {
      // Hash doesn't need escaping inside double quotes in dotenv format
      expect(escapeTokenForEnv('token#with#hash')).toBe('token#with#hash');
    });

    it('preserves other special characters', () => {
      expect(escapeTokenForEnv('token$@!%^&*()')).toBe('token$@!%^&*()');
    });

    it('handles empty string', () => {
      expect(escapeTokenForEnv('')).toBe('');
    });
  });

  describe('path helpers', () => {
    it('getEnvFilePath returns correct path', () => {
      const result = getEnvFilePath('/some/worktree');
      expect(result).toBe(path.join('/some/worktree', '.env.jeeves'));
    });

    it('getEnvTempFilePath returns correct path', () => {
      const result = getEnvTempFilePath('/some/worktree');
      expect(result).toBe(path.join('/some/worktree', '.env.jeeves.tmp'));
    });
  });

  describe('reconcileSonarTokenToWorktree', () => {
    describe('when token is present', () => {
      it('writes .env.jeeves with correct format', async () => {
        const result = await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'my-secret-token',
          envVarName: 'SONAR_TOKEN',
        });

        expect(result.sync_status).toBe('in_sync');
        expect(result.warnings).toEqual([]);
        expect(result.last_error).toBeNull();

        const envFilePath = getEnvFilePath(worktreeDir);
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe('SONAR_TOKEN="my-secret-token"\n');
      });

      it('uses default env var name when not specified', async () => {
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'test-token',
        });

        const envFilePath = getEnvFilePath(worktreeDir);
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe('SONAR_TOKEN="test-token"\n');
      });

      it('uses custom env var name when specified', async () => {
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'test-token',
          envVarName: 'SONARQUBE_TOKEN',
        });

        const envFilePath = getEnvFilePath(worktreeDir);
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe('SONARQUBE_TOKEN="test-token"\n');
      });

      it('escapes backslashes in token', async () => {
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'token\\with\\backslash',
          envVarName: 'SONAR_TOKEN',
        });

        const envFilePath = getEnvFilePath(worktreeDir);
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe('SONAR_TOKEN="token\\\\with\\\\backslash"\n');
      });

      it('escapes double quotes in token', async () => {
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'token"with"quotes',
          envVarName: 'SONAR_TOKEN',
        });

        const envFilePath = getEnvFilePath(worktreeDir);
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe('SONAR_TOKEN="token\\"with\\"quotes"\n');
      });

      it('handles token with hash character', async () => {
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'token#with#hash',
          envVarName: 'SONAR_TOKEN',
        });

        const envFilePath = getEnvFilePath(worktreeDir);
        const content = await fs.readFile(envFilePath, 'utf-8');
        // Hash is preserved inside quotes - no escaping needed
        expect(content).toBe('SONAR_TOKEN="token#with#hash"\n');
      });

      it('handles token with mixed special characters', async () => {
        // Token with backslash, quote, and hash
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'token\\with"quote#hash',
          envVarName: 'SONAR_TOKEN',
        });

        const envFilePath = getEnvFilePath(worktreeDir);
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe('SONAR_TOKEN="token\\\\with\\"quote#hash"\n');
      });

      it('sets file permissions to 0600 on POSIX', async () => {
        if (process.platform === 'win32') {
          return; // Skip on Windows
        }

        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'test-token',
        });

        const envFilePath = getEnvFilePath(worktreeDir);
        const stat = await fs.stat(envFilePath);
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);
      });

      it('cleans up leftover .env.jeeves.tmp before writing', async () => {
        const tempFilePath = getEnvTempFilePath(worktreeDir);
        await fs.writeFile(tempFilePath, 'leftover content');

        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'new-token',
        });

        // Temp file should be cleaned up
        await expect(fs.stat(tempFilePath)).rejects.toThrow();

        // Env file should have correct content
        const envFilePath = getEnvFilePath(worktreeDir);
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe('SONAR_TOKEN="new-token"\n');
      });

      it('overwrites existing .env.jeeves file', async () => {
        const envFilePath = getEnvFilePath(worktreeDir);
        await fs.writeFile(envFilePath, 'OLD_TOKEN="old-value"\n');

        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'new-token',
          envVarName: 'NEW_VAR',
        });

        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe('NEW_VAR="new-token"\n');
      });
    });

    describe('when token is absent', () => {
      it('removes .env.jeeves if present', async () => {
        const envFilePath = getEnvFilePath(worktreeDir);
        await fs.writeFile(envFilePath, 'SONAR_TOKEN="old-value"\n');

        const result = await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: false,
        });

        expect(result.sync_status).toBe('in_sync');
        expect(result.warnings).toEqual([]);
        expect(result.last_error).toBeNull();

        await expect(fs.stat(envFilePath)).rejects.toThrow();
      });

      it('succeeds when .env.jeeves does not exist (idempotent)', async () => {
        const result = await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: false,
        });

        expect(result.sync_status).toBe('in_sync');
        expect(result.warnings).toEqual([]);
        expect(result.last_error).toBeNull();
      });

      it('cleans up leftover .env.jeeves.tmp even when token is absent', async () => {
        const tempFilePath = getEnvTempFilePath(worktreeDir);
        await fs.writeFile(tempFilePath, 'leftover content');

        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: false,
        });

        await expect(fs.stat(tempFilePath)).rejects.toThrow();
      });
    });

    describe('git exclude handling', () => {
      it('adds .env.jeeves and .env.jeeves.tmp to .git/info/exclude', async () => {
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'test-token',
        });

        const excludePath = path.join(worktreeDir, '.git', 'info', 'exclude');
        const content = await fs.readFile(excludePath, 'utf-8');

        expect(content).toContain('.env.jeeves');
        expect(content).toContain('.env.jeeves.tmp');
      });

      it('does not duplicate entries in .git/info/exclude', async () => {
        // Run reconcile twice
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'test-token',
        });

        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'updated-token',
        });

        const excludePath = path.join(worktreeDir, '.git', 'info', 'exclude');
        const content = await fs.readFile(excludePath, 'utf-8');

        // Count occurrences - each should appear exactly once
        const envJeevesCount = (content.match(/^\.env\.jeeves$/gm) || []).length;
        const envJeevesTmpCount = (content.match(/^\.env\.jeeves\.tmp$/gm) || []).length;

        expect(envJeevesCount).toBe(1);
        expect(envJeevesTmpCount).toBe(1);
      });

      it('preserves existing entries in .git/info/exclude', async () => {
        const excludePath = path.join(worktreeDir, '.git', 'info', 'exclude');
        await fs.writeFile(excludePath, '# existing comment\n.existing-pattern\n');

        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'test-token',
        });

        const content = await fs.readFile(excludePath, 'utf-8');
        expect(content).toContain('# existing comment');
        expect(content).toContain('.existing-pattern');
        expect(content).toContain('.env.jeeves');
      });

      it('still updates exclude when token is absent', async () => {
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: false,
        });

        const excludePath = path.join(worktreeDir, '.git', 'info', 'exclude');
        const content = await fs.readFile(excludePath, 'utf-8');

        expect(content).toContain('.env.jeeves');
        expect(content).toContain('.env.jeeves.tmp');
      });
    });

    describe('worktree absent handling', () => {
      it('returns deferred_worktree_absent when worktree does not exist', async () => {
        const nonExistentWorktree = path.join(tempDir, 'nonexistent');

        const result = await reconcileSonarTokenToWorktree({
          worktreeDir: nonExistentWorktree,
          hasToken: true,
          token: 'test-token',
        });

        expect(result.sync_status).toBe('deferred_worktree_absent');
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.last_error).not.toBeNull();
      });

      it('returns deferred_worktree_absent when worktree path is a file', async () => {
        const filePath = path.join(tempDir, 'not-a-directory');
        await fs.writeFile(filePath, 'i am a file');

        const result = await reconcileSonarTokenToWorktree({
          worktreeDir: filePath,
          hasToken: true,
          token: 'test-token',
        });

        expect(result.sync_status).toBe('deferred_worktree_absent');
      });
    });

    describe('env var name customization', () => {
      it('supports various valid env var names', async () => {
        const testCases = [
          { name: 'SONAR_TOKEN', expected: 'SONAR_TOKEN="test"\n' },
          { name: 'SONARQUBE_TOKEN', expected: 'SONARQUBE_TOKEN="test"\n' },
          { name: 'MY_CUSTOM_VAR', expected: 'MY_CUSTOM_VAR="test"\n' },
          { name: '_PRIVATE_VAR', expected: '_PRIVATE_VAR="test"\n' },
          { name: 'VAR123', expected: 'VAR123="test"\n' },
        ];

        for (const { name, expected } of testCases) {
          // Clean up from previous iteration
          const envFilePath = getEnvFilePath(worktreeDir);
          await fs.rm(envFilePath, { force: true }).catch(() => void 0);

          await reconcileSonarTokenToWorktree({
            worktreeDir,
            hasToken: true,
            token: 'test',
            envVarName: name,
          });

          const content = await fs.readFile(envFilePath, 'utf-8');
          expect(content).toBe(expected);
        }
      });
    });

    describe('special character handling in tokens', () => {
      it('correctly escapes token with only hash', async () => {
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: '#just-hash',
          envVarName: 'TOKEN',
        });

        const content = await fs.readFile(getEnvFilePath(worktreeDir), 'utf-8');
        expect(content).toBe('TOKEN="#just-hash"\n');
      });

      it('correctly escapes token with only backslash', async () => {
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: '\\',
          envVarName: 'TOKEN',
        });

        const content = await fs.readFile(getEnvFilePath(worktreeDir), 'utf-8');
        expect(content).toBe('TOKEN="\\\\"\n');
      });

      it('correctly escapes token with only quote', async () => {
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: '"',
          envVarName: 'TOKEN',
        });

        const content = await fs.readFile(getEnvFilePath(worktreeDir), 'utf-8');
        expect(content).toBe('TOKEN="\\""\n');
      });

      it('correctly escapes complex token with all special characters', async () => {
        // Token: test#value\path"name
        // Expected escaped: test#value\\path\"name
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'test#value\\path"name',
          envVarName: 'TOKEN',
        });

        const content = await fs.readFile(getEnvFilePath(worktreeDir), 'utf-8');
        expect(content).toBe('TOKEN="test#value\\\\path\\"name"\n');
      });

      it('handles realistic SonarCloud token format', async () => {
        // SonarCloud tokens are typically alphanumeric with some special chars
        const realisticToken = 'sqp_abc123def456ghi789_jkl012mno345';

        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: realisticToken,
          envVarName: 'SONAR_TOKEN',
        });

        const content = await fs.readFile(getEnvFilePath(worktreeDir), 'utf-8');
        expect(content).toBe(`SONAR_TOKEN="${realisticToken}"\n`);
      });
    });

    describe('atomic write behavior', () => {
      it('file is never partially written', async () => {
        const token = 'test-token-for-atomicity';

        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token,
        });

        // Read should always succeed with complete data
        const envFilePath = getEnvFilePath(worktreeDir);
        const content = await fs.readFile(envFilePath, 'utf-8');

        expect(content).toBe(`SONAR_TOKEN="${token}"\n`);
        expect(content.endsWith('\n')).toBe(true);
      });

      it('no temp file remains after successful write', async () => {
        await reconcileSonarTokenToWorktree({
          worktreeDir,
          hasToken: true,
          token: 'test-token',
        });

        const tempFilePath = getEnvTempFilePath(worktreeDir);
        await expect(fs.stat(tempFilePath)).rejects.toThrow();
      });
    });
  });
});
