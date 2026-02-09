import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  deleteMemoryEntryFromDb,
  listMemoryEntriesFromDb,
  markMemoryEntryStaleInDb,
  readIssueFromDb,
  readMemoryEntryFromDb,
  upsertMemoryEntriesInDb,
  upsertMemoryEntryInDb,
  writeIssueToDb,
} from './index.js';

async function makeStateDir(prefix: string): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(dataDir, 'issues', 'acme', 'rocket', '112');
  await fs.mkdir(stateDir, { recursive: true });
  return stateDir;
}

function dataDirFromStateDir(stateDir: string): string {
  return path.resolve(stateDir, '..', '..', '..', '..');
}

describe('state-db memory entries', () => {
  it('supports bulk upsert in a single call', async () => {
    const stateDir = await makeStateDir('jeeves-state-db-memory-bulk-');

    upsertMemoryEntriesInDb({
      stateDir,
      entries: [
        {
          scope: 'session',
          key: 'implement_task:a',
          value: { phase: 'implement_task', note: 'a' },
          sourceIteration: 1,
        },
        {
          scope: 'session',
          key: 'implement_task:b',
          value: { phase: 'implement_task', note: 'b' },
          sourceIteration: 2,
        },
        {
          scope: 'cross_run',
          key: 'implement_task:carry',
          value: { relevantPhases: ['implement_task'] },
          sourceIteration: 3,
        },
      ],
    });

    expect(listMemoryEntriesFromDb({ stateDir, scope: 'session', limit: null }).map((entry) => entry.key)).toEqual([
      'implement_task:a',
      'implement_task:b',
    ]);
    expect(listMemoryEntriesFromDb({ stateDir, scope: 'cross_run', limit: null }).map((entry) => entry.key)).toEqual([
      'implement_task:carry',
    ]);
  });

  it('supports disabling the default cap with limit=null', async () => {
    const stateDir = await makeStateDir('jeeves-state-db-memory-limit-');

    upsertMemoryEntryInDb({
      stateDir,
      scope: 'session',
      key: 'a',
      value: { phase: 'implement_task' },
      sourceIteration: 1,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'session',
      key: 'b',
      value: { phase: 'implement_task' },
      sourceIteration: 1,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'session',
      key: 'c',
      value: { phase: 'implement_task' },
      sourceIteration: 1,
    });

    expect(listMemoryEntriesFromDb({ stateDir, scope: 'session', limit: 2 })).toHaveLength(2);
    expect(listMemoryEntriesFromDb({ stateDir, scope: 'session', limit: null })).toHaveLength(3);
  });

  it('supports query by scope and key and lists entries in deterministic scope order', async () => {
    const stateDir = await makeStateDir('jeeves-state-db-memory-');

    upsertMemoryEntryInDb({
      stateDir,
      scope: 'working_set',
      key: 'current-task',
      value: { taskId: 'T1' },
      sourceIteration: 2,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'decisions',
      key: 'runtime-policy',
      value: { mode: 'strict' },
      sourceIteration: 2,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'session',
      key: 'implement_task:focus',
      value: { phase: 'implement_task', focus: 'memory wiring' },
      sourceIteration: 3,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'cross_run',
      key: 'design_classify:hint',
      value: { phaseNames: ['design_classify'], note: 'carry issue hierarchy' },
      sourceIteration: 1,
    });

    const decision = readMemoryEntryFromDb({
      stateDir,
      scope: 'decisions',
      key: 'runtime-policy',
    });
    expect(decision).not.toBeNull();
    expect(decision?.value).toEqual({ mode: 'strict' });

    const allEntries = listMemoryEntriesFromDb({ stateDir });
    expect(allEntries.map((entry) => `${entry.scope}:${entry.key}`)).toEqual([
      'working_set:current-task',
      'decisions:runtime-policy',
      'session:implement_task:focus',
      'cross_run:design_classify:hint',
    ]);
  });

  it('supports stale marking and clean replacement for the same key', async () => {
    const stateDir = await makeStateDir('jeeves-state-db-memory-stale-');

    upsertMemoryEntryInDb({
      stateDir,
      scope: 'decisions',
      key: 'schema-choice',
      value: { version: 'v1' },
      sourceIteration: 4,
    });

    expect(
      markMemoryEntryStaleInDb({
        stateDir,
        scope: 'decisions',
        key: 'schema-choice',
      }),
    ).toBe(true);

    expect(listMemoryEntriesFromDb({ stateDir, scope: 'decisions' })).toHaveLength(0);
    const staleRows = listMemoryEntriesFromDb({
      stateDir,
      scope: 'decisions',
      includeStale: true,
    });
    expect(staleRows).toHaveLength(1);
    expect(staleRows[0]?.stale).toBe(true);

    upsertMemoryEntryInDb({
      stateDir,
      scope: 'decisions',
      key: 'schema-choice',
      value: { version: 'v2' },
      sourceIteration: 5,
    });

    const replaced = readMemoryEntryFromDb({
      stateDir,
      scope: 'decisions',
      key: 'schema-choice',
    });
    expect(replaced?.stale).toBe(false);
    expect(replaced?.sourceIteration).toBe(5);
    expect(replaced?.value).toEqual({ version: 'v2' });
  });

  it('supports deleting entries by scope and key', async () => {
    const stateDir = await makeStateDir('jeeves-state-db-memory-delete-');

    upsertMemoryEntryInDb({
      stateDir,
      scope: 'cross_run',
      key: 'implement_task:lint-reminder',
      value: { phase: 'implement_task', reminder: 'run lint first' },
      sourceIteration: 1,
    });

    expect(
      deleteMemoryEntryFromDb({
        stateDir,
        scope: 'cross_run',
        key: 'implement_task:lint-reminder',
      }),
    ).toBe(true);
    expect(
      deleteMemoryEntryFromDb({
        stateDir,
        scope: 'cross_run',
        key: 'implement_task:lint-reminder',
      }),
    ).toBe(false);

    const entry = readMemoryEntryFromDb({
      stateDir,
      scope: 'cross_run',
      key: 'implement_task:lint-reminder',
    });
    expect(entry).toBeNull();
  });

  it('recreates memory table on legacy DBs without losing existing issue payloads', async () => {
    const stateDir = await makeStateDir('jeeves-state-db-memory-migration-');
    const dataDir = dataDirFromStateDir(stateDir);
    const dbPath = path.join(dataDir, 'jeeves.db');

    writeIssueToDb(stateDir, {
      repo: 'acme/rocket',
      issue: { number: 112, title: 'legacy memory migration test' },
      phase: 'implement_task',
      status: { currentTaskId: 'T1' },
    });

    const db = new Database(dbPath);
    try {
      db.prepare('DROP TABLE IF EXISTS issue_memory').run();
      const before = db
        .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = 'issue_memory'")
        .get() as { count: number };
      expect(before.count).toBe(0);
    } finally {
      db.close();
    }

    const restoredIssue = readIssueFromDb(stateDir);
    expect(restoredIssue).not.toBeNull();
    expect((restoredIssue?.status as { currentTaskId?: string } | undefined)?.currentTaskId).toBe('T1');

    upsertMemoryEntryInDb({
      stateDir,
      scope: 'working_set',
      key: 'current-task',
      value: { taskId: 'T1' },
      sourceIteration: 1,
    });

    const afterDb = new Database(dbPath, { readonly: true });
    try {
      const after = afterDb
        .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = 'issue_memory'")
        .get() as { count: number };
      expect(after.count).toBe(1);
    } finally {
      afterDb.close();
    }

    const memory = readMemoryEntryFromDb({
      stateDir,
      scope: 'working_set',
      key: 'current-task',
    });
    expect(memory).not.toBeNull();
    expect(memory?.value).toEqual({ taskId: 'T1' });
  });
});
