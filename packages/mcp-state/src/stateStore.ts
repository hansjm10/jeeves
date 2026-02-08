import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  readIssueFromDb,
  readIssueUpdatedAtMs,
  readTasksFromDb,
  writeIssueToDb,
  writeTasksToDb,
} from '@jeeves/state-db';

type JsonRecord = Record<string, unknown>;

function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseJsonRecord(raw: string): JsonRecord | null {
  const parsed = tryParseJson(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as JsonRecord)
    : null;
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  await fsp.rename(tmp, filePath);
}

async function readJsonRecordFile(filePath: string): Promise<JsonRecord | null> {
  const raw = await fsp.readFile(filePath, 'utf-8').catch(() => null);
  if (!raw || !raw.trim()) return null;
  return parseJsonRecord(raw);
}

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
  const issuePath = path.join(stateDir, 'issue.json');
  const fileStat = await fsp.stat(issuePath).catch(() => null);
  const fromDb = readIssueFromDb(stateDir);
  const fromDbUpdatedAtMs = readIssueUpdatedAtMs(stateDir);
  if (fromDb && (!fileStat || !fileStat.isFile() || fileStat.mtimeMs <= fromDbUpdatedAtMs)) {
    return fromDb;
  }

  const fromFile = await readJsonRecordFile(issuePath);
  if (fromFile) {
    writeIssueToDb(stateDir, fromFile);
    return fromFile;
  }

  return fromDb ?? null;
}

export async function putIssue(stateDir: string, issue: JsonRecord): Promise<void> {
  writeIssueToDb(stateDir, issue);
  await writeJsonAtomic(path.join(stateDir, 'issue.json'), issue);
}

export async function getTasks(stateDir: string): Promise<JsonRecord | null> {
  const fromDb = readTasksFromDb(stateDir);
  if (fromDb) return fromDb;

  const tasksPath = path.join(stateDir, 'tasks.json');
  const fromFile = await readJsonRecordFile(tasksPath);
  if (!fromFile) return null;
  writeTasksToDb(stateDir, fromFile);
  return fromFile;
}

export async function putTasks(stateDir: string, tasks: JsonRecord): Promise<void> {
  writeTasksToDb(stateDir, tasks);
  await writeJsonAtomic(path.join(stateDir, 'tasks.json'), tasks);
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
  const progressPath = path.join(stateDir, 'progress.txt');
  await fsp.mkdir(path.dirname(progressPath), { recursive: true });
  await fsp.appendFile(progressPath, entry, 'utf-8');
}
