import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  appendProgress,
  getIssue,
  getTasks,
  putIssue,
  putTasks,
  setTaskStatus,
  updateIssueControlFields,
  updateIssueStatusFields,
} from './stateStore.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function dbPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'jeeves.db');
}

describe('mcp-state store', () => {
  it('persists issue JSON to file and normalized DB', async () => {
    const dataDir = await makeTempDir('jeeves-mcp-state-');
    const stateDir = path.join(dataDir, 'issues', 'acme', 'rocket', '15');
    await fs.mkdir(stateDir, { recursive: true });

    await putIssue(stateDir, {
      repo: 'acme/rocket',
      issue: { number: 15, title: 'Add feature' },
      phase: 'task_decomposition',
      status: { currentTaskId: 'T1' },
    });

    const reloaded = await getIssue(stateDir);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.repo).toBe('acme/rocket');
    expect((reloaded?.status as { currentTaskId?: string })?.currentTaskId).toBe('T1');

    const db = new Database(dbPath(dataDir), { readonly: true });
    try {
      const repoCount = db.prepare('SELECT COUNT(*) as count FROM repositories').get() as { count: number };
      const issueCount = db.prepare('SELECT COUNT(*) as count FROM repository_issues').get() as { count: number };
      const payload = db
        .prepare('SELECT payload_json FROM issue_state_payload WHERE state_dir = ?')
        .get(path.resolve(stateDir)) as { payload_json: string } | undefined;
      expect(repoCount.count).toBe(1);
      expect(issueCount.count).toBe(1);
      expect(payload).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('updates task status and issue status/control fields', async () => {
    const dataDir = await makeTempDir('jeeves-mcp-state-tasks-');
    const stateDir = path.join(dataDir, 'issues', 'acme', 'rocket', '88');
    await fs.mkdir(stateDir, { recursive: true });

    await putIssue(stateDir, {
      repo: 'acme/rocket',
      issue: { number: 88, title: 'Task flow' },
      status: { currentTaskId: 'T1' },
    });
    await putTasks(stateDir, {
      schemaVersion: 1,
      tasks: [
        { id: 'T1', status: 'pending', title: 'one' },
        { id: 'T2', status: 'pending', title: 'two' },
      ],
    });

    expect(await setTaskStatus(stateDir, 'T1', 'in_progress')).toBe(true);
    expect(await updateIssueStatusFields(stateDir, { taskPassed: false, taskFailed: true })).toBe(true);
    expect(await updateIssueControlFields(stateDir, { restartPhase: true })).toBe(true);

    const tasks = await getTasks(stateDir);
    const issue = await getIssue(stateDir);
    expect(((tasks?.tasks as { id: string; status: string }[])[0])?.status).toBe('in_progress');
    expect((issue?.status as { taskFailed?: boolean })?.taskFailed).toBe(true);
    expect((issue?.control as { restartPhase?: boolean })?.restartPhase).toBe(true);
  });

  it('appends progress text', async () => {
    const dataDir = await makeTempDir('jeeves-mcp-state-progress-');
    const stateDir = path.join(dataDir, 'issues', 'acme', 'rocket', '99');
    await fs.mkdir(stateDir, { recursive: true });

    await appendProgress(stateDir, 'line-one\n');
    await appendProgress(stateDir, 'line-two\n');

    const raw = await fs.readFile(path.join(stateDir, 'progress.txt'), 'utf-8');
    expect(raw).toBe('line-one\nline-two\n');
  });
});
