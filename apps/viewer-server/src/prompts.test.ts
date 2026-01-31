import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('viewer-server prompts API', () => {
  it('lists, reads, and writes prompt files (and blocks symlinks)', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-prompts-');
    const promptsDir = await makeTempDir('jeeves-vs-prompts-');

    await fs.writeFile(path.join(promptsDir, 'a.md'), 'A\n', 'utf-8');
    await fs.writeFile(path.join(promptsDir, 'b.md'), 'B\n', 'utf-8');
    await fs.mkdir(path.join(promptsDir, 'fixtures'), { recursive: true });
    await fs.writeFile(path.join(promptsDir, 'fixtures', 'x.md'), 'X\n', 'utf-8');
    await fs.symlink(path.join(promptsDir, 'a.md'), path.join(promptsDir, 'link.md'));

    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
      promptsDir,
    });

    try {
      const listRes = await app.inject({ method: 'GET', url: '/api/prompts' });
      expect(listRes.statusCode).toBe(200);
      const listJson = listRes.json() as { prompts: { id: string }[] };
      expect(listJson.prompts.map((p) => p.id)).toEqual(['a.md', 'b.md', 'fixtures/x.md']);

      const readRes = await app.inject({ method: 'GET', url: '/api/prompts/fixtures/x.md' });
      expect(readRes.statusCode).toBe(200);
      const readJson = readRes.json() as { content: string };
      expect(readJson.content).toBe('X\n');

      const writeRes = await app.inject({
        method: 'PUT',
        url: '/api/prompts/new.md',
        remoteAddress: '127.0.0.1',
        payload: { content: 'NEW\n' },
      });
      expect(writeRes.statusCode).toBe(200);
      await expect(fs.readFile(path.join(promptsDir, 'new.md'), 'utf-8')).resolves.toBe('NEW\n');

      const writeSymlinkRes = await app.inject({
        method: 'PUT',
        url: '/api/prompts/link.md',
        remoteAddress: '127.0.0.1',
        payload: { content: 'NOPE\n' },
      });
      expect(writeSymlinkRes.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects prompt traversal attempts', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-prompts-traversal-');
    const promptsDir = await makeTempDir('jeeves-vs-prompts-traversal-');
    await fs.writeFile(path.join(promptsDir, 'ok.md'), 'ok\n', 'utf-8');

    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
      promptsDir,
    });

    try {
      const res = await app.inject({ method: 'GET', url: '/api/prompts/..%5csecrets.md' });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
