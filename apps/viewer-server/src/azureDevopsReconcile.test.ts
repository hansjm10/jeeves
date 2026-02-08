import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reconcileAzureDevopsToWorktree } from './azureDevopsReconcile.js';

/** The env var name used by the reconcile module. */
const AZURE_ENV_VAR = 'AZURE_DEVOPS_EXT_PAT';

describe('azureDevopsReconcile', () => {
  let tempDir: string;
  let worktreeDir: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'azure-reconcile-test-'));

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

  describe('reconcileAzureDevopsToWorktree', () => {
    describe('when secret is present', () => {
      it('writes AZURE_DEVOPS_EXT_PAT to .env.jeeves', async () => {
        const result = await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'my-secret-pat',
        });

        expect(result.sync_status).toBe('in_sync');
        expect(result.warnings).toEqual([]);
        expect(result.last_error).toBeNull();

        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe(`${AZURE_ENV_VAR}="my-secret-pat"\n`);
      });

      it('escapes backslashes in PAT', async () => {
        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'pat\\with\\backslash',
        });

        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe(`${AZURE_ENV_VAR}="pat\\\\with\\\\backslash"\n`);
      });

      it('escapes double quotes in PAT', async () => {
        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'pat"with"quotes',
        });

        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe(`${AZURE_ENV_VAR}="pat\\"with\\"quotes"\n`);
      });

      it('handles PAT with hash character', async () => {
        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'pat#with#hash',
        });

        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe(`${AZURE_ENV_VAR}="pat#with#hash"\n`);
      });

      it('handles PAT with mixed special characters', async () => {
        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'pat\\with"quote#hash',
        });

        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe(`${AZURE_ENV_VAR}="pat\\\\with\\"quote#hash"\n`);
      });

      it('sets file permissions to 0600 on POSIX', async () => {
        if (process.platform === 'win32') {
          return; // Skip on Windows
        }

        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'test-pat',
        });

        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        const stat = await fs.stat(envFilePath);
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);
      });

      it('cleans up leftover .env.jeeves.tmp before writing', async () => {
        const tempFilePath = path.join(worktreeDir, '.env.jeeves.tmp');
        await fs.writeFile(tempFilePath, 'leftover content');

        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'new-pat',
        });

        // Temp file should be cleaned up
        await expect(fs.stat(tempFilePath)).rejects.toThrow();

        // Env file should have correct content
        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe(`${AZURE_ENV_VAR}="new-pat"\n`);
      });

      it('updates existing AZURE_DEVOPS_EXT_PAT line', async () => {
        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        await fs.writeFile(envFilePath, `${AZURE_ENV_VAR}="old-pat"\n`);

        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'new-pat',
        });

        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toBe(`${AZURE_ENV_VAR}="new-pat"\n`);
      });
    });

    describe('coexistence with sonar token', () => {
      it('preserves existing SONAR_TOKEN when adding Azure PAT', async () => {
        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        await fs.writeFile(envFilePath, 'SONAR_TOKEN="sqp_abc123"\n');

        const result = await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'azure-pat-value',
        });

        expect(result.sync_status).toBe('in_sync');

        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toContain('SONAR_TOKEN="sqp_abc123"');
        expect(content).toContain(`${AZURE_ENV_VAR}="azure-pat-value"`);

        // Both lines should be present
        const lines = content.split('\n').filter((l) => l.trim().length > 0);
        expect(lines).toHaveLength(2);
      });

      it('preserves existing SONAR_TOKEN when updating Azure PAT', async () => {
        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        await fs.writeFile(
          envFilePath,
          `SONAR_TOKEN="sqp_abc123"\n${AZURE_ENV_VAR}="old-pat"\n`,
        );

        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'updated-pat',
        });

        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toContain('SONAR_TOKEN="sqp_abc123"');
        expect(content).toContain(`${AZURE_ENV_VAR}="updated-pat"`);
        expect(content).not.toContain('old-pat');
      });

      it('preserves SONAR_TOKEN when removing Azure PAT', async () => {
        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        await fs.writeFile(
          envFilePath,
          `SONAR_TOKEN="sqp_abc123"\n${AZURE_ENV_VAR}="pat-to-remove"\n`,
        );

        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: false,
        });

        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toContain('SONAR_TOKEN="sqp_abc123"');
        expect(content).not.toContain(AZURE_ENV_VAR);
        expect(content).not.toContain('pat-to-remove');
      });

      it('removes .env.jeeves when Azure PAT is the only content', async () => {
        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        await fs.writeFile(envFilePath, `${AZURE_ENV_VAR}="only-pat"\n`);

        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: false,
        });

        // File should be removed since no other content remains
        await expect(fs.stat(envFilePath)).rejects.toThrow();
      });
    });

    describe('when secret is absent', () => {
      it('removes AZURE_DEVOPS_EXT_PAT line from .env.jeeves if present', async () => {
        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        await fs.writeFile(envFilePath, `${AZURE_ENV_VAR}="old-value"\n`);

        const result = await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: false,
        });

        expect(result.sync_status).toBe('in_sync');
        expect(result.warnings).toEqual([]);
        expect(result.last_error).toBeNull();

        // File should be removed (was only content)
        await expect(fs.stat(envFilePath)).rejects.toThrow();
      });

      it('succeeds when .env.jeeves does not exist (idempotent)', async () => {
        const result = await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: false,
        });

        expect(result.sync_status).toBe('in_sync');
        expect(result.warnings).toEqual([]);
        expect(result.last_error).toBeNull();
      });

      it('succeeds when .env.jeeves exists but has no Azure PAT line', async () => {
        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        await fs.writeFile(envFilePath, 'SONAR_TOKEN="sqp_abc123"\n');

        const result = await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: false,
        });

        expect(result.sync_status).toBe('in_sync');

        // SONAR_TOKEN should still be there
        const content = await fs.readFile(envFilePath, 'utf-8');
        expect(content).toContain('SONAR_TOKEN="sqp_abc123"');
      });

      it('cleans up leftover .env.jeeves.tmp even when secret is absent', async () => {
        const tempFilePath = path.join(worktreeDir, '.env.jeeves.tmp');
        await fs.writeFile(tempFilePath, 'leftover content');

        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: false,
        });

        await expect(fs.stat(tempFilePath)).rejects.toThrow();
      });
    });

    describe('git exclude handling', () => {
      it('adds .env.jeeves and .env.jeeves.tmp to .git/info/exclude', async () => {
        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'test-pat',
        });

        const excludePath = path.join(worktreeDir, '.git', 'info', 'exclude');
        const content = await fs.readFile(excludePath, 'utf-8');

        expect(content).toContain('.env.jeeves');
        expect(content).toContain('.env.jeeves.tmp');
      });

      it('does not duplicate entries in .git/info/exclude', async () => {
        // Run reconcile twice
        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'test-pat',
        });

        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'updated-pat',
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

        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'test-pat',
        });

        const content = await fs.readFile(excludePath, 'utf-8');
        expect(content).toContain('# existing comment');
        expect(content).toContain('.existing-pattern');
        expect(content).toContain('.env.jeeves');
      });

      it('still updates exclude when secret is absent', async () => {
        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: false,
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

        const result = await reconcileAzureDevopsToWorktree({
          worktreeDir: nonExistentWorktree,
          hasSecret: true,
          pat: 'test-pat',
        });

        expect(result.sync_status).toBe('deferred_worktree_absent');
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.last_error).not.toBeNull();
      });

      it('returns deferred_worktree_absent when worktree path is a file', async () => {
        const filePath = path.join(tempDir, 'not-a-directory');
        await fs.writeFile(filePath, 'i am a file');

        const result = await reconcileAzureDevopsToWorktree({
          worktreeDir: filePath,
          hasSecret: true,
          pat: 'test-pat',
        });

        expect(result.sync_status).toBe('deferred_worktree_absent');
      });
    });

    describe('atomic write behavior', () => {
      it('no temp file remains after successful write', async () => {
        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: 'test-pat',
        });

        const tempFilePath = path.join(worktreeDir, '.env.jeeves.tmp');
        await expect(fs.stat(tempFilePath)).rejects.toThrow();
      });

      it('file content is complete after write', async () => {
        const pat = 'test-pat-for-atomicity';

        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat,
        });

        const envFilePath = path.join(worktreeDir, '.env.jeeves');
        const content = await fs.readFile(envFilePath, 'utf-8');

        expect(content).toBe(`${AZURE_ENV_VAR}="${pat}"\n`);
        expect(content.endsWith('\n')).toBe(true);
      });
    });

    describe('special character handling in PAT', () => {
      it('correctly escapes PAT with only backslash', async () => {
        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: '\\',
        });

        const content = await fs.readFile(path.join(worktreeDir, '.env.jeeves'), 'utf-8');
        expect(content).toBe(`${AZURE_ENV_VAR}="\\\\"\n`);
      });

      it('correctly escapes PAT with only quote', async () => {
        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: '"',
        });

        const content = await fs.readFile(path.join(worktreeDir, '.env.jeeves'), 'utf-8');
        expect(content).toBe(`${AZURE_ENV_VAR}="\\""\n`);
      });

      it('handles realistic Azure PAT format', async () => {
        const realisticPat = 'q7a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v3';

        await reconcileAzureDevopsToWorktree({
          worktreeDir,
          hasSecret: true,
          pat: realisticPat,
        });

        const content = await fs.readFile(path.join(worktreeDir, '.env.jeeves'), 'utf-8');
        expect(content).toBe(`${AZURE_ENV_VAR}="${realisticPat}"\n`);
      });
    });

    describe('PAT never leaked in warnings or errors', () => {
      it('warnings do not contain PAT value on worktree absent', async () => {
        const pat = 'super-secret-pat-value-12345';
        const result = await reconcileAzureDevopsToWorktree({
          worktreeDir: path.join(tempDir, 'nonexistent'),
          hasSecret: true,
          pat,
        });

        // PAT should never appear in warnings or last_error
        for (const warning of result.warnings) {
          expect(warning).not.toContain(pat);
        }
        if (result.last_error) {
          expect(result.last_error).not.toContain(pat);
        }
      });
    });
  });
});
