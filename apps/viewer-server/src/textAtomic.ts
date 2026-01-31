import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs
    .rm(filePath, { force: true })
    .catch(() => void 0);
  await fs.rename(tmp, filePath);
}

