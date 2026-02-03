import fs from 'node:fs/promises';
import path from 'node:path';

import { createIssueState, getIssueStateDir, getWorktreePath, parseRepoSpec, type RepoSpec } from '@jeeves/core';

import { runGit } from './git.js';
import { ensureJeevesExcludedFromGitStatus } from './gitExclude.js';
import { writeJsonAtomic } from './jsonAtomic.js';

async function pathExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function resolveBaseRef(repoDir: string): Promise<string> {
  const candidates = ['refs/remotes/origin/main', 'refs/remotes/origin/master'];
  for (const ref of candidates) {
    try {
      await runGit(['show-ref', '--verify', ref], { cwd: repoDir });
      return ref.replace(/^refs\/remotes\//, '');
    } catch {
      // try next
    }
  }
  return 'origin/main';
}

async function ensureRepoClone(params: { dataDir: string; repo: RepoSpec }): Promise<string> {
  const repoDir = path.join(params.dataDir, 'repos', params.repo.owner, params.repo.repo);
  if (!(await pathExists(repoDir))) {
    await ensureDir(path.dirname(repoDir));
    await runGit(['clone', `https://github.com/${params.repo.owner}/${params.repo.repo}.git`, repoDir]);
  } else {
    await runGit(['-C', repoDir, 'fetch', 'origin', '--prune']);
  }
  return repoDir;
}

async function ensureWorktree(params: {
  repoDir: string;
  worktreeDir: string;
  branch: string;
  baseRef: string;
  force: boolean;
}): Promise<void> {
  if (await pathExists(params.worktreeDir)) {
    if (!params.force) throw new Error(`worktree already exists at ${params.worktreeDir}`);
    await runGit(['-C', params.repoDir, 'worktree', 'remove', '--force', params.worktreeDir]);
    await fs.rm(params.worktreeDir, { recursive: true, force: true });
  }

  await ensureDir(path.dirname(params.worktreeDir));
  await runGit(['-C', params.repoDir, 'worktree', 'add', '-B', params.branch, params.worktreeDir, params.baseRef]);
}

async function ensureStateLink(worktreeDir: string, stateDir: string): Promise<void> {
  const linkPath = path.join(worktreeDir, '.jeeves');
  await fs.rm(linkPath, { recursive: true, force: true }).catch(() => void 0);

  const type: 'dir' | 'junction' = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(stateDir, linkPath, type);
}

export type InitIssueRequest = Readonly<{
  repo: string;
  issue: number;
  branch?: string;
  workflow?: string;
  phase?: string;
  design_doc?: string;
  force?: boolean;
}>;

export type InitIssueResult = Readonly<{
  issue_ref: string;
  state_dir: string;
  work_dir: string;
  repo_dir: string;
  branch: string;
}>;

export async function initIssue(params: { dataDir: string; body: InitIssueRequest }): Promise<InitIssueResult> {
  const repo = parseRepoSpec(params.body.repo);
  const issueNumber = params.body.issue;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('issue must be a positive integer');

  const branch = params.body.branch?.trim() || `issue/${issueNumber}`;
  const workflow = params.body.workflow?.trim() || 'default';
  const phase = params.body.phase?.trim() || 'design_draft';
  const force = Boolean(params.body.force ?? false);

  const repoDir = await ensureRepoClone({ dataDir: params.dataDir, repo });
  const baseRef = await resolveBaseRef(repoDir);

  const stateDir = getIssueStateDir(repo.owner, repo.repo, issueNumber, params.dataDir);
  await createIssueState({
    owner: repo.owner,
    repo: repo.repo,
    issueNumber,
    dataDir: params.dataDir,
    branch,
    workflow,
    phase,
    designDocPath: params.body.design_doc?.trim() || undefined,
    force,
  });

  const worktreeDir = getWorktreePath(repo.owner, repo.repo, issueNumber, params.dataDir);
  await ensureWorktree({ repoDir, worktreeDir, branch, baseRef, force });
  await ensureStateLink(worktreeDir, stateDir);
  await ensureJeevesExcludedFromGitStatus(worktreeDir).catch(() => void 0);

  await writeJsonAtomic(path.join(params.dataDir, 'active-issue.json'), {
    issue_ref: `${repo.owner}/${repo.repo}#${issueNumber}`,
    saved_at: new Date().toISOString(),
  });

  return {
    issue_ref: `${repo.owner}/${repo.repo}#${issueNumber}`,
    state_dir: stateDir,
    work_dir: worktreeDir,
    repo_dir: repoDir,
    branch,
  };
}
