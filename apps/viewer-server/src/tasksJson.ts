import fs from 'node:fs/promises';
import path from 'node:path';

import { expandFilesAllowedForTests } from '@jeeves/core';

import { writeJsonAtomic } from './jsonAtomic.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Post-processes `.jeeves/tasks.json` to auto-expand `filesAllowed` with common test-file variants.
 *
 * This makes the behavior deterministic (not prompt-dependent) and reduces task retries due to
 * accidental test edits that would otherwise fail `task_spec_check`.
 */
export async function expandTasksFilesAllowedForTests(stateDir: string): Promise<boolean> {
  const tasksPath = path.join(stateDir, 'tasks.json');
  const raw = await fs.readFile(tasksPath, 'utf-8').catch(() => null);
  if (!raw) return false;

  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }

  if (!isPlainObject(json)) return false;
  const tasks = json.tasks;
  if (!Array.isArray(tasks)) return false;

  let changed = false;
  for (const task of tasks) {
    if (!isPlainObject(task)) continue;
    const filesAllowed = task.filesAllowed;
    if (!isStringArray(filesAllowed)) continue;

    const expanded = expandFilesAllowedForTests(filesAllowed);
    if (!arraysEqual(filesAllowed, expanded)) {
      task.filesAllowed = expanded;
      changed = true;
    }
  }

  if (!changed) return false;
  await writeJsonAtomic(tasksPath, json);
  return true;
}

