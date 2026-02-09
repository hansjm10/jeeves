import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createIssueState, listIssueStates, loadIssueStateFromPath } from './issueState.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jeeves-core-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('issue state read/write', () => {
  it('creates and loads issue state under the XDG layout', async () => {
    await withTempDir(async (dataDir) => {
      const created = await createIssueState({ owner: 'o', repo: 'r', issueNumber: 38, dataDir });
      expect(created.owner).toBe('o');
      expect(created.repo).toBe('r');
      expect(created.issue.number).toBe(38);

      const loaded = await loadIssueStateFromPath(path.join(dataDir, 'issues', 'o', 'r', '38'));
      expect(loaded.issue.number).toBe(38);
      expect(loaded.branch).toBe('issue/38');

      await expect(fs.stat(path.join(dataDir, 'issues', 'o', 'r', '38', '.runs'))).resolves.toBeDefined();
    });
  });

  it('reads legacy on-disk state without migration (missing schemaVersion, branchName)', async () => {
    await withTempDir(async (dataDir) => {
      const stateDir = path.join(dataDir, 'issues', 'owner', 'repo', '1');
      await fs.mkdir(stateDir, { recursive: true });

      await fs.writeFile(
        path.join(stateDir, 'issue.json'),
        JSON.stringify(
          {
            project: 'owner/repo',
            branchName: 'issue/1',
            issue: { number: 1, repo: 'owner/repo' },
            designDoc: 'docs/design.md',
            notes: '',
            extraField: { ok: true },
          },
          null,
          2,
        ),
      );

      const loaded = await loadIssueStateFromPath(stateDir);
      expect(loaded.owner).toBe('owner');
      expect(loaded.repo).toBe('repo');
      expect(loaded.schemaVersion).toBe(1);
      expect(loaded.branch).toBe('issue/1');
      expect(loaded.designDocPath).toBe('docs/design.md');
    });
  });

  it('accepts legacy issue.json where issue is a number', async () => {
    await withTempDir(async (dataDir) => {
      const stateDir = path.join(dataDir, 'issues', 'owner', 'repo', '2');
      await fs.mkdir(stateDir, { recursive: true });

      await fs.writeFile(
        path.join(stateDir, 'issue.json'),
        JSON.stringify(
          {
            project: 'owner/repo',
            branchName: 'issue/2',
            issue: 2,
            workflow: 'default',
            notes: '',
          },
          null,
          2,
        ),
      );

      const loaded = await loadIssueStateFromPath(stateDir);
      expect(loaded.owner).toBe('owner');
      expect(loaded.repo).toBe('repo');
      expect(loaded.issue.number).toBe(2);
      expect(loaded.branch).toBe('issue/2');
    });
  });

  it('lists issue states from the issues directory', async () => {
    await withTempDir(async (dataDir) => {
      await createIssueState({ owner: 'o', repo: 'r', issueNumber: 1, dataDir });
      await createIssueState({ owner: 'o', repo: 'r', issueNumber: 2, dataDir });
      const list = await listIssueStates(dataDir);
      expect(list.map((x) => x.issueNumber)).toEqual([1, 2]);
    });
  });

  it('throws if issue state exists, unless forced (and overwrites issue.json)', async () => {
    await withTempDir(async (dataDir) => {
      await createIssueState({ owner: 'o', repo: 'r', issueNumber: 38, dataDir, notes: 'first' });

      await expect(createIssueState({ owner: 'o', repo: 'r', issueNumber: 38, dataDir })).rejects.toThrow(/already exists/);

      await createIssueState({ owner: 'o', repo: 'r', issueNumber: 38, dataDir, force: true, notes: 'second' });
      const loaded = await loadIssueStateFromPath(path.join(dataDir, 'issues', 'o', 'r', '38'));
      expect(loaded.notes).toBe('second');
    });
  });

  it('loads legacy issue.json without status/pullRequest/source extensions (defaults omitted)', async () => {
    await withTempDir(async (dataDir) => {
      const stateDir = path.join(dataDir, 'issues', 'owner', 'repo', '5');
      await fs.mkdir(stateDir, { recursive: true });

      await fs.writeFile(
        path.join(stateDir, 'issue.json'),
        JSON.stringify(
          {
            repo: 'owner/repo',
            issue: { number: 5, repo: 'owner/repo' },
            branch: 'issue/5',
            notes: '',
          },
          null,
          2,
        ),
      );

      const loaded = await loadIssueStateFromPath(stateDir);
      expect(loaded.issue.number).toBe(5);
      expect(loaded.status).toBeUndefined();
      expect(loaded.pullRequest).toBeUndefined();
      // issue.source is inside issue object via passthrough, not on IssueState directly
      expect(loaded.issue.source).toBeUndefined();
    });
  });

  it('passes through status object from issue.json', async () => {
    await withTempDir(async (dataDir) => {
      const stateDir = path.join(dataDir, 'issues', 'owner', 'repo', '6');
      await fs.mkdir(stateDir, { recursive: true });

      await fs.writeFile(
        path.join(stateDir, 'issue.json'),
        JSON.stringify(
          {
            repo: 'owner/repo',
            issue: { number: 6, repo: 'owner/repo' },
            branch: 'issue/6',
            notes: '',
            status: {
              prCreated: true,
              issueIngest: {
                provider: 'azure_devops',
                mode: 'create',
                outcome: 'success',
                remote_id: '42',
                remote_url: 'https://dev.azure.com/org/project/_workitems/edit/42',
                warnings: [],
                occurred_at: '2026-02-06T00:00:00.000Z',
              },
            },
          },
          null,
          2,
        ),
      );

      const loaded = await loadIssueStateFromPath(stateDir);
      expect(loaded.status).toBeDefined();
      expect((loaded.status as Record<string, unknown>).prCreated).toBe(true);
      const ingest = (loaded.status as Record<string, unknown>).issueIngest as Record<string, unknown>;
      expect(ingest.provider).toBe('azure_devops');
      expect(ingest.outcome).toBe('success');
    });
  });

  it('passes through pullRequest object from issue.json', async () => {
    await withTempDir(async (dataDir) => {
      const stateDir = path.join(dataDir, 'issues', 'owner', 'repo', '7');
      await fs.mkdir(stateDir, { recursive: true });

      await fs.writeFile(
        path.join(stateDir, 'issue.json'),
        JSON.stringify(
          {
            repo: 'owner/repo',
            issue: { number: 7, repo: 'owner/repo' },
            branch: 'issue/7',
            notes: '',
            pullRequest: {
              number: 42,
              url: 'https://github.com/owner/repo/pull/42',
              provider: 'github',
              external_id: '42',
              source_branch: 'issue/7',
              target_branch: 'main',
            },
          },
          null,
          2,
        ),
      );

      const loaded = await loadIssueStateFromPath(stateDir);
      expect(loaded.pullRequest).toBeDefined();
      expect((loaded.pullRequest as Record<string, unknown>).number).toBe(42);
      expect((loaded.pullRequest as Record<string, unknown>).provider).toBe('github');
      expect((loaded.pullRequest as Record<string, unknown>).external_id).toBe('42');
    });
  });

  it('passes through issue.source from issue.json via passthrough', async () => {
    await withTempDir(async (dataDir) => {
      const stateDir = path.join(dataDir, 'issues', 'owner', 'repo', '8');
      await fs.mkdir(stateDir, { recursive: true });

      await fs.writeFile(
        path.join(stateDir, 'issue.json'),
        JSON.stringify(
          {
            repo: 'owner/repo',
            issue: {
              number: 8,
              repo: 'owner/repo',
              title: 'Test issue',
              url: 'https://github.com/owner/repo/issues/8',
              source: {
                provider: 'github',
                kind: 'issue',
                id: '8',
                url: 'https://github.com/owner/repo/issues/8',
                title: 'Test issue',
                mode: 'init_existing',
              },
            },
            branch: 'issue/8',
            notes: '',
          },
          null,
          2,
        ),
      );

      const loaded = await loadIssueStateFromPath(stateDir);
      const source = loaded.issue.source as Record<string, unknown>;
      expect(source).toBeDefined();
      expect(source.provider).toBe('github');
      expect(source.kind).toBe('issue');
      expect(source.id).toBe('8');
    });
  });

  it('ignores non-object status and pullRequest values', async () => {
    await withTempDir(async (dataDir) => {
      const stateDir = path.join(dataDir, 'issues', 'owner', 'repo', '9');
      await fs.mkdir(stateDir, { recursive: true });

      await fs.writeFile(
        path.join(stateDir, 'issue.json'),
        JSON.stringify(
          {
            repo: 'owner/repo',
            issue: { number: 9, repo: 'owner/repo' },
            branch: 'issue/9',
            notes: '',
            status: 'invalid',
            pullRequest: [1, 2, 3],
          },
          null,
          2,
        ),
      );

      const loaded = await loadIssueStateFromPath(stateDir);
      expect(loaded.status).toBeUndefined();
      expect(loaded.pullRequest).toBeUndefined();
    });
  });
});
