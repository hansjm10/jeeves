import fs from 'node:fs/promises';
import path from 'node:path';

import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import {
  loadWorkflowByName,
  parseWorkflowObject,
  parseWorkflowYaml,
  parseRepoSpec,
  resolveDataDir,
  toRawWorkflowJson,
  toWorkflowYaml,
  getIssueStateDir,
  getWorktreePath,
} from '@jeeves/core';
import Fastify from 'fastify';

import { clearActiveIssue, loadActiveIssue, saveActiveIssue } from './activeIssue.js';
import {
  cachePromptInStore,
  cacheWorkflowInStore,
  listPromptIdsFromStore,
  listWorkflowNamesFromStore,
  readPromptFromStore,
  readWorkflowYamlFromStore,
  writePromptToStore,
  writeWorkflowToStore,
} from './contentStore.js';
import { EventHub } from './eventHub.js';
import { CreateGitHubIssueError, createGitHubIssue as defaultCreateGitHubIssue } from './githubIssueCreate.js';
import { initIssue } from './init.js';
import { runIssueExpand, buildSuccessResponse } from './issueExpand.js';
import { listIssueJsonStates, readIssueJson, readIssueJsonUpdatedAtMs, writeIssueJson } from './issueJson.js';
import { findRepoRoot } from './repoRoot.js';
import { RunManager } from './runManager.js';
import {
  getDbHealth,
  getLatestRunIdForStateDir,
  listRunLogLines,
  listRunSdkEvents,
  runDbBackup,
  runDbIntegrityCheck,
  runDbVacuum,
} from './sqliteStorage.js';
import { reconcileStartupState } from './startupReconcile.js';
import { reconcileAzureDevopsToWorktree } from './azureDevopsReconcile.js';
import { readAzureDevopsSecret, writeAzureDevopsSecret, deleteAzureDevopsSecret, AzureDevopsSecretReadError } from './azureDevopsSecret.js';
import {
  validatePutAzureDevopsRequest,
  validatePatchAzureDevopsRequest,
  validateReconcileAzureDevopsRequest,
  validateCreateProviderIssueRequest,
  validateInitFromExistingRequest,
  sanitizePatFromMessage,
  AZURE_PAT_ENV_VAR_NAME,
  type AzureDevopsStatus,
  type AzureDevopsSyncStatus,
  type AzureDevopsStatusEvent,
  type AzureDevopsOperation,
  type IngestResponse,
  type IssueIngestStatusEvent,
  type IngestRemoteRef,
  type IngestHierarchy,
} from './azureDevopsTypes.js';
import { reconcileSonarTokenToWorktree } from './sonarTokenReconcile.js';
import { readSonarTokenSecret, writeSonarTokenSecret, deleteSonarTokenSecret, SonarTokenSecretReadError } from './sonarTokenSecret.js';
import {
  validatePutRequest,
  validateReconcileRequest,
  sanitizeErrorForUi,
  DEFAULT_ENV_VAR_NAME,
  type SonarTokenStatus,
  type SonarSyncStatus,
} from './sonarTokenTypes.js';
import { reconcileProjectFilesToWorktree } from './projectFilesReconcile.js';
import {
  listProjectFiles,
  upsertProjectFile,
  deleteProjectFile,
  getRepoProjectFilesDir,
} from './projectFilesStore.js';
import {
  validatePutProjectFileRequest,
  validateDeleteProjectFileId,
  validateReconcileProjectFilesRequest,
  toProjectFilePublic,
  type ProjectFilesSyncStatus,
  type ProjectFilesStatus,
  type ProjectFilesStatusEvent,
  type ProjectFilesOperation,
} from './projectFilesTypes.js';
import { resolveWorkerArtifactsRunId } from './workerArtifacts.js';
import { WorkerTailerManager } from './workerTailers.js';
import {
  cleanupStaleArtifacts,
  detectRecovery,
  acquireLock,
  releaseLock,
  createJournal,
  updateJournalState,
  updateJournalCheckpoint,
  finalizeJournal,
  generateOperationId,
} from './providerOperationJournal.js';
import {
  createProviderIssue as defaultCreateProviderIssue,
  lookupExistingIssue as defaultLookupExistingIssue,
  fetchAzureHierarchy as defaultFetchAzureHierarchy,
  ProviderAdapterError,
} from './providerIssueAdapter.js';
import {
  writeIssueSource,
  writeIssueIngestStatus,
  type IssueSource,
  type IssueIngestStatus,
} from './providerIssueState.js';
import type { CreateGitHubIssueAdapter, CreateProviderIssueAdapter, LookupExistingIssueAdapter, FetchAzureHierarchyAdapter } from './types.js';

function isLocalAddress(addr: string | undefined | null): boolean {
  const a = (addr ?? '').trim();
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function parseAllowedOriginsFromEnv(): Set<string> {
  const raw = (process.env.JEEVES_VIEWER_ALLOWED_ORIGINS ?? '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function getRemoteAddress(req: import('fastify').FastifyRequest): string | null {
  return req.socket.remoteAddress ?? null;
}

function parseEnvBool(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parseEnvInt(
  value: string | undefined,
  fallback: number,
  opts?: { min?: number; max?: number },
): number {
  const raw = (value ?? '').trim();
  const n = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  let out = Math.trunc(n);
  if (opts?.min !== undefined) out = Math.max(opts.min, out);
  if (opts?.max !== undefined) out = Math.min(opts.max, out);
  return out;
}

function splitHostHeader(hostHeader: string): { hostname: string; port: number | null } {
  const host = hostHeader.trim();
  if (!host) return { hostname: '', port: null };
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return { hostname: host.toLowerCase(), port: null };
    const hostname = host.slice(1, end).toLowerCase();
    const rest = host.slice(end + 1);
    if (!rest.startsWith(':')) return { hostname, port: null };
    const portRaw = rest.slice(1).trim();
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0) return { hostname, port: null };
    return { hostname, port };
  }
  const lastColon = host.lastIndexOf(':');
  if (lastColon === -1) return { hostname: host.toLowerCase(), port: null };
  const hostname = host.slice(0, lastColon).toLowerCase();
  const portRaw = host.slice(lastColon + 1).trim();
  if (!portRaw) return { hostname: host.toLowerCase(), port: null };
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) return { hostname: host.toLowerCase(), port: null };
  return { hostname, port };
}

function isSameOrigin(req: import('fastify').FastifyRequest, origin: string): boolean {
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const proto = parsed.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') return false;

  const { hostname, port } = splitHostHeader(hostHeader);
  if (!hostname) return false;
  if (parsed.hostname.trim().toLowerCase() !== hostname) return false;

  const originPort = parsed.port ? Number(parsed.port) : (proto === 'https:' ? 443 : 80);
  if (!Number.isInteger(originPort) || originPort <= 0) return false;

  const reqPort = port ?? req.socket.localPort ?? null;
  if (typeof reqPort !== 'number' || !Number.isInteger(reqPort) || reqPort <= 0) return false;
  return originPort === reqPort;
}

function isAllowedOrigin(
  req: import('fastify').FastifyRequest,
  origin: string,
  allowlist: ReadonlySet<string>,
): boolean {
  const o = origin.trim();
  if (!o) return false;
  if (o === 'null') return false;
  if (allowlist.has(o)) return true;
  return isSameOrigin(req, o);
}

function isBodyRecord(body: unknown): body is Record<string, unknown> {
  return Boolean(body) && typeof body === 'object' && !Array.isArray(body);
}

function getBody(req: import('fastify').FastifyRequest): Record<string, unknown> {
  return isBodyRecord(req.body) ? req.body : {};
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) return null;
    return value;
  }
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }
  return null;
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v ? v : undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return undefined;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function parseOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  }
  return undefined;
}

function parseAzureWorkItemIdFromUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const isAzureHost = host === 'dev.azure.com' || host.endsWith('.visualstudio.com');
  if (!isAzureHost) return null;

  const pathMatch = parsed.pathname.match(/\/(?:_workitems\/edit|_apis\/wit\/workitems)\/(\d+)(?:\/|$)/i);
  if (pathMatch) return pathMatch[1];

  const queryId = parsed.searchParams.get('id');
  if (queryId && /^[1-9][0-9]*$/.test(queryId)) return queryId;

  return null;
}

function parseOwnerRepoFromIssueRef(issueRef: string): { owner: string; repo: string } {
  const hashIndex = issueRef.indexOf('#');
  if (hashIndex <= 0) throw new Error(`invalid issue ref: ${issueRef}`);
  const repoPart = issueRef.slice(0, hashIndex);
  const parsed = parseRepoSpec(repoPart);
  return { owner: parsed.owner, repo: parsed.repo };
}

function errorToHttp(err: unknown): { status: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('worktree already exists')) return { status: 409, message };
  if (message.includes('issue.json not found')) return { status: 404, message };
  return { status: 400, message };
}

function normalizePromptId(promptId: string): string {
  return promptId.split('\\').join('/');
}

function getWorkflowNameParamInfo(raw: string): { name: string; fileName: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes('\0')) return null;
  // Prevent path traversal or directory separators.
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return null;

  if (trimmed.endsWith('.yaml')) {
    const name = trimmed.slice(0, -'.yaml'.length);
    if (!name) return null;
    return { name, fileName: trimmed };
  }
  return { name: trimmed, fileName: `${trimmed}.yaml` };
}

function isValidWorkflowName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
}

function isSafePromptId(promptId: string): boolean {
  if (!promptId.trim()) return false;
  if (promptId.includes('\0')) return false;
  const normalized = normalizePromptId(promptId);
  if (normalized.startsWith('/')) return false;
  if (normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) return false;
  return true;
}

async function ensureNoSymlinkParents(baseDir: string, relPath: string): Promise<void> {
  const parts = normalizePromptId(relPath).split('/').filter(Boolean);
  let current = baseDir;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw new Error('Refusing to traverse symlinked path segment.');
    }
  }
}

async function resolvePromptPathForRead(promptsDir: string, promptId: string): Promise<string> {
  if (!isSafePromptId(promptId)) throw new Error('Invalid prompt id.');
  const baseDir = path.resolve(promptsDir);
  const normalized = normalizePromptId(promptId);
  if (!normalized.endsWith('.md')) throw new Error('Prompt id must end with .md');

  const candidate = path.resolve(baseDir, normalized);
  const rel = path.relative(baseDir, candidate);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid prompt path.');

  const baseReal = await fs.realpath(baseDir);
  const candidateReal = await fs.realpath(candidate);
  const relReal = path.relative(baseReal, candidateReal);
  if (!relReal || relReal.startsWith('..') || path.isAbsolute(relReal)) throw new Error('Invalid prompt path.');

  const stat = await fs.stat(candidateReal);
  if (!stat.isFile()) throw new Error('Prompt is not a file.');
  return candidateReal;
}

async function resolvePromptPathForWrite(promptsDir: string, promptId: string): Promise<string> {
  if (!isSafePromptId(promptId)) throw new Error('Invalid prompt id.');
  const baseDir = path.resolve(promptsDir);
  const normalized = normalizePromptId(promptId);
  if (!normalized.endsWith('.md')) throw new Error('Prompt id must end with .md');

  const candidate = path.resolve(baseDir, normalized);
  const rel = path.relative(baseDir, candidate);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid prompt path.');

  const parentRel = normalizePromptId(path.posix.dirname(normalized));
  if (parentRel && parentRel !== '.') {
    await ensureNoSymlinkParents(baseDir, parentRel);
  }

  const existing = await fs.lstat(candidate).catch(() => null);
  if (existing?.isSymbolicLink()) throw new Error('Refusing to write to a symlink.');
  if (existing) {
    const baseReal = await fs.realpath(baseDir);
    const candidateReal = await fs.realpath(candidate);
    const relReal = path.relative(baseReal, candidateReal);
    if (!relReal || relReal.startsWith('..') || path.isAbsolute(relReal)) throw new Error('Invalid prompt path.');
    return candidateReal;
  }
  return candidate;
}

function emitSdkSnapshot(send: (event: string, data: unknown) => void, snapshot: Record<string, unknown>): void {
  const sessionId = typeof snapshot.session_id === 'string' ? snapshot.session_id : null;
  if (sessionId) {
    send('sdk-init', {
      session_id: sessionId,
      started_at: snapshot.started_at,
      status: snapshot.ended_at ? 'complete' : 'running',
    });
  }

  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  for (let i = 0; i < messages.length; i += 1) {
    send('sdk-message', { message: messages[i], index: i, total: messages.length });
  }

  const toolCalls = Array.isArray(snapshot.tool_calls) ? snapshot.tool_calls : [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue;
    const toolUseId = (tc as { tool_use_id?: unknown }).tool_use_id;
    const name = (tc as { name?: unknown }).name;
    const input = (tc as { input?: unknown }).input;
    if (typeof toolUseId !== 'string') continue;
    send('sdk-tool-start', { tool_use_id: toolUseId, name, input: input ?? {} });
    const durationMs = (tc as { duration_ms?: unknown }).duration_ms;
    const isError = (tc as { is_error?: unknown }).is_error;
    const responseText = (tc as { response_text?: unknown }).response_text;
    const responseTruncated = (tc as { response_truncated?: unknown }).response_truncated;
    if (durationMs !== undefined || isError !== undefined) {
      send('sdk-tool-complete', {
        tool_use_id: toolUseId,
        name,
        duration_ms: durationMs ?? 0,
        is_error: isError ?? false,
        ...(responseText !== undefined ? { response_text: responseText } : {}),
        ...(responseTruncated !== undefined ? { response_truncated: responseTruncated } : {}),
      });
    }
  }

  if (snapshot.ended_at) {
    send('sdk-complete', {
      status: snapshot.success === false ? 'error' : 'success',
      summary: snapshot.stats ?? {},
    });
  }
}

export type ViewerServerConfig = Readonly<{
  port: number;
  host: string;
  allowRemoteRun: boolean;
  repoRoot?: string;
  promptsDir?: string;
  workflowsDir?: string;
  dataDir?: string;
  initialIssue?: string;
  createGitHubIssue?: CreateGitHubIssueAdapter;
  /** Mutex timeout for sonar token operations (ms). Default: 1500. For testing only. */
  sonarTokenMutexTimeoutMs?: number;
  /** Mutex timeout for Azure DevOps credential operations (ms). Default: 1500. For testing only. */
  azureDevopsMutexTimeoutMs?: number;
  /** Mutex timeout for project files operations (ms). Default: 1500. For testing only. */
  projectFilesMutexTimeoutMs?: number;
  /** Provider issue create adapter override. For testing only. */
  createProviderIssue?: CreateProviderIssueAdapter;
  /** Provider issue lookup adapter override. For testing only. */
  lookupExistingIssue?: LookupExistingIssueAdapter;
  /** Azure hierarchy fetch adapter override. For testing only. */
  fetchAzureHierarchy?: FetchAzureHierarchyAdapter;
  /** File-level lock timeout for provider operations (ms). Default: 30000. For testing only. */
  providerOperationLockTimeoutMs?: number;
}>;

