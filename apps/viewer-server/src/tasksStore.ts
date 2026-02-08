import fs from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from './jsonAtomic.js';
import { readTaskCountFromDb, readTasksFromDb, writeTasksToDb } from './sqliteStorage.js';

export async function readTasksJson(stateDir: string): Promise<Record<string, unknown> | null> {
  const fromDb = readTasksFromDb(stateDir);
  if (fromDb) return fromDb;

  const tasksPath = path.join(stateDir, 'tasks.json');
  const raw = await fs.readFile(tasksPath, 'utf-8').catch(() => null);
  if (!raw || !raw.trim()) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const tasksJson = parsed as Record<string, unknown>;
      writeTasksToDb(stateDir, tasksJson);
      return tasksJson;
    }
  } catch {
    // ignore
  }

  return null;
}

export async function writeTasksJson(stateDir: string, data: Record<string, unknown>): Promise<void> {
  writeTasksToDb(stateDir, data);
  await writeJsonAtomic(path.join(stateDir, 'tasks.json'), data);
}

export async function readTaskCount(stateDir: string): Promise<number | null> {
  const fromDb = readTaskCountFromDb(stateDir);
  if (fromDb !== null) return fromDb;

  const tasks = await readTasksJson(stateDir);
  if (!tasks) return null;
  return Array.isArray(tasks.tasks) ? tasks.tasks.length : null;
}
