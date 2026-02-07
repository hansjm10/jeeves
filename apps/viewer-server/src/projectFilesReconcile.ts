import fs from 'node:fs/promises';
import path from 'node:path';

import { ensurePatternsExcluded } from './gitExclude.js';
import type {
  ProjectFileRecord,
  ProjectFilesSyncStatus,
} from './projectFilesTypes.js';

export type ProjectFilesReconcileOptions = Readonly<{
  worktreeDir: string;
  repoFilesDir: string;
  files: readonly ProjectFileRecord[];
  previousManagedTargets: readonly string[];
  platform?: NodeJS.Platform;
}>;

export type ProjectFilesReconcileResult = Readonly<{
  sync_status: ProjectFilesSyncStatus;
  warnings: string[];
  last_error: string | null;
  managed_targets: readonly string[];
}>;

function fsPathFromTarget(worktreeDir: string, targetPath: string): string {
  return path.join(worktreeDir, ...targetPath.split('/'));
}

function canonicalPath(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSamePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

function isPathWithin(rootDir: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(rootDir), path.resolve(candidate));
  if (!rel) return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function resolveExistingLinkTarget(linkPath: string): Promise<string | null> {
  try {
    const linkTarget = await fs.readlink(linkPath);
    return path.resolve(path.dirname(linkPath), linkTarget);
  } catch {
    return null;
  }
}

async function ensureSymlink(sourceAbs: string, destPath: string, platform: NodeJS.Platform): Promise<void> {
  const symlinkType: 'file' | undefined = platform === 'win32' ? 'file' : undefined;
  await fs.symlink(sourceAbs, destPath, symlinkType);
}

async function ensureHardLink(sourceAbs: string, destPath: string): Promise<void> {
  await fs.link(sourceAbs, destPath);
}

function shouldRetryWithHardLink(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN';
}

function isSameFileIdentity(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  if (a.ino === 0 || b.ino === 0) return false;
  return a.dev === b.dev && a.ino === b.ino;
}

function chooseFailureStatus(current: ProjectFilesSyncStatus, next: ProjectFilesSyncStatus): ProjectFilesSyncStatus {
  if (current === 'failed_source_missing') return current;
  if (current === 'failed_conflict' && next !== 'failed_source_missing') return current;
  if (current === 'failed_link_create' && (next === 'failed_conflict' || next === 'failed_source_missing')) {
    return next;
  }
  if (current === 'failed_link_create') return current;
  if (current === 'in_sync') return next;
  return current;
}

export async function reconcileProjectFilesToWorktree(
  options: ProjectFilesReconcileOptions,
): Promise<ProjectFilesReconcileResult> {
  const { worktreeDir, repoFilesDir, files, previousManagedTargets } = options;
  const platform = options.platform ?? process.platform;

  const warnings: string[] = [];
  let syncStatus: ProjectFilesSyncStatus = 'in_sync';
  let lastError: string | null = null;

  try {
    const stat = await fs.stat(worktreeDir);
    if (!stat.isDirectory()) {
      return {
        sync_status: 'deferred_worktree_absent',
        warnings: ['Worktree path exists but is not a directory.'],
        last_error: 'Worktree path exists but is not a directory.',
        managed_targets: previousManagedTargets,
      };
    }
  } catch {
    return {
      sync_status: 'deferred_worktree_absent',
      warnings: ['Worktree directory does not exist.'],
      last_error: 'Worktree directory does not exist.',
      managed_targets: previousManagedTargets,
    };
  }

  const desiredTargets = new Map<string, ProjectFileRecord>();
  for (const file of files) {
    desiredTargets.set(file.target_path, file);
  }

  if (desiredTargets.size > 0) {
    const excluded = await ensurePatternsExcluded(worktreeDir, [...desiredTargets.keys()]);
    if (!excluded) {
      return {
        sync_status: 'failed_exclude',
        warnings: ['Failed to update .git/info/exclude; refusing to materialize project files.'],
        last_error: 'Failed to update .git/info/exclude.',
        managed_targets: previousManagedTargets,
      };
    }
  }

  const staleTargets = [...new Set(previousManagedTargets)].filter((target) => !desiredTargets.has(target));
  const repoBlobsDir = path.join(repoFilesDir, 'blobs');

  for (const targetPath of staleTargets) {
    const destPath = fsPathFromTarget(worktreeDir, targetPath);
    const stat = await fs.lstat(destPath).catch(() => null);
    if (!stat) continue;

    if (stat.isFile()) {
      await fs.rm(destPath, { force: true }).catch(() => {
        warnings.push(`Failed to remove stale managed target ${targetPath}.`);
      });
      continue;
    }

    if (!stat.isSymbolicLink()) {
      warnings.push(`Skipped stale target ${targetPath}: not a managed file.`);
      continue;
    }

    const linkResolved = await resolveExistingLinkTarget(destPath);
    if (!linkResolved) {
      warnings.push(`Skipped stale target ${targetPath}: unable to resolve symlink target.`);
      continue;
    }

    if (!isPathWithin(repoBlobsDir, linkResolved)) {
      warnings.push(`Skipped stale target ${targetPath}: symlink is not managed by Jeeves.`);
      continue;
    }

    await fs.rm(destPath, { force: true }).catch(() => {
      warnings.push(`Failed to remove stale managed target ${targetPath}.`);
    });
  }

  for (const file of files) {
    const sourceAbs = path.join(repoFilesDir, file.storage_relpath);
    const sourceStat = await fs.stat(sourceAbs).catch(() => null);
    if (!sourceStat || !sourceStat.isFile()) {
      syncStatus = chooseFailureStatus(syncStatus, 'failed_source_missing');
      lastError = `Source file missing for target ${file.target_path}.`;
      warnings.push(lastError);
      continue;
    }

    const destPath = fsPathFromTarget(worktreeDir, file.target_path);
    await fs.mkdir(path.dirname(destPath), { recursive: true }).catch(() => void 0);

    const destStat = await fs.lstat(destPath).catch(() => null);
    if (!destStat) {
      try {
        await ensureSymlink(sourceAbs, destPath, platform);
      } catch (error) {
        if (shouldRetryWithHardLink(error, platform)) {
          try {
            await ensureHardLink(sourceAbs, destPath);
          } catch (hardLinkError) {
            syncStatus = chooseFailureStatus(syncStatus, 'failed_link_create');
            const message = hardLinkError instanceof Error ? hardLinkError.message : String(hardLinkError);
            lastError = `Failed to create link for ${file.target_path}: ${message}`;
            warnings.push(lastError);
          }
        } else {
          syncStatus = chooseFailureStatus(syncStatus, 'failed_link_create');
          const message = error instanceof Error ? error.message : String(error);
          lastError = `Failed to create symlink for ${file.target_path}: ${message}`;
          warnings.push(lastError);
        }
      }
      continue;
    }

    if (destStat.isFile()) {
      const destFileStat = await fs.stat(destPath).catch(() => null);
      if (destFileStat && isSameFileIdentity(destFileStat, sourceStat)) {
        continue;
      }
      syncStatus = chooseFailureStatus(syncStatus, 'failed_conflict');
      lastError = `Conflict at ${file.target_path}: destination exists and is not a managed link.`;
      warnings.push(lastError);
      continue;
    }

    if (!destStat.isSymbolicLink()) {
      syncStatus = chooseFailureStatus(syncStatus, 'failed_conflict');
      lastError = `Conflict at ${file.target_path}: destination exists and is not a symlink.`;
      warnings.push(lastError);
      continue;
    }

    const linkResolved = await resolveExistingLinkTarget(destPath);
    if (!linkResolved) {
      syncStatus = chooseFailureStatus(syncStatus, 'failed_conflict');
      lastError = `Conflict at ${file.target_path}: existing symlink target cannot be resolved.`;
      warnings.push(lastError);
      continue;
    }

    if (!isSamePath(linkResolved, sourceAbs)) {
      syncStatus = chooseFailureStatus(syncStatus, 'failed_conflict');
      lastError = `Conflict at ${file.target_path}: existing symlink points elsewhere.`;
      warnings.push(lastError);
      continue;
    }
  }

  return {
    sync_status: syncStatus,
    warnings,
    last_error: lastError,
    managed_targets: syncStatus === 'in_sync'
      ? files.map((f) => f.target_path)
      : previousManagedTargets,
  };
}
