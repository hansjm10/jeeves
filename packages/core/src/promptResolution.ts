import fs from 'node:fs/promises';
import path from 'node:path';

import type { WorkflowEngine } from './workflowEngine';

export async function resolvePromptPath(
  phase: string,
  promptsDir: string,
  engine: WorkflowEngine,
): Promise<string> {
  if (engine.isTerminal(phase)) {
    throw new Error('Phase is complete; no prompt to run.');
  }

  const promptName = engine.getPromptForPhase(phase);
  if (!promptName) {
    throw new Error(`No prompt defined for phase: ${phase}`);
  }

  const baseDir = path.resolve(promptsDir);
  const promptPath = path.resolve(baseDir, promptName);

  const rel = path.relative(baseDir, promptPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Invalid prompt path: ${promptName}`);
  }

  const stat = await fs
    .stat(promptPath)
    .catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`Prompt not found: ${promptPath}`);
  }

  return promptPath;
}

