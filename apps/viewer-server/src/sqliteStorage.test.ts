import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  listIssuesFromDb,
  readIssueFromDb,
  readTaskCountFromDb,
  readTasksFromDb,
  writeIssueToDb,
  writeTasksToDb,
} from './sqliteStorage.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function dbPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'jeeves.db');
}

describe('sqliteStorage normalized schema', () => {
  it('normalizes repositories and repository issues while preserving issue payload reads', async () => {
    const dataDir = await makeTempDir('jeeves-sqlite-storage-');

    const stateDir1 = path.join(dataDir, 'issues', 'acme', 'rocket', '101');
    const stateDir2 = path.join(dataDir, 'issues', 'acme', 'rocket', '102');
    await fs.mkdir(stateDir1, { recursive: true });
    await fs.mkdir(stateDir2, { recursive: true });

    writeIssueToDb(stateDir1, {
      repo: 'acme/rocket',
      issue: { number: 101, title: 'Fix alpha' },
      branch: 'issue-101',
      phase: 'design',
      workflow: 'default',
      status: { ok: true },
    });
    writeIssueToDb(stateDir2, {
      repo: 'acme/rocket',
      issue: { number: 102, title: 'Fix beta' },
      branch: 'issue-102',
      phase: 'implement',
      workflow: 'default',
      status: { ok: true },
    });

    const listed = listIssuesFromDb(dataDir);
    expect(listed).toHaveLength(2);
    expect(listed.map((row) => row.issueNumber)).toEqual([101, 102]);
    expect(listed.map((row) => row.owner)).toEqual(['acme', 'acme']);
    expect(listed.map((row) => row.repo)).toEqual(['rocket', 'rocket']);

    const reloaded = readIssueFromDb(stateDir1);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.repo).toBe('acme/rocket');
    expect((reloaded?.issue as { number?: number })?.number).toBe(101);
    expect((reloaded?.status as { ok?: boolean })?.ok).toBe(true);

    const db = new Database(dbPath(dataDir), { readonly: true });
    try {
      const repoCount = db.prepare('SELECT COUNT(*) AS count FROM repositories').get() as { count: number };
      const issueCount = db.prepare('SELECT COUNT(*) AS count FROM repository_issues').get() as { count: number };
      const stateCount = db.prepare('SELECT COUNT(*) AS count FROM issue_state_core').get() as { count: number };
      expect(repoCount.count).toBe(1);
      expect(issueCount.count).toBe(2);
      expect(stateCount.count).toBe(2);
    } finally {
      db.close();
    }
  });

  it('normalizes tasks and dependencies and reconstructs task JSON', async () => {
    const dataDir = await makeTempDir('jeeves-sqlite-tasks-');
    const stateDir = path.join(dataDir, 'issues', 'acme', 'rocket', '200');
    await fs.mkdir(stateDir, { recursive: true });

    writeTasksToDb(stateDir, {
      schemaVersion: 1,
      tasks: [
        {
          id: 'T1',
          title: 'A',
          summary: 'a',
          status: 'pending',
          dependsOn: ['ROOT'],
          acceptanceCriteria: ['x'],
        },
        {
          id: 'T2',
          title: 'B',
          summary: 'b',
          status: 'failed',
          dependsOn: ['T1', 'T1'],
          acceptanceCriteria: ['y'],
        },
      ],
      extra: { note: 'keep-me' },
    });

    expect(readTaskCountFromDb(stateDir)).toBe(2);

    const reloaded = readTasksFromDb(stateDir);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.schemaVersion).toBe(1);
    expect((reloaded?.extra as { note?: string })?.note).toBe('keep-me');
    const tasks = reloaded?.tasks as { id: string; dependsOn?: string[] }[];
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.id)).toEqual(['T1', 'T2']);
    expect(tasks[1]?.dependsOn).toEqual(['T1', 'T1']);

    const db = new Database(dbPath(dataDir), { readonly: true });
    try {
      const listRow = db
        .prepare('SELECT tasks_split, task_count FROM issue_task_lists WHERE state_dir = ?')
        .get(path.resolve(stateDir)) as { tasks_split: number; task_count: number };
      expect(listRow.tasks_split).toBe(1);
      expect(listRow.task_count).toBe(2);

      const itemRows = db
        .prepare('SELECT task_index, task_id, status FROM issue_task_items WHERE state_dir = ? ORDER BY task_index ASC')
        .all(path.resolve(stateDir)) as { task_index: number; task_id: string; status: string }[];
      expect(itemRows).toEqual([
        { task_index: 0, task_id: 'T1', status: 'pending' },
        { task_index: 1, task_id: 'T2', status: 'failed' },
      ]);

      const depRows = db
        .prepare(
          `
          SELECT task_index, depends_on_task_id
          FROM issue_task_dependencies
          WHERE state_dir = ?
          ORDER BY task_index ASC, depends_on_task_id ASC
          `,
        )
        .all(path.resolve(stateDir)) as { task_index: number; depends_on_task_id: string }[];
      expect(depRows).toEqual([
        { task_index: 0, depends_on_task_id: 'ROOT' },
        { task_index: 1, depends_on_task_id: 'T1' },
      ]);
    } finally {
      db.close();
    }
  });
});
