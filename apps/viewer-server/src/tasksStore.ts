import { readTaskCountFromDb, readTasksFromDb, writeTasksToDb } from './sqliteStorage.js';

export async function readTasksJson(stateDir: string): Promise<Record<string, unknown> | null> {
  return readTasksFromDb(stateDir);
}

export async function writeTasksJson(stateDir: string, data: Record<string, unknown>): Promise<void> {
  writeTasksToDb(stateDir, data);
}

export async function readTaskCount(stateDir: string): Promise<number | null> {
  const fromDb = readTaskCountFromDb(stateDir);
  if (fromDb !== null) return fromDb;

  const tasks = await readTasksJson(stateDir);
  if (!tasks) return null;
  return Array.isArray(tasks.tasks) ? tasks.tasks.length : null;
}
