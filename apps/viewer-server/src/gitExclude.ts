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
  await ensurePatternsExcluded(worktreeDir, ['.jeeves']);
}

/**
 * Ensure multiple patterns are present in .git/info/exclude, deduped.
 * Returns true if all patterns were ensured, false if the exclude file could not be updated.
 *
 * @param worktreeDir - The worktree directory
 * @param patterns - Patterns to ensure are ignored (e.g., ['.env.jeeves', '.env.jeeves.tmp'])
 * @returns true if successful, false if the exclude file could not be updated
 */
export async function ensurePatternsExcluded(worktreeDir: string, patterns: string[]): Promise<boolean> {
  let excludePath: string | null;
  try {
    excludePath = await resolveInfoExcludePath(worktreeDir);
  } catch {
    // resolveInfoExcludePath can throw if git rev-parse fails (e.g., not a git repo)
    return false;
  }
  if (!excludePath) return false;

  try {
    const existing = await fs.readFile(excludePath, 'utf-8').catch(() => '');

    // Find which patterns are missing
    const missingPatterns = patterns.filter((p) => !hasExactIgnoreLine(existing, p));

    if (missingPatterns.length === 0) return true;

    // Ensure the directory exists
    await fs.mkdir(path.dirname(excludePath), { recursive: true }).catch(() => void 0);

    // Append missing patterns, ensuring proper newline handling
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const linesToAdd = missingPatterns.join('\n') + '\n';
    await fs.appendFile(excludePath, `${prefix}${linesToAdd}`, 'utf-8');

    return true;
  } catch {
    return false;
  }
}

