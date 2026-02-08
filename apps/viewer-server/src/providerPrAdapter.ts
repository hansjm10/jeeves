/**
 * Provider CLI adapters for PR list and create operations.
 *
 * Normalizes GitHub (`gh`) and Azure DevOps (`az`) PR outputs to provider-agnostic
 * structures. Adapter failures map to documented status/code categories and never
 * expose PAT values.
 */

import { spawn as defaultSpawn } from 'node:child_process';

import type { IssueProvider } from './azureDevopsTypes.js';
import { sanitizePatFromMessage } from './azureDevopsTypes.js';
import {
  ProviderAdapterError,
  spawnCliCommand,
  mapAzError,
  buildAzureEnv,
  formatCliArgs,
} from './providerIssueAdapter.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Normalized PR reference returned by PR adapters.
 */
export type ProviderPrRef = Readonly<{
  id: string;
  url: string;
  number?: number;
  state?: string;
}>;

// ============================================================================
// PR List (existing PR lookup)
// ============================================================================

/** Parameters for listing existing PRs. */
export type ListExistingPrParams = Readonly<{
  provider: IssueProvider;
  repo: string;
  branch: string;
  azure?: Readonly<{
    organization?: string;
    project?: string;
    pat?: string;
  }>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof defaultSpawn;
}>;

/**
 * Look up an existing PR for a branch.
 * Returns the first matching PR ref, or null if none found.
 */
export async function listExistingPr(
  params: ListExistingPrParams,
): Promise<ProviderPrRef | null> {
  if (params.provider === 'github') {
    return listGitHubPr(params);
  }
  return listAzurePr(params);
}

async function listGitHubPr(
  params: ListExistingPrParams,
): Promise<ProviderPrRef | null> {
  const args = [
    'pr',
    'list',
    '--head',
    params.branch,
    '--repo',
    params.repo,
    '--json',
    'number,url,state',
  ];

  const result = await spawnCliCommand('gh', args, {
    cwd: params.cwd,
    env: params.env,
    spawnImpl: params.spawnImpl,
  });

  if (result.exitCode === null && result.signal === null) {
    throw new ProviderAdapterError({
      status: 500,
      code: 'missing_cli',
      message:
        'GitHub CLI (gh) is not installed or not found in PATH on the viewer-server host.',
    });
  }

  if (result.exitCode !== 0) {
    throw mapGhPrStderrToAdapter(result.stderr);
  }

  let parsed: unknown[];
  try {
    parsed = JSON.parse(result.stdout) as unknown[];
  } catch {
    throw new ProviderAdapterError({
      status: 500,
      code: 'io_error',
      message: 'Failed to parse GitHub CLI output as JSON.',
    });
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }

  const first = parsed[0] as Record<string, unknown>;
  const number = typeof first['number'] === 'number' ? first['number'] : undefined;

  return {
    id: String(number ?? ''),
    url: String(first['url'] ?? ''),
    number,
    state: typeof first['state'] === 'string' ? first['state'] : undefined,
  };
}

async function listAzurePr(
  params: ListExistingPrParams,
): Promise<ProviderPrRef | null> {
  const azure = params.azure;
  const org = azure?.organization ?? '';
  const project = azure?.project ?? '';
  const pat = azure?.pat;

  const args = [
    'repos',
    'pr',
    'list',
    '--organization',
    org,
    '--project',
    project,
    '--repository',
    params.repo,
    '--source-branch',
    params.branch,
    '--status',
    'active',
    '--output',
    'json',
  ];

  const cmdSummary = formatCliArgs('az', args);
  const result = await spawnCliCommand('az', args, {
    cwd: params.cwd,
    env: buildAzureEnv(params.env, pat),
    spawnImpl: params.spawnImpl,
  });

  if (result.exitCode === null && result.signal === null) {
    throw new ProviderAdapterError({
      status: 500,
      code: 'missing_cli',
      message: sanitizePatFromMessage(
        'Azure CLI (az) is not installed or not found in PATH on the viewer-server host.',
        pat,
      ),
    });
  }

  if (result.exitCode !== 0) {
    throw mapAzError(result.stderr, pat, false, cmdSummary);
  }

  let parsed: unknown[];
  try {
    parsed = JSON.parse(result.stdout) as unknown[];
  } catch {
    throw new ProviderAdapterError({
      status: 500,
      code: 'io_error',
      message: sanitizePatFromMessage(
        'Failed to parse Azure CLI output as JSON.',
        pat,
      ),
    });
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }

  const first = parsed[0] as Record<string, unknown>;
  return normalizeAzurePrRef(first, org, project);
}

// ============================================================================
// PR Create
// ============================================================================

/** Parameters for creating a PR. */
export type CreatePrParams = Readonly<{
  provider: IssueProvider;
  repo: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  azure?: Readonly<{
    organization?: string;
    project?: string;
    pat?: string;
  }>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof defaultSpawn;
}>;

/**
 * Create a PR via the appropriate CLI.
 * Returns a normalized ProviderPrRef.
 */
export async function createPr(
  params: CreatePrParams,
): Promise<ProviderPrRef> {
  if (params.provider === 'github') {
    return createGitHubPr(params);
  }
  return createAzurePr(params);
}

