import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isBootstrapComplete,
  loadActiveIssueFromDb,
  readIssueFromDb,
  readTasksFromDb,
} from './sqliteStorage.js';
import { reconcileStartupState } from './startupReconcile.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('startupReconcile', () => {
  it('imports legacy issue/tasks/active issue files on first startup bootstrap', async () => {
    const dataDir = await makeTempDir('jeeves-startup-reconcile-data-');
    const promptsDir = await makeTempDir('jeeves-startup-reconcile-prompts-');
    const workflowsDir = await makeTempDir('jeeves-startup-reconcile-workflows-');
    const stateDir = path.join(dataDir, 'issues', 'acme', 'rocket', '42');
    await fs.mkdir(stateDir, { recursive: true });

    await fs.writeFile(path.join(promptsDir, 'issue.implement.md'), 'Implement prompt\n', 'utf-8');
    await fs.writeFile(path.join(workflowsDir, 'default.yaml'), 'workflow: {}\nphases: {}\n', 'utf-8');

    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({
        repo: 'acme/rocket',
        issue: { number: 42, title: 'Legacy issue' },
        phase: 'design',
        workflow: 'default',
        branch: 'issue/42',
      }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(stateDir, 'tasks.json'),
      JSON.stringify({
        schemaVersion: 1,
        tasks: [{ id: 'T1', title: 'Task 1', status: 'pending' }],
      }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(dataDir, 'active-issue.json'),
      JSON.stringify({
        issue_ref: 'acme/rocket#42',
        saved_at: '2026-02-01T00:00:00.000Z',
      }),
      'utf-8',
    );

    const summary = await reconcileStartupState({
      dataDir,
      promptsDir,
      workflowsDir,
      selectedStateDir: stateDir,
    });

    expect(summary.promptsSynced).toBe(1);
    expect(summary.workflowsSynced).toBe(1);
    expect(summary.bootstrapRan).toBe(true);
    expect(summary.bootstrapIssuesImported).toBe(1);
    expect(summary.bootstrapTasksImported).toBe(1);
    expect(summary.bootstrapActiveIssueImported).toBe(true);
    expect(summary.issueSynced).toBe(true);
    expect(summary.tasksSynced).toBe(true);

    expect(readIssueFromDb(stateDir)).not.toBeNull();
    expect(readTasksFromDb(stateDir)).not.toBeNull();
    expect(loadActiveIssueFromDb(dataDir)).toBe('acme/rocket#42');
    expect(isBootstrapComplete(dataDir)).toBe(true);
  });

  it('runs legacy bootstrap only once and skips newly added legacy files after marker is set', async () => {
    const dataDir = await makeTempDir('jeeves-startup-reconcile-once-data-');
    const promptsDir = await makeTempDir('jeeves-startup-reconcile-once-prompts-');
    const workflowsDir = await makeTempDir('jeeves-startup-reconcile-once-workflows-');
    await fs.writeFile(path.join(promptsDir, 'issue.design.md'), 'Design prompt\n', 'utf-8');
    await fs.writeFile(path.join(workflowsDir, 'default.yaml'), 'workflow: {}\nphases: {}\n', 'utf-8');

    const firstStateDir = path.join(dataDir, 'issues', 'acme', 'rocket', '41');
    await fs.mkdir(firstStateDir, { recursive: true });
    await fs.writeFile(
      path.join(firstStateDir, 'issue.json'),
      JSON.stringify({ repo: 'acme/rocket', issue: { number: 41 }, workflow: 'default', phase: 'design' }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(firstStateDir, 'tasks.json'),
      JSON.stringify({ schemaVersion: 1, tasks: [{ id: 'T1', title: 'Task', status: 'pending' }] }),
      'utf-8',
    );

    const firstSummary = await reconcileStartupState({
      dataDir,
      promptsDir,
      workflowsDir,
      selectedStateDir: firstStateDir,
    });
    expect(firstSummary.bootstrapRan).toBe(true);
    expect(firstSummary.bootstrapIssuesImported).toBe(1);
    expect(firstSummary.bootstrapTasksImported).toBe(1);

    const secondStateDir = path.join(dataDir, 'issues', 'acme', 'rocket', '99');
    await fs.mkdir(secondStateDir, { recursive: true });
    await fs.writeFile(
      path.join(secondStateDir, 'issue.json'),
      JSON.stringify({ repo: 'acme/rocket', issue: { number: 99 }, workflow: 'default', phase: 'design' }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(secondStateDir, 'tasks.json'),
      JSON.stringify({ schemaVersion: 1, tasks: [{ id: 'T99', title: 'Task 99', status: 'pending' }] }),
      'utf-8',
    );

    const secondSummary = await reconcileStartupState({
      dataDir,
      promptsDir,
      workflowsDir,
      selectedStateDir: secondStateDir,
    });
    expect(secondSummary.bootstrapRan).toBe(false);
    expect(secondSummary.bootstrapIssuesImported).toBe(0);
    expect(secondSummary.bootstrapTasksImported).toBe(0);
    expect(secondSummary.bootstrapActiveIssueImported).toBe(false);
    expect(secondSummary.issueSynced).toBe(false);
    expect(secondSummary.tasksSynced).toBe(false);
    expect(readIssueFromDb(secondStateDir)).toBeNull();
    expect(readTasksFromDb(secondStateDir)).toBeNull();
  });
});
