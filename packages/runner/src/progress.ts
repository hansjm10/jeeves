import fs from 'node:fs/promises';
import path from 'node:path';

function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureProgressFile(progressPath: string): Promise<void> {
  await fs.mkdir(path.dirname(progressPath), { recursive: true });
  const exists = await fs
    .stat(progressPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await fs.writeFile(progressPath, '', 'utf-8');
  }
}

export async function appendProgress(progressPath: string, line: string): Promise<void> {
  await ensureProgressFile(progressPath);
  await fs.appendFile(progressPath, `${line}\n`, 'utf-8');
}

export async function markStarted(progressPath: string): Promise<void> {
  await appendProgress(progressPath, `Started: ${nowIso()}`);
}

export async function markPhase(progressPath: string, phase: string): Promise<void> {
  await appendProgress(progressPath, `Phase: ${phase}`);
}

export async function markEnded(progressPath: string, success: boolean): Promise<void> {
  await appendProgress(progressPath, `Ended: ${nowIso()} Success: ${success}`);
}

