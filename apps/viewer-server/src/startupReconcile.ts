import fs from 'node:fs/promises';
import path from 'node:path';

import {
  reconcilePromptsFromFiles,
  reconcileWorkflowsFromFiles,
} from './contentStore.js';
import {
  isBootstrapComplete,
  markBootstrapComplete,
  readIssueFromDb,
  readTasksFromDb,
  saveActiveIssueToDb,
  writeIssueToDb,
  writeTasksToDb,
} from './sqliteStorage.js';

export type StartupReconcileSummary = Readonly<{
  promptsSynced: number;
  workflowsSynced: number;
  issueSynced: boolean;
  tasksSynced: boolean;
  bootstrapRan: boolean;
  bootstrapIssuesImported: number;
  bootstrapTasksImported: number;
  bootstrapActiveIssueImported: boolean;
}>;

const STARTUP_BOOTSTRAP_VERSION = 'state-db-v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await fs.readFile(filePath, 'utf-8').catch(() => null);
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function listLegacyStateDirs(dataDir: string): Promise<string[]> {
  const issuesRoot = path.join(path.resolve(dataDir), 'issues');
  const owners = await fs.readdir(issuesRoot, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];

  for (const owner of owners) {
    if (!owner.isDirectory() || owner.isSymbolicLink()) continue;
    const ownerDir = path.join(issuesRoot, owner.name);
    const repos = await fs.readdir(ownerDir, { withFileTypes: true }).catch(() => []);
    for (const repo of repos) {
      if (!repo.isDirectory() || repo.isSymbolicLink()) continue;
      const repoDir = path.join(ownerDir, repo.name);
      const issues = await fs.readdir(repoDir, { withFileTypes: true }).catch(() => []);
      for (const issue of issues) {
        if (!issue.isDirectory() || issue.isSymbolicLink()) continue;
        if (!/^\d+$/.test(issue.name)) continue;
        out.push(path.join(repoDir, issue.name));
      }
    }
  }

  return out;
}

async function bootstrapLegacyState(dataDir: string): Promise<{
  ran: boolean;
  issuesImported: number;
  tasksImported: number;
  activeIssueImported: boolean;
}> {
  if (isBootstrapComplete(dataDir)) {
    return {
      ran: false,
      issuesImported: 0,
      tasksImported: 0,
      activeIssueImported: false,
    };
  }

  let issuesImported = 0;
  let tasksImported = 0;
  let activeIssueImported = false;

  const stateDirs = await listLegacyStateDirs(dataDir);
  for (const stateDir of stateDirs) {
    const issueDoc = await readJsonRecord(path.join(stateDir, 'issue.json'));
    if (issueDoc) {
      try {
        writeIssueToDb(stateDir, issueDoc);
        issuesImported += 1;
      } catch {
        // Ignore bad legacy entries; continue importing the rest.
      }
    }

    const tasksDoc = await readJsonRecord(path.join(stateDir, 'tasks.json'));
    if (tasksDoc) {
      try {
        writeTasksToDb(stateDir, tasksDoc);
        tasksImported += 1;
      } catch {
        // Ignore bad legacy entries; continue importing the rest.
      }
    }
  }

  const activeIssue = await readJsonRecord(path.join(path.resolve(dataDir), 'active-issue.json'));
  const issueRefRaw = activeIssue?.issue_ref;
  const issueRef = typeof issueRefRaw === 'string' ? issueRefRaw.trim() : '';
  if (issueRef) {
    const savedAtRaw = activeIssue?.saved_at;
    const savedAt = typeof savedAtRaw === 'string' && savedAtRaw.trim().length > 0
      ? savedAtRaw.trim()
      : new Date().toISOString();
    try {
      saveActiveIssueToDb(dataDir, issueRef, savedAt);
      activeIssueImported = true;
    } catch {
      // Ignore invalid active issue payload and continue startup.
    }
  }

  markBootstrapComplete(dataDir, STARTUP_BOOTSTRAP_VERSION);

  return {
    ran: true,
    issuesImported,
    tasksImported,
    activeIssueImported,
  };
}

export async function reconcileStartupState(params: {
  dataDir: string;
  promptsDir: string;
  workflowsDir: string;
  selectedStateDir: string | null;
}): Promise<StartupReconcileSummary> {
  const promptsSynced = await reconcilePromptsFromFiles(params.dataDir, params.promptsDir);
  const workflowsSynced = await reconcileWorkflowsFromFiles(params.dataDir, params.workflowsDir);
  const bootstrap = await bootstrapLegacyState(params.dataDir);

  let issueSynced = false;
  let tasksSynced = false;
  if (params.selectedStateDir) {
    issueSynced = readIssueFromDb(params.selectedStateDir) !== null;
    tasksSynced = readTasksFromDb(params.selectedStateDir) !== null;
  }

  return {
    promptsSynced,
    workflowsSynced,
    issueSynced,
    tasksSynced,
    bootstrapRan: bootstrap.ran,
    bootstrapIssuesImported: bootstrap.issuesImported,
    bootstrapTasksImported: bootstrap.tasksImported,
    bootstrapActiveIssueImported: bootstrap.activeIssueImported,
  };
}
