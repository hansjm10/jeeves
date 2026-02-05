import os from 'node:os';
import path from 'node:path';

export type RepoSpec = Readonly<{ owner: string; repo: string }>;
export type IssueRef = Readonly<{ owner: string; repo: string; issueNumber: number }>;

function expandHome(inputPath: string, homeDir: string): string {
  if (inputPath === '~') return homeDir;
  if (inputPath.startsWith('~/')) return path.join(homeDir, inputPath.slice(2));
  if (inputPath.startsWith('~\\')) return path.join(homeDir, inputPath.slice(2));
  return inputPath;
}

export function resolveDataDir(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}): string {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const homeDir = options?.homeDir ?? os.homedir();

  const override = env.JEEVES_DATA_DIR;
  if (override && override.trim()) {
    return path.resolve(expandHome(override.trim(), homeDir));
  }

  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local');
    return path.resolve(base, 'jeeves');
  }

  if (platform === 'darwin') {
    return path.resolve(homeDir, 'Library', 'Application Support', 'jeeves');
  }

  const xdgDataHome = env.XDG_DATA_HOME;
  if (xdgDataHome && xdgDataHome.trim()) {
    return path.resolve(xdgDataHome.trim(), 'jeeves');
  }
  return path.resolve(homeDir, '.local', 'share', 'jeeves');
}

export function getDataDir(): string {
  return resolveDataDir();
}

export function getIssuesDir(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'issues');
}

export function getWorktreesDir(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'worktrees');
}

/**
 * Legacy issue state directory (pre-2026-02): `${dataDir}/issues/<owner>/<repo>/<issueNumber>`.
 *
 * Jeeves now stores per-issue state inside the issue worktree at `${worktreeDir}/.jeeves`
 * so agent sandboxes and MCP tools can access it without traversing symlinks outside cwd.
 */
export function getLegacyIssueStateDir(
  owner: string,
  repo: string,
  issueNumber: number,
  dataDir: string = getDataDir(),
): string {
  return path.join(getIssuesDir(dataDir), owner, repo, String(issueNumber));
}

export function getIssueStateDir(
  owner: string,
  repo: string,
  issueNumber: number,
  dataDir: string = getDataDir(),
): string {
  return path.join(getWorktreePath(owner, repo, issueNumber, dataDir), '.jeeves');
}

export function getWorktreePath(
  owner: string,
  repo: string,
  issueNumber: number,
  dataDir: string = getDataDir(),
): string {
  return path.join(getWorktreesDir(dataDir), owner, repo, `issue-${issueNumber}`);
}

export function parseRepoSpec(spec: string): RepoSpec {
  const cleaned = spec.trim();
  if (!cleaned) throw new Error('repo spec is required');

  if (cleaned.includes('/') && !cleaned.startsWith('http://') && !cleaned.startsWith('https://') && !cleaned.startsWith('git@')) {
    const parts = cleaned.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
    }
  }

  if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) {
    const idx = cleaned.indexOf('github.com/');
    if (idx === -1) throw new Error(`invalid repo spec: ${spec}`);
    const after = cleaned.slice(idx + 'github.com/'.length).replace(/\.git$/, '').replace(/\/$/, '');
    const parts = after.split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
  }

  if (cleaned.startsWith('git@')) {
    const segments = cleaned.split(':');
    const after = segments.length > 0 ? segments[segments.length - 1] : '';
    const withoutGit = after.replace(/\.git$/, '');
    const parts = withoutGit.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
  }

  throw new Error(
    `invalid repo spec: ${spec}. expected owner/repo, https://github.com/owner/repo, or git@github.com:owner/repo.git`,
  );
}

export function parseIssueRef(ref: string, defaultRepo?: RepoSpec): IssueRef {
  const cleaned = ref.trim();
  if (!cleaned) throw new Error('issue ref is required');

  if (cleaned.startsWith('#')) {
    if (!defaultRepo) {
      throw new Error(`cannot resolve ${ref} without a default repo`);
    }
    const num = Number(cleaned.slice(1));
    if (!Number.isInteger(num) || num <= 0) throw new Error(`invalid issue number: ${cleaned.slice(1)}`);
    return { ...defaultRepo, issueNumber: num };
  }

  if (cleaned.includes('#')) {
    const [repoPart, issuePart] = cleaned.split('#');
    const num = Number(issuePart);
    if (!Number.isInteger(num) || num <= 0) throw new Error(`invalid issue number: ${issuePart}`);
    const parsed = parseRepoSpec(repoPart);
    return { ...parsed, issueNumber: num };
  }

  const match = cleaned.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (match) {
    const [, owner, repo, issue] = match;
    return { owner, repo: repo.replace(/\.git$/, ''), issueNumber: Number(issue) };
  }

  if (/^\d+$/.test(cleaned)) {
    if (!defaultRepo) throw new Error(`issue number ${cleaned} requires a repo`);
    return { ...defaultRepo, issueNumber: Number(cleaned) };
  }

  throw new Error(`invalid issue ref: ${ref}`);
}
