import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createIssueState, listIssueStates, loadIssueStateFromPath } from './issueState';

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
      await expect(fs.stat(path.join(dataDir, 'issues', 'o', 'r', '38', 'progress.txt'))).resolves.toBeDefined();
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
});
