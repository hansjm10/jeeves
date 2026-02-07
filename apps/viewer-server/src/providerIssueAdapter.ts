/**
 * Provider CLI adapters for issue/work-item create, lookup, and hierarchy fetch.
 *
 * Normalizes GitHub (`gh`) and Azure DevOps (`az`) CLI outputs to provider-agnostic
 * structures. Adapter failures map to documented status/code categories and never
 * expose PAT values.
 */

import { spawn as defaultSpawn, type ChildProcess } from 'node:child_process';

import type {
  IssueProvider,
  IngestRemoteRef,
  IngestHierarchy,
  HierarchyItemRef,
  AzureWorkItemType,
  RemoteItemKind,
} from './azureDevopsTypes.js';
import {
  sanitizePatFromMessage,
  AZURE_PAT_ENV_VAR_NAME,
} from './azureDevopsTypes.js';
import {
  createGitHubIssue,
  CreateGitHubIssueError,
  parseIssueRefFromUrl,
} from './githubIssueCreate.js';

// ============================================================================
// Error Types
// ============================================================================

/**
 * Documented provider adapter error codes from Section 3 status/code matrix.
 */
export type ProviderAdapterErrorCode =
  | 'provider_auth_required'
  | 'provider_permission_denied'
  | 'provider_timeout'
  | 'remote_not_found'
  | 'remote_validation_failed'
  | 'io_error'
  | 'missing_cli';

/**
 * Custom error for provider adapter failures.
 * Carries HTTP status and documented error code for upstream mapping.
 */
export class ProviderAdapterError extends Error {
  readonly status: number;
  readonly code: ProviderAdapterErrorCode;

