import fs from 'node:fs/promises';
import path from 'node:path';

import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import {
  listIssueStates,
  loadWorkflowByName,
  parseRepoSpec,
  resolveDataDir,
} from '@jeeves/core';
import Fastify from 'fastify';

import { loadActiveIssue, saveActiveIssue } from './activeIssue.js';
import { EventHub } from './eventHub.js';
import { CreateGitHubIssueError, createGitHubIssue as defaultCreateGitHubIssue } from './githubIssueCreate.js';
import { initIssue } from './init.js';
import { readIssueJson, writeIssueJson } from './issueJson.js';
import { findRepoRoot } from './repoRoot.js';
import { RunManager } from './runManager.js';
import { LogTailer, SdkOutputTailer } from './tailers.js';
import { writeTextAtomic } from './textAtomic.js';
import type { CreateGitHubIssueAdapter } from './types.js';

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

function errorToHttp(err: unknown): { status: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('worktree already exists')) return { status: 409, message };
  if (message.includes('issue.json not found')) return { status: 404, message };
  return { status: 400, message };
}

function normalizePromptId(promptId: string): string {
  return promptId.split('\\').join('/');
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

async function listPromptIds(promptsDir: string): Promise<string[]> {
  const baseDir = path.resolve(promptsDir);

  async function walk(dir: string, prefix: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const results: string[] = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        results.push(...(await walk(path.join(dir, e.name), rel)));
        continue;
      }
      if (e.isFile() && e.name.endsWith('.md')) {
        results.push(normalizePromptId(rel));
      }
    }
    return results;
  }

  const ids = await walk(baseDir, '');
  ids.sort((a, b) => a.localeCompare(b));
  return ids;
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

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await fs.readFile(filePath, 'utf-8').catch(() => null);
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // ignore
  }
  return null;
}

