import fs from 'node:fs/promises';
import path from 'node:path';

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then((st) => st.isFile())
    .catch(() => false);
}

export async function findRepoRoot(startDir: string): Promise<string> {
  let current = path.resolve(startDir);
  // Walk until filesystem root.
  while (true) {
    const candidate = path.join(current, 'pnpm-workspace.yaml');
    if (await fileExists(candidate)) return current;
    const parent = path.dirname(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

