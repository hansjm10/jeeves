import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess, spawn as spawnType } from 'node:child_process';

import {
  listExistingPr,
  createPr,
} from './providerPrAdapter.js';
import { ProviderAdapterError } from './providerIssueAdapter.js';

// ============================================================================
// Helpers: fake spawn
// ============================================================================

type SpawnBehavior = {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  enoent?: boolean;
};

function createFakeSpawn(behavior: SpawnBehavior): typeof spawnType {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return ((_cmd: string, _args: string[]) => {
    const child = new EventEmitter() as ChildProcess;

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const stdoutStream = new Readable({ read() {} });
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const stderrStream = new Readable({ read() {} });
    const stdinStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    (child as unknown as { stdout: Readable }).stdout = stdoutStream;
    (child as unknown as { stderr: Readable }).stderr = stderrStream;
    (child as unknown as { stdin: Writable }).stdin = stdinStream;

    setTimeout(() => {
      if (behavior.enoent) {
        const err = new Error('spawn ENOENT') as Error & { code: string };
        err.code = 'ENOENT';
        child.emit('error', err);
        return;
      }

      if (behavior.stdout) {
        stdoutStream.push(Buffer.from(behavior.stdout));
      }
      stdoutStream.push(null);

      if (behavior.stderr) {
        stderrStream.push(Buffer.from(behavior.stderr));
      }
      stderrStream.push(null);

      child.emit(
        'exit',
        behavior.exitCode ?? 0,
        behavior.signal ?? null,
      );
    });

    return child;
  }) as unknown as typeof spawnType;
}

// ============================================================================
// listExistingPr — GitHub
// ============================================================================

