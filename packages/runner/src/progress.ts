import { appendProgressEvent } from '@jeeves/state-db';

function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureProgressFile(_stateDir: string): Promise<void> {
  void _stateDir;
}

export async function appendProgress(stateDir: string, line: string): Promise<void> {
  await ensureProgressFile(stateDir);
  const trimmed = line.trim();
  appendProgressEvent({
    stateDir,
    source: 'runner',
    phase: trimmed.startsWith('Phase: ') ? trimmed.slice('Phase: '.length).trim() : null,
    message: line,
  });
}

export async function markStarted(stateDir: string): Promise<void> {
  await appendProgress(stateDir, `Started: ${nowIso()}`);
}

export async function markPhase(stateDir: string, phase: string): Promise<void> {
  await appendProgress(stateDir, `Phase: ${phase}`);
}

export async function markEnded(stateDir: string, success: boolean): Promise<void> {
  await appendProgress(stateDir, `Ended: ${nowIso()} Success: ${success}`);
}
