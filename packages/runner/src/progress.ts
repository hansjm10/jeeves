import fs from 'node:fs/promises';
import path from 'node:path';

import { appendProgressEvent } from '@jeeves/state-db';

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
  const stateDir = path.dirname(progressPath);
  const trimmed = line.trim();
  appendProgressEvent({
    stateDir,
    source: 'runner',
    phase: trimmed.startsWith('Phase: ') ? trimmed.slice('Phase: '.length).trim() : null,
    message: line,
  });
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
