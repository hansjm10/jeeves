import fs from 'node:fs/promises';
import path from 'node:path';

import { writeTextAtomic, writeTextAtomicNew } from './textAtomic.js';
import {
  countPromptsInDb,
  countWorkflowsInDb,
  listPromptsFromDb,
  listWorkflowsFromDb,
  readPromptFromDb,
  readWorkflowFromDb,
  upsertPromptInDb,
  upsertWorkflowInDb,
} from './sqliteStorage.js';

async function walkMarkdownFiles(dir: string, prefix = ''): Promise<readonly { id: string; absPath: string }[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: { id: string; absPath: string }[] = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push(...(await walkMarkdownFiles(abs, rel)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push({ id: rel.replace(/\\/g, '/'), absPath: abs });
    }
  }

  return out;
}

export async function reconcilePromptsFromFiles(dataDir: string, promptsDir: string): Promise<number> {
  const files = await walkMarkdownFiles(path.resolve(promptsDir));
  let written = 0;
  for (const file of files) {
    const content = await fs.readFile(file.absPath, 'utf-8').catch(() => null);
    if (typeof content !== 'string') continue;
    upsertPromptInDb(dataDir, file.id, content);
    written += 1;
  }
  return written;
}

export async function seedPromptsFromFilesIfNeeded(dataDir: string, promptsDir: string): Promise<void> {
  if (countPromptsInDb(dataDir) > 0) return;
  await reconcilePromptsFromFiles(dataDir, promptsDir);
}

export async function listPromptIdsFromStore(dataDir: string): Promise<string[]> {
  return listPromptsFromDb(dataDir).map((p) => p.id);
}

export async function readPromptFromStore(dataDir: string, id: string): Promise<string | null> {
  return readPromptFromDb(dataDir, id)?.content ?? null;
}

export async function writePromptToStore(params: {
  dataDir: string;
  promptsDir: string;
  id: string;
  content: string;
  createIfMissing: boolean;
}): Promise<void> {
  const { dataDir, promptsDir, id, content, createIfMissing } = params;
  upsertPromptInDb(dataDir, id, content);

  const target = path.resolve(promptsDir, id);
  if (createIfMissing) {
    await writeTextAtomicNew(target, content);
  } else {
    await writeTextAtomic(target, content);
  }
}

export async function cachePromptInStore(dataDir: string, id: string, content: string): Promise<void> {
  upsertPromptInDb(dataDir, id, content);
}

async function listWorkflowFiles(workflowsDir: string): Promise<readonly { name: string; absPath: string }[]> {
  const absDir = path.resolve(workflowsDir);
  const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.yaml'))
    .map((entry) => ({ name: path.basename(entry.name, '.yaml'), absPath: path.join(absDir, entry.name) }));
}

export async function reconcileWorkflowsFromFiles(dataDir: string, workflowsDir: string): Promise<number> {
  const files = await listWorkflowFiles(workflowsDir);
  let written = 0;
  for (const file of files) {
    const yaml = await fs.readFile(file.absPath, 'utf-8').catch(() => null);
    if (typeof yaml !== 'string') continue;
    upsertWorkflowInDb(dataDir, file.name, yaml);
    written += 1;
  }
  return written;
}

export async function seedWorkflowsFromFilesIfNeeded(dataDir: string, workflowsDir: string): Promise<void> {
  if (countWorkflowsInDb(dataDir) > 0) return;
  await reconcileWorkflowsFromFiles(dataDir, workflowsDir);
}

export async function listWorkflowNamesFromStore(dataDir: string): Promise<string[]> {
  return listWorkflowsFromDb(dataDir).map((wf) => wf.name);
}

export async function readWorkflowYamlFromStore(dataDir: string, name: string): Promise<string | null> {
  return readWorkflowFromDb(dataDir, name)?.yaml ?? null;
}

export async function writeWorkflowToStore(params: {
  dataDir: string;
  workflowsDir: string;
  name: string;
  yaml: string;
  createIfMissing: boolean;
}): Promise<void> {
  const { dataDir, workflowsDir, name, yaml, createIfMissing } = params;
  upsertWorkflowInDb(dataDir, name, yaml);

  const filePath = path.resolve(workflowsDir, `${name}.yaml`);
  if (createIfMissing) {
    await writeTextAtomicNew(filePath, yaml);
  } else {
    await writeTextAtomic(filePath, yaml);
  }
}

export async function cacheWorkflowInStore(dataDir: string, name: string, yaml: string): Promise<void> {
  upsertWorkflowInDb(dataDir, name, yaml);
}
