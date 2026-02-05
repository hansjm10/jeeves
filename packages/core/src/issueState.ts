import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { getIssueStateDir, getIssuesDir, getLegacyIssueStateDir, getWorktreesDir, parseRepoSpec, type RepoSpec } from './paths.js';

export type IssueState = Readonly<{
  schemaVersion: 1;
  owner: string;
  repo: string;
  issue: Readonly<{
    number: number;
    title?: string;
    url?: string;
    repo?: string;
    [key: string]: unknown;
  }>;
  branch: string;
  phase: string;
  workflow: string;
  designDocPath?: string;
  notes: string;
}>;

export type IssueStateSummary = Readonly<{
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  branch: string;
  phase: string;
  stateDir: string;
}>;

const githubIssueSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().optional(),
    url: z.string().optional(),
    repo: z.string().optional(),
  })
  .passthrough();

const issueFieldSchema = z.union([z.number().int().positive(), githubIssueSchema]).transform((value) =>
  typeof value === 'number' ? { number: value } : value,
);

const issueStateJsonSchema = z
  .object({
    schemaVersion: z.number().int().optional().default(1),
    repo: z.string().optional(),
    project: z.string().optional(),
    issue: issueFieldSchema,
    branch: z.string().optional(),
    branchName: z.string().optional(),
    phase: z.string().optional(),
    workflow: z.string().optional().default('default'),
    designDocPath: z.string().optional(),
    designDoc: z.string().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

const issueStateWriteSchema = z
  .object({
    schemaVersion: z.literal(1),
    repo: z.string(),
    issue: githubIssueSchema,
    branch: z.string(),
    phase: z.string(),
    workflow: z.string(),
    notes: z.string(),
    designDocPath: z.string().optional(),
  })
  .strict();

function resolveOwnerRepo(data: z.output<typeof issueStateJsonSchema>): RepoSpec {
  const repoSpec = data.repo ?? data.issue.repo ?? data.project;
  if (repoSpec) {
    try {
      return parseRepoSpec(repoSpec);
    } catch {
      // fall through
    }
  }
  return { owner: 'unknown', repo: 'unknown' };
}

function normalizeIssueState(data: z.output<typeof issueStateJsonSchema>): IssueState {
  const { owner, repo } = resolveOwnerRepo(data);
  const fullRepo = `${owner}/${repo}`;

  const issue = { ...data.issue };
  if (issue.repo === undefined) issue.repo = fullRepo;

  return {
    schemaVersion: 1,
    owner,
    repo,
    issue,
    branch: data.branch ?? data.branchName ?? `issue/${data.issue.number}`,
    phase: data.phase ?? 'design_classify',
    workflow: data.workflow ?? 'default',
    designDocPath: data.designDocPath ?? data.designDoc,
    notes: data.notes ?? '',
  };
}

export async function loadIssueStateFromPath(issuePath: string): Promise<IssueState> {
  const stat = await fs.stat(issuePath);
  const issueFile = stat.isDirectory() ? path.join(issuePath, 'issue.json') : issuePath;
  const raw = await fs.readFile(issueFile, 'utf-8');
  const json = JSON.parse(raw) as unknown;
  const parsed = issueStateJsonSchema.parse(json);
  return normalizeIssueState(parsed);
}

export async function loadIssueState(
  owner: string,
  repo: string,
  issueNumber: number,
  dataDir?: string,
): Promise<IssueState> {
  const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
  return loadIssueStateFromPath(stateDir);
}

export async function createIssueState(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  dataDir?: string;
  branch?: string;
  phase?: string;
  workflow?: string;
  designDocPath?: string;
  notes?: string;
  force?: boolean;
}): Promise<IssueState> {
  const stateDir = getIssueStateDir(params.owner, params.repo, params.issueNumber, params.dataDir);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(path.join(stateDir, '.runs'), { recursive: true });

  const issueFile = path.join(stateDir, 'issue.json');
  const existing = await fs
    .stat(issueFile)
    .then(() => true)
    .catch(() => false);
  if (existing && !params.force) {
    throw new Error(`issue state already exists at ${stateDir}`);
  }

  const fullRepo = `${params.owner}/${params.repo}`;
  const data = {
    schemaVersion: 1 as const,
    repo: fullRepo,
    issue: {
      number: params.issueNumber,
      repo: fullRepo,
    },
    branch: params.branch ?? `issue/${params.issueNumber}`,
    phase: params.phase ?? 'design_classify',
    workflow: params.workflow ?? 'default',
    notes: params.notes ?? '',
    ...(params.designDocPath ? { designDocPath: params.designDocPath } : {}),
  };

  const validated = issueStateWriteSchema.parse(data);
  await fs.writeFile(issueFile, `${JSON.stringify(validated, null, 2)}\n`, 'utf-8');

  const progressFile = path.join(stateDir, 'progress.txt');
  const progressExists = await fs
    .stat(progressFile)
    .then(() => true)
    .catch(() => false);
  if (!progressExists) {
    await fs.writeFile(progressFile, '', 'utf-8');
  }

  return normalizeIssueState(issueStateJsonSchema.parse(validated));
}

export async function listIssueStates(dataDir?: string): Promise<IssueStateSummary[]> {
  const results: IssueStateSummary[] = [];
  const seenKeys = new Set<string>();

  // Prefer the modern layout: worktrees/<owner>/<repo>/issue-<N>/.jeeves/issue.json
  const worktreesDir = getWorktreesDir(dataDir);
  const owners = await fs.readdir(worktreesDir, { withFileTypes: true }).catch(() => []);

  for (const ownerEnt of owners) {
    if (!ownerEnt.isDirectory()) continue;
    const owner = ownerEnt.name;

    const repos = await fs.readdir(path.join(worktreesDir, owner), { withFileTypes: true }).catch(() => []);
    for (const repoEnt of repos) {
      if (!repoEnt.isDirectory()) continue;
      const repo = repoEnt.name;

      const worktrees = await fs.readdir(path.join(worktreesDir, owner, repo), { withFileTypes: true }).catch(() => []);
      for (const wtEnt of worktrees) {
        if (!wtEnt.isDirectory()) continue;
        const m = wtEnt.name.match(/^issue-(\d+)$/);
        if (!m) continue;
        const issueNumber = Number(m[1]);
        if (!Number.isInteger(issueNumber) || issueNumber <= 0) continue;

        const stateDir = path.join(worktreesDir, owner, repo, wtEnt.name, '.jeeves');
        const issueFile = path.join(stateDir, 'issue.json');
        const exists = await fs
          .stat(issueFile)
          .then(() => true)
          .catch(() => false);
        if (!exists) continue;

        try {
          const state = await loadIssueStateFromPath(issueFile);
          const key = `${state.owner}/${state.repo}#${state.issue.number}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          results.push({
            owner: state.owner,
            repo: state.repo,
            issueNumber,
            issueTitle: state.issue.title ?? '',
            branch: state.branch,
            phase: state.phase,
            stateDir,
          });
        } catch {
          // Skip invalid issue.json
        }
      }
    }
  }

  // Also include legacy layout: issues/<owner>/<repo>/<issue>/issue.json
  // (best-effort; helps visibility before migration runs).
  const issuesDir = getIssuesDir(dataDir);
  const legacyOwners = await fs.readdir(issuesDir, { withFileTypes: true }).catch(() => []);
  for (const ownerEnt of legacyOwners) {
    if (!ownerEnt.isDirectory()) continue;
    const owner = ownerEnt.name;

    const repos = await fs.readdir(path.join(issuesDir, owner), { withFileTypes: true }).catch(() => []);
    for (const repoEnt of repos) {
      if (!repoEnt.isDirectory()) continue;
      const repo = repoEnt.name;

      const issues = await fs.readdir(path.join(issuesDir, owner, repo), { withFileTypes: true }).catch(() => []);
      for (const issueEnt of issues) {
        if (!issueEnt.isDirectory()) continue;
        const n = Number(issueEnt.name);
        if (!Number.isInteger(n) || n <= 0) continue;

        const legacyStateDir = getLegacyIssueStateDir(owner, repo, n, dataDir);
        const issueFile = path.join(legacyStateDir, 'issue.json');
        const exists = await fs
          .stat(issueFile)
          .then(() => true)
          .catch(() => false);
        if (!exists) continue;

        try {
          const state = await loadIssueStateFromPath(issueFile);
          const key = `${state.owner}/${state.repo}#${state.issue.number}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          results.push({
            owner: state.owner,
            repo: state.repo,
            issueNumber: state.issue.number,
            issueTitle: state.issue.title ?? '',
            branch: state.branch,
            phase: state.phase,
            stateDir: legacyStateDir,
          });
        } catch {
          // ignore
        }
      }
    }
  }

  return results.sort((a, b) =>
    a.owner !== b.owner ? a.owner.localeCompare(b.owner) : a.repo !== b.repo ? a.repo.localeCompare(b.repo) : a.issueNumber - b.issueNumber,
  );
}
