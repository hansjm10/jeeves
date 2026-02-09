import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  appendProgressEvent,
  deleteMemoryEntryFromDb,
  listMemoryEntriesFromDb,
  markMemoryEntryStaleInDb,
  type MemoryEntry,
  type MemoryScope,
  readIssueFromDb,
  readTasksFromDb,
  upsertMemoryEntryInDb,
  writeIssueToDb,
  writeTasksToDb,
} from '@jeeves/state-db';

type JsonRecord = Record<string, unknown>;

function ensureObjectField(root: JsonRecord, key: string): JsonRecord {
  const existing = root[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as JsonRecord;
  }
  const next: JsonRecord = {};
  root[key] = next;
  return next;
}

export async function getIssue(stateDir: string): Promise<JsonRecord | null> {
  return readIssueFromDb(stateDir);
}

export async function putIssue(stateDir: string, issue: JsonRecord): Promise<void> {
  writeIssueToDb(stateDir, issue);
}

export async function getTasks(stateDir: string): Promise<JsonRecord | null> {
  return readTasksFromDb(stateDir);
}

export async function putTasks(stateDir: string, tasks: JsonRecord): Promise<void> {
  writeTasksToDb(stateDir, tasks);
}

export async function updateIssueStatusFields(stateDir: string, fields: JsonRecord): Promise<boolean> {
  const issue = (await getIssue(stateDir)) ?? {};
  const status = ensureObjectField(issue, 'status');
  let changed = false;
  for (const [key, value] of Object.entries(fields)) {
    if (status[key] !== value) changed = true;
    status[key] = value;
  }
  if (!changed) return false;
  await putIssue(stateDir, issue);
  return true;
}

export async function updateIssueControlFields(stateDir: string, fields: JsonRecord): Promise<boolean> {
  const issue = (await getIssue(stateDir)) ?? {};
  const control = ensureObjectField(issue, 'control');
  let changed = false;
  for (const [key, value] of Object.entries(fields)) {
    if (control[key] !== value) changed = true;
    control[key] = value;
  }
  if (!changed) return false;
  await putIssue(stateDir, issue);
  return true;
}

export async function setTaskStatus(stateDir: string, taskId: string, status: string): Promise<boolean> {
  const tasksDoc = await getTasks(stateDir);
  if (!tasksDoc) return false;
  const tasks = tasksDoc.tasks;
  if (!Array.isArray(tasks)) return false;

  let changed = false;
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
    const record = task as JsonRecord;
    if (record.id !== taskId) continue;
    if (record.status !== status) {
      record.status = status;
      changed = true;
    }
  }

  if (!changed) return false;
  await putTasks(stateDir, tasksDoc);
  return true;
}

export async function appendProgress(stateDir: string, entry: string): Promise<void> {
  appendProgressEvent({
    stateDir,
    source: 'mcp-state',
    message: entry,
  });
  const progressPath = path.join(stateDir, 'progress.txt');
  await fsp.mkdir(path.dirname(progressPath), { recursive: true });
  await fsp.appendFile(progressPath, entry, 'utf-8');
}

export async function getMemory(
  stateDir: string,
  options: {
    scope?: MemoryScope;
    key?: string;
    includeStale?: boolean;
    limit?: number;
  } = {},
): Promise<readonly MemoryEntry[]> {
  return listMemoryEntriesFromDb({
    stateDir,
    scope: options.scope,
    key: options.key,
    includeStale: options.includeStale,
    limit: options.limit,
  });
}

export async function upsertMemory(
  stateDir: string,
  params: {
    scope: MemoryScope;
    key: string;
    value: JsonRecord;
    sourceIteration?: number | null;
    stale?: boolean;
  },
): Promise<MemoryEntry> {
  return upsertMemoryEntryInDb({
    stateDir,
    scope: params.scope,
    key: params.key,
    value: params.value,
    sourceIteration: params.sourceIteration,
    stale: params.stale,
  });
}

export async function markMemoryStale(
  stateDir: string,
  scope: MemoryScope,
  key: string,
  stale = true,
): Promise<boolean> {
  return markMemoryEntryStaleInDb({ stateDir, scope, key, stale });
}

export async function deleteMemory(stateDir: string, scope: MemoryScope, key: string): Promise<boolean> {
  return deleteMemoryEntryFromDb({ stateDir, scope, key });
}
