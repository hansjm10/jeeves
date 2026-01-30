import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  await fs
    .rm(filePath, { force: true })
    .catch(() => void 0);
  await fs.rename(tmp, filePath);
}

