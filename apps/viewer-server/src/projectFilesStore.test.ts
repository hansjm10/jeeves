import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteProjectFile,
  getRepoProjectFilesBlobsDir,
  getRepoProjectFilesIndexPath,
  listProjectFiles,
  upsertProjectFile,
} from './projectFilesStore.js';
import { PROJECT_FILE_MAX_COUNT } from './projectFilesTypes.js';

describe('projectFilesStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-files-store-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => void 0);
  });

  it('creates a new project file record and blob', async () => {
    const upsert = await upsertProjectFile({
      dataDir: tempDir,
      owner: 'owner',
      repo: 'repo',
      displayName: 'connections.local.config',
      targetPath: 'connections.local.config',
      content: Buffer.from('secret-content', 'utf-8'),
    });

    expect(upsert.created).toBe(true);
    expect(upsert.record.id).toMatch(/^[a-f0-9]{32}$/);

    const files = await listProjectFiles(tempDir, 'owner', 'repo');
    expect(files).toHaveLength(1);
    expect(files[0]?.target_path).toBe('connections.local.config');

    const blobPath = path.join(getRepoProjectFilesBlobsDir(tempDir, 'owner', 'repo'), upsert.record.id);
    await expect(fs.readFile(blobPath, 'utf-8')).resolves.toBe('secret-content');

    const indexPath = getRepoProjectFilesIndexPath(tempDir, 'owner', 'repo');
    await expect(fs.stat(indexPath)).resolves.toBeDefined();
  });

  it('updates an existing file when id is provided', async () => {
    const initial = await upsertProjectFile({
      dataDir: tempDir,
      owner: 'owner',
      repo: 'repo',
      displayName: 'connections.local.config',
      targetPath: 'connections.local.config',
      content: Buffer.from('v1', 'utf-8'),
    });

    const updated = await upsertProjectFile({
      dataDir: tempDir,
      owner: 'owner',
      repo: 'repo',
      id: initial.record.id,
      displayName: 'connections.local.config',
      targetPath: 'connections.local.config',
      content: Buffer.from('v2', 'utf-8'),
    });

    expect(updated.created).toBe(false);
    expect(updated.record.id).toBe(initial.record.id);

    const files = await listProjectFiles(tempDir, 'owner', 'repo');
    expect(files).toHaveLength(1);
    expect(files[0]?.sha256).toBe(updated.record.sha256);

    const blobPath = path.join(getRepoProjectFilesBlobsDir(tempDir, 'owner', 'repo'), initial.record.id);
    await expect(fs.readFile(blobPath, 'utf-8')).resolves.toBe('v2');
  });

  it('rejects duplicate target_path across different records', async () => {
    await upsertProjectFile({
      dataDir: tempDir,
      owner: 'owner',
      repo: 'repo',
      displayName: 'f1',
      targetPath: 'secrets/config.json',
      content: Buffer.from('a', 'utf-8'),
    });

    await expect(
      upsertProjectFile({
        dataDir: tempDir,
        owner: 'owner',
        repo: 'repo',
        displayName: 'f2',
        targetPath: 'secrets/config.json',
        content: Buffer.from('b', 'utf-8'),
      }),
    ).rejects.toThrow('target_path already exists');
  });

  it('enforces the max file count limit for new records', async () => {
    for (let i = 0; i < PROJECT_FILE_MAX_COUNT; i += 1) {
      await upsertProjectFile({
        dataDir: tempDir,
        owner: 'owner',
        repo: 'repo',
        displayName: `f-${i}`,
        targetPath: `files/f-${i}.txt`,
        content: Buffer.from(String(i), 'utf-8'),
      });
    }

    await expect(
      upsertProjectFile({
        dataDir: tempDir,
        owner: 'owner',
        repo: 'repo',
        displayName: 'overflow',
        targetPath: 'files/overflow.txt',
        content: Buffer.from('x', 'utf-8'),
      }),
    ).rejects.toThrow(`Maximum of ${PROJECT_FILE_MAX_COUNT} files per repo exceeded.`);
  });

  it('deletes an existing record and blob', async () => {
    const record = await upsertProjectFile({
      dataDir: tempDir,
      owner: 'owner',
      repo: 'repo',
      displayName: 'to-delete',
      targetPath: 'to-delete.txt',
      content: Buffer.from('bye', 'utf-8'),
    });

    const deleted = await deleteProjectFile({
      dataDir: tempDir,
      owner: 'owner',
      repo: 'repo',
      id: record.record.id,
    });

    expect(deleted.deleted).toBe(true);
    expect(deleted.removed?.id).toBe(record.record.id);

    const files = await listProjectFiles(tempDir, 'owner', 'repo');
    expect(files).toHaveLength(0);

    const blobPath = path.join(getRepoProjectFilesBlobsDir(tempDir, 'owner', 'repo'), record.record.id);
    await expect(fs.stat(blobPath)).rejects.toThrow();
  });

  it('returns deleted=false when record id does not exist', async () => {
    const result = await deleteProjectFile({
      dataDir: tempDir,
      owner: 'owner',
      repo: 'repo',
      id: 'missing',
    });

    expect(result.deleted).toBe(false);
    expect(result.removed).toBeNull();
  });
});
