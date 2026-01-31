import { spawn } from 'node:child_process';

import type { IssueRefString } from './types.js';

export type CreateGitHubIssueParams = Readonly<{
  repo: string;
  title: string;
  body: string;
  labels?: readonly string[];
  assignees?: readonly string[];
  milestone?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}>;

export type CreateGitHubIssueResult = Readonly<{
  issue_url: string;
  issue_ref: IssueRefString | null;
}>;

export class CreateGitHubIssueError extends Error {
  readonly status: number;
  readonly code: 'MISSING_GH' | 'NOT_AUTHENTICATED' | 'REPO_NOT_FOUND_OR_FORBIDDEN' | 'UNKNOWN';

  constructor(params: {
    status: number;
    code: CreateGitHubIssueError['code'];
    message: string;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = 'CreateGitHubIssueError';
    this.status = params.status;
    this.code = params.code;
    if (params.cause !== undefined) (this as unknown as { cause?: unknown }).cause = params.cause;
  }
}

function parseIssueUrl(stdout: string): string | null {
  const m = stdout.match(/https?:\/\/\S+/);
  if (!m) return null;
  const raw = m[0].trim();
  return raw.replace(/[),.;]+$/, '');
}

function parseIssueRefFromUrl(issueUrl: string): IssueRefString | null {
  let url: URL;
  try {
    url = new URL(issueUrl);
  } catch {
    return null;
  }

  const host = url.hostname.trim().toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  const [owner, repo, kind, num] = parts;
  if (kind !== 'issues') return null;
  const n = Number(num);
  if (!Number.isInteger(n) || n <= 0) return null;
  return `${owner}/${repo}#${n}`;
}

function mapGhFailureToSafeError(stderr: string): {
  status: number;
  code: CreateGitHubIssueError['code'];
  message: string;
} {
  const raw = String(stderr ?? '');
  const msg = raw.trim();
  const lower = msg.toLowerCase();

  const authHints = [
    'not logged',
    'authentication',
    'authorize',
    'oauth',
    'gh auth login',
    'please run: gh auth login',
    'missing oauth scope',
  ];
  if (authHints.some((h) => lower.includes(h))) {
    return {
      status: 401,
      code: 'NOT_AUTHENTICATED',
      message: 'GitHub CLI (gh) is not authenticated. Run `gh auth login` on the viewer-server host.',
    };
  }

  const repoHints = [
    'could not resolve to a repository',
    'repository not found',
    'not found',
    'permission denied',
    'insufficient permission',
    'forbidden',
    'http 403',
    'http 404',
  ];
  if (repoHints.some((h) => lower.includes(h))) {
    return {
      status: 403,
      code: 'REPO_NOT_FOUND_OR_FORBIDDEN',
      message:
        'Repository not found or access denied for the authenticated user. Check the repo name and your GitHub permissions.',
    };
  }

  return {
    status: 500,
    code: 'UNKNOWN',
    message: 'Failed to create GitHub issue via `gh`.',
  };
}

export async function createGitHubIssue(params: CreateGitHubIssueParams): Promise<CreateGitHubIssueResult> {
  const repo = params.repo.trim();
  const title = params.title;
  const body = params.body;

  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'];
  if (params.labels && params.labels.length > 0) {
    for (const label of params.labels) args.push('--label', label);
  }
  if (params.assignees && params.assignees.length > 0) {
    args.push('--assignee', params.assignees.join(','));
  }
  if (params.milestone) {
    args.push('--milestone', params.milestone);
  }

  const child = spawn('gh', args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
  child.stderr.on('data', (d: Buffer) => stderrChunks.push(d));

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  child.stdin.write(body);
  child.stdin.end();

  let res: { code: number | null; signal: NodeJS.Signals | null };
  try {
    res = await exit;
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new CreateGitHubIssueError({
        status: 500,
        code: 'MISSING_GH',
        message: 'GitHub CLI (gh) is not installed or not found in PATH on the viewer-server host.',
      });
    }
    throw new CreateGitHubIssueError({
      status: 500,
      code: 'UNKNOWN',
      message: 'Failed to spawn `gh` to create GitHub issue.',
    });
  }

  const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
  const stderr = Buffer.concat(stderrChunks).toString('utf-8');

  if (res.code !== 0) {
    const mapped = mapGhFailureToSafeError(stderr);
    throw new CreateGitHubIssueError({ status: mapped.status, code: mapped.code, message: mapped.message });
  }

  const issueUrl = parseIssueUrl(stdout);
  if (!issueUrl) {
    throw new CreateGitHubIssueError({
      status: 500,
      code: 'UNKNOWN',
      message: 'Issue created but `gh` did not return an issue URL.',
    });
  }

  return { issue_url: issueUrl, issue_ref: parseIssueRefFromUrl(issueUrl) };
}