async function createGitHubPr(
  params: CreatePrParams,
): Promise<ProviderPrRef> {
  const args = [
    'pr',
    'create',
    '--base',
    params.baseBranch,
    '--head',
    params.branch,
    '--title',
    params.title,
    '--body',
    params.body,
    '--repo',
    params.repo,
  ];

  const result = await spawnCliCommand('gh', args, {
    cwd: params.cwd,
    env: params.env,
    spawnImpl: params.spawnImpl,
  });

  if (result.exitCode === null && result.signal === null) {
    throw new ProviderAdapterError({
      status: 500,
      code: 'missing_cli',
      message:
        'GitHub CLI (gh) is not installed or not found in PATH on the viewer-server host.',
    });
  }

  if (result.exitCode !== 0) {
    throw mapGhPrStderrToAdapter(result.stderr);
  }

  // gh pr create outputs the PR URL on stdout
  const prUrl = result.stdout.trim();
  if (!prUrl) {
    throw new ProviderAdapterError({
      status: 500,
      code: 'io_error',
      message: 'PR created but `gh` did not return a PR URL.',
    });
  }

  // Extract PR number from URL (https://github.com/owner/repo/pull/123)
  const prNumber = extractGhPrNumber(prUrl);

  return {
    id: String(prNumber ?? ''),
    url: prUrl,
    number: prNumber ?? undefined,
  };
}

async function createAzurePr(
  params: CreatePrParams,
): Promise<ProviderPrRef> {
  const azure = params.azure;
  const org = azure?.organization ?? '';
  const project = azure?.project ?? '';
  const pat = azure?.pat;

  const args = [
    'repos',
    'pr',
    'create',
    '--organization',
    org,
    '--project',
    project,
    '--repository',
    params.repo,
    '--source-branch',
    params.branch,
    '--target-branch',
    params.baseBranch,
    '--title',
    params.title,
    '--description',
    params.body,
    '--output',
    'json',
  ];

  const cmdSummary = formatCliArgs('az', args);
  const result = await spawnCliCommand('az', args, {
    cwd: params.cwd,
    env: buildAzureEnv(params.env, pat),
    spawnImpl: params.spawnImpl,
  });

  if (result.exitCode === null && result.signal === null) {
    throw new ProviderAdapterError({
      status: 500,
      code: 'missing_cli',
      message: sanitizePatFromMessage(
        'Azure CLI (az) is not installed or not found in PATH on the viewer-server host.',
        pat,
      ),
    });
  }

  // Timeout
  if (result.signal !== null && result.exitCode === null) {
    throw mapAzError(result.stderr, pat, true, cmdSummary);
  }

  if (result.exitCode !== 0) {
    throw mapAzError(result.stderr, pat, false, cmdSummary);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new ProviderAdapterError({
      status: 500,
      code: 'io_error',
      message: sanitizePatFromMessage(
        'Failed to parse Azure CLI output as JSON.',
        pat,
      ),
    });
  }

  return normalizeAzurePrRef(parsed, org, project);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Map GitHub PR stderr to ProviderAdapterError.
 */
function mapGhPrStderrToAdapter(stderr: string): ProviderAdapterError {
  const raw = String(stderr ?? '').trim();
  const lower = raw.toLowerCase();

  const authHints = [
    'not logged',
    'authentication',
    'authorize',
    'oauth',
    'gh auth login',
    'missing oauth scope',
  ];
  if (authHints.some((h) => lower.includes(h))) {
    return new ProviderAdapterError({
      status: 401,
      code: 'provider_auth_required',
      message:
        'GitHub CLI (gh) is not authenticated. Run `gh auth login` on the viewer-server host.',
    });
  }

  const permHints = [
    'permission denied',
    'insufficient permission',
    'forbidden',
    'http 403',
    'could not resolve to a repository',
    'repository not found',
  ];
  if (permHints.some((h) => lower.includes(h))) {
    return new ProviderAdapterError({
      status: 403,
      code: 'provider_permission_denied',
      message:
        'GitHub access denied. Check your permissions for this repository.',
    });
  }

  const validationHints = [
    'already exists',
    'a pull request already exists',
    'no commits between',
    'validation failed',
  ];
  if (validationHints.some((h) => lower.includes(h))) {
    return new ProviderAdapterError({
      status: 422,
      code: 'remote_validation_failed',
      message: 'GitHub rejected the pull request due to a validation error.',
    });
  }

  return new ProviderAdapterError({
    status: 500,
    code: 'io_error',
    message: 'GitHub CLI command failed.',
  });
}

/**
 * Extract PR number from a GitHub PR URL.
 */
function extractGhPrNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Normalize Azure DevOps PR JSON to ProviderPrRef.
 */
function normalizeAzurePrRef(
  parsed: Record<string, unknown>,
  org: string,
  project: string,
): ProviderPrRef {
  const pullRequestId =
    typeof parsed['pullRequestId'] === 'number'
      ? parsed['pullRequestId']
      : undefined;
  const id = String(pullRequestId ?? parsed['id'] ?? '');

  // Try to get web URL from the response
  let url = '';
  const repository = parsed['repository'] as
    | Record<string, unknown>
    | undefined;
  if (repository) {
    const webUrl = repository['webUrl'] as string | undefined;
    if (webUrl) {
      url = `${webUrl}/pullrequest/${id}`;
    }
  }
  if (!url && typeof parsed['url'] === 'string') {
    url = parsed['url'] as string;
  }
  if (!url) {
    // Construct a best-effort URL
    url = `${org.replace(/\/$/, '')}/${encodeURIComponent(project)}/_git/${encodeURIComponent(String(parsed['repository'] ?? ''))}/pullrequest/${id}`;
  }

  const status =
    typeof parsed['status'] === 'string'
      ? (parsed['status'] as string)
      : undefined;

  return {
    id,
    url,
    number: pullRequestId,
    state: status,
  };
}