export async function buildServer(config: ViewerServerConfig) {
  const repoRoot = config.repoRoot ?? (await findRepoRoot(process.cwd()));
  const dataDir = config.dataDir ?? resolveDataDir();
  const promptsDir = config.promptsDir ?? path.join(repoRoot, 'prompts');
  const workflowsDir = config.workflowsDir ?? path.join(repoRoot, 'workflows');
  const createGitHubIssue = config.createGitHubIssue ?? defaultCreateGitHubIssue;
  const createProviderIssue = config.createProviderIssue ?? defaultCreateProviderIssue;
  const lookupExistingIssue = config.lookupExistingIssue ?? defaultLookupExistingIssue;
  const fetchAzureHierarchy = config.fetchAzureHierarchy ?? defaultFetchAzureHierarchy;
  const providerOpLockTimeoutMs = config.providerOperationLockTimeoutMs ?? 30_000;

  const allowRemoteRun = config.allowRemoteRun || parseEnvBool(process.env.JEEVES_VIEWER_ALLOW_REMOTE_RUN);
  const allowedOrigins = parseAllowedOriginsFromEnv();
  const pollMs = parseEnvInt(process.env.JEEVES_VIEWER_POLL_MS, 150, { min: 25, max: 10_000 });
  const logSnapshotLines = parseEnvInt(process.env.JEEVES_VIEWER_LOG_TAIL_LINES, 500, { min: 0, max: 10_000 });
  const viewerLogSnapshotLines = parseEnvInt(process.env.JEEVES_VIEWER_VIEWER_LOG_TAIL_LINES, 500, { min: 0, max: 10_000 });

  const hub = new EventHub();
  const app = Fastify({ logger: false });
  // CORS is opt-in. Same-origin requests do not require CORS headers.
  if (allowedOrigins.size) {
    await app.register(cors, {
      origin: (origin, cb) => {
        if (!origin) return cb(null, false);
        return cb(null, allowedOrigins.has(origin));
      },
    });
  }
  await app.register(websocket);

  const runManager = new RunManager({
    promptsDir,
    workflowsDir,
    repoRoot,
    dataDir,
    broadcast: (event, data) => hub.broadcast(event, data),
  });

  // ============================================================================
  // Sonar Token Mutex (must be declared early for startup reconcile)
  // ============================================================================

  /** Mutex timeout for sonar token operations (ms). */
  const SONAR_TOKEN_MUTEX_TIMEOUT_MS = config.sonarTokenMutexTimeoutMs ?? 1500;

  /** Per-issue mutex map for sonar token operations. */
  const sonarTokenMutexes = new Map<string, { locked: boolean; waiters: ((acquired: boolean) => void)[] }>();

  /** Acquire mutex for issue - returns true if acquired, false if timed out. */
  async function acquireSonarTokenMutex(issueRef: string): Promise<boolean> {
    let mutex = sonarTokenMutexes.get(issueRef);
    if (!mutex) {
      mutex = { locked: false, waiters: [] };
      sonarTokenMutexes.set(issueRef, mutex);
    }

    if (!mutex.locked) {
      mutex.locked = true;
      return true;
    }

    // Wait for mutex with timeout
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // Remove ourselves from the waiter queue
        const idx = mutex!.waiters.indexOf(waiterCallback);
        if (idx !== -1) mutex!.waiters.splice(idx, 1);
        resolve(false);
      }, SONAR_TOKEN_MUTEX_TIMEOUT_MS);

      const waiterCallback = (acquired: boolean) => {
        clearTimeout(timer);
        resolve(acquired);
      };

      mutex!.waiters.push(waiterCallback);
    });
  }

  /** Release mutex for issue. */
  function releaseSonarTokenMutex(issueRef: string): void {
    const mutex = sonarTokenMutexes.get(issueRef);
    if (!mutex) return;

    if (mutex.waiters.length > 0) {
      // Pass to next waiter
      const next = mutex.waiters.shift();
      if (next) next(true);
    } else {
      mutex.locked = false;
    }
  }

  // ── Azure DevOps credential mutex (same pattern as sonar token) ──
  const AZURE_DEVOPS_MUTEX_TIMEOUT_MS = config.azureDevopsMutexTimeoutMs ?? 1500;
  const azureDevopsMutexes = new Map<string, { locked: boolean; waiters: ((acquired: boolean) => void)[] }>();

  /**
   * Acquire a per-issue mutex for Azure DevOps credential operations.
   * Returns true if acquired, false on timeout.
   */
  async function acquireAzureDevopsMutex(issueRef: string): Promise<boolean> {
    let mutex = azureDevopsMutexes.get(issueRef);
    if (!mutex) {
      mutex = { locked: false, waiters: [] };
      azureDevopsMutexes.set(issueRef, mutex);
    }

    if (!mutex.locked) {
      mutex.locked = true;
      return true;
    }

    // Wait for mutex with timeout
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = mutex!.waiters.indexOf(waiterCallback);
        if (idx !== -1) mutex!.waiters.splice(idx, 1);
        resolve(false);
      }, AZURE_DEVOPS_MUTEX_TIMEOUT_MS);

      const waiterCallback = (acquired: boolean) => {
        clearTimeout(timer);
        resolve(acquired);
      };

      mutex!.waiters.push(waiterCallback);
    });
  }

  /** Release Azure DevOps mutex for issue. */
  function releaseAzureDevopsMutex(issueRef: string): void {
    const mutex = azureDevopsMutexes.get(issueRef);
    if (!mutex) return;

    if (mutex.waiters.length > 0) {
      const next = mutex.waiters.shift();
      if (next) next(true);
    } else {
      mutex.locked = false;
    }
  }

  // ── Project files mutex (repo-scoped) ──
  const PROJECT_FILES_MUTEX_TIMEOUT_MS = config.projectFilesMutexTimeoutMs ?? 1500;
  const projectFilesMutexes = new Map<string, { locked: boolean; waiters: ((acquired: boolean) => void)[] }>();

  async function acquireProjectFilesMutex(repoRef: string): Promise<boolean> {
    let mutex = projectFilesMutexes.get(repoRef);
    if (!mutex) {
      mutex = { locked: false, waiters: [] };
      projectFilesMutexes.set(repoRef, mutex);
    }

    if (!mutex.locked) {
      mutex.locked = true;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = mutex!.waiters.indexOf(waiterCallback);
        if (idx !== -1) mutex!.waiters.splice(idx, 1);
        resolve(false);
      }, PROJECT_FILES_MUTEX_TIMEOUT_MS);

      const waiterCallback = (acquired: boolean) => {
        clearTimeout(timer);
        resolve(acquired);
      };

      mutex!.waiters.push(waiterCallback);
    });
  }

  function releaseProjectFilesMutex(repoRef: string): void {
    const mutex = projectFilesMutexes.get(repoRef);
    if (!mutex) return;

    if (mutex.waiters.length > 0) {
      const next = mutex.waiters.shift();
      if (next) next(true);
    } else {
      mutex.locked = false;
    }
  }

  // ============================================================================
  // Provider Operation File Lock Helper
  // ============================================================================

  /**
   * Acquire the per-issue file-level provider operation lock with retry-on-stale.
   * Returns `{ acquired: true, operationId }` or `{ acquired: false }`.
   */
  async function acquireProviderOperationLock(
    issueStateDir: string,
    issueRef: string,
  ): Promise<{ acquired: true; operationId: string } | { acquired: false }> {
    const operationId = generateOperationId();
    const lockResult = await acquireLock(issueStateDir, {
      operation_id: operationId,
      issue_ref: issueRef,
      timeout_ms: providerOpLockTimeoutMs,
    });
    if (lockResult.acquired) {
      return { acquired: true, operationId };
    }
    if (lockResult.reason === 'stale_cleaned') {
      // Retry once after stale cleanup
      const retry = await acquireLock(issueStateDir, {
        operation_id: operationId,
        issue_ref: issueRef,
        timeout_ms: providerOpLockTimeoutMs,
      });
      if (retry.acquired) {
        return { acquired: true, operationId };
      }
    }
    return { acquired: false };
  }

  const workerTailerManager = new WorkerTailerManager();

  let currentStateDir: string | null = null;
  let currentRunId: string | null = null;
  let canonicalLogCursor = 0;
  let viewerLogCursor = 0;
  let sdkCursor = 0;
  let cachedIssueJsonStateDir: string | null = null;
  let cachedIssueJsonMtimeMs = 0;
  let cachedIssueJson: Record<string, unknown> | null = null;
  let warnedMissingWorkerArtifactsRunId = false;

  async function readIssueJsonCached(stateDir: string): Promise<Record<string, unknown> | null> {
    const updatedAtMs = await readIssueJsonUpdatedAtMs(stateDir);
    if (updatedAtMs <= 0) {
      cachedIssueJsonStateDir = stateDir;
      cachedIssueJsonMtimeMs = 0;
      cachedIssueJson = null;
      return null;
    }

    if (cachedIssueJsonStateDir === stateDir && updatedAtMs === cachedIssueJsonMtimeMs) {
      return cachedIssueJson;
    }

    cachedIssueJsonStateDir = stateDir;
    cachedIssueJsonMtimeMs = updatedAtMs;
    cachedIssueJson = await readIssueJson(stateDir);
    return cachedIssueJson;
  }

  function resolveCurrentRunId(stateDir: string | null): string | null {
    const runStatus = runManager.getStatus();
    const statusRunId = runStatus.run_id;
    if (runStatus.running && typeof statusRunId === 'string' && statusRunId.trim().length > 0) {
      return statusRunId.trim();
    }
    if (!stateDir) return null;
    return getLatestRunIdForStateDir(dataDir, stateDir);
  }

  function listLogSnapshotLines(params: {
    runId: string | null;
    scope: string;
    maxLines: number;
  }): { lines: string[]; cursor: number } {
    if (!params.runId) return { lines: [], cursor: 0 };
    if (params.maxLines <= 0) return { lines: [], cursor: 0 };
    const rows = listRunLogLines({
      dataDir,
      runId: params.runId,
      scope: params.scope,
      stream: 'log',
      afterId: 0,
      limit: Math.max(params.maxLines * 4, params.maxLines),
    });
    const tailRows = rows.length > params.maxLines ? rows.slice(rows.length - params.maxLines) : rows;
    const cursor = tailRows[tailRows.length - 1]?.id ?? 0;
    return { lines: tailRows.map((row) => row.line), cursor };
  }

  function replaySdkRowsToClient(
    send: (event: string, data: unknown) => void,
    rows: readonly { id: number; event: Record<string, unknown> }[],
  ): number {
    let latest = 0;
    for (const row of rows) {
      latest = row.id;
      const eventName = typeof row.event.event === 'string' ? row.event.event.trim() : '';
      if (!eventName) continue;
      const eventData = Object.prototype.hasOwnProperty.call(row.event, 'data')
        ? row.event.data
        : {};
      send(eventName, eventData);
    }
    return latest;
  }

  async function refreshRunTargets(): Promise<void> {
    const stateDir = runManager.getIssue().stateDir;
    const runId = resolveCurrentRunId(stateDir);
    if (stateDir !== currentStateDir || runId !== currentRunId) {
      currentStateDir = stateDir;
      currentRunId = runId;
      cachedIssueJsonStateDir = null;
      cachedIssueJsonMtimeMs = 0;
      cachedIssueJson = null;
      warnedMissingWorkerArtifactsRunId = false;

      const canonicalSnapshot = listLogSnapshotLines({
        runId,
        scope: 'canonical',
        maxLines: logSnapshotLines,
      });
      canonicalLogCursor = canonicalSnapshot.cursor;
      hub.broadcast('logs', { lines: canonicalSnapshot.lines, reset: true });

      const viewerSnapshot = listLogSnapshotLines({
        runId,
        scope: 'viewer',
        maxLines: viewerLogSnapshotLines,
      });
      viewerLogCursor = viewerSnapshot.cursor;
      hub.broadcast('viewer-logs', { lines: viewerSnapshot.lines, reset: true });

      const sdkRows = runId
        ? listRunSdkEvents({
            dataDir,
            runId,
            scope: 'canonical',
            afterId: 0,
            limit: 5000,
          })
        : [];
      sdkCursor = replaySdkRowsToClient(
        (event, data) => hub.broadcast(event, data),
        sdkRows.map((row) => ({ id: row.id, event: row.event })),
      );
    }
  }

  function sendCurrentRunSnapshotToClient(clientId: number): void {
    const canonicalSnapshot = listLogSnapshotLines({
      runId: currentRunId,
      scope: 'canonical',
      maxLines: logSnapshotLines,
    });
    hub.sendTo(clientId, 'logs', { lines: canonicalSnapshot.lines, reset: true });

    const viewerSnapshot = listLogSnapshotLines({
      runId: currentRunId,
      scope: 'viewer',
      maxLines: viewerLogSnapshotLines,
    });
    hub.sendTo(clientId, 'viewer-logs', { lines: viewerSnapshot.lines, reset: true });

    const sdkRows = currentRunId
      ? listRunSdkEvents({
          dataDir,
          runId: currentRunId,
          scope: 'canonical',
          afterId: 0,
          limit: 5000,
        })
      : [];
    replaySdkRowsToClient(
      (event, data) => hub.sendTo(clientId, event, data),
      sdkRows.map((row) => ({ id: row.id, event: row.event })),
    );
  }

  async function getStateSnapshot(): Promise<Record<string, unknown>> {
    const issue = runManager.getIssue();
    const issueJson = issue.stateDir ? await readIssueJson(issue.stateDir) : null;
    return {
      issue_ref: issue.issueRef,
      paths: {
        dataDir,
        stateDir: issue.stateDir,
        workDir: issue.workDir,
        workflowsDir,
        promptsDir,
      },
      issue_json: issueJson,
      run: runManager.getStatus(),
    };
  }

  async function requireAllowedBrowserOrigin(
    req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ): Promise<void | import('fastify').FastifyReply> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (!origin) return;
    if (isAllowedOrigin(req, origin, allowedOrigins)) return;
    return reply.code(403).send({ ok: false, error: 'Origin not allowed' });
  }

  async function requireMutatingAllowed(req: import('fastify').FastifyRequest): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    if (allowRemoteRun) return { ok: true };
    const ip = getRemoteAddress(req);
    if (isLocalAddress(ip)) return { ok: true };
    return { ok: false, status: 403, error: 'This endpoint is only allowed from localhost. Restart with --allow-remote-run to enable it.' };
  }

  app.addHook('onRequest', async (req, reply) => {
    return requireAllowedBrowserOrigin(req, reply);
  });

  // Startup reconciliation: refresh prompt/workflow cache and verify selected DB-backed state.
  try {
    await reconcileStartupState({
      dataDir,
      promptsDir,
      workflowsDir,
      selectedStateDir: null,
    });
  } catch (err) {
    console.error(
      'Startup state reconciliation failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Initialize active issue selection
  const explicitIssue = config.initialIssue?.trim() || process.env.JEEVES_VIEWER_ISSUE?.trim();
  const saved = await loadActiveIssue(dataDir);
  const candidates = [explicitIssue, saved].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  for (const c of candidates) {
    try {
      await runManager.setIssue(c);
      await saveActiveIssue(dataDir, c);
      break;
    } catch {
      // ignore
    }
  }
  if (!runManager.getIssue().issueRef) {
    const issues = await listIssueJsonStates(dataDir);
    if (issues.length) {
      issues.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const latest = issues[issues.length - 1] ?? null;
      if (latest) {
        const ref = `${latest.owner}/${latest.repo}#${latest.issueNumber}`;
        try {
          await runManager.setIssue(ref);
          await saveActiveIssue(dataDir, ref);
        } catch {
          // ignore
        }
      }
    }
  }

  await refreshRunTargets();

  // Startup reconcile/cleanup: run best-effort reconcile for initially selected issue
  // This converges worktree artifacts, cleans up leftover .env.jeeves.tmp files,
  // and emits sonar-token-status event (Design §3 Worktree Filesystem Contracts).
  // Non-fatal: failures are surfaced via sync_status/last_error without blocking startup.
  const startupIssue = runManager.getIssue();
  if (startupIssue.issueRef && startupIssue.stateDir) {
    try {
      await autoReconcileSonarToken(startupIssue.issueRef, startupIssue.stateDir, startupIssue.workDir);
    } catch (err) {
      // Startup reconcile is best-effort: log error but don't block server startup
      // (e.g., disk full, permission errors on writeIssueJson)
      console.error(
        'Startup sonar token reconcile failed (non-fatal):',
        err instanceof Error ? err.message : String(err),
      );
    }

    // Startup Azure DevOps reconcile (best-effort, non-fatal)
    try {
      await autoReconcileAzureDevops(startupIssue.issueRef, startupIssue.stateDir, startupIssue.workDir);
    } catch (err) {
      console.error(
        'Startup Azure DevOps reconcile failed (non-fatal):',
        err instanceof Error ? err.message : String(err),
      );
    }

    // Startup project files reconcile (best-effort, non-fatal)
    try {
      await autoReconcileProjectFiles(startupIssue.issueRef, startupIssue.stateDir, startupIssue.workDir);
    } catch (err) {
      console.error(
        'Startup project files reconcile failed (non-fatal):',
        err instanceof Error ? err.message : String(err),
      );
    }

    // Startup recovery: clean stale provider operation artifacts (lock, journal, temp files).
    // Non-fatal: failures are logged without blocking server startup.
    try {
      await cleanupStaleArtifacts(startupIssue.stateDir);
    } catch (err) {
      console.error(
        'Startup provider operation cleanup failed (non-fatal):',
        err instanceof Error ? err.message : String(err),
      );
    }

    // Detect incomplete operations that need recovery and expose resumable checkpoint state.
    // Non-fatal: failures are logged without blocking server startup.
    try {
      const recovery = await detectRecovery(startupIssue.stateDir);
      if (recovery.needed) {
        console.warn(
          `Provider operation recovery needed: operation=${recovery.journal.operation_id} ` +
          `kind=${recovery.journal.kind} recovery_state=${recovery.recovery_state}`,
        );
      }
    } catch (err) {
      console.error(
        'Startup provider operation recovery detection failed (non-fatal):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Poll for log/sdk updates and file target changes
  async function pollTick(): Promise<void> {
    try {
      await refreshRunTargets();
      if (!currentStateDir) return;

      if (currentRunId) {
        const logRows = listRunLogLines({
          dataDir,
          runId: currentRunId,
          scope: 'canonical',
          stream: 'log',
          afterId: canonicalLogCursor,
          limit: 2000,
        });
        if (logRows.length > 0) {
          canonicalLogCursor = logRows[logRows.length - 1]?.id ?? canonicalLogCursor;
          hub.broadcast('logs', { lines: logRows.map((row) => row.line) });
        }

        const viewerRows = listRunLogLines({
          dataDir,
          runId: currentRunId,
          scope: 'viewer',
          stream: 'log',
          afterId: viewerLogCursor,
          limit: 2000,
        });
        if (viewerRows.length > 0) {
          viewerLogCursor = viewerRows[viewerRows.length - 1]?.id ?? viewerLogCursor;
          hub.broadcast('viewer-logs', { lines: viewerRows.map((row) => row.line) });
        }

        const sdkRows = listRunSdkEvents({
          dataDir,
          runId: currentRunId,
          scope: 'canonical',
          afterId: sdkCursor,
          limit: 2000,
        });
        if (sdkRows.length > 0) {
          sdkCursor = replaySdkRowsToClient(
            (event, data) => hub.broadcast(event, data),
            sdkRows.map((row) => ({ id: row.id, event: row.event })),
          );
        }
      }

      // Reconcile worker tailers with active workers and poll for events
      const runStatus = runManager.getStatus();
      const activeWorkers = runStatus.workers ?? [];
      const issueJsonForWorkers =
        activeWorkers.length > 0 ? await readIssueJsonCached(currentStateDir) : null;
      const workerArtifactsRunId = resolveWorkerArtifactsRunId({ run: runStatus, issueJson: issueJsonForWorkers });
      if (activeWorkers.length > 0 && !workerArtifactsRunId && !warnedMissingWorkerArtifactsRunId) {
        warnedMissingWorkerArtifactsRunId = true;
        console.error(
          `[pollTick] Unable to resolve worker artifacts runId (run.run_id=${runStatus.run_id ?? 'null'}). ` +
            `Expected issue.json.status.parallel.runId during parallel execution.`,
        );
      }
      if (activeWorkers.length > 0) {
        console.error(`[pollTick] Reconciling ${activeWorkers.length} workers: ${activeWorkers.map(w => w.taskId).join(', ')}`);
      }
      workerTailerManager.reconcile(activeWorkers, (taskId) => {
        if (!currentStateDir || !workerArtifactsRunId) return null;
        return path.join(currentStateDir, '.runs', workerArtifactsRunId, 'workers', taskId);
      });
      const workerResults = await workerTailerManager.poll();
      if (workerResults.workerLogs.length > 0 || workerResults.workerSdkEvents.length > 0) {
        console.error(`[pollTick] Worker results: ${workerResults.workerLogs.length} log batches, ${workerResults.workerSdkEvents.length} SDK events`);
      }
      for (const wl of workerResults.workerLogs) {
        hub.broadcast('worker-logs', { workerId: wl.taskId, lines: wl.lines });
      }
      for (const ws of workerResults.workerSdkEvents) {
        hub.broadcast(ws.event, { ...ws.data as Record<string, unknown>, workerId: ws.taskId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error('viewer-server poller error:', stack ?? message);
      hub.broadcast('viewer-error', { source: 'poller', message, stack });
    }
  }

  let pollInFlight = false;
  const poller = setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    void pollTick().finally(() => {
      pollInFlight = false;
    });
  }, pollMs);

  app.addHook('onClose', async () => {
    clearInterval(poller);
    workerTailerManager.clear();
    await runManager.stop({ force: false }).catch(() => void 0);
  });

  app.get('/api/state', async () => ({ ...(await getStateSnapshot()) }));

  app.get('/api/run', async () => ({ run: runManager.getStatus() }));

  app.get('/api/db/health', async () => {
    try {
      const health = getDbHealth(dataDir);
      return { ok: true, health };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/api/db/integrity-check', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });

    try {
      const result = runDbIntegrityCheck(dataDir);
      return reply.send({ ok: true, integrity: result });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/db/vacuum', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });
    if (runManager.getStatus().running) {
      return reply.code(409).send({ ok: false, error: 'Cannot vacuum database while Jeeves is running.' });
    }

    try {
      const result = runDbVacuum(dataDir);
      return reply.send({ ok: true, vacuum: result });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/db/backup', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });
    if (runManager.getStatus().running) {
      return reply.code(409).send({ ok: false, error: 'Cannot back up database while Jeeves is running.' });
    }

    const body = getBody(req);
    const filenameRaw = parseOptionalString(body.filename);
    if (filenameRaw && (filenameRaw.includes('/') || filenameRaw.includes('\\') || filenameRaw.includes('..'))) {
      return reply.code(400).send({ ok: false, error: 'filename must be a simple file name' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = filenameRaw && filenameRaw.endsWith('.db')
      ? filenameRaw
      : `${filenameRaw ?? `jeeves-backup-${timestamp}`}.db`;
    const backupPath = path.join(dataDir, 'backups', fileName);

    try {
      const backup = await runDbBackup(dataDir, backupPath);
      return reply.send({ ok: true, backup });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

	  app.get('/api/issues', async () => {
	    const issues = await listIssueJsonStates(dataDir);
	    return {
	      ok: true,
      issues: issues.map((i) => ({
        owner: i.owner,
        repo: i.repo,
        issue_number: i.issueNumber,
        issue_title: i.issueTitle,
        branch: i.branch,
        phase: i.phase,
        state_dir: i.stateDir,
      })),
      data_dir: dataDir,
      count: issues.length,
	      current_issue: runManager.getIssue().issueRef,
	    };
	  });

	  app.get('/api/workflows', async (_req, reply) => {
	    const absWorkflowsDir = path.resolve(workflowsDir);
	    const names = await listWorkflowNamesFromStore(dataDir);
	    return reply.send({
	      ok: true,
	      workflows: names.map((name) => ({ name })),
	      workflows_dir: absWorkflowsDir,
	    });
	  });

		  app.post('/api/workflows', async (req, reply) => {
		    const gate = await requireMutatingAllowed(req);
		    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });
		    if (runManager.getStatus().running) return reply.code(409).send({ ok: false, error: 'Cannot edit workflows while Jeeves is running.' });

		    const body = getBody(req);
		    const nameRaw = parseOptionalString(body.name);
		    if (!nameRaw) return reply.code(400).send({ ok: false, error: 'name is required' });

		    const info = getWorkflowNameParamInfo(nameRaw);
		    if (!info || !isValidWorkflowName(info.name)) return reply.code(400).send({ ok: false, error: 'invalid workflow name' });

		    const existing = await readWorkflowYamlFromStore(dataDir, info.name);
		    if (existing !== null) return reply.code(409).send({ ok: false, error: 'workflow already exists' });

		    const fromProvided = body.from !== undefined;
		    const fromRaw = parseOptionalString(body.from);
		    if (fromProvided && !fromRaw) return reply.code(400).send({ ok: false, error: 'from must be a string' });

		    try {
		      const workflow =
		        fromRaw
		          ? (() => {
		              const fromInfo = getWorkflowNameParamInfo(fromRaw);
		              if (!fromInfo || !isValidWorkflowName(fromInfo.name)) throw new Error('invalid workflow name');
		              return readWorkflowYamlFromStore(dataDir, fromInfo.name).then((yaml) => {
		                if (yaml === null) throw Object.assign(new Error('workflow not found'), { code: 'ENOENT' });
		                const parsed = parseWorkflowYaml(yaml, { sourceName: fromInfo.name });
		                return { ...parsed, name: info.name };
		              });
		            })()
		          : Promise.resolve(
		              parseWorkflowObject(
		                {
		                  workflow: { name: info.name, version: 1, start: 'start' },
		                  phases: {
		                    start: { type: 'execute', prompt: 'Start', transitions: [{ to: 'complete' }] },
		                    complete: { type: 'terminal', transitions: [] },
		                  },
		                },
		                { sourceName: info.name },
		              ),
		            );

		      const resolvedWorkflow = await workflow;
		      const yaml = toWorkflowYaml(resolvedWorkflow);
		      await writeWorkflowToStore({
		        dataDir,
		        workflowsDir,
		        name: info.name,
		        yaml,
		        createIfMissing: true,
		      });
		      return reply.send({ ok: true, name: info.name, yaml, workflow: toRawWorkflowJson(resolvedWorkflow) });
		    } catch (err) {
		      if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
		        return reply.code(409).send({ ok: false, error: 'workflow already exists' });
		      }
		      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT' && fromRaw) {
		        return reply.code(404).send({ ok: false, error: 'workflow not found' });
		      }
		      const mapped = errorToHttp(err);
		      return reply.code(mapped.status).send({ ok: false, error: mapped.message });
		    }
		  });

		  app.get('/api/workflows/:name', async (req, reply) => {
		    const raw = parseOptionalString((req.params as { name?: unknown } | undefined)?.name);
		    if (!raw) return reply.code(400).send({ ok: false, error: 'name is required' });
		    const info = getWorkflowNameParamInfo(raw);
		    if (!info) return reply.code(400).send({ ok: false, error: 'invalid workflow name' });

		    let yaml = await readWorkflowYamlFromStore(dataDir, info.name);
		    if (yaml === null) {
		      const filePath = path.resolve(workflowsDir, info.fileName);
		      const stat = await fs.lstat(filePath).catch(() => null);
		      if (!stat || stat.isSymbolicLink()) {
		        return reply.code(404).send({ ok: false, error: 'workflow not found' });
		      }
		      yaml = await fs.readFile(filePath, 'utf-8').catch(() => null);
		      if (yaml === null) return reply.code(404).send({ ok: false, error: 'workflow not found' });
		      await cacheWorkflowInStore(dataDir, info.name, yaml);
		    }

		    try {
		      const workflow = parseWorkflowYaml(yaml, { sourceName: info.name });
		      return reply.send({ ok: true, name: info.name, yaml, workflow: toRawWorkflowJson(workflow) });
		    } catch (err) {
		      const mapped = errorToHttp(err);
		      return reply.code(mapped.status).send({ ok: false, error: mapped.message });
		    }
		  });

		  app.put('/api/workflows/:name', async (req, reply) => {
		    const gate = await requireMutatingAllowed(req);
		    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });
		    if (runManager.getStatus().running) return reply.code(409).send({ ok: false, error: 'Cannot edit workflows while Jeeves is running.' });

		    const raw = parseOptionalString((req.params as { name?: unknown } | undefined)?.name);
		    if (!raw) return reply.code(400).send({ ok: false, error: 'name is required' });
		    const info = getWorkflowNameParamInfo(raw);
		    if (!info) return reply.code(400).send({ ok: false, error: 'invalid workflow name' });

		    const body = getBody(req);
		    const rawWorkflow = body.workflow;
		    if (rawWorkflow === undefined) return reply.code(400).send({ ok: false, error: 'workflow is required' });

		    try {
		      const workflow = parseWorkflowObject(rawWorkflow, { sourceName: info.name });
		      const yaml = toWorkflowYaml(workflow);
		      await writeWorkflowToStore({
		        dataDir,
		        workflowsDir,
		        name: info.name,
		        yaml,
		        createIfMissing: false,
		      });
		      return reply.send({ ok: true, name: info.name, yaml, workflow: toRawWorkflowJson(workflow) });
		    } catch (err) {
		      const mapped = errorToHttp(err);
		      return reply.code(mapped.status).send({ ok: false, error: mapped.message });
		    }
		  });

		  app.get('/api/prompts', async () => {
		    const ids = await listPromptIdsFromStore(dataDir);
		    return { ok: true, prompts: ids.map((id) => ({ id })), count: ids.length };
		  });

  app.get('/api/prompts/*', async (req, reply) => {
    const id = parseOptionalString((req.params as { '*': unknown } | undefined)?.['*']);
    if (!id) return reply.code(400).send({ ok: false, error: 'id is required' });
    const normalizedId = normalizePromptId(id);
    if (!isSafePromptId(normalizedId) || !normalizedId.endsWith('.md')) {
      return reply.code(400).send({ ok: false, error: 'Invalid prompt id.' });
    }

    let content = await readPromptFromStore(dataDir, normalizedId);
    if (content === null) {
      try {
        const resolved = await resolvePromptPathForRead(promptsDir, normalizedId);
        content = await fs.readFile(resolved, 'utf-8');
        await cachePromptInStore(dataDir, normalizedId, content);
      } catch (err) {
        const mapped = errorToHttp(err);
        return reply.code(mapped.status).send({ ok: false, error: mapped.message });
      }
    }

    return reply.send({ ok: true, id: normalizedId, content });
  });

  app.put('/api/prompts/*', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });
    if (runManager.getStatus().running) return reply.code(409).send({ ok: false, error: 'Cannot edit prompts while Jeeves is running.' });

    const id = parseOptionalString((req.params as { '*': unknown } | undefined)?.['*']);
    if (!id) return reply.code(400).send({ ok: false, error: 'id is required' });

    const body = getBody(req);
    const content = typeof body.content === 'string' ? body.content : null;
    if (content === null) return reply.code(400).send({ ok: false, error: 'content is required' });

    try {
      const normalizedId = normalizePromptId(id);
      const resolved = await resolvePromptPathForWrite(promptsDir, normalizedId);
      const exists = await fs.stat(resolved).then(() => true).catch(() => false);
      await writePromptToStore({
        dataDir,
        promptsDir,
        id: normalizedId,
        content,
        createIfMissing: !exists,
      });
      return reply.send({ ok: true, id: normalizedId });
    } catch (err) {
      const mapped = errorToHttp(err);
      return reply.code(mapped.status).send({ ok: false, error: mapped.message });
    }
  });

  // ======================================================================
  // Provider-Aware Ingest Endpoints
  // ======================================================================

  /**
   * Shared ingest orchestration. Handles the full workflow:
   * validate → create/lookup remote → hierarchy → persist state → init → select → auto-run → emit event.
   *
   * Returns an IngestResponse on success or partial, or throws with { status, body } on error.
   */
  async function executeProviderIngest(params: {
    provider: 'github' | 'azure_devops';
    mode: 'create' | 'init_existing';
    repo: string;
    // For create mode
    title?: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    milestone?: string;
    azure?: {
      organization?: string;
      project?: string;
      pat?: string;
      work_item_type?: 'User Story' | 'Bug' | 'Task';
      parent_id?: number;
      area_path?: string;
      iteration_path?: string;
      tags?: string[];
    };
    // For init_existing mode
    existing?: { id?: number | string; url?: string };
    azureInitOptions?: { organization?: string; project?: string; pat?: string; fetch_hierarchy?: boolean };
    // Shared optional params
    init?: { branch?: string; workflow?: string; phase?: string; design_doc?: string; force?: boolean };
    auto_select?: boolean;
    auto_run?: { provider?: string; workflow?: string; max_iterations?: number; inactivity_timeout_sec?: number; iteration_timeout_sec?: number };
  }): Promise<IngestResponse> {
    const { provider, mode, repo } = params;
    const initRequested = params.init !== undefined;
    const autoSelectEnabled = initRequested ? (params.auto_select ?? true) : false;
    const autoRunRequested = params.auto_run !== undefined;
    const warnings: string[] = [];
    let outcome: 'success' | 'partial' = 'success';
    let remoteRef: IngestRemoteRef | null = null;
    let hierarchy: IngestHierarchy | undefined;
    let initResult: { ok: true; issue_ref: string; branch: string } | { ok: false; error: string } | undefined;
    let autoSelectResult: { requested: boolean; ok: boolean; error?: string } | undefined;
    let autoRunResult: { requested: boolean; ok: boolean; error?: string } | undefined;

    // Determine the issue state dir for journal/lock (if an issue is selected)
    const currentIssue = runManager.getIssue();

    // Run conflict check
    if (initRequested && runManager.getStatus().running) {
      throw { status: 409, body: { ok: false, error: 'Cannot init while a run is active.', code: 'conflict_running' } };
    }

    // Acquire file-level provider operation lock if a state dir exists
    const lockStateDir = currentIssue.stateDir ?? null;
    let ingestOperationId: string | null = null;
    if (lockStateDir) {
      const lockResult = await acquireProviderOperationLock(lockStateDir, currentIssue.issueRef!);
      if (!lockResult.acquired) {
        throw { status: 503, body: { ok: false, error: 'Another provider operation is in progress.', code: 'busy' } };
      }
      ingestOperationId = lockResult.operationId;
    }

    try {
    if (lockStateDir) {
      if (!ingestOperationId) {
        throw new Error('Provider ingest lock state missing operation id.');
      }
      // Create journal after lock acquisition; failures still flow through finally for lock release.
      await createJournal(lockStateDir, {
        operation_id: ingestOperationId,
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: currentIssue.issueRef!,
        provider,
      });
    }

    // Resolve Azure credentials if needed
    let azurePat: string | undefined;
    let azureOrg: string | undefined;
    let azureProject: string | undefined;
    if (provider === 'azure_devops') {
      const azureOpts = mode === 'create' ? params.azure : params.azureInitOptions;
      azureOrg = azureOpts?.organization;
      azureProject = azureOpts?.project;
      azurePat = azureOpts?.pat;

      // If org/project not provided in request, try to read from stored Azure credentials
      if (currentIssue.stateDir && (!azureOrg || !azureProject || !azurePat)) {
        try {
          const secret = await readAzureDevopsSecret(currentIssue.stateDir);
          if (secret.exists) {
            if (!azureOrg) azureOrg = secret.data.organization;
            if (!azureProject) azureProject = secret.data.project;
            if (!azurePat) azurePat = secret.data.pat;
          }
        } catch {
          // Non-fatal: proceed without stored credentials
        }
      }

      if (!azureOrg || !azureProject || !azurePat) {
        const fieldErrors: Record<string, string> = {};
        if (!azureOrg) fieldErrors['azure.organization'] = 'Organization is required for Azure DevOps.';
        if (!azureProject) fieldErrors['azure.project'] = 'Project is required for Azure DevOps.';
        if (!azurePat) fieldErrors['azure.pat'] = 'PAT is required for Azure DevOps.';
        throw {
          status: 400,
          body: {
            ok: false,
            error: 'Validation failed.',
            code: 'validation_failed',
            field_errors: fieldErrors,
          },
        };
      }
    }

    // ---- Remote operation ----
    if (lockStateDir) await updateJournalState(lockStateDir, mode === 'create' ? 'ingest.creating_remote' : 'ingest.resolving_existing');
    if (mode === 'create') {
      try {
        remoteRef = await createProviderIssue({
          provider,
          repo,
          title: params.title!,
          body: params.body!,
          labels: params.labels,
          assignees: params.assignees,
          milestone: params.milestone,
          azure: provider === 'azure_devops'
            ? {
                organization: azureOrg,
                project: azureProject,
                work_item_type: params.azure?.work_item_type,
                parent_id: params.azure?.parent_id,
                area_path: params.azure?.area_path,
                iteration_path: params.azure?.iteration_path,
                tags: params.azure?.tags,
                pat: azurePat,
              }
            : undefined,
        });
      } catch (err) {
        if (err instanceof ProviderAdapterError) {
          throw {
            status: err.status,
            body: { ok: false, error: err.message, code: err.code },
          };
        }
        throw {
          status: 500,
          body: { ok: false, error: 'Failed to create remote item.', code: 'io_error' },
        };
      }
    } else {
      // init_existing: lookup the existing item
      const existingId = params.existing?.id ?? params.existing?.url;
      if (!existingId) {
        throw {
          status: 400,
          body: { ok: false, error: 'existing.id or existing.url is required', code: 'validation_failed' },
        };
      }
      const lookupId = provider === 'azure_devops' && params.existing?.url
        ? parseAzureWorkItemIdFromUrl(params.existing.url)
        : String(existingId);
      if (!lookupId) {
        throw {
          status: 400,
          body: {
            ok: false,
            error: 'For Azure DevOps, existing.url must include a numeric work-item ID.',
            code: 'validation_failed',
          },
        };
      }
      try {
        remoteRef = await lookupExistingIssue({
          provider,
          repo,
          id: lookupId,
          azure: provider === 'azure_devops'
            ? { organization: azureOrg, project: azureProject, pat: azurePat }
            : undefined,
        });
      } catch (err) {
        if (err instanceof ProviderAdapterError) {
          throw {
            status: err.status,
            body: { ok: false, error: err.message, code: err.code },
          };
        }
        throw {
          status: 500,
          body: { ok: false, error: 'Failed to resolve existing item.', code: 'io_error' },
        };
      }
    }

    // Update journal checkpoint with remote reference
    if (lockStateDir && remoteRef) {
      await updateJournalCheckpoint(lockStateDir, {
        remote_id: remoteRef.id,
        remote_url: remoteRef.url,
      });
    }

    // ---- Hierarchy fetch (Azure only) ----
    if (lockStateDir) await updateJournalState(lockStateDir, 'ingest.fetching_hierarchy');
    if (provider === 'azure_devops' && azureOrg && azureProject) {
      const fetchHierarchy = mode === 'init_existing'
        ? (params.azureInitOptions?.fetch_hierarchy ?? true)
        : true;
      if (fetchHierarchy) {
        try {
          hierarchy = await fetchAzureHierarchy({
            organization: azureOrg,
            project: azureProject,
            id: remoteRef.id,
            pat: azurePat,
          });
        } catch {
          if (mode === 'create') {
            // Remote item was just created by this request — partial success
            warnings.push('Failed to fetch Azure hierarchy. Hierarchy data is unavailable.');
            outcome = 'partial';
          } else {
            // init_existing: no remote mutation happened — this is an error
            throw {
              status: 500,
              body: { ok: false, error: 'Failed to fetch Azure hierarchy.', code: 'hierarchy_fetch_failed' },
            };
          }
        }
      }
    }

    // ---- Persist issue state ----
    if (lockStateDir) await updateJournalState(lockStateDir, 'ingest.persisting_issue_state');
    let persistedStateDir: string | null = null;
    if (initRequested) {
      // Init will create issue state, then we persist source metadata
      const issueNumber = parseInt(remoteRef.id, 10);
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        // For Azure work items, the id might not parse as int — use as-is
        // For GitHub issues, it should be a positive integer
      }

      // Save previous active issue before initIssue (which always updates active issue selection)
      const prevActiveIssue = await loadActiveIssue(dataDir);

      try {
        const initRes = await initIssue({
          dataDir,
          workflowsDir,
          body: {
            repo,
            issue: parseInt(remoteRef.id, 10) || 1,
            branch: params.init?.branch,
            workflow: params.init?.workflow,
            phase: params.init?.phase,
            design_doc: params.init?.design_doc,
            force: params.init?.force,
            ...(provider === 'azure_devops' && azurePat ? { pat: azurePat } : {}),
          },
        });

        persistedStateDir = initRes.state_dir;
        initResult = { ok: true, issue_ref: initRes.issue_ref, branch: initRes.branch };

        // Persist provider source metadata
        try {
          const issueSource: IssueSource = {
            provider,
            kind: remoteRef.kind,
            id: remoteRef.id,
            url: remoteRef.url,
            title: remoteRef.title,
            mode,
            ...(hierarchy
              ? {
                  hierarchy: {
                    parent: hierarchy.parent,
                    children: [...hierarchy.children],
                    fetched_at: new Date().toISOString(),
                  },
                }
              : {}),
          };
          await writeIssueSource(initRes.state_dir, issueSource);
          if (lockStateDir) await updateJournalCheckpoint(lockStateDir, { issue_state_persisted: true, init_completed: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to persist issue source metadata.';
          warnings.push(msg);
          outcome = 'partial';
          if (lockStateDir) await updateJournalCheckpoint(lockStateDir, { init_completed: true }).catch(() => void 0);
        }

        // Persist Azure credentials + sync worktree when init creates the issue
        if (provider === 'azure_devops' && azureOrg && azureProject && azurePat) {
          try {
            const now = new Date().toISOString();
            await writeAzureDevopsSecret(initRes.state_dir, azureOrg, azureProject, azurePat);

            await updateAzureDevopsStatusInIssueJson(initRes.state_dir, {
              organization: azureOrg,
              project: azureProject,
              pat_last_updated_at: now,
            });

            let syncStatus: AzureDevopsSyncStatus = 'never_attempted';
            let lastError: string | null = null;

            if (initRes.work_dir) {
              try {
                const reconcileResult = await reconcileAzureDevopsToWorktree({
                  worktreeDir: initRes.work_dir,
                  hasSecret: true,
                  pat: azurePat,
                });
                syncStatus = reconcileResult.sync_status;
                lastError = reconcileResult.last_error;
                warnings.push(...reconcileResult.warnings);
              } catch (err) {
                syncStatus = 'failed_exclude';
                lastError = sanitizeErrorForUi(err);
              }

              await updateAzureDevopsStatusInIssueJson(initRes.state_dir, {
                sync_status: syncStatus,
                last_attempt_at: now,
                last_success_at: syncStatus === 'in_sync' ? now : null,
                last_error: lastError,
              });
            } else {
              syncStatus = 'deferred_worktree_absent';
              await updateAzureDevopsStatusInIssueJson(initRes.state_dir, {
                sync_status: syncStatus,
                last_attempt_at: now,
                last_error: null,
              });
            }

            const status = await buildAzureDevopsStatus(initRes.issue_ref, initRes.state_dir, initRes.work_dir);
            emitAzureDevopsStatus(status, 'ingest');
          } catch (err) {
            const safeMessage = sanitizePatFromMessage(sanitizeErrorForUi(err), azurePat);
            warnings.push(`Azure DevOps credentials were not saved or synced: ${safeMessage}`);
            outcome = 'partial';
          }
        }

        // Auto-select
        if (lockStateDir) await updateJournalState(lockStateDir, 'ingest.auto_selecting').catch(() => void 0);
        if (autoSelectEnabled) {
          try {
            await runManager.setIssue(initRes.issue_ref);
            await saveActiveIssue(dataDir, initRes.issue_ref);
            await refreshRunTargets();
            autoSelectResult = { requested: true, ok: true };
            if (lockStateDir) await updateJournalCheckpoint(lockStateDir, { auto_selected: true }).catch(() => void 0);

            // Best-effort reconcile hooks
            const reconcileIssue = runManager.getIssue();
            if (reconcileIssue.issueRef && reconcileIssue.stateDir) {
              try { await autoReconcileSonarToken(reconcileIssue.issueRef, reconcileIssue.stateDir, reconcileIssue.workDir); } catch { /* non-fatal */ }
              try { await autoReconcileAzureDevops(reconcileIssue.issueRef, reconcileIssue.stateDir, reconcileIssue.workDir); } catch { /* non-fatal */ }
              try { await autoReconcileProjectFiles(reconcileIssue.issueRef, reconcileIssue.stateDir, reconcileIssue.workDir); } catch { /* non-fatal */ }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to auto-select issue.';
            autoSelectResult = { requested: true, ok: false, error: msg };
            outcome = 'partial';
          }
        } else {
          // Restore previous active issue (initIssue always updates active issue selection)
          if (prevActiveIssue) {
            await saveActiveIssue(dataDir, prevActiveIssue);
          } else {
            await clearActiveIssue(dataDir);
          }
          autoSelectResult = { requested: false, ok: true };
        }

        // Auto-run
        if (lockStateDir) await updateJournalState(lockStateDir, 'ingest.auto_starting_run').catch(() => void 0);
        if (autoRunRequested) {
          if (autoSelectResult?.ok) {
            try {
              await runManager.start({
                provider: params.auto_run?.provider ?? undefined,
                workflow: params.auto_run?.workflow,
                max_iterations: params.auto_run?.max_iterations,
                inactivity_timeout_sec: params.auto_run?.inactivity_timeout_sec,
                iteration_timeout_sec: params.auto_run?.iteration_timeout_sec,
              });
              autoRunResult = { requested: true, ok: true };
              if (lockStateDir) await updateJournalCheckpoint(lockStateDir, { auto_run_started: true }).catch(() => void 0);
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Failed to start run.';
              autoRunResult = { requested: true, ok: false, error: msg };
              outcome = 'partial';
            }
          } else {
            autoRunResult = { requested: true, ok: false, error: 'Auto-run skipped: auto-select failed.' };
            outcome = 'partial';
          }
        }
      } catch (err) {
        const safeMessage = err instanceof Error ? err.message : 'Failed to init issue.';
        initResult = { ok: false, error: safeMessage };
        outcome = 'partial';
      }
    } else {
      // No init requested: just persist source metadata to current issue state if available
      if (currentIssue.stateDir) {
        try {
          const issueSource: IssueSource = {
            provider,
            kind: remoteRef.kind,
            id: remoteRef.id,
            url: remoteRef.url,
            title: remoteRef.title,
            mode,
            ...(hierarchy
              ? {
                  hierarchy: {
                    parent: hierarchy.parent,
                    children: [...hierarchy.children],
                    fetched_at: new Date().toISOString(),
                  },
                }
              : {}),
          };
          await writeIssueSource(currentIssue.stateDir, issueSource);
          persistedStateDir = currentIssue.stateDir;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to persist issue source metadata.';
          warnings.push(msg);
          outcome = 'partial';
        }
      }
    }

    // ---- Record ingest status ----
    if (lockStateDir) await updateJournalState(lockStateDir, 'ingest.recording_status').catch(() => void 0);
    const stateDir = persistedStateDir ?? currentIssue.stateDir;
    if (stateDir) {
      try {
        const ingestStatus: IssueIngestStatus = {
          provider,
          mode,
          outcome: outcome === 'success' ? 'success' : 'partial',
          remote_id: remoteRef.id,
          remote_url: remoteRef.url,
          warnings: warnings.slice(0, 50),
          auto_select_ok: autoSelectResult ? autoSelectResult.ok : null,
          auto_run_ok: autoRunResult ? autoRunResult.ok : null,
          occurred_at: new Date().toISOString(),
        };
        await writeIssueIngestStatus(stateDir, ingestStatus);
      } catch {
        warnings.push('Failed to record ingest status.');
        outcome = 'partial';
      }
    }

    // ---- Emit ingest status event ----
    const issueRef = currentIssue.issueRef
      ?? (initResult && initResult.ok ? initResult.issue_ref : null);
    const ingestEvent: IssueIngestStatusEvent = {
      issue_ref: issueRef,
      provider,
      mode,
      outcome: outcome === 'success' ? 'success' : 'partial',
      remote_id: remoteRef.id,
      remote_url: remoteRef.url,
      warnings,
      auto_select: { requested: autoSelectResult?.requested ?? false, ok: autoSelectResult?.ok ?? true },
      auto_run: { requested: autoRunResult?.requested ?? false, ok: autoRunResult?.ok ?? true },
      occurred_at: new Date().toISOString(),
    };
    hub.broadcast('issue-ingest-status', ingestEvent);

    // ---- Build response ----
    const response: IngestResponse = {
      ok: true,
      provider,
      mode,
      outcome,
      remote: remoteRef,
      ...(hierarchy ? { hierarchy } : {}),
      ...(initResult ? { init: initResult } : {}),
      ...(autoSelectResult ? { auto_select: autoSelectResult } : {}),
      ...(autoRunResult ? { auto_run: autoRunResult } : {}),
      warnings,
      run: { running: runManager.getStatus().running, runId: runManager.getStatus().run_id ?? undefined },
    };

    // Finalize journal
    if (lockStateDir) {
      const terminalState = outcome === 'success' ? 'ingest.done_success' : 'ingest.done_partial';
      if (warnings.length > 0) await updateJournalCheckpoint(lockStateDir, { warnings }).catch(() => void 0);
      await finalizeJournal(lockStateDir, terminalState).catch(() => void 0);
    }

    return response;

    } catch (err) {
      // Finalize journal on error
      if (lockStateDir) {
        try { await finalizeJournal(lockStateDir, 'ingest.done_error'); } catch { /* journal finalize best-effort */ }
      }
      throw err;
    } finally {
      if (lockStateDir) await releaseLock(lockStateDir);
    }
  }

  // POST /api/issues/create — provider-aware create
  app.post('/api/issues/create', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    const body = getBody(req);
    const validation = validateCreateProviderIssueRequest(body);
    if (!validation.valid) {
      return reply.code(400).send({
        ok: false,
        error: validation.code === 'unsupported_provider'
          ? `Unsupported provider: ${typeof body.provider === 'string' ? body.provider : 'unknown'}`
          : 'Validation failed.',
        code: validation.code,
        ...(validation.field_errors && Object.keys(validation.field_errors).length > 0
          ? { field_errors: validation.field_errors }
          : {}),
      });
    }

    const validated = validation.value;

    try {
      const result = await executeProviderIngest({
        provider: validated.provider,
        mode: 'create',
        repo: validated.repo,
        title: validated.title,
        body: validated.body,
        labels: validated.labels ? [...validated.labels] : undefined,
        assignees: validated.assignees ? [...validated.assignees] : undefined,
        milestone: validated.milestone,
        azure: validated.azure,
        init: validated.init,
        auto_select: validated.auto_select,
        auto_run: validated.auto_run,
      });
      return reply.send(result);
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err && 'body' in err) {
        const { status, body: errBody } = err as { status: number; body: Record<string, unknown> };
        return reply.code(status).send(errBody);
      }
      return reply.code(500).send({ ok: false, error: 'Internal server error.', code: 'io_error' });
    }
  });

  // POST /api/issues/init-from-existing — provider-aware init from existing
  app.post('/api/issues/init-from-existing', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    const body = getBody(req);
    const validation = validateInitFromExistingRequest(body);
    if (!validation.valid) {
      return reply.code(400).send({
        ok: false,
        error: validation.code === 'unsupported_provider'
          ? `Unsupported provider: ${typeof body.provider === 'string' ? body.provider : 'unknown'}`
          : 'Validation failed.',
        code: validation.code,
        ...(validation.field_errors && Object.keys(validation.field_errors).length > 0
          ? { field_errors: validation.field_errors }
          : {}),
      });
    }

    const validated = validation.value;

    try {
      const result = await executeProviderIngest({
        provider: validated.provider,
        mode: 'init_existing',
        repo: validated.repo,
        existing: validated.existing,
        azureInitOptions: validated.azure,
        init: validated.init,
        auto_select: validated.auto_select,
        auto_run: validated.auto_run,
      });
      return reply.send(result);
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err && 'body' in err) {
        const { status, body: errBody } = err as { status: number; body: Record<string, unknown> };
        return reply.code(status).send(errBody);
      }
      return reply.code(500).send({ ok: false, error: 'Internal server error.', code: 'io_error' });
    }
  });

  // ======================================================================
  // Legacy GitHub Issue Create (backward-compatible shim)
  // ======================================================================

		  app.post('/api/github/issues/create', async (req, reply) => {
		    const gate = await requireMutatingAllowed(req);
		    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, run: runManager.getStatus() });

		    const body = getBody(req);

		    const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
		    if (!repo) return reply.code(400).send({ ok: false, error: 'repo is required (owner/repo)', run: runManager.getStatus() });

		    const titleRaw = typeof body.title === 'string' ? body.title : '';
		    if (!titleRaw.trim()) return reply.code(400).send({ ok: false, error: 'title is required', run: runManager.getStatus() });

		    const bodyRaw = typeof body.body === 'string' ? body.body : '';
		    if (!bodyRaw.trim()) return reply.code(400).send({ ok: false, error: 'body is required', run: runManager.getStatus() });

		    const labels =
		      body.labels === undefined
		        ? undefined
		        : Array.isArray(body.labels)
		          ? body.labels
		              .filter((v: unknown): v is string => typeof v === 'string')
		              .map((s: string) => s.trim())
		              .filter((s: string) => s.length > 0)
		          : null;
		    if (labels === null) return reply.code(400).send({ ok: false, error: '`labels` must be an array of strings', run: runManager.getStatus() });

		    const assignees =
		      body.assignees === undefined
		        ? undefined
		        : Array.isArray(body.assignees)
		          ? body.assignees
		              .filter((v: unknown): v is string => typeof v === 'string')
		              .map((s: string) => s.trim())
		              .filter((s: string) => s.length > 0)
		          : null;
		    if (assignees === null)
		      return reply.code(400).send({ ok: false, error: '`assignees` must be an array of strings', run: runManager.getStatus() });

		    const milestoneRaw = typeof body.milestone === 'string' ? body.milestone.trim() : '';
		    const milestone = milestoneRaw.length > 0 ? milestoneRaw : undefined;

		    const initValue = body.init;
		    const initBool = parseOptionalBool(initValue);
		    const initObj = isBodyRecord(initValue) ? initValue : null;
		    if (initValue !== undefined && initObj === null && initBool === undefined) {
		      return reply.code(400).send({ ok: false, error: '`init` must be an object', run: runManager.getStatus() });
		    }
		    const initRequested = initObj !== null || initBool === true;

		    const autoRunValue = body.auto_run;
		    const autoRunBool = parseOptionalBool(autoRunValue);
		    const autoRunObj = isBodyRecord(autoRunValue) ? autoRunValue : null;
		    if (autoRunValue !== undefined && autoRunObj === null && autoRunBool === undefined) {
		      return reply.code(400).send({ ok: false, error: '`auto_run` must be an object', run: runManager.getStatus() });
		    }
		    const autoRunRequested = autoRunObj !== null || autoRunBool === true;

		    const autoSelectRequested = parseOptionalBool(body.auto_select);
		    if (!initRequested && autoSelectRequested !== undefined) {
		      return reply.code(400).send({ ok: false, error: '`auto_select` requires `init`', run: runManager.getStatus() });
		    }

		    const autoSelectEnabled = initRequested ? (autoSelectRequested ?? true) : false;
		    if (autoRunRequested && (!initRequested || !autoSelectEnabled)) {
		      return reply.code(400).send({ ok: false, error: '`auto_run` requires `init` + `auto_select`', run: runManager.getStatus() });
		    }

		    if (initRequested && runManager.getStatus().running) {
		      return reply.code(409).send({ ok: false, error: 'Cannot init while Jeeves is running.', run: runManager.getStatus() });
		    }

		    try {
		      parseRepoSpec(repo);
		    } catch (err) {
		      const mapped = errorToHttp(err);
		      return reply.code(mapped.status).send({ ok: false, error: mapped.message, run: runManager.getStatus() });
		    }

		    // Delegate to provider-aware flow via executeProviderIngest
		    const initParams = initObj ?? {};
		    try {
		      const result = await executeProviderIngest({
		        provider: 'github',
		        mode: 'create',
		        repo,
		        title: titleRaw,
		        body: bodyRaw,
		        labels: labels ? [...labels] : undefined,
		        assignees: assignees ? [...assignees] : undefined,
		        milestone,
		        init: initRequested
		          ? {
		              branch: parseOptionalString(initParams.branch),
		              workflow: parseOptionalString(initParams.workflow),
		              phase: parseOptionalString(initParams.phase),
		              design_doc: parseOptionalString(initParams.design_doc),
		              force: parseOptionalBool(initParams.force),
		            }
		          : undefined,
		        auto_select: autoSelectEnabled,
		        auto_run: autoRunRequested
		          ? {
		              provider: parseOptionalString((autoRunObj ?? {}).provider) ?? parseOptionalString(body.provider),
		              workflow: parseOptionalString((autoRunObj ?? {}).workflow),
		              max_iterations: parseOptionalNumber((autoRunObj ?? {}).max_iterations),
		              inactivity_timeout_sec: parseOptionalNumber((autoRunObj ?? {}).inactivity_timeout_sec),
		              iteration_timeout_sec: parseOptionalNumber((autoRunObj ?? {}).iteration_timeout_sec),
		            }
		          : undefined,
		      });

		      // Legacy title/url persistence (kept for backward compat)
		      if (result.init && result.init.ok) {
		        const issueRef = result.init.issue_ref;
		        const refMatch = issueRef.match(/^([^/]+)\/([^#]+)#(\d+)$/);
		        if (refMatch) {
		          const [, owner, repoName, numStr] = refMatch;
		          const issueNum = parseInt(numStr, 10);
		          const stDir = getIssueStateDir(owner, repoName, issueNum, dataDir);
		          try {
		            const issueJson = ((await readIssueJson(stDir)) ?? {}) as Record<string, unknown>;
		            const issueField =
		              issueJson.issue && typeof issueJson.issue === 'object' && !Array.isArray(issueJson.issue)
		                ? (issueJson.issue as Record<string, unknown>)
		                : {};
		            await writeIssueJson(stDir, {
		              ...issueJson,
		              issue: { ...issueField, title: titleRaw.trim(), url: result.remote.url },
		            });
		          } catch { /* non-fatal legacy persistence */ }
		        }
		      }

		      // Map IngestResponse to legacy envelope
		      const legacyResponse: Record<string, unknown> = {
		        ok: true,
		        created: true,
		        issue_url: result.remote.url,
		        run: runManager.getStatus(),
		      };

		      // Reconstruct issue_ref in legacy format (owner/repo#number)
		      if (result.init?.ok) {
		        legacyResponse.issue_ref = result.init.issue_ref;
		      } else {
		        // Parse issue_ref from remote URL for non-init case
		        const urlMatch = result.remote.url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
		        if (urlMatch) {
		          legacyResponse.issue_ref = `${urlMatch[1]}/${urlMatch[2]}#${urlMatch[3]}`;
		        }
		      }

		      // Map init result if present
		      if (result.init) {
		        if (result.init.ok) {
		          const issueRef = result.init.issue_ref;
		          const refMatch = issueRef.match(/^([^/]+)\/([^#]+)#(\d+)$/);
		          if (refMatch) {
		            const [, owner, repoName, numStr] = refMatch;
		            const issueNum = parseInt(numStr, 10);
		            legacyResponse.init = {
		              ok: true,
		              result: {
		                issue_ref: issueRef,
		                state_dir: getIssueStateDir(owner, repoName, issueNum, dataDir),
		                work_dir: getWorktreePath(owner, repoName, issueNum, dataDir),
		                repo_dir: path.join(dataDir, 'repos', owner, repoName),
		                branch: result.init.branch,
		              },
		            };
		          } else {
		            legacyResponse.init = { ok: false, error: 'Failed to parse issue reference.' };
		          }
		        } else {
		          legacyResponse.init = { ok: false, error: result.init.error };
		        }
		      }

		      // Map auto_run result if present
		      if (result.auto_run) {
		        if (result.auto_run.ok) {
		          legacyResponse.auto_run = { ok: true, run_started: true };
		        } else {
		          legacyResponse.auto_run = { ok: false, run_started: false, error: result.auto_run.error ?? 'Failed to start run.' };
		        }
		        // Refresh run status after auto_run
		        legacyResponse.run = runManager.getStatus();
		      }

		      return reply.send(legacyResponse);
		    } catch (err) {
		      // Map provider-aware errors back to legacy envelope format
		      if (err && typeof err === 'object' && 'status' in err && 'body' in err) {
		        const { status, body: errBody } = err as { status: number; body: Record<string, unknown> };
		        const errorMsg = typeof errBody.error === 'string' ? errBody.error : 'Failed to create GitHub issue.';
		        return reply.code(status).send({ ok: false, error: errorMsg, run: runManager.getStatus() });
		      }
		      if (err instanceof CreateGitHubIssueError) {
		        return reply.code(err.status).send({ ok: false, error: err.message, run: runManager.getStatus() });
		      }
		      return reply.code(500).send({ ok: false, error: 'Failed to create GitHub issue.', run: runManager.getStatus() });
		    }
		  });

	  app.post('/api/github/issues/expand', async (req, reply) => {
	    // Gated by localhost-only by default
	    const gate = await requireMutatingAllowed(req);
	    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });

	    const body = getBody(req);

	    // Validate summary (required, 5-2000 chars)
	    const summaryRaw = typeof body.summary === 'string' ? body.summary : '';
	    const summary = summaryRaw.trim();
	    if (!summary) {
	      return reply.code(400).send({ ok: false, error: 'summary is required' });
	    }
	    if (summary.length < 5) {
	      return reply.code(400).send({ ok: false, error: 'summary must be at least 5 characters' });
	    }
	    if (summary.length > 2000) {
	      return reply.code(400).send({ ok: false, error: 'summary must be at most 2000 characters' });
	    }

	    // Validate issue_type (optional, must be one of feature/bug/refactor)
	    const issueTypeRaw = parseOptionalString(body.issue_type);
	    let issueType: 'feature' | 'bug' | 'refactor' | undefined;
	    if (issueTypeRaw !== undefined) {
	      const validTypes = ['feature', 'bug', 'refactor'] as const;
	      if (!validTypes.includes(issueTypeRaw as typeof validTypes[number])) {
	        return reply.code(400).send({ ok: false, error: `issue_type must be one of: ${validTypes.join(', ')}` });
	      }
	      issueType = issueTypeRaw as typeof validTypes[number];
	    }

	    // Resolve provider/model defaults from the 'default' workflow
	    let defaultProvider = 'claude';
	    let defaultModel: string | undefined;
	    try {
	      const workflow = await loadWorkflowByName('default', { workflowsDir });
	      if (workflow.defaultProvider) {
	        defaultProvider = workflow.defaultProvider;
	      }
	      if (workflow.defaultModel) {
	        defaultModel = workflow.defaultModel;
	      }
	    } catch {
	      // If default workflow doesn't exist or is invalid, use fallback defaults
	    }

	    // Allow overrides from request
	    const providerOverride = parseOptionalString(body.provider);
	    const modelOverride = parseOptionalString(body.model);
	    const effectiveProvider = providerOverride ?? defaultProvider;
	    const effectiveModel = modelOverride ?? defaultModel;

	    // Spawn runner subprocess with 60s timeout
	    const { result, timedOut } = await runIssueExpand(
	      { summary, issue_type: issueType },
	      {
	        repoRoot,
	        promptsDir,
	        provider: effectiveProvider,
	        model: effectiveModel,
	        timeoutMs: 60000,
	      },
	    );

	    // Handle timeout
	    if (timedOut) {
	      return reply.code(504).send({ ok: false, error: 'Request timed out' });
	    }

	    // Handle runner failure (do not include raw output in response)
	    if (!result.ok) {
	      return reply.code(500).send({ ok: false, error: result.error });
	    }

	    // Success - return title, body, provider, and optionally model
	    return reply.send(buildSuccessResponse(result.title, result.body, effectiveProvider, effectiveModel));
	  });

	  app.post('/api/issues/select', async (req, reply) => {
	    const gate = await requireMutatingAllowed(req);
	    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });
	    if (runManager.getStatus().running) return reply.code(409).send({ ok: false, error: 'Cannot select issue while Jeeves is running.' });

	    const body = getBody(req);
	    const issueRef = parseOptionalString(body.issue_ref);
	    if (!issueRef) return reply.code(400).send({ ok: false, error: 'issue_ref is required' });

	    try {
	      await runManager.setIssue(issueRef);
	      await saveActiveIssue(dataDir, issueRef);
	      await refreshRunTargets();

	      // Trigger best-effort sonar token reconcile and emit status (non-fatal)
	      const issue = runManager.getIssue();
	      if (issue.issueRef && issue.stateDir) {
	        try {
	          await autoReconcileSonarToken(issue.issueRef, issue.stateDir, issue.workDir);
	        } catch {
	          // Non-fatal - ignore reconcile errors
	        }
        try {
          await autoReconcileAzureDevops(issue.issueRef, issue.stateDir, issue.workDir);
        } catch {
          // Non-fatal - ignore reconcile errors
        }
        try {
          await autoReconcileProjectFiles(issue.issueRef, issue.stateDir, issue.workDir);
        } catch {
          // Non-fatal - ignore reconcile errors
        }
      }

	      return reply.send({ ok: true, issue_ref: issueRef });
	    } catch (err) {
	      const mapped = errorToHttp(err);
	      return reply.code(mapped.status).send({ ok: false, error: mapped.message });
	    }
	  });

	  app.post('/api/init/issue', async (req, reply) => {
	    const gate = await requireMutatingAllowed(req);
	    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });
	    if (runManager.getStatus().running) return reply.code(409).send({ ok: false, error: 'Cannot init while Jeeves is running.' });

	    const body = getBody(req);
	    const repoStr = parseOptionalString(body.repo);
	    if (!repoStr) return reply.code(400).send({ ok: false, error: 'repo is required (owner/repo)' });
	    const issueNum = parsePositiveInt(body.issue);
	    if (!issueNum) return reply.code(400).send({ ok: false, error: 'issue must be a positive integer' });

	    try {
	      parseRepoSpec(repoStr);
	    } catch (err) {
	      const mapped = errorToHttp(err);
	      return reply.code(mapped.status).send({ ok: false, error: mapped.message });
	    }

		    try {
		      const res = await initIssue({
		        dataDir,
		        workflowsDir,
		        body: {
		          repo: repoStr,
		          issue: issueNum,
		          branch: parseOptionalString(body.branch),
	          workflow: parseOptionalString(body.workflow),
	          phase: parseOptionalString(body.phase),
	          design_doc: parseOptionalString(body.design_doc),
	          force: parseOptionalBool(body.force) ?? false,
	        },
	      });

	      await runManager.setIssue(res.issue_ref);
	      await saveActiveIssue(dataDir, res.issue_ref);
	      await refreshRunTargets();

	      // Trigger best-effort sonar token reconcile and emit status (non-fatal)
	      const issue = runManager.getIssue();
	      if (issue.issueRef && issue.stateDir) {
	        try {
	          await autoReconcileSonarToken(issue.issueRef, issue.stateDir, issue.workDir);
	        } catch {
	          // Non-fatal - ignore reconcile errors
	        }
        try {
          await autoReconcileAzureDevops(issue.issueRef, issue.stateDir, issue.workDir);
        } catch {
          // Non-fatal - ignore reconcile errors
        }
        try {
          await autoReconcileProjectFiles(issue.issueRef, issue.stateDir, issue.workDir);
        } catch {
          // Non-fatal - ignore reconcile errors
        }
      }

	      return reply.send({ ok: true, ...res });
	    } catch (err) {
	      const msg = err instanceof Error ? err.message : String(err);
	      const status = msg.includes('worktree already exists') ? 409 : 500;
	      return reply.code(status).send({ ok: false, error: msg });
	    }
	  });

	  app.post('/api/run', async (req, reply) => {
	    const gate = await requireMutatingAllowed(req);
	    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });

	    const body = getBody(req);
	    const issueRef = parseOptionalString(body.issue_ref);
	    if (issueRef) {
	      if (runManager.getStatus().running) return reply.code(409).send({ ok: false, error: 'Cannot change issue while running.' });
	      try {
	        await runManager.setIssue(issueRef);
	        await saveActiveIssue(dataDir, issueRef);
	        await refreshRunTargets();
	      } catch (err) {
	        const mapped = errorToHttp(err);
	        return reply.code(mapped.status).send({ ok: false, error: mapped.message });
	      }
	    }

	    try {
	      const run = await runManager.start({
	        provider: parseOptionalString(body.provider) ?? body.provider,
	        workflow: parseOptionalString(body.workflow) ?? body.workflow,
	        quick: parseOptionalBool(body.quick) ?? body.quick,
	        max_iterations: parseOptionalNumber(body.max_iterations) ?? body.max_iterations,
	        inactivity_timeout_sec: parseOptionalNumber(body.inactivity_timeout_sec) ?? body.inactivity_timeout_sec,
	        iteration_timeout_sec: parseOptionalNumber(body.iteration_timeout_sec) ?? body.iteration_timeout_sec,
	        max_parallel_tasks: parseOptionalNumber(body.max_parallel_tasks) ?? body.max_parallel_tasks,
	      });
	      return reply.send({ ok: true, run });
	    } catch (err) {
	      const msg = err instanceof Error ? err.message : String(err);
	      // Per §6.2.6: 409 for already running, 400 for invalid inputs, 500 for orchestration failures
	      let status: number;
	      if (msg.includes('already running')) {
	        status = 409;
	      } else if (
	        msg.includes('Invalid max_parallel_tasks') ||
	        msg.includes('Invalid provider') ||
	        msg.includes('No issue selected') ||
	        msg.includes('Worktree not found') ||
	        msg.includes('Invalid quick')
	      ) {
	        status = 400;
	      } else {
	        // Orchestration failures (filesystem errors, spawn errors, etc.)
	        status = 500;
	      }
	      return reply.code(status).send({ ok: false, error: msg, run: runManager.getStatus() });
	    }
	  });

	  app.post('/api/run/stop', async (req, reply) => {
	    const gate = await requireMutatingAllowed(req);
	    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });

	    const body = getBody(req);
	    const force = parseOptionalBool(body.force) ?? false;
	    await runManager.stop({ force });
	    return reply.send({ ok: true, run: runManager.getStatus() });
	  });

	  app.post('/api/issue/workflow', async (req, reply) => {
	    const gate = await requireMutatingAllowed(req);
	    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });
	    if (runManager.getStatus().running) return reply.code(409).send({ ok: false, error: 'Cannot edit workflow while Jeeves is running.' });

	    const issue = runManager.getIssue();
	    if (!issue.stateDir) return reply.code(400).send({ ok: false, error: 'No issue selected.' });
	    const issueJson = await readIssueJson(issue.stateDir);
	    if (!issueJson) return reply.code(404).send({ ok: false, error: 'issue.json not found.' });

	    const body = getBody(req);
	    const workflowRaw = parseOptionalString(body.workflow);
	    if (!workflowRaw) return reply.code(400).send({ ok: false, error: 'workflow is required' });

	    const info = getWorkflowNameParamInfo(workflowRaw);
	    if (!info || !isValidWorkflowName(info.name)) return reply.code(400).send({ ok: false, error: 'invalid workflow name' });

	    const absWorkflowsDir = path.resolve(workflowsDir);
	    const workflowPath = path.join(absWorkflowsDir, `${info.name}.yaml`);
	    const exists = await fs.stat(workflowPath).catch(() => null);
	    if (!exists?.isFile()) return reply.code(404).send({ ok: false, error: 'workflow not found' });

	    let workflowStart: string;
	    try {
	      const workflow = await loadWorkflowByName(info.name, { workflowsDir: absWorkflowsDir });
	      workflowStart = workflow.start;
	    } catch (err) {
	      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
	    }

	    const resetPhase = parseOptionalBool(body.reset_phase) ?? false;
	    issueJson.workflow = info.name;
	    if (resetPhase) issueJson.phase = workflowStart;

	    await writeIssueJson(issue.stateDir, issueJson);
	    hub.broadcast('state', await getStateSnapshot());
	    return reply.send({ ok: true, workflow: info.name, ...(resetPhase ? { phase: workflowStart } : {}) });
	  });

	  app.post('/api/issue/status', async (req, reply) => {
	    const gate = await requireMutatingAllowed(req);
	    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });
	    if (runManager.getStatus().running) return reply.code(409).send({ ok: false, error: 'Cannot edit phase while Jeeves is running.' });

    const issue = runManager.getIssue();
    if (!issue.stateDir) return reply.code(400).send({ ok: false, error: 'No issue selected.' });
    const issueJson = await readIssueJson(issue.stateDir);
    if (!issueJson) return reply.code(404).send({ ok: false, error: 'issue.json not found.' });

	    const body = getBody(req);
	    const phase = parseOptionalString(body.phase);
	    if (!phase) return reply.code(400).send({ ok: false, error: 'phase is required' });

    const workflowName = typeof issueJson.workflow === 'string' ? issueJson.workflow : 'default';
    try {
      const workflow = await loadWorkflowByName(workflowName, { workflowsDir });
      if (!workflow.phases[phase]) {
        return reply.code(400).send({ ok: false, error: `phase must be one of: ${Object.keys(workflow.phases).sort().join(', ')}` });
      }
      issueJson.phase = phase;
      await writeIssueJson(issue.stateDir, issueJson);
      hub.broadcast('state', await getStateSnapshot());
      return reply.send({ ok: true, phase });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
	  });

	  app.get('/api/issue/task-execution', async (_req, reply) => {
	    const issue = runManager.getIssue();
	    if (!issue.stateDir) return reply.code(400).send({ ok: false, error: 'No issue selected.' });
	    const issueJson = await readIssueJson(issue.stateDir);
	    if (!issueJson) return reply.code(404).send({ ok: false, error: 'issue.json not found.' });

	    const settings = (issueJson.settings && typeof issueJson.settings === 'object' && !Array.isArray(issueJson.settings))
	      ? (issueJson.settings as Record<string, unknown>)
	      : {};
	    const taskExecution =
	      (settings.taskExecution && typeof settings.taskExecution === 'object' && !Array.isArray(settings.taskExecution))
	        ? (settings.taskExecution as Record<string, unknown>)
	        : {};

	    const mode = typeof taskExecution.mode === 'string' ? taskExecution.mode : 'sequential';
	    const maxParallelTasks = typeof taskExecution.maxParallelTasks === 'number' && Number.isInteger(taskExecution.maxParallelTasks) && taskExecution.maxParallelTasks >= 1
	      ? Math.min(taskExecution.maxParallelTasks, 8)
	      : 1;

	    return reply.send({
	      ok: true,
	      settings: {
	        taskExecution: {
	          mode: mode === 'parallel' ? 'parallel' : 'sequential',
	          maxParallelTasks,
	        },
	      },
	    });
	  });

	  app.post('/api/issue/task-execution', async (req, reply) => {
	    const gate = await requireMutatingAllowed(req);
	    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });
	    if (runManager.getStatus().running) return reply.code(409).send({ ok: false, error: 'Cannot edit task execution settings while Jeeves is running.' });

	    const issue = runManager.getIssue();
	    if (!issue.stateDir) return reply.code(400).send({ ok: false, error: 'No issue selected.' });
	    const issueJson = await readIssueJson(issue.stateDir);
	    if (!issueJson) return reply.code(404).send({ ok: false, error: 'issue.json not found.' });

	    const body = getBody(req);
	    const modeRaw = parseOptionalString(body.mode);
	    if (!modeRaw) return reply.code(400).send({ ok: false, error: 'mode is required' });
	    const mode = modeRaw.trim();
	    if (mode !== 'sequential' && mode !== 'parallel') {
	      return reply.code(400).send({ ok: false, error: 'mode must be "sequential" or "parallel"' });
	    }

	    const maxParallelTasksRaw = body.maxParallelTasks ?? body.max_parallel_tasks;
	    const parsedMaxParallel = parseOptionalNumber(maxParallelTasksRaw);
	    let maxParallelTasks: number | undefined;
	    if (parsedMaxParallel !== null && parsedMaxParallel !== undefined) {
	      if (!Number.isInteger(parsedMaxParallel) || parsedMaxParallel < 1 || parsedMaxParallel > 8) {
	        return reply.code(400).send({ ok: false, error: 'maxParallelTasks must be an integer between 1 and 8' });
	      }
	      maxParallelTasks = parsedMaxParallel;
	    }

	    const settings =
	      (issueJson.settings && typeof issueJson.settings === 'object' && !Array.isArray(issueJson.settings))
	        ? (issueJson.settings as Record<string, unknown>)
	        : {};
	    const existingTaskExecution =
	      (settings.taskExecution && typeof settings.taskExecution === 'object' && !Array.isArray(settings.taskExecution))
	        ? (settings.taskExecution as Record<string, unknown>)
	        : {};

	    const nextTaskExecution: Record<string, unknown> = {
	      ...existingTaskExecution,
	      mode,
	      ...(maxParallelTasks !== undefined ? { maxParallelTasks } : {}),
	    };

	    issueJson.settings = {
	      ...settings,
	      taskExecution: nextTaskExecution,
	    };

	    await writeIssueJson(issue.stateDir, issueJson);
	    hub.broadcast('state', await getStateSnapshot());

	    const effectiveMax = typeof nextTaskExecution.maxParallelTasks === 'number' && Number.isInteger(nextTaskExecution.maxParallelTasks) && nextTaskExecution.maxParallelTasks >= 1
	      ? Math.min(nextTaskExecution.maxParallelTasks, 8)
	      : 1;

	    return reply.send({
	      ok: true,
	      settings: {
	        taskExecution: {
	          mode,
	          maxParallelTasks: effectiveMax,
	        },
	      },
	    });
	  });

		  app.get('/api/workflow', async (_req, reply) => {
		    const issue = runManager.getIssue();
		    const issueJson = issue.stateDir ? await readIssueJson(issue.stateDir) : null;
		    const workflowName = (issueJson && typeof issueJson.workflow === 'string' && issueJson.workflow.trim()) ? issueJson.workflow : 'default';

	    try {
	      const workflow = await loadWorkflowByName(workflowName, { workflowsDir });
	      const currentPhaseRaw =
	        issueJson && typeof issueJson.phase === 'string' && issueJson.phase.trim() ? issueJson.phase.trim() : null;
	      const currentPhase = currentPhaseRaw && workflow.phases[currentPhaseRaw] ? currentPhaseRaw : workflow.start;
	      const phases = Object.entries(workflow.phases).map(([id, phase]) => ({
	        id,
	        name: id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
	        type: phase.type,
        description: phase.description ?? '',
      }));
      const phase_order = Object.keys(workflow.phases);
      return reply.send({
        ok: true,
        workflow_name: workflowName,
        start_phase: workflow.start,
        current_phase: currentPhase,
        phases,
        phase_order,
      });
    } catch (err) {
      return reply.code(404).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ============================================================================
  // Sonar Token Endpoints
  // ============================================================================

  /** Build SonarTokenStatus from current state (never includes token value). */
  async function buildSonarTokenStatus(
    issueRef: string,
    stateDir: string,
    workDir: string | null,
  ): Promise<SonarTokenStatus> {
    const secret = await readSonarTokenSecret(stateDir);
    const hasToken = secret.exists;

    const worktreePresent = Boolean(
      workDir && (await fs.stat(workDir).catch(() => null))?.isDirectory(),
    );

    // Read status from issue.json
    const issueJson = await readIssueJson(stateDir);
    const sonarTokenStatus = (issueJson?.status as Record<string, unknown> | undefined)?.sonarToken as
      | Record<string, unknown>
      | undefined;

    const envVarName =
      typeof sonarTokenStatus?.env_var_name === 'string' && sonarTokenStatus.env_var_name.trim()
        ? sonarTokenStatus.env_var_name.trim()
        : DEFAULT_ENV_VAR_NAME;

    const storedSyncStatus = (sonarTokenStatus?.sync_status as SonarSyncStatus) ?? 'never_attempted';
    const lastAttemptAt =
      typeof sonarTokenStatus?.last_attempt_at === 'string' ? sonarTokenStatus.last_attempt_at : null;
    const lastSuccessAt =
      typeof sonarTokenStatus?.last_success_at === 'string' ? sonarTokenStatus.last_success_at : null;
    const lastError =
      typeof sonarTokenStatus?.last_error === 'string' ? sonarTokenStatus.last_error : null;

    // Design §4 sync_status relationships when worktree is missing/deleted:
    // - If worktree_present=false and has_token=true: sync_status=deferred_worktree_absent
    // - If worktree_present=false and has_token=false: sync_status=in_sync (trivially satisfied)
    let syncStatus: SonarSyncStatus;
    if (!worktreePresent) {
      syncStatus = hasToken ? 'deferred_worktree_absent' : 'in_sync';
    } else {
      syncStatus = storedSyncStatus;
    }

    return {
      issue_ref: issueRef,
      worktree_present: worktreePresent,
      has_token: hasToken,
      env_var_name: envVarName,
      sync_status: syncStatus,
      last_attempt_at: lastAttemptAt,
      last_success_at: lastSuccessAt,
      last_error: lastError,
    };
  }

  /** Update issue.json with sonar token status (never stores token value). */
  async function updateSonarTokenStatusInIssueJson(
    stateDir: string,
    updates: Partial<{
      env_var_name: string;
      sync_status: SonarSyncStatus;
      last_attempt_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
    }>,
  ): Promise<void> {
    const issueJson = (await readIssueJson(stateDir)) ?? {};

    // Ensure status object exists
    if (!issueJson.status || typeof issueJson.status !== 'object') {
      issueJson.status = {};
    }
    const status = issueJson.status as Record<string, unknown>;

    // Ensure sonarToken object exists
    if (!status.sonarToken || typeof status.sonarToken !== 'object') {
      status.sonarToken = {};
    }
    const sonarToken = status.sonarToken as Record<string, unknown>;

    // Apply updates
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        sonarToken[key] = value;
      }
    }

    await writeIssueJson(stateDir, issueJson);
  }

  /** Emit sonar-token-status event. */
  function emitSonarTokenStatus(status: SonarTokenStatus): void {
    hub.broadcast('sonar-token-status', status);
  }

  /**
   * Best-effort auto-reconcile of sonar token to worktree.
   * Called after /api/init/issue, /api/issues/select, and on startup.
   * Non-fatal: errors are recorded in status but do not propagate.
   *
   * IMPORTANT: This function handles BOTH token-present AND token-absent cases:
   * - Token present: writes .env.jeeves with token, cleans up .env.jeeves.tmp
   * - Token absent: removes .env.jeeves (if stale), cleans up .env.jeeves.tmp
   *
   * This ensures that on startup or issue select, any leftover artifacts from
   * previous runs are cleaned up, regardless of whether a token is configured.
   *
   * MUTEX: This function acquires the per-issue Sonar token mutex to prevent
   * concurrent writes with PUT/DELETE/RECONCILE endpoints. If the mutex cannot
   * be acquired (busy), reconcile is skipped as a best-effort no-op.
   */
  async function autoReconcileSonarToken(
    issueRef: string,
    stateDir: string,
    workDir: string | null,
  ): Promise<void> {
    // Acquire mutex to prevent concurrent writes with PUT/DELETE/RECONCILE
    // If busy, skip reconcile as best-effort no-op (do not block or deadlock)
    const acquired = await acquireSonarTokenMutex(issueRef);
    if (!acquired) {
      // Mutex is busy - another operation is in progress. Skip reconcile.
      // This is fine for auto-reconcile since it's best-effort.
      return;
    }

    try {
      await autoReconcileSonarTokenCore(issueRef, stateDir, workDir);
    } finally {
      releaseSonarTokenMutex(issueRef);
    }
  }

  /**
   * Core implementation of auto-reconcile (called with mutex held).
   */
  async function autoReconcileSonarTokenCore(
    issueRef: string,
    stateDir: string,
    workDir: string | null,
  ): Promise<void> {
    const now = new Date().toISOString();

    // Read existing status to determine if we have a token
    // If reading fails (e.g., EACCES), treat as error (not as "token absent")
    let secret: Awaited<ReturnType<typeof readSonarTokenSecret>>;
    try {
      secret = await readSonarTokenSecret(stateDir);
    } catch (err) {
      // I/O error reading secret file - record error and abort reconcile
      // Do NOT treat as "token absent" (would incorrectly delete .env.jeeves)
      const lastError = err instanceof SonarTokenSecretReadError ? err.message : sanitizeErrorForUi(err);
      await updateSonarTokenStatusInIssueJson(stateDir, {
        sync_status: 'failed_secret_read',
        last_attempt_at: now,
        last_error: lastError,
      });
      // Best-effort: still try to emit status (may throw again, but that's fine)
      try {
        const status = await buildSonarTokenStatus(issueRef, stateDir, workDir);
        emitSonarTokenStatus(status);
      } catch {
        // Ignore - we already recorded the error
      }
      return;
    }

    const hasToken = secret.exists;

    // Read current env_var_name from issue.json
    const issueJson = await readIssueJson(stateDir);
    const sonarTokenStatus = (issueJson?.status as Record<string, unknown> | undefined)?.sonarToken as
      | Record<string, unknown>
      | undefined;
    const envVarName =
      typeof sonarTokenStatus?.env_var_name === 'string' && sonarTokenStatus.env_var_name.trim()
        ? sonarTokenStatus.env_var_name.trim()
        : DEFAULT_ENV_VAR_NAME;

    // Reconcile if worktree exists (handles both token present/absent cases)
    let syncStatus: SonarSyncStatus = 'never_attempted';
    let lastError: string | null = null;

    if (workDir) {
      const worktreeExists = (await fs.stat(workDir).catch(() => null))?.isDirectory();
      if (worktreeExists) {
        // Always call reconcile - it handles both:
        // - hasToken=true: write .env.jeeves with token
        // - hasToken=false: remove .env.jeeves if present
        // In both cases, it cleans up .env.jeeves.tmp
        const tokenValue = secret.exists ? secret.data.token : undefined;

        try {
          const reconcileResult = await reconcileSonarTokenToWorktree({
            worktreeDir: workDir,
            hasToken,
            token: tokenValue,
            envVarName,
          });

          syncStatus = reconcileResult.sync_status;
          lastError = reconcileResult.last_error;
        } catch (err) {
          // reconcileSonarTokenToWorktree should not throw, but if it does
          // (e.g., runGit throws in ensurePatternsExcluded), record the error
          syncStatus = 'failed_exclude';
          lastError = sanitizeErrorForUi(err);
        }
      } else {
        syncStatus = hasToken ? 'deferred_worktree_absent' : 'in_sync';
      }
    } else {
      syncStatus = hasToken ? 'deferred_worktree_absent' : 'in_sync';
    }

    // Update status in issue.json
    await updateSonarTokenStatusInIssueJson(stateDir, {
      sync_status: syncStatus,
      last_attempt_at: now,
      last_success_at: syncStatus === 'in_sync' ? now : (sonarTokenStatus?.last_success_at as string | null) ?? null,
      last_error: lastError,
    });

    // Build and emit final status
    const status = await buildSonarTokenStatus(issueRef, stateDir, workDir);
    emitSonarTokenStatus(status);
  }

  // ── Project files status helpers ──

  async function buildProjectFilesStatus(
    issueRef: string,
    stateDir: string,
    workDir: string | null,
  ): Promise<ProjectFilesStatus> {
    const { owner, repo } = parseOwnerRepoFromIssueRef(issueRef);
    const records = await listProjectFiles(dataDir, owner, repo);
    const files = records.map(toProjectFilePublic);

    const worktreePresent = Boolean(
      workDir && (await fs.stat(workDir).catch(() => null))?.isDirectory(),
    );

    const issueJson = await readIssueJson(stateDir);
    const projectFilesStatus = (issueJson?.status as Record<string, unknown> | undefined)?.projectFiles as
      | Record<string, unknown>
      | undefined;

    const storedSyncStatus = (projectFilesStatus?.sync_status as ProjectFilesSyncStatus) ?? 'never_attempted';
    const lastAttemptAt =
      typeof projectFilesStatus?.last_attempt_at === 'string' ? projectFilesStatus.last_attempt_at : null;
    const lastSuccessAt =
      typeof projectFilesStatus?.last_success_at === 'string' ? projectFilesStatus.last_success_at : null;
    const lastError =
      typeof projectFilesStatus?.last_error === 'string' ? projectFilesStatus.last_error : null;

    let syncStatus: ProjectFilesSyncStatus;
    if (!worktreePresent) {
      syncStatus = files.length > 0 ? 'deferred_worktree_absent' : 'in_sync';
    } else {
      syncStatus = storedSyncStatus;
    }

    return {
      issue_ref: issueRef,
      worktree_present: worktreePresent,
      file_count: files.length,
      files,
      sync_status: syncStatus,
      last_attempt_at: lastAttemptAt,
      last_success_at: lastSuccessAt,
      last_error: lastError,
    };
  }

  async function updateProjectFilesStatusInIssueJson(
    stateDir: string,
    updates: Partial<{
      sync_status: ProjectFilesSyncStatus;
      last_attempt_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
      managed_targets: readonly string[];
    }>,
  ): Promise<void> {
    const issueJson = (await readIssueJson(stateDir)) ?? {};

    if (!issueJson.status || typeof issueJson.status !== 'object') {
      issueJson.status = {};
    }
    const status = issueJson.status as Record<string, unknown>;

    if (!status.projectFiles || typeof status.projectFiles !== 'object') {
      status.projectFiles = {};
    }
    const projectFiles = status.projectFiles as Record<string, unknown>;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        projectFiles[key] = value;
      }
    }

    await writeIssueJson(stateDir, issueJson);
  }

  async function getManagedProjectTargetsFromIssueJson(stateDir: string): Promise<readonly string[]> {
    const issueJson = await readIssueJson(stateDir);
    const projectFilesStatus = (issueJson?.status as Record<string, unknown> | undefined)?.projectFiles as
      | Record<string, unknown>
      | undefined;
    const raw = projectFilesStatus?.managed_targets;
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  }

  async function hasProjectFilesStatusInIssueJson(stateDir: string): Promise<boolean> {
    const issueJson = await readIssueJson(stateDir);
    const projectFilesStatus = (issueJson?.status as Record<string, unknown> | undefined)?.projectFiles;
    return Boolean(projectFilesStatus && typeof projectFilesStatus === 'object' && !Array.isArray(projectFilesStatus));
  }

  function emitProjectFilesStatus(status: ProjectFilesStatus, operation: ProjectFilesOperation): void {
    const event: ProjectFilesStatusEvent = { ...status, operation };
    hub.broadcast('project-files-status', event);
  }

  async function reconcileProjectFilesForIssue(
    params: {
      issueRef: string;
      stateDir: string;
      workDir: string | null;
      operation: ProjectFilesOperation;
    },
  ): Promise<{ status: ProjectFilesStatus; warnings: string[] }> {
    const { issueRef, stateDir, workDir, operation } = params;
    const { owner, repo } = parseOwnerRepoFromIssueRef(issueRef);
    const records = await listProjectFiles(dataDir, owner, repo);

    const now = new Date().toISOString();
    const existingStatus = await buildProjectFilesStatus(issueRef, stateDir, workDir);
    const previousManagedTargets = await getManagedProjectTargetsFromIssueJson(stateDir);

    if (!workDir) {
      const syncStatus: ProjectFilesSyncStatus = records.length > 0 ? 'deferred_worktree_absent' : 'in_sync';
      await updateProjectFilesStatusInIssueJson(stateDir, {
        sync_status: syncStatus,
        last_attempt_at: now,
        last_success_at: syncStatus === 'in_sync' ? now : existingStatus.last_success_at,
        last_error: null,
      });
      const status = await buildProjectFilesStatus(issueRef, stateDir, workDir);
      emitProjectFilesStatus(status, operation);
      return {
        status,
        warnings: syncStatus === 'deferred_worktree_absent'
          ? ['Worktree not present; project files will sync when a worktree exists.']
          : [],
      };
    }

    const worktreeExists = (await fs.stat(workDir).catch(() => null))?.isDirectory();
    if (!worktreeExists) {
      const syncStatus: ProjectFilesSyncStatus = records.length > 0 ? 'deferred_worktree_absent' : 'in_sync';
      await updateProjectFilesStatusInIssueJson(stateDir, {
        sync_status: syncStatus,
        last_attempt_at: now,
        last_success_at: syncStatus === 'in_sync' ? now : existingStatus.last_success_at,
        last_error: null,
      });
      const status = await buildProjectFilesStatus(issueRef, stateDir, workDir);
      emitProjectFilesStatus(status, operation);
      return {
        status,
        warnings: syncStatus === 'deferred_worktree_absent'
          ? ['Worktree directory does not exist; project files sync deferred.']
          : [],
      };
    }

    const reconcileResult = await reconcileProjectFilesToWorktree({
      worktreeDir: workDir,
      repoFilesDir: getRepoProjectFilesDir(dataDir, owner, repo),
      files: records,
      previousManagedTargets,
    });

    await updateProjectFilesStatusInIssueJson(stateDir, {
      sync_status: reconcileResult.sync_status,
      last_attempt_at: now,
      last_success_at:
        reconcileResult.sync_status === 'in_sync'
          ? now
          : existingStatus.last_success_at,
      last_error: reconcileResult.last_error,
      ...(reconcileResult.sync_status === 'in_sync'
        ? { managed_targets: reconcileResult.managed_targets }
        : {}),
    });

    const status = await buildProjectFilesStatus(issueRef, stateDir, workDir);
    emitProjectFilesStatus(status, operation);
    return { status, warnings: reconcileResult.warnings };
  }

  async function autoReconcileProjectFiles(
    issueRef: string,
    stateDir: string,
    workDir: string | null,
  ): Promise<void> {
    const { owner, repo } = parseOwnerRepoFromIssueRef(issueRef);
    const repoRef = `${owner}/${repo}`;

    const acquired = await acquireProjectFilesMutex(repoRef);
    if (!acquired) return;

    try {
      const records = await listProjectFiles(dataDir, owner, repo);
      const hasStoredStatus = await hasProjectFilesStatusInIssueJson(stateDir);
      if (records.length === 0 && !hasStoredStatus) {
        return;
      }

      await reconcileProjectFilesForIssue({
        issueRef,
        stateDir,
        workDir,
        operation: 'auto_reconcile',
      });
    } finally {
      releaseProjectFilesMutex(repoRef);
    }
  }

  // ── Azure DevOps credential status helpers ──

  /**
   * Build the current Azure DevOps credential status for an issue.
   * Reads secret file + issue.json status to produce the full status object.
   */
  async function buildAzureDevopsStatus(
    issueRef: string,
    stateDir: string,
    workDir: string | null,
  ): Promise<AzureDevopsStatus> {
    const secret = await readAzureDevopsSecret(stateDir);
    const hasPat = secret.exists;

    const worktreePresent = Boolean(
      workDir && (await fs.stat(workDir).catch(() => null))?.isDirectory(),
    );

    // Read status from issue.json
    const issueJson = await readIssueJson(stateDir);
    const azureStatus = (issueJson?.status as Record<string, unknown> | undefined)?.azureDevops as
      | Record<string, unknown>
      | undefined;

    const organization =
      typeof azureStatus?.organization === 'string' ? azureStatus.organization : null;
    const project =
      typeof azureStatus?.project === 'string' ? azureStatus.project : null;
    const patLastUpdatedAt =
      typeof azureStatus?.pat_last_updated_at === 'string' ? azureStatus.pat_last_updated_at : null;

    const configured = organization !== null && project !== null;

    const storedSyncStatus = (azureStatus?.sync_status as AzureDevopsSyncStatus) ?? 'never_attempted';
    const lastAttemptAt =
      typeof azureStatus?.last_attempt_at === 'string' ? azureStatus.last_attempt_at : null;
    const lastSuccessAt =
      typeof azureStatus?.last_success_at === 'string' ? azureStatus.last_success_at : null;
    const lastError =
      typeof azureStatus?.last_error === 'string' ? azureStatus.last_error : null;

    // Sync status override when worktree is absent
    let syncStatus: AzureDevopsSyncStatus;
    if (!worktreePresent) {
      syncStatus = hasPat ? 'deferred_worktree_absent' : 'in_sync';
    } else {
      syncStatus = storedSyncStatus;
    }

    return {
      issue_ref: issueRef,
      worktree_present: worktreePresent,
      configured,
      organization,
      project,
      has_pat: hasPat,
      pat_last_updated_at: patLastUpdatedAt,
      pat_env_var_name: AZURE_PAT_ENV_VAR_NAME,
      sync_status: syncStatus,
      last_attempt_at: lastAttemptAt,
      last_success_at: lastSuccessAt,
      last_error: lastError,
    };
  }

  /**
   * Update Azure DevOps status fields in issue.json (at status.azureDevops).
   * Creates nested structure if needed.
   */
  async function updateAzureDevopsStatusInIssueJson(
    stateDir: string,
    updates: Partial<{
      organization: string | null;
      project: string | null;
      pat_last_updated_at: string | null;
      sync_status: AzureDevopsSyncStatus;
      last_attempt_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
    }>,
  ): Promise<void> {
    const issueJson = (await readIssueJson(stateDir)) ?? {};

    // Ensure status object exists
    if (!issueJson.status || typeof issueJson.status !== 'object') {
      issueJson.status = {};
    }
    const status = issueJson.status as Record<string, unknown>;

    // Ensure azureDevops object exists
    if (!status.azureDevops || typeof status.azureDevops !== 'object') {
      status.azureDevops = {};
    }
    const azureDevops = status.azureDevops as Record<string, unknown>;

    // Apply updates
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        azureDevops[key] = value;
      }
    }

    await writeIssueJson(stateDir, issueJson);
  }

  /** Emit azure-devops-status event with operation context. */
  function emitAzureDevopsStatus(status: AzureDevopsStatus, operation: AzureDevopsOperation): void {
    const event: AzureDevopsStatusEvent = { ...status, operation };
    hub.broadcast('azure-devops-status', event);
  }

  /**
   * Best-effort auto-reconcile of Azure DevOps credentials to worktree.
   * Called after /api/init/issue, /api/issues/select, and on startup.
   * Non-fatal: errors are recorded in status but do not propagate.
   *
   * MUTEX: Acquires per-issue Azure DevOps mutex. If busy, skips as best-effort no-op.
   */
  async function autoReconcileAzureDevops(
    issueRef: string,
    stateDir: string,
    workDir: string | null,
  ): Promise<void> {
    const acquired = await acquireAzureDevopsMutex(issueRef);
    if (!acquired) {
      // Mutex is busy - skip reconcile (best-effort)
      return;
    }

    try {
      await autoReconcileAzureDevopsCore(issueRef, stateDir, workDir);
    } finally {
      releaseAzureDevopsMutex(issueRef);
    }
  }

  /** Core Azure DevOps auto-reconcile logic (must be called with mutex held). */
  async function autoReconcileAzureDevopsCore(
    issueRef: string,
    stateDir: string,
    workDir: string | null,
  ): Promise<void> {
    const now = new Date().toISOString();

    // Read secret — distinguish I/O errors from "not present"
    let secret: Awaited<ReturnType<typeof readAzureDevopsSecret>>;
    try {
      secret = await readAzureDevopsSecret(stateDir);
    } catch (err) {
      const lastError = err instanceof AzureDevopsSecretReadError
        ? sanitizePatFromMessage(err.message)
        : sanitizeErrorForUi(err);
      await updateAzureDevopsStatusInIssueJson(stateDir, {
        sync_status: 'failed_secret_read',
        last_attempt_at: now,
        last_error: lastError,
      });
      try {
        const status = await buildAzureDevopsStatus(issueRef, stateDir, workDir);
        emitAzureDevopsStatus(status, 'auto_reconcile');
      } catch {
        // Ignore — already recorded the error
      }
      return;
    }

    const hasSecret = secret.exists;

    // Reconcile if worktree exists
    let syncStatus: AzureDevopsSyncStatus = 'never_attempted';
    let lastError: string | null = null;

    if (workDir) {
      const worktreeExists = (await fs.stat(workDir).catch(() => null))?.isDirectory();
      if (worktreeExists) {
        const patValue = secret.exists ? secret.data.pat : undefined;

        try {
          const reconcileResult = await reconcileAzureDevopsToWorktree({
            worktreeDir: workDir,
            hasSecret,
            pat: patValue,
          });

          syncStatus = reconcileResult.sync_status;
          lastError = reconcileResult.last_error;
        } catch (err) {
          syncStatus = 'failed_exclude';
          lastError = sanitizeErrorForUi(err);
        }
      } else {
        syncStatus = hasSecret ? 'deferred_worktree_absent' : 'in_sync';
      }
    } else {
      syncStatus = hasSecret ? 'deferred_worktree_absent' : 'in_sync';
    }

    // Read current status to preserve last_success_at
    const issueJson = await readIssueJson(stateDir);
    const azureStatus = (issueJson?.status as Record<string, unknown> | undefined)?.azureDevops as
      | Record<string, unknown>
      | undefined;

    // Update status in issue.json
    await updateAzureDevopsStatusInIssueJson(stateDir, {
      sync_status: syncStatus,
      last_attempt_at: now,
      last_success_at: syncStatus === 'in_sync' ? now : (azureStatus?.last_success_at as string | null) ?? null,
      last_error: lastError,
    });

    // Build and emit final status
    const status = await buildAzureDevopsStatus(issueRef, stateDir, workDir);
    emitAzureDevopsStatus(status, 'auto_reconcile');
  }

  // GET /api/issue/sonar-token
  app.get('/api/issue/sonar-token', async (_req, reply) => {
    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    try {
      const status = await buildSonarTokenStatus(issue.issueRef, issue.stateDir, issue.workDir);
      return reply.send({ ok: true, ...status });
    } catch (err) {
      const message = sanitizeErrorForUi(err);
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    }
  });

  // PUT /api/issue/sonar-token
  app.put('/api/issue/sonar-token', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    if (runManager.getStatus().running) {
      return reply.code(409).send({ ok: false, error: 'Cannot edit while Jeeves is running.', code: 'conflict_running' });
    }

    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    // Validate request body
    const validation = validatePutRequest(req.body);
    if (!validation.valid) {
      return reply.code(400).send({
        ok: false,
        error: validation.error,
        code: validation.code,
        field_errors: validation.field_errors,
      });
    }

    // Acquire mutex
    const acquired = await acquireSonarTokenMutex(issue.issueRef);
    if (!acquired) {
      return reply.code(503).send({ ok: false, error: 'Another token operation is in progress.', code: 'busy' });
    }

    try {
      const warnings: string[] = [];
      const now = new Date().toISOString();

      // Read existing status to get current env_var_name if not provided
      const existingStatus = await buildSonarTokenStatus(issue.issueRef, issue.stateDir, issue.workDir);

      // Determine env_var_name to use
      const envVarName = validation.env_var_name ?? existingStatus.env_var_name;

      // Persist token if provided
      if (validation.token !== undefined) {
        await writeSonarTokenSecret(issue.stateDir, validation.token);
      }

      // Update env_var_name in issue.json if provided
      if (validation.env_var_name !== undefined) {
        await updateSonarTokenStatusInIssueJson(issue.stateDir, { env_var_name: validation.env_var_name });
      }

      // Track whether meaningful changes were made that invalidate current sync state
      const tokenChanged = validation.token !== undefined;
      const envVarNameChanged =
        validation.env_var_name !== undefined && validation.env_var_name !== existingStatus.env_var_name;
      const meaningfulChange = tokenChanged || envVarNameChanged;

      // Reconcile if sync_now is true and worktree exists
      let syncStatus: SonarSyncStatus = existingStatus.sync_status;
      let lastError: string | null = existingStatus.last_error;

      if (validation.sync_now && issue.workDir) {
        const worktreeExists = (await fs.stat(issue.workDir).catch(() => null))?.isDirectory();
        if (worktreeExists) {
          // Read the token for reconciliation (we need the actual value to write to .env.jeeves)
          const secretResult = await readSonarTokenSecret(issue.stateDir);
          const tokenValue = secretResult.exists ? secretResult.data.token : undefined;
          const hasTokenNow = secretResult.exists;

          const reconcileResult = await reconcileSonarTokenToWorktree({
            worktreeDir: issue.workDir,
            hasToken: hasTokenNow,
            token: tokenValue,
            envVarName,
          });

          syncStatus = reconcileResult.sync_status;
          lastError = reconcileResult.last_error;
          warnings.push(...reconcileResult.warnings);

          await updateSonarTokenStatusInIssueJson(issue.stateDir, {
            sync_status: syncStatus,
            last_attempt_at: now,
            last_success_at: syncStatus === 'in_sync' ? now : existingStatus.last_success_at,
            last_error: lastError,
          });
        } else {
          syncStatus = 'deferred_worktree_absent';
          await updateSonarTokenStatusInIssueJson(issue.stateDir, {
            sync_status: syncStatus,
            last_attempt_at: now,
            last_error: null,
          });
        }
      } else if (meaningfulChange) {
        // Token or env_var_name changed without reconciliation - reset sync_status
        // so the UI shows that syncing is needed (per design, sync_status should
        // reflect actual state, not stale prior state)
        syncStatus = 'never_attempted';
        lastError = null;
        await updateSonarTokenStatusInIssueJson(issue.stateDir, {
          sync_status: syncStatus,
          last_error: null,
        });
      }

      // Build final status
      const status = await buildSonarTokenStatus(issue.issueRef, issue.stateDir, issue.workDir);

      // Emit event
      emitSonarTokenStatus(status);

      return reply.send({ ok: true, updated: true, status, warnings });
    } catch (err) {
      const message = sanitizeErrorForUi(err);
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    } finally {
      releaseSonarTokenMutex(issue.issueRef);
    }
  });

  // DELETE /api/issue/sonar-token
  app.delete('/api/issue/sonar-token', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    if (runManager.getStatus().running) {
      return reply.code(409).send({ ok: false, error: 'Cannot edit while Jeeves is running.', code: 'conflict_running' });
    }

    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    // Acquire mutex
    const acquired = await acquireSonarTokenMutex(issue.issueRef);
    if (!acquired) {
      return reply.code(503).send({ ok: false, error: 'Another token operation is in progress.', code: 'busy' });
    }

    try {
      const warnings: string[] = [];
      const now = new Date().toISOString();

      // Check if token existed before deletion
      const existingStatus = await buildSonarTokenStatus(issue.issueRef, issue.stateDir, issue.workDir);
      const hadToken = existingStatus.has_token;

      // Delete the secret file
      await deleteSonarTokenSecret(issue.stateDir);

      // Reconcile (remove .env.jeeves) if worktree exists
      let syncStatus: SonarSyncStatus = 'never_attempted';
      let lastError: string | null = null;

      if (issue.workDir) {
        const worktreeExists = (await fs.stat(issue.workDir).catch(() => null))?.isDirectory();
        if (worktreeExists) {
          const reconcileResult = await reconcileSonarTokenToWorktree({
            worktreeDir: issue.workDir,
            hasToken: false,
            envVarName: existingStatus.env_var_name,
          });

          syncStatus = reconcileResult.sync_status;
          lastError = reconcileResult.last_error;
          warnings.push(...reconcileResult.warnings);
        } else {
          syncStatus = 'in_sync'; // No worktree, so nothing to sync - trivially satisfied
        }
      } else {
        syncStatus = 'in_sync'; // No worktree, trivially satisfied
      }

      await updateSonarTokenStatusInIssueJson(issue.stateDir, {
        sync_status: syncStatus,
        last_attempt_at: now,
        last_success_at: syncStatus === 'in_sync' ? now : existingStatus.last_success_at,
        last_error: lastError,
      });

      // Build final status
      const status = await buildSonarTokenStatus(issue.issueRef, issue.stateDir, issue.workDir);

      // Emit event
      emitSonarTokenStatus(status);

      return reply.send({ ok: true, updated: hadToken, status, warnings });
    } catch (err) {
      const message = sanitizeErrorForUi(err);
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    } finally {
      releaseSonarTokenMutex(issue.issueRef);
    }
  });

  // POST /api/issue/sonar-token/reconcile
  app.post('/api/issue/sonar-token/reconcile', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    if (runManager.getStatus().running) {
      return reply.code(409).send({ ok: false, error: 'Cannot edit while Jeeves is running.', code: 'conflict_running' });
    }

    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    // Validate request body
    const validation = validateReconcileRequest(req.body);
    if (!validation.valid) {
      return reply.code(400).send({
        ok: false,
        error: validation.error,
        code: validation.code,
        field_errors: validation.field_errors,
      });
    }

    // Acquire mutex
    const acquired = await acquireSonarTokenMutex(issue.issueRef);
    if (!acquired) {
      return reply.code(503).send({ ok: false, error: 'Another token operation is in progress.', code: 'busy' });
    }

    try {
      const warnings: string[] = [];
      const now = new Date().toISOString();
      const forceReconcile = validation.value?.force ?? false;

      // Get current status
      const existingStatus = await buildSonarTokenStatus(issue.issueRef, issue.stateDir, issue.workDir);

      // Skip reconcile if already in_sync and force is not set
      if (existingStatus.sync_status === 'in_sync' && !forceReconcile) {
        // Already in desired state; no-op
        return reply.send({
          ok: true,
          updated: false,
          status: existingStatus,
          warnings: ['Already in sync; use force=true to re-run reconciliation.'],
        });
      }

      // Reconcile only if worktree exists
      let syncStatus: SonarSyncStatus = existingStatus.sync_status;
      let lastError: string | null = existingStatus.last_error;

      if (!issue.workDir) {
        syncStatus = existingStatus.has_token ? 'deferred_worktree_absent' : 'in_sync';
        warnings.push('Worktree not present; deferred.');
      } else {
        const worktreeExists = (await fs.stat(issue.workDir).catch(() => null))?.isDirectory();
        if (!worktreeExists) {
          syncStatus = existingStatus.has_token ? 'deferred_worktree_absent' : 'in_sync';
          warnings.push('Worktree directory does not exist; deferred.');
        } else {
          // Read token for reconciliation
          const secretResult = await readSonarTokenSecret(issue.stateDir);
          const tokenValue = secretResult.exists ? secretResult.data.token : undefined;
          const hasTokenNow = secretResult.exists;

          const reconcileResult = await reconcileSonarTokenToWorktree({
            worktreeDir: issue.workDir,
            hasToken: hasTokenNow,
            token: tokenValue,
            envVarName: existingStatus.env_var_name,
          });

          syncStatus = reconcileResult.sync_status;
          lastError = reconcileResult.last_error;
          warnings.push(...reconcileResult.warnings);
        }
      }

      await updateSonarTokenStatusInIssueJson(issue.stateDir, {
        sync_status: syncStatus,
        last_attempt_at: now,
        last_success_at: syncStatus === 'in_sync' ? now : existingStatus.last_success_at,
        last_error: lastError,
      });

      // Build final status
      const status = await buildSonarTokenStatus(issue.issueRef, issue.stateDir, issue.workDir);

      // Emit event
      emitSonarTokenStatus(status);

      // Reconcile never changes token presence, so updated is always false
      return reply.send({ ok: true, updated: false, status, warnings });
    } catch (err) {
      const message = sanitizeErrorForUi(err);
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    } finally {
      releaseSonarTokenMutex(issue.issueRef);
    }
  });

  // ── Azure DevOps credential endpoints ──

  // GET /api/issue/azure-devops
  app.get('/api/issue/azure-devops', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    try {
      const status = await buildAzureDevopsStatus(issue.issueRef, issue.stateDir, issue.workDir);
      return reply.send({ ok: true, ...status });
    } catch (err) {
      const message = sanitizeErrorForUi(err);
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    }
  });

  // PUT /api/issue/azure-devops
  app.put('/api/issue/azure-devops', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    if (runManager.getStatus().running) {
      return reply.code(409).send({ ok: false, error: 'Cannot edit while Jeeves is running.', code: 'conflict_running' });
    }

    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    // Validate request body
    const validation = validatePutAzureDevopsRequest(req.body);
    if (!validation.valid) {
      return reply.code(400).send({
        ok: false,
        error: validation.error,
        code: validation.code,
        field_errors: validation.field_errors,
      });
    }

    // Acquire in-memory mutex
    const acquired = await acquireAzureDevopsMutex(issue.issueRef);
    if (!acquired) {
      return reply.code(503).send({ ok: false, error: 'Another provider operation is in progress.', code: 'busy' });
    }

    // Acquire file-level lock inside mutex
    const lockResult = await acquireProviderOperationLock(issue.stateDir, issue.issueRef);
    if (!lockResult.acquired) {
      releaseAzureDevopsMutex(issue.issueRef);
      return reply.code(503).send({ ok: false, error: 'Another provider operation is in progress.', code: 'busy' });
    }

    try {
      // Create journal
      await createJournal(issue.stateDir, {
        operation_id: lockResult.operationId,
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: issue.issueRef,
        provider: null,
      });

      const warnings: string[] = [];
      const now = new Date().toISOString();

      // Persist secret
      await updateJournalState(issue.stateDir, 'cred.persisting_secret');
      await writeAzureDevopsSecret(
        issue.stateDir,
        validation.value.organization,
        validation.value.project,
        validation.value.pat,
      );

      // Update non-secret status fields in issue.json
      await updateAzureDevopsStatusInIssueJson(issue.stateDir, {
        organization: validation.value.organization,
        project: validation.value.project,
        pat_last_updated_at: now,
      });

      // Reconcile if sync_now is true (default) and worktree exists
      await updateJournalState(issue.stateDir, 'cred.reconciling_worktree');
      let syncStatus: AzureDevopsSyncStatus = 'never_attempted';
      let lastError: string | null = null;

      if (validation.value.sync_now && issue.workDir) {
        const worktreeExists = (await fs.stat(issue.workDir).catch(() => null))?.isDirectory();
        if (worktreeExists) {
          try {
            const reconcileResult = await reconcileAzureDevopsToWorktree({
              worktreeDir: issue.workDir,
              hasSecret: true,
              pat: validation.value.pat,
            });
            syncStatus = reconcileResult.sync_status;
            lastError = reconcileResult.last_error;
            warnings.push(...reconcileResult.warnings);
          } catch (err) {
            syncStatus = 'failed_exclude';
            lastError = sanitizeErrorForUi(err);
          }

          await updateAzureDevopsStatusInIssueJson(issue.stateDir, {
            sync_status: syncStatus,
            last_attempt_at: now,
            last_success_at: syncStatus === 'in_sync' ? now : null,
            last_error: lastError,
          });
        } else {
          syncStatus = 'deferred_worktree_absent';
          await updateAzureDevopsStatusInIssueJson(issue.stateDir, {
            sync_status: syncStatus,
            last_attempt_at: now,
            last_error: null,
          });
        }
      } else if (!validation.value.sync_now) {
        // sync_now=false: mark as never_attempted so UI shows syncing is needed
        syncStatus = 'never_attempted';
        await updateAzureDevopsStatusInIssueJson(issue.stateDir, {
          sync_status: syncStatus,
          last_error: null,
        });
      } else {
        // sync_now=true but no workDir
        syncStatus = 'deferred_worktree_absent';
        await updateAzureDevopsStatusInIssueJson(issue.stateDir, {
          sync_status: syncStatus,
          last_attempt_at: now,
          last_error: null,
        });
      }

      // Record status
      await updateJournalState(issue.stateDir, 'cred.recording_status');

      // Build final status
      const status = await buildAzureDevopsStatus(issue.issueRef, issue.stateDir, issue.workDir);

      // Emit event
      emitAzureDevopsStatus(status, 'put');

      // Finalize journal
      await finalizeJournal(issue.stateDir, 'cred.done_success');

      return reply.send({ ok: true, updated: true, status, warnings });
    } catch (err) {
      try { await finalizeJournal(issue.stateDir, 'cred.done_error'); } catch { /* journal finalize best-effort */ }
      const message = sanitizePatFromMessage(sanitizeErrorForUi(err));
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    } finally {
      await releaseLock(issue.stateDir);
      releaseAzureDevopsMutex(issue.issueRef);
    }
  });

  // PATCH /api/issue/azure-devops
  app.patch('/api/issue/azure-devops', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    if (runManager.getStatus().running) {
      return reply.code(409).send({ ok: false, error: 'Cannot edit while Jeeves is running.', code: 'conflict_running' });
    }

    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    // Validate request body
    const validation = validatePatchAzureDevopsRequest(req.body);
    if (!validation.valid) {
      return reply.code(400).send({
        ok: false,
        error: validation.error,
        code: validation.code,
        field_errors: validation.field_errors,
      });
    }

    // Acquire in-memory mutex
    const acquired = await acquireAzureDevopsMutex(issue.issueRef);
    if (!acquired) {
      return reply.code(503).send({ ok: false, error: 'Another provider operation is in progress.', code: 'busy' });
    }

    // Acquire file-level lock inside mutex
    const lockResult = await acquireProviderOperationLock(issue.stateDir, issue.issueRef);
    if (!lockResult.acquired) {
      releaseAzureDevopsMutex(issue.issueRef);
      return reply.code(503).send({ ok: false, error: 'Another provider operation is in progress.', code: 'busy' });
    }

    try {
      // Create journal
      await createJournal(issue.stateDir, {
        operation_id: lockResult.operationId,
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: issue.issueRef,
        provider: null,
      });

      const warnings: string[] = [];
      const now = new Date().toISOString();

      // Read existing secret to merge changes
      const existingSecret = await readAzureDevopsSecret(issue.stateDir);
      const existingStatus = await buildAzureDevopsStatus(issue.issueRef, issue.stateDir, issue.workDir);

      const { value } = validation;
      let meaningfulChange = false;

      // Persist secret changes
      await updateJournalState(issue.stateDir, 'cred.persisting_secret');

      // Handle clear_pat: delete secret but keep org/project in status
      if (value.clear_pat) {
        if (existingSecret.exists) {
          await deleteAzureDevopsSecret(issue.stateDir);
          meaningfulChange = true;
        }

        // Update org/project in status if provided
        const statusUpdates: Record<string, unknown> = {};
        if (value.organization !== undefined) {
          statusUpdates.organization = value.organization;
          meaningfulChange = true;
        }
        if (value.project !== undefined) {
          statusUpdates.project = value.project;
          meaningfulChange = true;
        }
        statusUpdates.pat_last_updated_at = existingSecret.exists ? now : existingStatus.pat_last_updated_at;

        if (Object.keys(statusUpdates).length > 0) {
          await updateAzureDevopsStatusInIssueJson(issue.stateDir, statusUpdates as Parameters<typeof updateAzureDevopsStatusInIssueJson>[1]);
        }
      } else if (value.pat !== undefined) {
        // New PAT provided: write or update secret
        const org = value.organization ?? (existingSecret.exists ? existingSecret.data.organization : existingStatus.organization ?? '');
        const proj = value.project ?? (existingSecret.exists ? existingSecret.data.project : existingStatus.project ?? '');

        await writeAzureDevopsSecret(issue.stateDir, org, proj, value.pat);

        await updateAzureDevopsStatusInIssueJson(issue.stateDir, {
          organization: org,
          project: proj,
          pat_last_updated_at: now,
        });
        meaningfulChange = true;
      } else {
        // Only org/project updates (no PAT change)
        if (value.organization !== undefined || value.project !== undefined) {
          const statusUpdates: Record<string, unknown> = {};
          if (value.organization !== undefined) statusUpdates.organization = value.organization;
          if (value.project !== undefined) statusUpdates.project = value.project;

          // If a secret exists, update it with new org/project
          if (existingSecret.exists) {
            const org = value.organization ?? existingSecret.data.organization;
            const proj = value.project ?? existingSecret.data.project;
            await writeAzureDevopsSecret(issue.stateDir, org, proj, existingSecret.data.pat);
          }

          await updateAzureDevopsStatusInIssueJson(issue.stateDir, statusUpdates as Parameters<typeof updateAzureDevopsStatusInIssueJson>[1]);
          meaningfulChange = true;
        }
      }

      // Reconcile if sync_now and there were changes (or always if sync_now=true)
      await updateJournalState(issue.stateDir, 'cred.reconciling_worktree');
      let syncStatus: AzureDevopsSyncStatus = existingStatus.sync_status;
      let lastError: string | null = existingStatus.last_error;

      if (value.sync_now && issue.workDir) {
        const worktreeExists = (await fs.stat(issue.workDir).catch(() => null))?.isDirectory();
        if (worktreeExists) {
          const secretResult = await readAzureDevopsSecret(issue.stateDir);
          const patValue = secretResult.exists ? secretResult.data.pat : undefined;

          try {
            const reconcileResult = await reconcileAzureDevopsToWorktree({
              worktreeDir: issue.workDir,
              hasSecret: secretResult.exists,
              pat: patValue,
            });
            syncStatus = reconcileResult.sync_status;
            lastError = reconcileResult.last_error;
            warnings.push(...reconcileResult.warnings);
          } catch (err) {
            syncStatus = 'failed_exclude';
            lastError = sanitizeErrorForUi(err);
          }

          await updateAzureDevopsStatusInIssueJson(issue.stateDir, {
            sync_status: syncStatus,
            last_attempt_at: now,
            last_success_at: syncStatus === 'in_sync' ? now : existingStatus.last_success_at,
            last_error: lastError,
          });
        } else {
          const secretResult = await readAzureDevopsSecret(issue.stateDir);
          syncStatus = secretResult.exists ? 'deferred_worktree_absent' : 'in_sync';
          await updateAzureDevopsStatusInIssueJson(issue.stateDir, {
            sync_status: syncStatus,
            last_attempt_at: now,
            last_error: null,
          });
        }
      } else if (meaningfulChange) {
        // Changed without reconciliation — reset sync_status
        syncStatus = 'never_attempted';
        lastError = null;
        await updateAzureDevopsStatusInIssueJson(issue.stateDir, {
          sync_status: syncStatus,
          last_error: null,
        });
      }

      // Record status
      await updateJournalState(issue.stateDir, 'cred.recording_status');

      // Build final status
      const status = await buildAzureDevopsStatus(issue.issueRef, issue.stateDir, issue.workDir);

      // Emit event
      emitAzureDevopsStatus(status, 'patch');

      // Finalize journal
      await finalizeJournal(issue.stateDir, 'cred.done_success');

      return reply.send({ ok: true, updated: meaningfulChange, status, warnings });
    } catch (err) {
      try { await finalizeJournal(issue.stateDir, 'cred.done_error'); } catch { /* journal finalize best-effort */ }
      const message = sanitizePatFromMessage(sanitizeErrorForUi(err));
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    } finally {
      await releaseLock(issue.stateDir);
      releaseAzureDevopsMutex(issue.issueRef);
    }
  });

  // DELETE /api/issue/azure-devops
  app.delete('/api/issue/azure-devops', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    if (runManager.getStatus().running) {
      return reply.code(409).send({ ok: false, error: 'Cannot edit while Jeeves is running.', code: 'conflict_running' });
    }

    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    // Acquire in-memory mutex
    const acquired = await acquireAzureDevopsMutex(issue.issueRef);
    if (!acquired) {
      return reply.code(503).send({ ok: false, error: 'Another provider operation is in progress.', code: 'busy' });
    }

    // Acquire file-level lock inside mutex
    const lockResult = await acquireProviderOperationLock(issue.stateDir, issue.issueRef);
    if (!lockResult.acquired) {
      releaseAzureDevopsMutex(issue.issueRef);
      return reply.code(503).send({ ok: false, error: 'Another provider operation is in progress.', code: 'busy' });
    }

    try {
      // Create journal
      await createJournal(issue.stateDir, {
        operation_id: lockResult.operationId,
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: issue.issueRef,
        provider: null,
      });

      const warnings: string[] = [];
      const now = new Date().toISOString();

      // Check if secret existed before deletion
      const existingStatus = await buildAzureDevopsStatus(issue.issueRef, issue.stateDir, issue.workDir);
      const hadSecret = existingStatus.has_pat;

      // Delete the secret file
      await updateJournalState(issue.stateDir, 'cred.persisting_secret');
      await deleteAzureDevopsSecret(issue.stateDir);

      // Reconcile (remove env var from .env.jeeves) if worktree exists
      await updateJournalState(issue.stateDir, 'cred.reconciling_worktree');
      let syncStatus: AzureDevopsSyncStatus = 'never_attempted';
      let lastError: string | null = null;

      if (issue.workDir) {
        const worktreeExists = (await fs.stat(issue.workDir).catch(() => null))?.isDirectory();
        if (worktreeExists) {
          try {
            const reconcileResult = await reconcileAzureDevopsToWorktree({
              worktreeDir: issue.workDir,
              hasSecret: false,
            });
            syncStatus = reconcileResult.sync_status;
            lastError = reconcileResult.last_error;
            warnings.push(...reconcileResult.warnings);
          } catch (err) {
            syncStatus = 'failed_exclude';
            lastError = sanitizeErrorForUi(err);
          }
        } else {
          syncStatus = 'in_sync'; // No worktree — trivially satisfied
        }
      } else {
        syncStatus = 'in_sync'; // No worktree — trivially satisfied
      }

      // Record status
      await updateJournalState(issue.stateDir, 'cred.recording_status');

      // Clear status fields (org/project and sync state)
      await updateAzureDevopsStatusInIssueJson(issue.stateDir, {
        organization: null,
        project: null,
        pat_last_updated_at: null,
        sync_status: syncStatus,
        last_attempt_at: now,
        last_success_at: syncStatus === 'in_sync' ? now : existingStatus.last_success_at,
        last_error: lastError,
      });

      // Build final status
      const status = await buildAzureDevopsStatus(issue.issueRef, issue.stateDir, issue.workDir);

      // Emit event
      emitAzureDevopsStatus(status, 'delete');

      // Finalize journal
      await finalizeJournal(issue.stateDir, 'cred.done_success');

      return reply.send({ ok: true, updated: hadSecret, status, warnings });
    } catch (err) {
      try { await finalizeJournal(issue.stateDir, 'cred.done_error'); } catch { /* journal finalize best-effort */ }
      const message = sanitizeErrorForUi(err);
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    } finally {
      await releaseLock(issue.stateDir);
      releaseAzureDevopsMutex(issue.issueRef);
    }
  });

  // POST /api/issue/azure-devops/reconcile
  app.post('/api/issue/azure-devops/reconcile', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    if (runManager.getStatus().running) {
      return reply.code(409).send({ ok: false, error: 'Cannot edit while Jeeves is running.', code: 'conflict_running' });
    }

    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    // Validate request body
    const validation = validateReconcileAzureDevopsRequest(req.body);
    if (!validation.valid) {
      return reply.code(400).send({
        ok: false,
        error: validation.error,
        code: validation.code,
        field_errors: validation.field_errors,
      });
    }

    // Acquire in-memory mutex
    const acquired = await acquireAzureDevopsMutex(issue.issueRef);
    if (!acquired) {
      return reply.code(503).send({ ok: false, error: 'Another provider operation is in progress.', code: 'busy' });
    }

    // Acquire file-level lock inside mutex
    const lockResult = await acquireProviderOperationLock(issue.stateDir, issue.issueRef);
    if (!lockResult.acquired) {
      releaseAzureDevopsMutex(issue.issueRef);
      return reply.code(503).send({ ok: false, error: 'Another provider operation is in progress.', code: 'busy' });
    }

    try {
      // Create journal
      await createJournal(issue.stateDir, {
        operation_id: lockResult.operationId,
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: issue.issueRef,
        provider: null,
      });

      const warnings: string[] = [];
      const now = new Date().toISOString();
      const forceReconcile = validation.value.force;

      // Get current status
      const existingStatus = await buildAzureDevopsStatus(issue.issueRef, issue.stateDir, issue.workDir);

      // Skip if already in_sync and force is not set
      if (existingStatus.sync_status === 'in_sync' && !forceReconcile) {
        await finalizeJournal(issue.stateDir, 'cred.done_success');
        return reply.send({
          ok: true,
          updated: false,
          status: existingStatus,
          warnings: ['Already in sync; use force=true to re-run reconciliation.'],
        });
      }

      // Reconcile only if worktree exists
      await updateJournalState(issue.stateDir, 'cred.reconciling_worktree');
      let syncStatus: AzureDevopsSyncStatus = existingStatus.sync_status;
      let lastError: string | null = existingStatus.last_error;

      if (!issue.workDir) {
        syncStatus = existingStatus.has_pat ? 'deferred_worktree_absent' : 'in_sync';
        warnings.push('Worktree not present; deferred.');
      } else {
        const worktreeExists = (await fs.stat(issue.workDir).catch(() => null))?.isDirectory();
        if (!worktreeExists) {
          syncStatus = existingStatus.has_pat ? 'deferred_worktree_absent' : 'in_sync';
          warnings.push('Worktree directory does not exist; deferred.');
        } else {
          // Read secret for reconciliation
          const secretResult = await readAzureDevopsSecret(issue.stateDir);
          const patValue = secretResult.exists ? secretResult.data.pat : undefined;
          const hasSecretNow = secretResult.exists;

          try {
            const reconcileResult = await reconcileAzureDevopsToWorktree({
              worktreeDir: issue.workDir,
              hasSecret: hasSecretNow,
              pat: patValue,
            });
            syncStatus = reconcileResult.sync_status;
            lastError = reconcileResult.last_error;
            warnings.push(...reconcileResult.warnings);
          } catch (err) {
            syncStatus = 'failed_exclude';
            lastError = sanitizeErrorForUi(err);
          }
        }
      }

      // Record status
      await updateJournalState(issue.stateDir, 'cred.recording_status');

      await updateAzureDevopsStatusInIssueJson(issue.stateDir, {
        sync_status: syncStatus,
        last_attempt_at: now,
        last_success_at: syncStatus === 'in_sync' ? now : existingStatus.last_success_at,
        last_error: lastError,
      });

      // Build final status
      const status = await buildAzureDevopsStatus(issue.issueRef, issue.stateDir, issue.workDir);

      // Emit event
      emitAzureDevopsStatus(status, 'reconcile');

      // Finalize journal
      await finalizeJournal(issue.stateDir, 'cred.done_success');

      // Reconcile never changes credential presence, so updated is always false
      return reply.send({ ok: true, updated: false, status, warnings });
    } catch (err) {
      try { await finalizeJournal(issue.stateDir, 'cred.done_error'); } catch { /* journal finalize best-effort */ }
      const message = sanitizeErrorForUi(err);
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    } finally {
      await releaseLock(issue.stateDir);
      releaseAzureDevopsMutex(issue.issueRef);
    }
  });

  // ── Project files endpoints ──

  app.get('/api/project-files', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    try {
      const status = await buildProjectFilesStatus(issue.issueRef, issue.stateDir, issue.workDir);
      return reply.send({ ok: true, ...status });
    } catch (err) {
      const message = sanitizeErrorForUi(err);
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    }
  });

  app.put('/api/project-files', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    if (runManager.getStatus().running) {
      return reply.code(409).send({ ok: false, error: 'Cannot edit while Jeeves is running.', code: 'conflict_running' });
    }

    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    const validation = validatePutProjectFileRequest(req.body);
    if (!validation.valid) {
      return reply.code(400).send({
        ok: false,
        error: validation.error,
        code: validation.code,
        field_errors: validation.field_errors,
      });
    }

    let ownerRepo: { owner: string; repo: string };
    try {
      ownerRepo = parseOwnerRepoFromIssueRef(issue.issueRef);
    } catch (err) {
      return reply.code(400).send({ ok: false, error: sanitizeErrorForUi(err), code: 'validation_failed' });
    }
    const repoRef = `${ownerRepo.owner}/${ownerRepo.repo}`;

    const acquired = await acquireProjectFilesMutex(repoRef);
    if (!acquired) {
      return reply.code(503).send({ ok: false, error: 'Another project files operation is in progress.', code: 'busy' });
    }

    try {
      const upsertResult = await upsertProjectFile({
        dataDir,
        owner: ownerRepo.owner,
        repo: ownerRepo.repo,
        id: validation.value.id,
        displayName: validation.value.display_name,
        targetPath: validation.value.target_path,
        content: validation.value.content,
      });

      let status: ProjectFilesStatus;
      let warnings: string[] = [];

      if (validation.value.sync_now) {
        const reconcileResult = await reconcileProjectFilesForIssue({
          issueRef: issue.issueRef,
          stateDir: issue.stateDir,
          workDir: issue.workDir,
          operation: 'put',
        });
        status = reconcileResult.status;
        warnings = reconcileResult.warnings;
      } else {
        await updateProjectFilesStatusInIssueJson(issue.stateDir, {
          sync_status: 'never_attempted',
          last_error: null,
        });
        status = await buildProjectFilesStatus(issue.issueRef, issue.stateDir, issue.workDir);
        emitProjectFilesStatus(status, 'put');
      }

      return reply.send({
        ok: true,
        updated: true,
        status,
        warnings,
        file: toProjectFilePublic(upsertResult.record),
      });
    } catch (err) {
      const message = sanitizeErrorForUi(err);
      if (message.includes('target_path already exists') || message.includes('Maximum of')) {
        return reply.code(400).send({ ok: false, error: message, code: 'validation_failed' });
      }
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    } finally {
      releaseProjectFilesMutex(repoRef);
    }
  });

  app.delete('/api/project-files/:id', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    if (runManager.getStatus().running) {
      return reply.code(409).send({ ok: false, error: 'Cannot edit while Jeeves is running.', code: 'conflict_running' });
    }

    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    const params = (req.params ?? {}) as Record<string, unknown>;
    const validation = validateDeleteProjectFileId(params.id);
    if (!validation.valid) {
      return reply.code(400).send({
        ok: false,
        error: validation.error,
        code: validation.code,
        field_errors: validation.field_errors,
      });
    }

    let ownerRepo: { owner: string; repo: string };
    try {
      ownerRepo = parseOwnerRepoFromIssueRef(issue.issueRef);
    } catch (err) {
      return reply.code(400).send({ ok: false, error: sanitizeErrorForUi(err), code: 'validation_failed' });
    }
    const repoRef = `${ownerRepo.owner}/${ownerRepo.repo}`;

    const acquired = await acquireProjectFilesMutex(repoRef);
    if (!acquired) {
      return reply.code(503).send({ ok: false, error: 'Another project files operation is in progress.', code: 'busy' });
    }

    try {
      const deleted = await deleteProjectFile({
        dataDir,
        owner: ownerRepo.owner,
        repo: ownerRepo.repo,
        id: validation.id,
      });

      const reconcileResult = await reconcileProjectFilesForIssue({
        issueRef: issue.issueRef,
        stateDir: issue.stateDir,
        workDir: issue.workDir,
        operation: 'delete',
      });

      const warnings = [...reconcileResult.warnings];
      if (!deleted.deleted) {
        warnings.push('File id not found.');
      }

      return reply.send({
        ok: true,
        updated: deleted.deleted,
        status: reconcileResult.status,
        warnings,
      });
    } catch (err) {
      const message = sanitizeErrorForUi(err);
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    } finally {
      releaseProjectFilesMutex(repoRef);
    }
  });

  app.post('/api/project-files/reconcile', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error, code: 'forbidden' });

    if (runManager.getStatus().running) {
      return reply.code(409).send({ ok: false, error: 'Cannot edit while Jeeves is running.', code: 'conflict_running' });
    }

    const issue = runManager.getIssue();
    if (!issue.issueRef || !issue.stateDir) {
      return reply.code(400).send({ ok: false, error: 'No issue selected.', code: 'no_issue_selected' });
    }

    const validation = validateReconcileProjectFilesRequest(req.body);
    if (!validation.valid) {
      return reply.code(400).send({
        ok: false,
        error: validation.error,
        code: validation.code,
        field_errors: validation.field_errors,
      });
    }

    let ownerRepo: { owner: string; repo: string };
    try {
      ownerRepo = parseOwnerRepoFromIssueRef(issue.issueRef);
    } catch (err) {
      return reply.code(400).send({ ok: false, error: sanitizeErrorForUi(err), code: 'validation_failed' });
    }
    const repoRef = `${ownerRepo.owner}/${ownerRepo.repo}`;

    const acquired = await acquireProjectFilesMutex(repoRef);
    if (!acquired) {
      return reply.code(503).send({ ok: false, error: 'Another project files operation is in progress.', code: 'busy' });
    }

    try {
      const existing = await buildProjectFilesStatus(issue.issueRef, issue.stateDir, issue.workDir);
      if (existing.sync_status === 'in_sync' && !validation.value.force) {
        return reply.send({
          ok: true,
          updated: false,
          status: existing,
          warnings: ['Already in sync; use force=true to re-run reconciliation.'],
        });
      }

      const reconcileResult = await reconcileProjectFilesForIssue({
        issueRef: issue.issueRef,
        stateDir: issue.stateDir,
        workDir: issue.workDir,
        operation: 'reconcile',
      });

      return reply.send({
        ok: true,
        updated: false,
        status: reconcileResult.status,
        warnings: reconcileResult.warnings,
      });
    } catch (err) {
      const message = sanitizeErrorForUi(err);
      return reply.code(500).send({ ok: false, error: message, code: 'io_error' });
    } finally {
      releaseProjectFilesMutex(repoRef);
    }
  });

  app.get('/api/stream', async (req, reply) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(origin && allowedOrigins.has(origin)
        ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
        : {}),
    });
    reply.hijack();

    reply.raw.write(': connected\n\n');

    const id = hub.addSseClient(reply.raw);
    const cleanup = () => {
      hub.removeClient(id);
    };
    req.raw.on('close', cleanup);
    req.raw.on('aborted', cleanup);

    const snapshot = await getStateSnapshot();
    hub.sendTo(id, 'state', snapshot);

    await refreshRunTargets();
    sendCurrentRunSnapshotToClient(id);
    const workerSnapshots = await workerTailerManager.getSnapshots(logSnapshotLines);
    for (const ws of workerSnapshots) {
      hub.sendTo(id, 'worker-logs', { workerId: ws.taskId, lines: ws.logLines, reset: true });
      if (ws.sdkSnapshot) {
        emitSdkSnapshot((event, data) => hub.sendTo(id, event, { ...data as Record<string, unknown>, workerId: ws.taskId }), ws.sdkSnapshot);
      }
    }
  });

  app.get('/api/ws', { websocket: true }, async (socket, req) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    const originAllowed = origin ? isAllowedOrigin(req, origin, allowedOrigins) : true;
    if (origin && !originAllowed) {
      try {
        socket.close();
      } catch {
        // ignore
      }
      return;
    }
    const id = hub.addWsClient(socket);
    socket.on('close', () => hub.removeClient(id));
    hub.sendTo(id, 'state', await getStateSnapshot());
    // Re-emit state on next tick so clients that attach `message` handlers right after
    // `open` do not miss the initial snapshot due to event-listener timing races.
    setTimeout(() => {
      void getStateSnapshot()
        .then((snapshot) => hub.sendTo(id, 'state', snapshot))
        .catch(() => void 0);
    }, 0);
    await refreshRunTargets();
    sendCurrentRunSnapshotToClient(id);
    const wsWorkerSnapshots = await workerTailerManager.getSnapshots(logSnapshotLines);
    for (const ws of wsWorkerSnapshots) {
      hub.sendTo(id, 'worker-logs', { workerId: ws.taskId, lines: ws.logLines, reset: true });
      if (ws.sdkSnapshot) {
        emitSdkSnapshot((event, data) => hub.sendTo(id, event, { ...data as Record<string, unknown>, workerId: ws.taskId }), ws.sdkSnapshot);
      }
    }
  });

  // Test helpers for direct mutex control (used only in tests)
  const __test__ = {
    /** Acquire the sonar token mutex for the given issue. Returns release function. */
    acquireSonarTokenMutex: async (issueRef: string): Promise<{ release: () => void }> => {
      const acquired = await acquireSonarTokenMutex(issueRef);
      if (!acquired) {
        throw new Error('Failed to acquire sonar token mutex (timeout)');
      }
      return { release: () => releaseSonarTokenMutex(issueRef) };
    },
    /** Acquire the Azure DevOps mutex for the given issue. Returns release function. */
    acquireAzureDevopsMutex: async (issueRef: string): Promise<{ release: () => void }> => {
      const acquired = await acquireAzureDevopsMutex(issueRef);
      if (!acquired) {
        throw new Error('Failed to acquire Azure DevOps mutex (timeout)');
      }
      return { release: () => releaseAzureDevopsMutex(issueRef) };
    },
  };

  return { app, dataDir, repoRoot, workflowsDir, promptsDir, allowRemoteRun, createGitHubIssue, __test__ };
}

export async function startServer(config: ViewerServerConfig): Promise<void> {
  const { app } = await buildServer(config);
  await app.listen({ port: config.port, host: config.host });
}