async function readSdkOutput(stateDir: string | null): Promise<Record<string, unknown> | null> {
  if (!stateDir) return null;
  return readJsonFile(path.join(stateDir, 'sdk-output.json'));
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
    if (durationMs !== undefined || isError !== undefined) {
      send('sdk-tool-complete', {
        tool_use_id: toolUseId,
        name,
        duration_ms: durationMs ?? 0,
        is_error: isError ?? false,
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
}>;

export async function buildServer(config: ViewerServerConfig) {
  const repoRoot = config.repoRoot ?? (await findRepoRoot(process.cwd()));
  const dataDir = config.dataDir ?? resolveDataDir();
  const promptsDir = config.promptsDir ?? path.join(repoRoot, 'prompts');
  const workflowsDir = config.workflowsDir ?? path.join(repoRoot, 'workflows');
  const createGitHubIssue = config.createGitHubIssue ?? defaultCreateGitHubIssue;

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

  const logTailer = new LogTailer();
  const viewerLogTailer = new LogTailer();
  const sdkTailer = new SdkOutputTailer();

  let currentStateDir: string | null = null;

  async function refreshFileTargets(): Promise<void> {
    const stateDir = runManager.getIssue().stateDir;
    if (stateDir !== currentStateDir) {
      currentStateDir = stateDir;
      logTailer.reset(stateDir ? path.join(stateDir, 'last-run.log') : null);
      viewerLogTailer.reset(stateDir ? path.join(stateDir, 'viewer-run.log') : null);
      sdkTailer.reset(stateDir ? path.join(stateDir, 'sdk-output.json') : null);

      const lines = await logTailer.getAllLines(logSnapshotLines);
      hub.broadcast('logs', { lines, reset: true });
      const viewerLines = await viewerLogTailer.getAllLines(viewerLogSnapshotLines);
      hub.broadcast('viewer-logs', { lines: viewerLines, reset: true });
      const sdk = await readSdkOutput(stateDir);
      if (sdk) emitSdkSnapshot((event, data) => hub.broadcast(event, data), sdk);
    }
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
    const issues = await listIssueStates(dataDir);
    if (issues.length) {
      const mtimes = await Promise.all(
        issues.map(async (i) => ({
          issue: i,
          mtime: await fs
            .stat(i.stateDir)
            .then((st) => st.mtimeMs)
            .catch(() => 0),
        })),
      );
      mtimes.sort((a, b) => a.mtime - b.mtime);
      const latest = mtimes[mtimes.length - 1]?.issue ?? null;
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

  await refreshFileTargets();

  // Poll for log/sdk updates and file target changes
  async function pollTick(): Promise<void> {
    try {
      await refreshFileTargets();
      if (!currentStateDir) return;

      const logs = await logTailer.getNewLines();
      if (logs.changed && logs.lines.length) hub.broadcast('logs', { lines: logs.lines });

      const viewerLogs = await viewerLogTailer.getNewLines();
      if (viewerLogs.changed && viewerLogs.lines.length) hub.broadcast('viewer-logs', { lines: viewerLogs.lines });

      const sdk = await sdkTailer.readSnapshot();
      if (sdk) {
        const diff = sdkTailer.consumeAndDiff(sdk);
        if (diff.sessionChanged && diff.sessionId) {
          hub.broadcast('sdk-init', { session_id: diff.sessionId, started_at: diff.startedAt, status: 'running' });
        }
        for (const m of diff.newMessages) hub.broadcast('sdk-message', m);
        for (const tc of diff.toolStarts) hub.broadcast('sdk-tool-start', tc);
        for (const tc of diff.toolCompletes) hub.broadcast('sdk-tool-complete', tc);
        if (diff.justEnded) {
          hub.broadcast('sdk-complete', { status: diff.success === false ? 'error' : 'success', summary: diff.stats ?? {} });
        }
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
    await runManager.stop({ force: false }).catch(() => void 0);
  });

  app.get('/api/state', async () => ({ ...(await getStateSnapshot()) }));

  app.get('/api/run', async () => ({ run: runManager.getStatus() }));

  app.get('/api/issues', async () => {
    const issues = await listIssueStates(dataDir);
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

  app.get('/api/prompts', async () => {
    const ids = await listPromptIds(promptsDir);
    return { ok: true, prompts: ids.map((id) => ({ id })), count: ids.length };
  });

  app.get('/api/prompts/*', async (req, reply) => {
    const id = parseOptionalString((req.params as { '*': unknown } | undefined)?.['*']);
    if (!id) return reply.code(400).send({ ok: false, error: 'id is required' });
    try {
      const resolved = await resolvePromptPathForRead(promptsDir, id);
      const content = await fs.readFile(resolved, 'utf-8');
      return reply.send({ ok: true, id: normalizePromptId(id), content });
    } catch (err) {
      const mapped = errorToHttp(err);
      return reply.code(mapped.status).send({ ok: false, error: mapped.message });
    }
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
      const resolved = await resolvePromptPathForWrite(promptsDir, id);
      await writeTextAtomic(resolved, content);
      return reply.send({ ok: true, id: normalizePromptId(id) });
    } catch (err) {
      const mapped = errorToHttp(err);
      return reply.code(mapped.status).send({ ok: false, error: mapped.message });
    }
  });

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

		    function parseGitHubDotComIssueUrl(issueUrl: string): { issueNumber: number } | null {
		      let parsed: URL;
		      try {
		        parsed = new URL(issueUrl);
		      } catch {
		        return null;
		      }
		      if (parsed.hostname.trim().toLowerCase() !== 'github.com') return null;
		      const m = parsed.pathname.match(/^\/[^/]+\/[^/]+\/issues\/(\d+)(?:\/.*)?$/);
		      if (!m) return null;
		      const n = Number(m[1]);
		      if (!Number.isInteger(n) || n <= 0) return null;
		      return { issueNumber: n };
		    }

		    try {
		      const res = await createGitHubIssue({ repo, title: titleRaw, body: bodyRaw, labels, assignees, milestone });
		      const baseResponse = {
		        ok: true,
		        created: true,
		        issue_url: res.issue_url,
		        ...(res.issue_ref ? { issue_ref: res.issue_ref } : {}),
		      };

		      if (!initRequested) return reply.send({ ...baseResponse, run: runManager.getStatus() });

		      const issueUrlInfo = parseGitHubDotComIssueUrl(res.issue_url);
		      if (!issueUrlInfo) {
		        return reply.send({
		          ...baseResponse,
		          run: runManager.getStatus(),
		          init: { ok: false, error: 'Only github.com issue URLs are supported in v1.' },
		        });
		      }

		      const initParams = initObj ?? {};
		      const prevActiveIssue = await loadActiveIssue(dataDir);

		      try {
		        const initRes = await initIssue({
		          dataDir,
		          body: {
		            repo,
		            issue: issueUrlInfo.issueNumber,
		            branch: parseOptionalString(initParams.branch),
		            workflow: parseOptionalString(initParams.workflow),
		            phase: parseOptionalString(initParams.phase),
		            design_doc: parseOptionalString(initParams.design_doc),
		            force: parseOptionalBool(initParams.force),
		          },
		        });

		        const issueJson = ((await readIssueJson(initRes.state_dir)) ?? {}) as Record<string, unknown>;
		        const issueField =
		          issueJson.issue && typeof issueJson.issue === 'object' && !Array.isArray(issueJson.issue)
		            ? (issueJson.issue as Record<string, unknown>)
		            : {};

		        await writeIssueJson(initRes.state_dir, {
		          ...issueJson,
		          issue: {
		            ...issueField,
		            title: titleRaw.trim(),
		            url: res.issue_url,
		          },
		        });

		        if (autoSelectEnabled) {
		          await runManager.setIssue(initRes.issue_ref);
		          await saveActiveIssue(dataDir, initRes.issue_ref);
		          await refreshFileTargets();
		        } else {
		          const activeIssueFile = path.join(dataDir, 'active-issue.json');
		          if (prevActiveIssue) await saveActiveIssue(dataDir, prevActiveIssue);
		          else await fs.rm(activeIssueFile, { force: true }).catch(() => void 0);
		        }

		        if (!autoRunRequested) {
		          return reply.send({
		            ...baseResponse,
		            init: { ok: true, result: initRes },
		            run: runManager.getStatus(),
		          });
		        }

		        const autoRunParams = autoRunObj ?? {};
		        let autoRunResult: { ok: true; run_started: true } | { ok: false; run_started: false; error: string };
		        try {
		          await runManager.start({
		            provider: parseOptionalString(autoRunParams.provider) ?? parseOptionalString(body.provider) ?? body.provider,
		            workflow: parseOptionalString(autoRunParams.workflow),
		            max_iterations: parseOptionalNumber(autoRunParams.max_iterations),
		            inactivity_timeout_sec: parseOptionalNumber(autoRunParams.inactivity_timeout_sec),
		            iteration_timeout_sec: parseOptionalNumber(autoRunParams.iteration_timeout_sec),
		          });
		          autoRunResult = { ok: true, run_started: true };
		        } catch (err) {
		          const msg = err instanceof Error ? err.message : 'Failed to start run.';
		          autoRunResult = { ok: false, run_started: false, error: msg };
		        }

		        return reply.send({
		          ...baseResponse,
		          init: { ok: true, result: initRes },
		          auto_run: autoRunResult,
		          run: runManager.getStatus(),
		        });
		      } catch (err) {
		        const safeMessage = err instanceof Error ? err.message : 'Failed to init issue.';
		        return reply.send({
		          ...baseResponse,
		          run: runManager.getStatus(),
		          init: { ok: false, error: safeMessage },
		        });
		      }
		    } catch (err) {
		      if (err instanceof CreateGitHubIssueError) {
		        return reply.code(err.status).send({ ok: false, error: err.message, run: runManager.getStatus() });
		      }
		      return reply.code(500).send({ ok: false, error: 'Failed to create GitHub issue.', run: runManager.getStatus() });
		    }
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
	      await refreshFileTargets();
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
	      await refreshFileTargets();
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
	        await refreshFileTargets();
	      } catch (err) {
	        const mapped = errorToHttp(err);
	        return reply.code(mapped.status).send({ ok: false, error: mapped.message });
	      }
	    }

	    try {
	      const run = await runManager.start({
	        provider: parseOptionalString(body.provider) ?? body.provider,
	        workflow: parseOptionalString(body.workflow) ?? body.workflow,
	        max_iterations: parseOptionalNumber(body.max_iterations) ?? body.max_iterations,
	        inactivity_timeout_sec: parseOptionalNumber(body.inactivity_timeout_sec) ?? body.inactivity_timeout_sec,
	        iteration_timeout_sec: parseOptionalNumber(body.iteration_timeout_sec) ?? body.iteration_timeout_sec,
	      });
	      return reply.send({ ok: true, run });
	    } catch (err) {
	      const msg = err instanceof Error ? err.message : String(err);
	      const status = msg.includes('already running') ? 409 : 400;
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

  app.get('/api/workflow', async (_req, reply) => {
    const issue = runManager.getIssue();
    const issueJson = issue.stateDir ? await readIssueJson(issue.stateDir) : null;
    const workflowName = (issueJson && typeof issueJson.workflow === 'string' && issueJson.workflow.trim()) ? issueJson.workflow : 'default';
    const currentPhase = (issueJson && typeof issueJson.phase === 'string' && issueJson.phase.trim()) ? issueJson.phase : 'design_draft';

    try {
      const workflow = await loadWorkflowByName(workflowName, { workflowsDir });
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

    await refreshFileTargets();
    const logLines = await logTailer.getAllLines(logSnapshotLines);
    hub.sendTo(id, 'logs', { lines: logLines, reset: true });
    const viewerLines = await viewerLogTailer.getAllLines(viewerLogSnapshotLines);
    hub.sendTo(id, 'viewer-logs', { lines: viewerLines, reset: true });
    const sdk = await readSdkOutput(currentStateDir);
    if (sdk) emitSdkSnapshot((event, data) => hub.sendTo(id, event, data), sdk);
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
    await refreshFileTargets();
    const logLines = await logTailer.getAllLines(logSnapshotLines);
    hub.sendTo(id, 'logs', { lines: logLines, reset: true });
    const viewerLines = await viewerLogTailer.getAllLines(viewerLogSnapshotLines);
    hub.sendTo(id, 'viewer-logs', { lines: viewerLines, reset: true });
    const sdk = await readSdkOutput(currentStateDir);
    if (sdk) emitSdkSnapshot((event, data) => hub.sendTo(id, event, data), sdk);
  });

  return { app, dataDir, repoRoot, workflowsDir, promptsDir, allowRemoteRun, createGitHubIssue };
}

export async function startServer(config: ViewerServerConfig): Promise<void> {
  const { app } = await buildServer(config);
  await app.listen({ port: config.port, host: config.host });
}
