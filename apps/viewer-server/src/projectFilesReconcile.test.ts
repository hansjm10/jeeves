import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reconcileProjectFilesToWorktree } from './projectFilesReconcile.js';
import type { ProjectFileRecord } from './projectFilesTypes.js';

function makeRecord(params: {
  id: string;
  targetPath: string;
  storageRelpath?: string;
}): ProjectFileRecord {
  return {
    id: params.id,
    display_name: params.id,
    target_path: params.targetPath,
    storage_relpath: params.storageRelpath ?? `blobs/${params.id}`,
    size_bytes: 8,
    sha256: 'abc',
    updated_at: new Date().toISOString(),
  };
}

describe('projectFilesReconcile', () => {
  let tempDir: string;
  let worktreeDir: string;
  let repoFilesDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-files-reconcile-test-'));
    worktreeDir = path.join(tempDir, 'worktree');
    repoFilesDir = path.join(tempDir, 'repo-files', 'owner', 'repo');
    await fs.mkdir(path.join(repoFilesDir, 'blobs'), { recursive: true });
    await fs.mkdir(worktreeDir, { recursive: true });

    execSync('git init', { cwd: worktreeDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => void 0);
  });

  it('creates symlinks for managed files and updates git exclude', async () => {
    const record = makeRecord({ id: 'file1', targetPath: 'secrets/connections.local.config' });
    const sourcePath = path.join(repoFilesDir, record.storage_relpath);
    await fs.writeFile(sourcePath, 'secret', 'utf-8');

    const result = await reconcileProjectFilesToWorktree({
      worktreeDir,
      repoFilesDir,
      files: [record],
      previousManagedTargets: [],
    });

    expect(result.sync_status).toBe('in_sync');
    expect(result.last_error).toBeNull();
    expect(result.managed_targets).toEqual([record.target_path]);

    const linkedPath = path.join(worktreeDir, 'secrets', 'connections.local.config');
    const st = await fs.lstat(linkedPath);
    expect(st.isSymbolicLink()).toBe(true);

    const excludePath = path.join(worktreeDir, '.git', 'info', 'exclude');
    const exclude = await fs.readFile(excludePath, 'utf-8');
    expect(exclude).toContain('secrets/connections.local.config');
  });

  it('returns failed_conflict when destination exists as a normal file', async () => {
    const record = makeRecord({ id: 'file2', targetPath: 'secrets/conflict.txt' });
    await fs.writeFile(path.join(repoFilesDir, record.storage_relpath), 'content', 'utf-8');
    const destPath = path.join(worktreeDir, 'secrets', 'conflict.txt');
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, 'existing', 'utf-8');

    const result = await reconcileProjectFilesToWorktree({
      worktreeDir,
      repoFilesDir,
      files: [record],
      previousManagedTargets: [],
    });

    expect(result.sync_status).toBe('failed_conflict');
    expect(result.last_error).toContain('destination exists');
  });

  it('returns failed_source_missing when blob source does not exist', async () => {
    const record = makeRecord({ id: 'missing', targetPath: 'secrets/missing.txt' });

    const result = await reconcileProjectFilesToWorktree({
      worktreeDir,
      repoFilesDir,
      files: [record],
      previousManagedTargets: [],
    });

    expect(result.sync_status).toBe('failed_source_missing');
    expect(result.last_error).toContain('Source file missing');
  });

  it('falls back to hard links on Windows when symlink creation is denied', async () => {
    const record = makeRecord({ id: 'file3', targetPath: 'secrets/windows-link.txt' });
    const sourcePath = path.join(repoFilesDir, record.storage_relpath);
    await fs.writeFile(sourcePath, 'content', 'utf-8');

    const symlinkSpy = vi.spyOn(fs, 'symlink').mockRejectedValueOnce(
      Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
    );

    const result = await reconcileProjectFilesToWorktree({
      worktreeDir,
      repoFilesDir,
      files: [record],
      previousManagedTargets: [],
      platform: 'win32',
    });

    symlinkSpy.mockRestore();

    expect(result.sync_status).toBe('in_sync');
    const linkedPath = path.join(worktreeDir, 'secrets', 'windows-link.txt');
    const linkedStat = await fs.stat(linkedPath);
    const sourceStat = await fs.stat(sourcePath);
    expect(linkedStat.ino).toBe(sourceStat.ino);
    expect(linkedStat.dev).toBe(sourceStat.dev);
  });

  it('accepts an existing managed hard link as in-sync', async () => {
    const record = makeRecord({ id: 'file4', targetPath: 'secrets/existing-hard-link.txt' });
    const sourcePath = path.join(repoFilesDir, record.storage_relpath);
    await fs.writeFile(sourcePath, 'content', 'utf-8');

    const destPath = path.join(worktreeDir, 'secrets', 'existing-hard-link.txt');
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.link(sourcePath, destPath);

    const result = await reconcileProjectFilesToWorktree({
      worktreeDir,
      repoFilesDir,
      files: [record],
      previousManagedTargets: [],
      platform: 'win32',
    });

    expect(result.sync_status).toBe('in_sync');
    expect(result.last_error).toBeNull();
  });

  it('removes stale managed symlink targets during reconcile', async () => {
    const staleRecord = makeRecord({ id: 'stale', targetPath: 'secrets/old.txt' });
    const staleSource = path.join(repoFilesDir, staleRecord.storage_relpath);
    await fs.writeFile(staleSource, 'old', 'utf-8');

    const staleDest = path.join(worktreeDir, 'secrets', 'old.txt');
    await fs.mkdir(path.dirname(staleDest), { recursive: true });
    await fs.symlink(staleSource, staleDest);

    const nextRecord = makeRecord({ id: 'new', targetPath: 'secrets/new.txt' });
    const nextSource = path.join(repoFilesDir, nextRecord.storage_relpath);
    await fs.writeFile(nextSource, 'new', 'utf-8');

    const result = await reconcileProjectFilesToWorktree({
      worktreeDir,
      repoFilesDir,
      files: [nextRecord],
      previousManagedTargets: [staleRecord.target_path],
    });

    expect(result.sync_status).toBe('in_sync');
    await expect(fs.lstat(staleDest)).rejects.toThrow();

    const nextDest = path.join(worktreeDir, 'secrets', 'new.txt');
    const nextStat = await fs.lstat(nextDest);
    expect(nextStat.isSymbolicLink()).toBe(true);
  });

  it('removes stale managed regular-file targets (hard-link mode)', async () => {
    const staleRecord = makeRecord({ id: 'stale-hard', targetPath: 'secrets/old-hard.txt' });
    const staleSource = path.join(repoFilesDir, staleRecord.storage_relpath);
    await fs.writeFile(staleSource, 'old', 'utf-8');

    const staleDest = path.join(worktreeDir, 'secrets', 'old-hard.txt');
    await fs.mkdir(path.dirname(staleDest), { recursive: true });
    await fs.link(staleSource, staleDest);

    const result = await reconcileProjectFilesToWorktree({
      worktreeDir,
      repoFilesDir,
      files: [],
      previousManagedTargets: [staleRecord.target_path],
      platform: 'win32',
    });

    expect(result.sync_status).toBe('in_sync');
    await expect(fs.stat(staleDest)).rejects.toThrow();
  });

  it('returns deferred_worktree_absent when worktree is missing', async () => {
    const missingWorktree = path.join(tempDir, 'missing-worktree');
    const record = makeRecord({ id: 'a', targetPath: 'a.txt' });
    await fs.writeFile(path.join(repoFilesDir, record.storage_relpath), 'a', 'utf-8');

    const result = await reconcileProjectFilesToWorktree({
      worktreeDir: missingWorktree,
      repoFilesDir,
      files: [record],
      previousManagedTargets: [],
    });

    expect(result.sync_status).toBe('deferred_worktree_absent');
  });

  it('returns failed_exclude when worktree is not a git repo and files are present', async () => {
    const plainDir = path.join(tempDir, 'plain-dir');
    await fs.mkdir(plainDir, { recursive: true });

    const record = makeRecord({ id: 'x', targetPath: 'x.txt' });
    await fs.writeFile(path.join(repoFilesDir, record.storage_relpath), 'x', 'utf-8');

    const result = await reconcileProjectFilesToWorktree({
      worktreeDir: plainDir,
      repoFilesDir,
      files: [record],
      previousManagedTargets: [],
    });

    expect(result.sync_status).toBe('failed_exclude');
    expect(result.last_error).toContain('.git/info/exclude');
  });
});