describe('listExistingPr', () => {
  describe('github', () => {
    it('returns ProviderPrRef from parsed JSON', async () => {
      const ghOutput = JSON.stringify([
        {
          number: 42,
          url: 'https://github.com/owner/repo/pull/42',
          state: 'OPEN',
        },
      ]);

      const spawn = createFakeSpawn({
        stdout: ghOutput,
        exitCode: 0,
      });

      const result = await listExistingPr({
        provider: 'github',
        repo: 'owner/repo',
        branch: 'feature-branch',
        spawnImpl: spawn,
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe('42');
      expect(result!.url).toBe('https://github.com/owner/repo/pull/42');
      expect(result!.number).toBe(42);
      expect(result!.state).toBe('OPEN');
    });

    it('returns null when empty array', async () => {
      const spawn = createFakeSpawn({
        stdout: '[]',
        exitCode: 0,
      });

      const result = await listExistingPr({
        provider: 'github',
        repo: 'owner/repo',
        branch: 'feature-branch',
        spawnImpl: spawn,
      });

      expect(result).toBeNull();
    });

    it('maps auth error to provider_auth_required', async () => {
      const spawn = createFakeSpawn({
        stderr: 'gh auth login required',
        exitCode: 1,
      });

      try {
        await listExistingPr({
          provider: 'github',
          repo: 'owner/repo',
          branch: 'feature-branch',
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('provider_auth_required');
        expect(err.status).toBe(401);
      }
    });

    it('maps missing CLI to missing_cli', async () => {
      const spawn = createFakeSpawn({ enoent: true });

      try {
        await listExistingPr({
          provider: 'github',
          repo: 'owner/repo',
          branch: 'feature-branch',
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('missing_cli');
        expect(err.status).toBe(500);
      }
    });

    it('maps permission error to provider_permission_denied', async () => {
      const spawn = createFakeSpawn({
        stderr: 'repository not found',
        exitCode: 1,
      });

      try {
        await listExistingPr({
          provider: 'github',
          repo: 'owner/repo',
          branch: 'feature',
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('provider_permission_denied');
        expect(err.status).toBe(403);
      }
    });
  });

  describe('azure', () => {
    it('returns ProviderPrRef from parsed JSON', async () => {
      const azOutput = JSON.stringify([
        {
          pullRequestId: 99,
          status: 'active',
          repository: {
            webUrl: 'https://dev.azure.com/org/proj/_git/repo',
          },
        },
      ]);

      const spawn = createFakeSpawn({
        stdout: azOutput,
        exitCode: 0,
      });

      const result = await listExistingPr({
        provider: 'azure_devops',
        repo: 'repo',
        branch: 'feature-branch',
        azure: {
          organization: 'https://dev.azure.com/org',
          project: 'proj',
        },
        spawnImpl: spawn,
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe('99');
      expect(result!.url).toContain('pullrequest/99');
      expect(result!.number).toBe(99);
      expect(result!.state).toBe('active');
    });

    it('returns null when empty array', async () => {
      const spawn = createFakeSpawn({
        stdout: '[]',
        exitCode: 0,
      });

      const result = await listExistingPr({
        provider: 'azure_devops',
        repo: 'repo',
        branch: 'feature-branch',
        azure: {
          organization: 'https://dev.azure.com/org',
          project: 'proj',
        },
        spawnImpl: spawn,
      });

      expect(result).toBeNull();
    });

    it('maps auth error to provider_auth_required', async () => {
      const spawn = createFakeSpawn({
        stderr: 'ERROR: Please run az login first',
        exitCode: 1,
      });

      try {
        await listExistingPr({
          provider: 'azure_devops',
          repo: 'repo',
          branch: 'feature-branch',
          azure: {
            organization: 'https://dev.azure.com/org',
            project: 'proj',
          },
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('provider_auth_required');
        expect(err.status).toBe(401);
      }
    });

    it('maps permission error to provider_permission_denied', async () => {
      const spawn = createFakeSpawn({
        stderr: 'TF401019: does not have permissions',
        exitCode: 1,
      });

      try {
        await listExistingPr({
          provider: 'azure_devops',
          repo: 'repo',
          branch: 'feature-branch',
          azure: {
            organization: 'https://dev.azure.com/org',
            project: 'proj',
          },
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('provider_permission_denied');
        expect(err.status).toBe(403);
      }
    });

    it('maps missing CLI to missing_cli', async () => {
      const spawn = createFakeSpawn({ enoent: true });

      try {
        await listExistingPr({
          provider: 'azure_devops',
          repo: 'repo',
          branch: 'feature-branch',
          azure: {
            organization: 'https://dev.azure.com/org',
            project: 'proj',
          },
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('missing_cli');
        expect(err.status).toBe(500);
      }
    });

    it('never exposes PAT in error messages', async () => {
      const pat = 'az-secret-pat-value';
      const spawn = createFakeSpawn({
        stderr: `Error with ${pat} in it`,
        exitCode: 1,
      });

      try {
        await listExistingPr({
          provider: 'azure_devops',
          repo: 'repo',
          branch: 'feature-branch',
          azure: {
            organization: 'https://dev.azure.com/org',
            project: 'proj',
            pat,
          },
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.message).not.toContain(pat);
      }
    });
  });
});

// ============================================================================
// createPr — GitHub
// ============================================================================

describe('createPr', () => {
  describe('github', () => {
    it('returns ProviderPrRef from created PR URL', async () => {
      const spawn = createFakeSpawn({
        stdout: 'https://github.com/owner/repo/pull/55\n',
        exitCode: 0,
      });

      const result = await createPr({
        provider: 'github',
        repo: 'owner/repo',
        branch: 'feature-branch',
        baseBranch: 'main',
        title: 'My PR',
        body: 'PR body',
        spawnImpl: spawn,
      });

      expect(result.id).toBe('55');
      expect(result.url).toBe('https://github.com/owner/repo/pull/55');
      expect(result.number).toBe(55);
    });

    it('maps auth error to provider_auth_required', async () => {
      const spawn = createFakeSpawn({
        stderr: 'gh auth login required for authentication',
        exitCode: 1,
      });

      try {
        await createPr({
          provider: 'github',
          repo: 'owner/repo',
          branch: 'feature',
          baseBranch: 'main',
          title: 'PR',
          body: 'Body',
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('provider_auth_required');
        expect(err.status).toBe(401);
      }
    });

    it('maps permission error to provider_permission_denied', async () => {
      const spawn = createFakeSpawn({
        stderr: 'repository not found',
        exitCode: 1,
      });

      try {
        await createPr({
          provider: 'github',
          repo: 'owner/repo',
          branch: 'feature',
          baseBranch: 'main',
          title: 'PR',
          body: 'Body',
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('provider_permission_denied');
        expect(err.status).toBe(403);
      }
    });

    it('maps validation error to remote_validation_failed', async () => {
      const spawn = createFakeSpawn({
        stderr: 'a pull request already exists for this branch',
        exitCode: 1,
      });

      try {
        await createPr({
          provider: 'github',
          repo: 'owner/repo',
          branch: 'feature',
          baseBranch: 'main',
          title: 'PR',
          body: 'Body',
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('remote_validation_failed');
        expect(err.status).toBe(422);
      }
    });

    it('maps missing CLI to missing_cli', async () => {
      const spawn = createFakeSpawn({ enoent: true });

      try {
        await createPr({
          provider: 'github',
          repo: 'owner/repo',
          branch: 'feature',
          baseBranch: 'main',
          title: 'PR',
          body: 'Body',
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('missing_cli');
        expect(err.status).toBe(500);
      }
    });

    it('maps empty stdout to io_error', async () => {
      const spawn = createFakeSpawn({
        stdout: '',
        exitCode: 0,
      });

      try {
        await createPr({
          provider: 'github',
          repo: 'owner/repo',
          branch: 'feature',
          baseBranch: 'main',
          title: 'PR',
          body: 'Body',
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('io_error');
        expect(err.status).toBe(500);
      }
    });
  });

  describe('azure', () => {
    it('returns ProviderPrRef from created PR JSON', async () => {
      const azOutput = JSON.stringify({
        pullRequestId: 77,
        status: 'active',
        repository: {
          webUrl: 'https://dev.azure.com/org/proj/_git/repo',
        },
      });

      const spawn = createFakeSpawn({
        stdout: azOutput,
        exitCode: 0,
      });

      const result = await createPr({
        provider: 'azure_devops',
        repo: 'repo',
        branch: 'feature-branch',
        baseBranch: 'main',
        title: 'Azure PR',
        body: 'PR body',
        azure: {
          organization: 'https://dev.azure.com/org',
          project: 'proj',
        },
        spawnImpl: spawn,
      });

      expect(result.id).toBe('77');
      expect(result.url).toContain('pullrequest/77');
      expect(result.number).toBe(77);
      expect(result.state).toBe('active');
    });

    it('maps auth error to provider_auth_required', async () => {
      const spawn = createFakeSpawn({
        stderr: 'ERROR: Please run az login first',
        exitCode: 1,
      });

      try {
        await createPr({
          provider: 'azure_devops',
          repo: 'repo',
          branch: 'feature',
          baseBranch: 'main',
          title: 'PR',
          body: 'Body',
          azure: {
            organization: 'https://dev.azure.com/org',
            project: 'proj',
          },
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('provider_auth_required');
        expect(err.status).toBe(401);
      }
    });

    it('maps permission error to provider_permission_denied', async () => {
      const spawn = createFakeSpawn({
        stderr: 'TF401019: forbidden access',
        exitCode: 1,
      });

      try {
        await createPr({
          provider: 'azure_devops',
          repo: 'repo',
          branch: 'feature',
          baseBranch: 'main',
          title: 'PR',
          body: 'Body',
          azure: {
            organization: 'https://dev.azure.com/org',
            project: 'proj',
          },
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('provider_permission_denied');
        expect(err.status).toBe(403);
      }
    });

    it('maps missing CLI to missing_cli', async () => {
      const spawn = createFakeSpawn({ enoent: true });

      try {
        await createPr({
          provider: 'azure_devops',
          repo: 'repo',
          branch: 'feature',
          baseBranch: 'main',
          title: 'PR',
          body: 'Body',
          azure: {
            organization: 'https://dev.azure.com/org',
            project: 'proj',
          },
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('missing_cli');
        expect(err.status).toBe(500);
      }
    });

    it('never exposes PAT in error messages', async () => {
      const pat = 'super-secret-azure-pat';
      const spawn = createFakeSpawn({
        stderr: `Error with ${pat} in stderr`,
        exitCode: 1,
      });

      try {
        await createPr({
          provider: 'azure_devops',
          repo: 'repo',
          branch: 'feature',
          baseBranch: 'main',
          title: 'PR',
          body: 'Body',
          azure: {
            organization: 'https://dev.azure.com/org',
            project: 'proj',
            pat,
          },
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.message).not.toContain(pat);
      }
    });

    it('handles invalid JSON output', async () => {
      const spawn = createFakeSpawn({
        stdout: 'not json',
        exitCode: 0,
      });

      try {
        await createPr({
          provider: 'azure_devops',
          repo: 'repo',
          branch: 'feature',
          baseBranch: 'main',
          title: 'PR',
          body: 'Body',
          azure: {
            organization: 'https://dev.azure.com/org',
            project: 'proj',
          },
          spawnImpl: spawn,
        });
        expect.unreachable('Should have thrown');
      } catch (e) {
        const err = e as ProviderAdapterError;
        expect(err.code).toBe('io_error');
      }
    });
  });
});
