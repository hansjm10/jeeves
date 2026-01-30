import fs from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from './jsonAtomic.js';

export async function readIssueJson(stateDir: string): Promise<Record<string, unknown> | null> {
  const issuePath = path.join(stateDir, 'issue.json');
  const raw = await fs
    .readFile(issuePath, 'utf-8')
    .catch(() => null);
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // ignore
  }
  return null;
}

export async function writeIssueJson(stateDir: string, data: Record<string, unknown>): Promise<void> {
  const issuePath = path.join(stateDir, 'issue.json');
  await writeJsonAtomic(issuePath, data);
}