  constructor(params: {
    status: number;
    code: ProviderAdapterErrorCode;
    message: string;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = 'ProviderAdapterError';
    this.status = params.status;
    this.code = params.code;
    if (params.cause !== undefined)
      (this as unknown as { cause?: unknown }).cause = params.cause;
  }
}

// ============================================================================
// Spawn Helper (shared with providerPrAdapter.ts)
// ============================================================================

/** Result from a CLI spawn operation. */
export type SpawnResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

/** Options for the spawn helper. */
export type SpawnCliOptions = Readonly<{
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  spawnImpl?: typeof defaultSpawn;
}>;

/**
 * Spawn a CLI command and collect stdout/stderr.
 * Handles ENOENT for missing CLI, timeout with SIGTERM, and signal termination.
 */
export async function spawnCliCommand(
  cmd: string,
  args: readonly string[],
  opts?: SpawnCliOptions,
): Promise<SpawnResult> {
  const {
    cwd,
    env,
    stdin,
    timeoutMs,
    spawnImpl = defaultSpawn,
  } = opts ?? {};

  let child: ChildProcess;
  try {
    child = spawnImpl(cmd, [...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return { stdout: '', stderr: '', exitCode: null, signal: null };
    }
    throw err;
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
  child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('error', (err) => {
      if (isNodeError(err) && err.code === 'ENOENT') {
        // CLI not found — resolve as a "missing CLI" result
        resolve({ code: null, signal: null });
      } else {
        reject(err);
      }
    });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
  }

  if (stdin !== undefined && child.stdin) {
    child.stdin.write(stdin);
    child.stdin.end();
  } else if (child.stdin) {
    child.stdin.end();
  }

  let res: { code: number | null; signal: NodeJS.Signals | null };
  try {
    res = await exit;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
  const stderr = Buffer.concat(stderrChunks).toString('utf-8');

  // Treat ENOENT-resolved result as exitCode=null (caller detects missing CLI)
  if (res.code === null && res.signal === null && !timedOut) {
    return { stdout, stderr, exitCode: null, signal: null };
  }

  if (timedOut) {
    return {
      stdout,
      stderr,
      exitCode: res.code,
      signal: res.signal ?? 'SIGTERM',
    };
  }

  return {
    stdout,
    stderr,
    exitCode: res.code,
    signal: res.signal,
  };
}

// ============================================================================
// Azure CLI Environment Helpers
// ============================================================================

/**
 * Build a process environment with the Azure PAT injected.
 * If `pat` is provided, sets AZURE_DEVOPS_EXT_PAT so the `az` CLI
 * authenticates with it. Falls back to the base env (or process.env).
 */
export function buildAzureEnv(
  baseEnv: NodeJS.ProcessEnv | undefined,
  pat: string | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!pat) return baseEnv;
  return {
    ...(baseEnv ?? process.env),
    [AZURE_PAT_ENV_VAR_NAME]: pat,
  };
}

// ============================================================================
// Azure CLI Error Mapping
// ============================================================================

const AZ_AUTH_HINTS = [
  'not logged in',
  'az login',
  'authentication',
  'please run az login',
  'token has expired',
  'access token',
  'unauthorized',
];

const AZ_PERMISSION_HINTS = [
  'does not have permissions',
  'forbidden',
  'tf401019',
  'access denied',
  'insufficient permission',
];

const AZ_NOT_FOUND_HINTS = [
  'could not be found',
  'does not exist',
  'tf401232',
  'resource not found',
  'work item not found',
  'tf26198',
];

const AZ_VALIDATION_HINTS = [
  'vs402337',
  'vs402336',
  'the field',
  'is required',
  'invalid value',
  'vs403429',
];

/**
 * Format a CLI args array into a shell-like string for error messages.
 * Values containing spaces are quoted. PAT values are never included
 * because they are passed via env var, not args.
 */
export function formatCliArgs(cmd: string, args: readonly string[]): string {
  const parts = [cmd];
  for (const arg of args) {
    parts.push(arg.includes(' ') ? `"${arg}"` : arg);
  }
  return parts.join(' ');
}

/**
 * Map Azure CLI stderr to a ProviderAdapterError.
 * PAT is scrubbed from the message before returning.
 */
export function mapAzError(
  stderr: string,
  pat?: string,
  isTimeout?: boolean,
  cmdSummary?: string,
): ProviderAdapterError {
  const raw = String(stderr ?? '').trim();
  const lower = raw.toLowerCase();
  const cmdLine = cmdSummary ? ` Command: ${cmdSummary}` : '';

  if (isTimeout) {
    return new ProviderAdapterError({
      status: 504,
      code: 'provider_timeout',
      message: sanitizePatFromMessage(
        `Azure DevOps CLI command timed out.${cmdLine}`,
        pat,
      ),
    });
  }

  if (AZ_AUTH_HINTS.some((h) => lower.includes(h))) {
    return new ProviderAdapterError({
      status: 401,
      code: 'provider_auth_required',
      message: sanitizePatFromMessage(
        `Azure DevOps CLI is not authenticated. Run \`az login\` on the viewer-server host.${cmdLine}`,
        pat,
      ),
    });
  }

  if (AZ_PERMISSION_HINTS.some((h) => lower.includes(h))) {
    return new ProviderAdapterError({
      status: 403,
      code: 'provider_permission_denied',
      message: sanitizePatFromMessage(
        `Azure DevOps access denied. Check your permissions for the organization and project.${cmdLine}`,
        pat,
      ),
    });
  }

  if (AZ_NOT_FOUND_HINTS.some((h) => lower.includes(h))) {
    return new ProviderAdapterError({
      status: 404,
      code: 'remote_not_found',
      message: sanitizePatFromMessage(
        `Azure DevOps resource not found. Check the organization, project, and item ID.${cmdLine}`,
        pat,
      ),
    });
  }

  if (AZ_VALIDATION_HINTS.some((h) => lower.includes(h))) {
    return new ProviderAdapterError({
      status: 422,
      code: 'remote_validation_failed',
      message: sanitizePatFromMessage(
        `Azure DevOps rejected the request due to a validation error.${cmdLine}`,
        pat,
      ),
    });
  }

  const detail = raw.length > 0 ? ` Detail: ${raw}` : '';
  return new ProviderAdapterError({
    status: 500,
    code: 'io_error',
    message: sanitizePatFromMessage(
      `Azure DevOps CLI command failed.${detail}${cmdLine}`,
      pat,
    ),
  });
}

/**
 * Map GitHub CLI errors to ProviderAdapterError.
 */
function mapGhErrorToAdapter(err: unknown): ProviderAdapterError {
  if (err instanceof CreateGitHubIssueError) {
    switch (err.code) {
      case 'MISSING_GH':
        return new ProviderAdapterError({
          status: 500,
          code: 'missing_cli',
          message: err.message,
          cause: err,
        });
      case 'NOT_AUTHENTICATED':
        return new ProviderAdapterError({
          status: 401,
          code: 'provider_auth_required',
          message: err.message,
          cause: err,
        });
      case 'REPO_NOT_FOUND_OR_FORBIDDEN':
        return new ProviderAdapterError({
          status: 403,
          code: 'provider_permission_denied',
          message: err.message,
          cause: err,
        });
      default:
        return new ProviderAdapterError({
          status: 500,
          code: 'io_error',
          message: err.message,
          cause: err,
        });
    }
  }

  return new ProviderAdapterError({
    status: 500,
    code: 'io_error',
    message: 'GitHub CLI command failed.',
    cause: err,
  });
}

/**
 * Map `gh` stderr to ProviderAdapterError codes for view/lookup commands.
 */
function mapGhStderrToAdapter(stderr: string): ProviderAdapterError {
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

  const notFoundHints = [
    'not found',
    'could not resolve',
    'no issue found',
    'issue not found',
    'http 404',
  ];
  if (notFoundHints.some((h) => lower.includes(h))) {
    return new ProviderAdapterError({
      status: 404,
      code: 'remote_not_found',
      message:
        'GitHub issue not found. Check the issue number and repository.',
    });
  }

  const permHints = [
    'permission denied',
    'insufficient permission',
    'forbidden',
    'http 403',
  ];
  if (permHints.some((h) => lower.includes(h))) {
    return new ProviderAdapterError({
      status: 403,
      code: 'provider_permission_denied',
      message:
        'GitHub access denied. Check your permissions for this repository.',
    });
  }

  return new ProviderAdapterError({
    status: 500,
    code: 'io_error',
    message: 'GitHub CLI command failed.',
  });
}

// ============================================================================
// Issue/Work-Item Create
// ============================================================================

/** Parameters for creating a provider issue/work-item. */
export type CreateProviderIssueParams = Readonly<{
  provider: IssueProvider;
  repo: string;
  title: string;
  body: string;
  labels?: readonly string[];
  assignees?: readonly string[];
  milestone?: string;
  azure?: Readonly<{
    organization?: string;
    project?: string;
    work_item_type?: AzureWorkItemType;
    parent_id?: number;
    area_path?: string;
    iteration_path?: string;
    tags?: readonly string[];
    pat?: string;
  }>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof defaultSpawn;
}>;

/**
 * Create an issue or work item via the appropriate CLI.
 * Returns a normalized IngestRemoteRef.
 */
export async function createProviderIssue(
  params: CreateProviderIssueParams,
): Promise<IngestRemoteRef> {
  if (params.provider === 'github') {
    return createGitHubIssueAdapter(params);
  }
  return createAzureWorkItem(params);
}

async function createGitHubIssueAdapter(
  params: CreateProviderIssueParams,
): Promise<IngestRemoteRef> {
  try {
    const result = await createGitHubIssue({
      repo: params.repo,
      title: params.title,
      body: params.body,
      labels: params.labels ? [...params.labels] : undefined,
      assignees: params.assignees ? [...params.assignees] : undefined,
      milestone: params.milestone,
      cwd: params.cwd,
      env: params.env,
    });

    // Parse issue number from URL for the ID
    const issueRef = result.issue_ref;
    let id = '';
    if (issueRef) {
      const hashIdx = issueRef.lastIndexOf('#');
      if (hashIdx >= 0) {
        id = issueRef.slice(hashIdx + 1);
      }
    }
    if (!id) {
      // Try to extract from URL
      const urlParts = result.issue_url.split('/');
      id = urlParts[urlParts.length - 1] ?? '';
    }

    return {
      id,
      url: result.issue_url,
      title: params.title,
      kind: 'issue' as RemoteItemKind,
    };
  } catch (err) {
    throw mapGhErrorToAdapter(err);
  }
}

async function createAzureWorkItem(
  params: CreateProviderIssueParams,
): Promise<IngestRemoteRef> {
  const azure = params.azure;
  const org = azure?.organization ?? '';
  const project = azure?.project ?? '';
  const workItemType = azure?.work_item_type ?? 'User Story';
  const pat = azure?.pat;

  const args: string[] = [
    'boards',
    'work-item',
    'create',
    '--organization',
    org,
    '--project',
    project,
    '--type',
    workItemType,
    '--title',
    params.title,
    '--description',
    params.body,
    '--output',
    'json',
  ];

  // Optional fields
  const fields: string[] = [];
  if (azure?.parent_id !== undefined) {
    fields.push(`System.Parent=${azure.parent_id}`);
  }
  if (azure?.area_path) {
    fields.push(`System.AreaPath=${azure.area_path}`);
  }
  if (azure?.iteration_path) {
    fields.push(`System.IterationPath=${azure.iteration_path}`);
  }
  if (azure?.tags && azure.tags.length > 0) {
    fields.push(`System.Tags=${azure.tags.join('; ')}`);
  }
  if (fields.length > 0) {
    for (const field of fields) {
      args.push('--fields', field);
    }
  }

  const cmdSummary = formatCliArgs('az', args);
  const result = await spawnCliCommand('az', args, {
    cwd: params.cwd,
    env: buildAzureEnv(params.env, pat),
    spawnImpl: params.spawnImpl,
  });

  // Missing CLI
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

  // Non-zero exit
  if (result.exitCode !== 0) {
    throw mapAzError(result.stderr, pat, false, cmdSummary);
  }

  // Parse JSON output
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

  const id = String(parsed['id'] ?? '');
  const url = extractAzureWorkItemUrl(parsed, org, project, id);
  const title =
    extractAzureField(parsed, 'System.Title') ?? params.title;

  return {
    id,
    url,
    title,
    kind: 'work_item' as RemoteItemKind,
  };
}

// ============================================================================
// Issue/Work-Item Lookup
// ============================================================================

/** Parameters for looking up an existing issue/work-item. */
export type LookupExistingIssueParams = Readonly<{
  provider: IssueProvider;
  repo: string;
  id: string;
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
 * Look up an existing issue or work item by ID.
 * Returns a normalized IngestRemoteRef.
 */
export async function lookupExistingIssue(
  params: LookupExistingIssueParams,
): Promise<IngestRemoteRef> {
  if (params.provider === 'github') {
    return lookupGitHubIssue(params);
  }
  return lookupAzureWorkItem(params);
}

async function lookupGitHubIssue(
  params: LookupExistingIssueParams,
): Promise<IngestRemoteRef> {
  const args = [
    'issue',
    'view',
    params.id,
    '--repo',
    params.repo,
    '--json',
    'number,url,title',
  ];

  const result = await spawnCliCommand('gh', args, {
    cwd: params.cwd,
    env: params.env,
    spawnImpl: params.spawnImpl,
  });

  // Missing CLI
  if (result.exitCode === null && result.signal === null) {
    throw new ProviderAdapterError({
      status: 500,
      code: 'missing_cli',
      message:
        'GitHub CLI (gh) is not installed or not found in PATH on the viewer-server host.',
    });
  }

  // Non-zero exit
  if (result.exitCode !== 0) {
    throw mapGhStderrToAdapter(result.stderr);
  }

  // Parse JSON output
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new ProviderAdapterError({
      status: 500,
      code: 'io_error',
      message: 'Failed to parse GitHub CLI output as JSON.',
    });
  }

  const number = String(parsed['number'] ?? params.id);
  const url = String(parsed['url'] ?? '');
  const title = String(parsed['title'] ?? '');

  return {
    id: number,
    url,
    title,
    kind: 'issue' as RemoteItemKind,
  };
}

async function lookupAzureWorkItem(
  params: LookupExistingIssueParams,
): Promise<IngestRemoteRef> {
  const azure = params.azure;
  const org = azure?.organization ?? '';
  const project = azure?.project ?? '';
  const pat = azure?.pat;

  // az boards work-item show does not accept --project; work items are
  // identified by --id alone (IDs are org-scoped).
  const args = [
    'boards',
    'work-item',
    'show',
    '--organization',
    org,
    '--id',
    params.id,
    '--output',
    'json',
  ];

  const cmdSummary = formatCliArgs('az', args);
  const result = await spawnCliCommand('az', args, {
    cwd: params.cwd,
    env: buildAzureEnv(params.env, pat),
    spawnImpl: params.spawnImpl,
  });

  // Missing CLI
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

  // Non-zero exit
  if (result.exitCode !== 0) {
    throw mapAzError(result.stderr, pat, false, cmdSummary);
  }

  // Parse JSON output
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

  const id = String(parsed['id'] ?? params.id);
  const url = extractAzureWorkItemUrl(parsed, org, project, id);
  const title = extractAzureField(parsed, 'System.Title') ?? '';

  return {
    id,
    url,
    title,
    kind: 'work_item' as RemoteItemKind,
  };
}

// ============================================================================
// Azure Hierarchy Fetch
// ============================================================================

/** Parameters for fetching Azure work-item hierarchy. */
export type FetchAzureHierarchyParams = Readonly<{
  organization: string;
  project: string;
  id: string;
  pat?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof defaultSpawn;
}>;

/**
 * Fetch hierarchy (parent/children) for an Azure DevOps work item.
 * Returns an IngestHierarchy with resolved parent and children refs.
 */
export async function fetchAzureHierarchy(
  params: FetchAzureHierarchyParams,
): Promise<IngestHierarchy> {
  const { organization, project, id, pat } = params;

  // az boards work-item show does not accept --project; work items are
  // identified by --id alone (IDs are org-scoped).
  const args = [
    'boards',
    'work-item',
    'show',
    '--organization',
    organization,
    '--id',
    id,
    '--expand',
    'relations',
    '--output',
    'json',
  ];

  const cmdSummary = formatCliArgs('az', args);
  const result = await spawnCliCommand('az', args, {
    cwd: params.cwd,
    env: buildAzureEnv(params.env, pat),
    spawnImpl: params.spawnImpl,
  });

  // Missing CLI
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

  const relations = Array.isArray(parsed['relations'])
    ? (parsed['relations'] as Record<string, unknown>[])
    : [];

  let parent: HierarchyItemRef | null = null;
  const children: HierarchyItemRef[] = [];

  for (const rel of relations) {
    const relType = String(rel['rel'] ?? '');
    const relUrl = String(rel['url'] ?? '');

    if (
      relType === 'System.LinkTypes.Hierarchy-Reverse' &&
      parent === null
    ) {
      // Parent relation — try to resolve
      const parentRef = await resolveWorkItemFromApiUrl(relUrl, {
        organization,
        project,
        pat,
        cwd: params.cwd,
        env: params.env,
        spawnImpl: params.spawnImpl,
      });
      if (parentRef) {
        parent = parentRef;
      }
    } else if (relType === 'System.LinkTypes.Hierarchy-Forward') {
      // Child relation
      const childRef = await resolveWorkItemFromApiUrl(relUrl, {
        organization,
        project,
        pat,
        cwd: params.cwd,
        env: params.env,
        spawnImpl: params.spawnImpl,
      });
      if (childRef) {
        children.push(childRef);
      }
    }
  }

  return { parent, children };
}

/**
 * Resolve a work item from an Azure API URL (extract ID and fetch details).
 * Returns null if the resolution fails (non-fatal for partial hierarchy).
 */
async function resolveWorkItemFromApiUrl(
  apiUrl: string,
  opts: {
    organization: string;
    project: string;
    pat?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    spawnImpl?: typeof defaultSpawn;
  },
): Promise<HierarchyItemRef | null> {
  // Extract work item ID from Azure API URL
  // Format: https://dev.azure.com/<org>/<project>/_apis/wit/workItems/<id>
  const idMatch = apiUrl.match(/\/workItems\/(\d+)/i);
  if (!idMatch) return null;
  const itemId = idMatch[1];

  try {
    const ref = await lookupAzureWorkItem({
      provider: 'azure_devops',
      repo: '',
      id: itemId,
      azure: {
        organization: opts.organization,
        project: opts.project,
        pat: opts.pat,
      },
      cwd: opts.cwd,
      env: opts.env,
      spawnImpl: opts.spawnImpl,
    });

    return {
      id: ref.id,
      title: ref.title,
      url: ref.url,
    };
  } catch {
    // Non-fatal — partial hierarchy is acceptable
    return null;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Type guard for Node.js errors with a code property. */
function isNodeError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && 'code' in err;
}

/**
 * Extract the HTML URL for an Azure work item from the parsed JSON.
 * Tries _links.html.href first, then constructs from org/project/id.
 */
function extractAzureWorkItemUrl(
  parsed: Record<string, unknown>,
  org: string,
  project: string,
  id: string,
): string {
  // Try _links.html.href
  const links = parsed['_links'] as Record<string, unknown> | undefined;
  if (links) {
    const html = links['html'] as Record<string, unknown> | undefined;
    if (html && typeof html['href'] === 'string') {
      return html['href'] as string;
    }
  }

  // Try direct url field
  if (typeof parsed['url'] === 'string') {
    const apiUrl = parsed['url'] as string;
    // Convert API URL to HTML URL if it looks like an API URL
    if (apiUrl.includes('/_apis/')) {
      return `${org.replace(/\/$/, '')}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
    }
    return apiUrl;
  }

  // Construct from known values
  return `${org.replace(/\/$/, '')}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

/**
 * Extract a field value from Azure work item JSON fields object.
 */
function extractAzureField(
  parsed: Record<string, unknown>,
  fieldName: string,
): string | undefined {
  const fields = parsed['fields'] as
    | Record<string, unknown>
    | undefined;
  if (fields && typeof fields[fieldName] === 'string') {
    return fields[fieldName] as string;
  }
  return undefined;
}

// Re-export for use by providerPrAdapter.ts
export { parseIssueRefFromUrl };
