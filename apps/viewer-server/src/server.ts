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
import { initIssue } from './init.js';
import { readIssueJson, writeIssueJson } from './issueJson.js';
import { findRepoRoot } from './repoRoot.js';
import { RunManager } from './runManager.js';
import { LogTailer, SdkOutputTailer } from './tailers.js';

function isLocalAddress(addr: string | undefined | null): boolean {
  const a = (addr ?? '').trim();
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function getRemoteAddress(req: import('fastify').FastifyRequest): string | null {
  return req.socket.remoteAddress ?? null;
}

function parseEnvBool(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
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
}>;

export async function buildServer(config: ViewerServerConfig) {
  const repoRoot = config.repoRoot ?? (await findRepoRoot(process.cwd()));
  const dataDir = config.dataDir ?? resolveDataDir();
  const promptsDir = config.promptsDir ?? path.join(repoRoot, 'prompts');
  const workflowsDir = config.workflowsDir ?? path.join(repoRoot, 'workflows');

  const allowRemoteRun = config.allowRemoteRun || parseEnvBool(process.env.JEEVES_VIEWER_ALLOW_REMOTE_RUN);

  const hub = new EventHub();
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
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
      if (stateDir) {
        logTailer.reset(path.join(stateDir, 'last-run.log'));
        viewerLogTailer.reset(path.join(stateDir, 'viewer-run.log'));
        sdkTailer.reset(path.join(stateDir, 'sdk-output.json'));
      }
      const lines = await logTailer.getAllLines(500);
      if (lines.length) hub.broadcast('logs', { lines, reset: true });
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

  async function requireMutatingAllowed(req: import('fastify').FastifyRequest): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    if (allowRemoteRun) return { ok: true };
    const ip = getRemoteAddress(req);
    if (isLocalAddress(ip)) return { ok: true };
    return { ok: false, status: 403, error: 'This endpoint is only allowed from localhost. Restart with --allow-remote-run to enable it.' };
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
  const poller = setInterval(async () => {
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
  }, 150);

  app.addHook('onClose', async () => {
    clearInterval(poller);
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

  app.post('/api/issues/select', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });
    if (runManager.getStatus().running) return reply.code(409).send({ ok: false, error: 'Cannot select issue while Jeeves is running.' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const issueRef = typeof body.issue_ref === 'string' ? body.issue_ref : '';
    if (!issueRef.trim()) return reply.code(400).send({ ok: false, error: 'issue_ref is required' });

    try {
      await runManager.setIssue(issueRef.trim());
      await saveActiveIssue(dataDir, issueRef.trim());
      await refreshFileTargets();
      return reply.send({ ok: true, issue_ref: issueRef.trim() });
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/init/issue', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });
    if (runManager.getStatus().running) return reply.code(409).send({ ok: false, error: 'Cannot init while Jeeves is running.' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const repoStr = typeof body.repo === 'string' ? body.repo : '';
    const issueNum = typeof body.issue === 'number' ? body.issue : Number(body.issue);
    if (!repoStr.trim()) return reply.code(400).send({ ok: false, error: 'repo is required (owner/repo)' });
    if (!Number.isInteger(issueNum) || issueNum <= 0) return reply.code(400).send({ ok: false, error: 'issue must be a positive integer' });

    try {
      // Validate repo early
      parseRepoSpec(repoStr.trim());
      const res = await initIssue({
        dataDir,
        body: {
          repo: repoStr.trim(),
          issue: issueNum,
          branch: typeof body.branch === 'string' ? body.branch : undefined,
          workflow: typeof body.workflow === 'string' ? body.workflow : undefined,
          phase: typeof body.phase === 'string' ? body.phase : undefined,
          design_doc: typeof body.design_doc === 'string' ? body.design_doc : undefined,
          force: Boolean(body.force ?? false),
        },
      });

      await runManager.setIssue(res.issue_ref);
      await saveActiveIssue(dataDir, res.issue_ref);
      await refreshFileTargets();
      return reply.send({ ok: true, ...res });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/run', async (req, reply) => {
    const gate = await requireMutatingAllowed(req);
    if (!gate.ok) return reply.code(gate.status).send({ ok: false, error: gate.error });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const issueRef = typeof body.issue_ref === 'string' ? body.issue_ref.trim() : '';
    if (issueRef) {
      if (runManager.getStatus().running) return reply.code(409).send({ ok: false, error: 'Cannot change issue while running.' });
      await runManager.setIssue(issueRef);
      await saveActiveIssue(dataDir, issueRef);
      await refreshFileTargets();
    }

    try {
      const run = await runManager.start({
        provider: body.provider,
        workflow: body.workflow,
        max_iterations: body.max_iterations,
        inactivity_timeout_sec: body.inactivity_timeout_sec,
        iteration_timeout_sec: body.iteration_timeout_sec,
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

    const body = (req.body ?? {}) as Record<string, unknown>;
    await runManager.stop({ force: Boolean(body.force ?? false) });
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

    const body = (req.body ?? {}) as Record<string, unknown>;
    const phase = typeof body.phase === 'string' ? body.phase.trim() : '';
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
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
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
    if (currentStateDir) {
      const logLines = await logTailer.getAllLines(500);
      if (logLines.length) hub.sendTo(id, 'logs', { lines: logLines, reset: true });
      const viewerLines = await viewerLogTailer.getAllLines(500);
      if (viewerLines.length) hub.sendTo(id, 'viewer-logs', { lines: viewerLines, reset: true });
      const sdk = await readSdkOutput(currentStateDir);
      if (sdk) emitSdkSnapshot((event, data) => hub.sendTo(id, event, data), sdk);
    }
  });

  app.get('/api/ws', { websocket: true }, async (connection) => {
    const id = hub.addWsClient(connection.socket);
    connection.socket.on('close', () => hub.removeClient(id));
    hub.sendTo(id, 'state', await getStateSnapshot());
    await refreshFileTargets();
    if (currentStateDir) {
      const logLines = await logTailer.getAllLines(500);
      if (logLines.length) hub.sendTo(id, 'logs', { lines: logLines, reset: true });
      const viewerLines = await viewerLogTailer.getAllLines(500);
      if (viewerLines.length) hub.sendTo(id, 'viewer-logs', { lines: viewerLines, reset: true });
      const sdk = await readSdkOutput(currentStateDir);
      if (sdk) emitSdkSnapshot((event, data) => hub.sendTo(id, event, data), sdk);
    }
  });

  return { app, dataDir, repoRoot, workflowsDir, promptsDir, allowRemoteRun };
}

export async function startServer(config: ViewerServerConfig): Promise<void> {
  const { app } = await buildServer(config);
  await app.listen({ port: config.port, host: config.host });
}
