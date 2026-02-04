import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseRepoSpec } from '@jeeves/core';

const execFileAsync = promisify(execFile);

export type GitHubIssueMeta = Readonly<{
  title: string;
  body: string;
  labels: readonly string[];
}>;

export type QuickFixRouteDecision =
  | Readonly<{ route: true; reason: string; meta?: GitHubIssueMeta }>
  | Readonly<{ route: false; reason: string; meta?: GitHubIssueMeta }>;

export function matchesQuickFixHeuristics(meta: GitHubIssueMeta): { match: boolean; reasons: string[] } {
  const reasons: string[] = [];

  const labelsLower = meta.labels.map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (labelsLower.includes('quick-fix') || labelsLower.includes('quick_fix') || labelsLower.includes('trivial')) {
    reasons.push('label quick-fix/trivial');
  }

  const titleLower = meta.title.trim().toLowerCase();
  if (titleLower.startsWith('fix:') || titleLower.startsWith('docs:') || titleLower.startsWith('chore:')) {
    reasons.push('title prefix fix:/docs:/chore:');
  }

  const bodyLen = meta.body.trim().length;
  if (bodyLen > 0 && bodyLen < 200) {
    reasons.push('body < 200 chars');
  }

  return { match: reasons.length > 0, reasons };
}

export async function fetchIssueMetaViaGhApi(params: {
  repo: string;
  issueNumber: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GitHubIssueMeta> {
  const repoSpec = parseRepoSpec(params.repo);
  const apiPath = `/repos/${repoSpec.owner}/${repoSpec.repo}/issues/${params.issueNumber}`;

  let stdout: string;
  try {
    const res = await execFileAsync(
      'gh',
      ['api', '-H', 'Accept: application/vnd.github+json', apiPath],
      { cwd: params.cwd, env: params.env, maxBuffer: 10 * 1024 * 1024 },
    );
    stdout = String(res.stdout ?? '');
  } catch (err) {
    const e = err as { code?: string; stderr?: string };
    if (e?.code === 'ENOENT') {
      throw new Error('gh not found in PATH (required for quick-fix auto-routing)');
    }
    const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
    throw new Error(stderr || 'Failed to fetch issue metadata via gh api');
  }

  const json = JSON.parse(stdout) as unknown;
  if (typeof json !== 'object' || json === null) throw new Error('Invalid issue metadata JSON');
  const obj = json as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title : '';
  const body = typeof obj.body === 'string' ? obj.body : '';
  const labelsRaw = Array.isArray(obj.labels) ? obj.labels : [];
  const labels = labelsRaw
    .map((l) => (l && typeof l === 'object' && typeof (l as Record<string, unknown>).name === 'string' ? String((l as Record<string, unknown>).name) : ''))
    .filter((s) => s.trim().length > 0);

  return { title, body, labels };
}

export async function decideQuickFixRouting(params: {
  explicitQuick: boolean;
  repo: string;
  issueNumber: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<QuickFixRouteDecision> {
  if (params.explicitQuick) {
    return { route: true, reason: 'explicit quick=true' };
  }

  const meta = await fetchIssueMetaViaGhApi({
    repo: params.repo,
    issueNumber: params.issueNumber,
    cwd: params.cwd,
    env: params.env,
  });
  const match = matchesQuickFixHeuristics(meta);
  if (!match.match) return { route: false, reason: 'no quick-fix heuristics matched', meta };
  return { route: true, reason: match.reasons.join(', '), meta };
}

