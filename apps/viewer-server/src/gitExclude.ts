import fs from 'node:fs/promises';
import path from 'node:path';

import { runGit } from './git.js';

async function readGitDirPointer(worktreeDir: string): Promise<string | null> {
  const dotGitPath = path.join(worktreeDir, '.git');
  const stat = await fs.stat(dotGitPath).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  const raw = await fs.readFile(dotGitPath, 'utf-8').catch(() => null);
  if (!raw) return null;
  const m = raw.trim().match(/^gitdir:\s*(.+)\s*$/i);
  if (!m) return null;
  const gitDir = m[1].trim();
  return path.isAbsolute(gitDir) ? gitDir : path.resolve(worktreeDir, gitDir);
}

async function resolveInfoExcludePath(worktreeDir: string): Promise<string | null> {
  const { stdout } = await runGit(['-C', worktreeDir, 'rev-parse', '--git-path', 'info/exclude']);
  const gitPath = stdout.trim();
  if (!gitPath) return null;

  if (path.isAbsolute(gitPath)) return gitPath;

  const candidate = path.resolve(worktreeDir, gitPath);
  if (await fs.stat(candidate).then(() => true).catch(() => false)) return candidate;

  // Some git versions may print `.git/info/exclude` even when `.git` is a file
  // pointing at a worktree gitdir; fall back to parsing the gitdir pointer.
  if (gitPath.replace(/\\/g, '/').startsWith('.git/')) {
    const gitDir = await readGitDirPointer(worktreeDir);
    if (gitDir) return path.join(gitDir, 'info', 'exclude');
  }

  return candidate;
}

function hasExactIgnoreLine(content: string, pattern: string): boolean {
  const lines = content.split(/\r?\n/);
  return lines.some((l) => {
    const trimmed = l.trim();
    if (!trimmed || trimmed.startsWith('#')) return false;
    return trimmed === pattern || trimmed === `/${pattern}`;
  });
}

export async function ensureJeevesExcludedFromGitStatus(worktreeDir: string): Promise<void> {
  const excludePath = await resolveInfoExcludePath(worktreeDir);
  if (!excludePath) return;

  const pattern = '.jeeves';
  const existing = await fs.readFile(excludePath, 'utf-8').catch(() => '');
  if (hasExactIgnoreLine(existing, pattern)) return;

  await fs.mkdir(path.dirname(excludePath), { recursive: true }).catch(() => void 0);
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await fs.appendFile(excludePath, `${prefix}${pattern}\n`, 'utf-8');
}

