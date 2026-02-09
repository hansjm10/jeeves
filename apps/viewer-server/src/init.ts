import fs from 'node:fs/promises';
import path from 'node:path';

import { createIssueState, getIssueStateDir, getWorktreePath, loadWorkflowByName, parseRepoSpec, type RepoSpec } from '@jeeves/core';

import { saveActiveIssue } from './activeIssue.js';
import { runGit } from './git.js';
import { ensureJeevesExcludedFromGitStatus } from './gitExclude.js';
import { writeIssueJson } from './issueJson.js';

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

function injectPatIntoUrl(url: string, pat: string): string {
  return url.replace(/^(https?:\/\/)/, `$1x-token-auth:${pat}@`);
}

async function ensureRepoClone(params: { dataDir: string; repo: RepoSpec; pat?: string }): Promise<string> {
  const repoDir = path.join(params.dataDir, 'repos', params.repo.owner, params.repo.repo);
  const cloneUrl = params.repo.cloneUrl
    ? (params.pat ? injectPatIntoUrl(params.repo.cloneUrl, params.pat) : params.repo.cloneUrl)
    : `https://github.com/${params.repo.owner}/${params.repo.repo}.git`;

  if (!(await pathExists(repoDir))) {
    await ensureDir(path.dirname(repoDir));
    await runGit(['clone', cloneUrl, repoDir]);
  } else {
    // Update remote URL to handle PAT rotation
    if (params.repo.cloneUrl) {
      await runGit(['-C', repoDir, 'remote', 'set-url', 'origin', cloneUrl]);
    }
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
  pat?: string;
}>;

export type InitIssueResult = Readonly<{
  issue_ref: string;
  state_dir: string;
  work_dir: string;
  repo_dir: string;
  branch: string;
}>;

export async function initIssue(params: { dataDir: string; workflowsDir: string; body: InitIssueRequest }): Promise<InitIssueResult> {
  const repo = parseRepoSpec(params.body.repo);
  const issueNumber = params.body.issue;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('issue must be a positive integer');

  const branch = params.body.branch?.trim() || `issue/${issueNumber}`;
  const workflow = params.body.workflow?.trim() || 'default';
  const phase =
    params.body.phase?.trim() ||
    (await loadWorkflowByName(workflow, { workflowsDir: params.workflowsDir }).then((w) => w.start));
  const force = Boolean(params.body.force ?? false);

  const repoDir = await ensureRepoClone({ dataDir: params.dataDir, repo, pat: params.body.pat });
  const baseRef = await resolveBaseRef(repoDir);

  const stateDir = getIssueStateDir(repo.owner, repo.repo, issueNumber, params.dataDir);
  const createdIssueState = await createIssueState({
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

  // Keep runtime state DB-backed even though createIssueState still writes files.
  await writeIssueJson(stateDir, createdIssueState as unknown as Record<string, unknown>);

  const worktreeDir = getWorktreePath(repo.owner, repo.repo, issueNumber, params.dataDir);
  await ensureWorktree({ repoDir, worktreeDir, branch, baseRef, force });
  await ensureStateLink(worktreeDir, stateDir);
  await ensureJeevesExcludedFromGitStatus(worktreeDir).catch(() => void 0);

  await saveActiveIssue(params.dataDir, `${repo.owner}/${repo.repo}#${issueNumber}`);

  return {
    issue_ref: `${repo.owner}/${repo.repo}#${issueNumber}`,
    state_dir: stateDir,
    work_dir: worktreeDir,
    repo_dir: repoDir,
    branch,
  };
}
