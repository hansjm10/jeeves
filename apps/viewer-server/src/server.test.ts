import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';

import { getIssueStateDir, getWorktreePath } from '@jeeves/core';

import { CreateGitHubIssueError } from './githubIssueCreate.js';
import { readIssueJson } from './issueJson.js';
import { buildServer } from './server.js';

const execFileAsync = promisify(execFile);

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function decodeWsData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return String(data ?? '');
}

async function git(args: string[], opts?: { cwd?: string }): Promise<void> {
  await execFileAsync('git', args, { cwd: opts?.cwd });
}

async function ensureLocalRepoClone(params: { dataDir: string; owner: string; repo: string }): Promise<void> {
  const origin = await makeTempDir('jeeves-vs-origin-');
  await git(['init', '--bare', origin]);

  const work = await makeTempDir('jeeves-vs-origin-work-');
  await git(['init'], { cwd: work });
  await fs.writeFile(path.join(work, 'README.md'), 'hello\n', 'utf-8');
  await git(['add', '.'], { cwd: work });
  await git(['-c', 'user.name=jeeves-test', '-c', 'user.email=jeeves-test@example.com', 'commit', '-m', 'init'], { cwd: work });
  await git(['branch', '-M', 'main'], { cwd: work });
  await git(['remote', 'add', 'origin', origin], { cwd: work });
  await git(['push', '-u', 'origin', 'main'], { cwd: work });

  const repoDir = path.join(params.dataDir, 'repos', params.owner, params.repo);
  await fs.mkdir(path.dirname(repoDir), { recursive: true });
  await git(['clone', origin, repoDir]);
}

describe('viewer-server', () => {
  it('rejects cross-origin browser requests by default', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-origin-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/state',
      headers: {
        host: '127.0.0.1:8080',
        origin: 'https://evil.example',
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows same-origin browser requests by default', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-same-origin-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/state',
      headers: {
        host: '127.0.0.1:8080',
        origin: 'http://127.0.0.1:8080',
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('allows same-origin requests with mapped host/port (docker port mapping)', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-docker-origin-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/state',
      headers: {
        host: '192.168.1.127:8060',
        origin: 'http://192.168.1.127:8060',
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('allows allowlisted origins and returns CORS allow-origin', async () => {
    const prev = process.env.JEEVES_VIEWER_ALLOWED_ORIGINS;
    process.env.JEEVES_VIEWER_ALLOWED_ORIGINS = 'http://127.0.0.1:5173';
    try {
      const dataDir = await makeTempDir('jeeves-vs-data-allowlist-');
      const { app } = await buildServer({
        host: '127.0.0.1',
        port: 0,
        allowRemoteRun: false,
        dataDir,
        repoRoot: path.resolve(process.cwd()),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/state',
        headers: {
          host: '127.0.0.1:8080',
          origin: 'http://127.0.0.1:5173',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
      await app.close();
    } finally {
      if (prev === undefined) delete process.env.JEEVES_VIEWER_ALLOWED_ORIGINS;
      else process.env.JEEVES_VIEWER_ALLOWED_ORIGINS = prev;
    }
  });

  it('rejects mutating endpoints from non-local clients by default', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/run',
      remoteAddress: '8.8.8.8',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows mutating endpoints from localhost by default', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-local-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/run',
      remoteAddress: '127.0.0.1',
      payload: {},
    });
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('lists yaml workflows directly under workflowsDir', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-workflows-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-workflows-');
    const workflowsDir = path.join(repoRoot, 'workflows');
    await fs.mkdir(workflowsDir, { recursive: true });

    await fs.writeFile(path.join(workflowsDir, 'b.yaml'), 'workflow: {}\nphases: {}\n', 'utf-8');
    await fs.writeFile(path.join(workflowsDir, 'a.yaml'), 'workflow: {}\nphases: {}\n', 'utf-8');
    await fs.writeFile(path.join(workflowsDir, 'ignore.txt'), 'nope\n', 'utf-8');
    await fs.mkdir(path.join(workflowsDir, 'nested'), { recursive: true });
    await fs.writeFile(path.join(workflowsDir, 'nested', 'c.yaml'), 'nope\n', 'utf-8');

    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot,
    });

    const res = await app.inject({ method: 'GET', url: '/api/workflows' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      workflows: [{ name: 'a' }, { name: 'b' }],
      workflows_dir: path.resolve(workflowsDir),
    });

    await app.close();
  });

  it('SSE stream responds with event-stream and includes initial state event', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-sse-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
    });

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = new URL('/api/stream', address);

    const ac = new AbortController();
    const res = await fetch(url, { signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let text = '';
    const start = Date.now();
    while (!text.includes('event: state')) {
      const { value, done } = await reader!.read();
      if (done) break;
      text += decoder.decode(value);
      if (Date.now() - start > 1500) break;
    }
    expect(text).toContain(': connected');
    expect(text).toContain('event: state');

    ac.abort();
    await app.close();
  });

  it('rejects cross-origin SSE stream requests by default', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-sse-origin-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
    });

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = new URL('/api/stream', address);

    const res = await fetch(url, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);

    await app.close();
  });

  it('does not include CORS allow-origin for same-origin SSE by default', async () => {
    const prev = process.env.JEEVES_VIEWER_ALLOWED_ORIGINS;
    delete process.env.JEEVES_VIEWER_ALLOWED_ORIGINS;
    try {
      const dataDir = await makeTempDir('jeeves-vs-data-sse-no-cors-');
      const { app } = await buildServer({
        host: '127.0.0.1',
        port: 0,
        allowRemoteRun: false,
        dataDir,
        repoRoot: path.resolve(process.cwd()),
      });

      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const url = new URL('/api/stream', address);

      const ac = new AbortController();
      const res = await fetch(url, { headers: { origin: new URL(address).origin }, signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();

      ac.abort();
      await app.close();
    } finally {
      if (prev === undefined) delete process.env.JEEVES_VIEWER_ALLOWED_ORIGINS;
      else process.env.JEEVES_VIEWER_ALLOWED_ORIGINS = prev;
    }
  });

  it('SSE does not return wildcard allow-origin', async () => {
    const prev = process.env.JEEVES_VIEWER_ALLOWED_ORIGINS;
    process.env.JEEVES_VIEWER_ALLOWED_ORIGINS = 'http://127.0.0.1:5173';
    try {
      const dataDir = await makeTempDir('jeeves-vs-data-sse-cors-');
      const { app } = await buildServer({
        host: '127.0.0.1',
        port: 0,
        allowRemoteRun: false,
        dataDir,
        repoRoot: path.resolve(process.cwd()),
      });

      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const url = new URL('/api/stream', address);

      const ac = new AbortController();
      const res = await fetch(url, { headers: { origin: 'http://127.0.0.1:5173' }, signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*');

      ac.abort();
      await app.close();
    } finally {
      if (prev === undefined) delete process.env.JEEVES_VIEWER_ALLOWED_ORIGINS;
      else process.env.JEEVES_VIEWER_ALLOWED_ORIGINS = prev;
    }
  });

  it('WebSocket stream sends initial state message', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-ws-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
    });

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const httpUrl = new URL(address);
    const wsUrl = new URL('/api/ws', address);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

    const ws = new WebSocket(wsUrl.toString(), { origin: httpUrl.origin });

    let gotState = false;
    let lastMessage: string | null = null;
    let closed = false;
    let wsError: unknown = null;
    ws.on('close', () => {
      closed = true;
    });
    ws.on('error', (evt: unknown) => {
      wsError = evt;
    });
    ws.on('message', (data: unknown) => {
      try {
        lastMessage = decodeWsData(data);
        const parsed = JSON.parse(lastMessage) as { event?: unknown };
        if (parsed.event === 'state') gotState = true;
      } catch {
        // ignore
      }
    });

    try {
      await waitFor(() => gotState || closed || wsError !== null, 3000);
      if (!gotState) {
        const observed = lastMessage ? ` lastMessage=${(lastMessage as string).slice(0, 200)}` : '';
        throw new Error(`expected initial state message (closed=${closed} wsError=${wsError !== null})${observed}`);
      }
    } finally {
      try {
        ws.close();
      } catch {
        // ignore
      }
      await app.close();
    }
  });

  it('WebSocket rejects disallowed Origin by closing connection', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-ws-origin-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
    });

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const wsUrl = new URL('/api/ws', address);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

    const ws = new WebSocket(wsUrl.toString(), { origin: 'https://evil.example' });

    let closed = false;
    let wsError: unknown = null;
    ws.on('error', (evt: unknown) => {
      wsError = evt;
    });
    ws.on('close', () => {
      closed = true;
    });

    try {
      await waitFor(() => closed || wsError !== null || ws.readyState === WebSocket.CLOSED, 1500);
    } finally {
      try {
        ws.close();
      } catch {
        // ignore
      }
      await app.close();
    }
  });

  it('rejects create issue endpoint from non-local clients by default', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-gate-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '8.8.8.8',
      payload: { repo: 'o/r', title: 't', body: 'b' },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json() as { ok?: unknown; error?: unknown; run?: unknown };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.run).toBeTruthy();

    await app.close();
  });

  it('propagates create issue adapter 401 status and includes run', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-401-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
      createGitHubIssue: async () => {
        throw new CreateGitHubIssueError({
          status: 401,
          code: 'NOT_AUTHENTICATED',
          message: 'GitHub CLI (gh) is not authenticated. Run `gh auth login` on the viewer-server host.',
        });
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { repo: 'o/r', title: 't', body: 'b' },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json() as { ok?: unknown; error?: unknown; run?: unknown };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.run).toBeTruthy();

    await app.close();
  });

  it('propagates create issue adapter 403 status and includes run', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-403-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
      createGitHubIssue: async () => {
        throw new CreateGitHubIssueError({
          status: 403,
          code: 'REPO_NOT_FOUND_OR_FORBIDDEN',
          message: 'Repository not found or access denied for the authenticated user. Check the repo name and your GitHub permissions.',
        });
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { repo: 'o/r', title: 't', body: 'b' },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json() as { ok?: unknown; error?: unknown; run?: unknown };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.run).toBeTruthy();

    await app.close();
  });

  it('validates create issue endpoint required fields (400)', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-validate-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { title: 't', body: 'b' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { run?: unknown }).run).toBeTruthy();

    await app.close();
  });

  it('rejects create issue endpoint missing title (400) and includes run', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-missing-title-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
      createGitHubIssue: async () => {
        throw new Error('unexpected createGitHubIssue call');
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { repo: 'o/r', body: 'b' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok?: unknown; error?: unknown; run?: unknown };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('title is required');
    expect(body.run).toBeTruthy();

    await app.close();
  });

  it('rejects create issue endpoint missing body (400) and includes run', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-missing-body-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
      createGitHubIssue: async () => {
        throw new Error('unexpected createGitHubIssue call');
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { repo: 'o/r', title: 't' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok?: unknown; error?: unknown; run?: unknown };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('body is required');
    expect(body.run).toBeTruthy();

    await app.close();
  });

  it('rejects auto_select without init (400) and includes run', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-auto-select-no-init-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
      createGitHubIssue: async () => {
        throw new Error('unexpected createGitHubIssue call');
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { repo: 'o/r', title: 't', body: 'b', auto_select: true },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok?: unknown; error?: unknown; run?: unknown };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('`auto_select` requires `init`');
    expect(body.run).toBeTruthy();

    await app.close();
  });

  it('rejects auto_run with auto_select=false (400) and includes run', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-auto-run-no-auto-select-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
      createGitHubIssue: async () => {
        throw new Error('unexpected createGitHubIssue call');
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { repo: 'o/r', title: 't', body: 'b', init: {}, auto_select: false, auto_run: { provider: 'fake' } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok?: unknown; error?: unknown; run?: unknown };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('`auto_run` requires `init` + `auto_select`');
    expect(body.run).toBeTruthy();

    await app.close();
  });

  it('rejects auto_run without init (400)', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-auto-run-');
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { repo: 'o/r', title: 't', body: 'b', auto_run: { provider: 'fake' } },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('sanitizes labels/assignees/milestone and passes them to the create adapter', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-extra-fields-');

    let captured: { labels?: unknown; assignees?: unknown; milestone?: unknown } | null = null;
    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
      createGitHubIssue: async (params) => {
        captured = params as unknown as { labels?: unknown; assignees?: unknown; milestone?: unknown };
        return { issue_ref: null, issue_url: 'https://github.com/o/r/issues/123' };
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: {
        repo: 'o/r',
        title: 't',
        body: 'b',
        labels: [' bug ', '', 123],
        assignees: [' octocat ', ''],
        milestone: ' v1.0 ',
      },
    });
    expect(res.statusCode).toBe(200);

    if (!captured) throw new Error('expected create adapter to be called');
    const capturedParams = captured as { labels?: unknown; assignees?: unknown; milestone?: unknown };
    expect(capturedParams.labels).toEqual(['bug']);
    expect(capturedParams.assignees).toEqual(['octocat']);
    expect(capturedParams.milestone).toBe('v1.0');

    await app.close();
  });

  it('returns 409 when init is requested while a run is active', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-init-running-');

    const repoRoot = await makeTempDir('jeeves-vs-repo-root-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'),
      "setTimeout(() => process.exit(0), 800);\n",
      'utf-8',
    );

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 1;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: 'fixture-trivial', branch: 'issue/1', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot,
      promptsDir: path.join(process.cwd(), 'prompts'),
      workflowsDir: path.join(process.cwd(), 'workflows'),
      initialIssue: issueRef,
      createGitHubIssue: async () => ({ issue_ref: 'o/r#999', issue_url: 'https://github.com/o/r/issues/999' }),
    });

    const runRes = await app.inject({
      method: 'POST',
      url: '/api/run',
      remoteAddress: '127.0.0.1',
      payload: { provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 30, iteration_timeout_sec: 30 },
    });
    expect(runRes.statusCode).toBe(200);
    expect((runRes.json() as { run?: { running?: unknown } }).run?.running).toBe(true);

    const createOnlyRes = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { repo: 'o/r', title: 't', body: 'b' },
    });
    expect(createOnlyRes.statusCode).toBe(200);
    expect((createOnlyRes.json() as { ok?: unknown; run?: { running?: unknown } }).ok).toBe(true);
    expect((createOnlyRes.json() as { ok?: unknown; run?: { running?: unknown } }).run?.running).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { repo: 'o/r', title: 't', body: 'b', init: {} },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error?: unknown }).error).toBe('Cannot init while Jeeves is running.');

    const start = Date.now();
    while (true) {
      const statusRes = await app.inject({ method: 'GET', url: '/api/run' });
      const running = (statusRes.json() as { run?: { running?: unknown } }).run?.running;
      if (running === false) break;
      if (Date.now() - start > 2500) throw new Error('timeout waiting for run to stop');
      await new Promise((r) => setTimeout(r, 25));
    }

    await app.close();
  });

  it('supports create+init and persists issue.title and issue.url into issue.json', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-init-');
    await ensureLocalRepoClone({ dataDir, owner: 'o', repo: 'r' });

    const createdIssueRef = 'o/r#123';
    const createdIssueUrl = 'https://github.com/o/r/issues/123';

    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
      createGitHubIssue: async () => ({ issue_ref: createdIssueRef, issue_url: createdIssueUrl }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { repo: 'o/r', title: ' My Title ', body: 'Hello', init: { branch: 'issue/123-test' } },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      ok?: unknown;
      created?: unknown;
      issue_ref?: unknown;
      issue_url?: unknown;
      init?: { ok?: unknown; result?: { state_dir?: unknown; work_dir?: unknown; repo_dir?: unknown; branch?: unknown } };
    };
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
    expect(body.issue_ref).toBe(createdIssueRef);
    expect(body.issue_url).toBe(createdIssueUrl);
    expect(body.init?.ok).toBe(true);
    expect(body.init?.result?.state_dir).toBe(getIssueStateDir('o', 'r', 123, dataDir));
    expect(body.init?.result?.work_dir).toBe(getWorktreePath('o', 'r', 123, dataDir));
    expect(body.init?.result?.repo_dir).toBe(path.join(dataDir, 'repos', 'o', 'r'));
    expect(body.init?.result?.branch).toBe('issue/123-test');

    const stateRes = await app.inject({ method: 'GET', url: '/api/state' });
    expect((stateRes.json() as { issue_ref?: unknown }).issue_ref).toBe(createdIssueRef);

    const stateDir = getIssueStateDir('o', 'r', 123, dataDir);
    const issueJson = await readIssueJson(stateDir);
    expect(issueJson).toBeTruthy();
    const issue = (issueJson as { issue?: unknown }).issue as Record<string, unknown> | undefined;
    expect(issue?.title).toBe('My Title');
    expect(issue?.url).toBe(createdIssueUrl);

    await app.close();
  });

  it('supports init with auto_select=false without changing selected issue', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-init-no-select-');
    await ensureLocalRepoClone({ dataDir, owner: 'o', repo: 'r' });

    const initialIssueNumber = 1;
    const initialIssueRef = `o/r#${initialIssueNumber}`;
    const initialStateDir = getIssueStateDir('o', 'r', initialIssueNumber, dataDir);
    const initialWorkDir = getWorktreePath('o', 'r', initialIssueNumber, dataDir);
    await fs.mkdir(initialStateDir, { recursive: true });
    await fs.mkdir(initialWorkDir, { recursive: true });
    await fs.writeFile(
      path.join(initialStateDir, 'issue.json'),
      JSON.stringify({ repo: 'o/r', issue: { number: initialIssueNumber }, phase: 'design_draft', workflow: 'default', branch: 'issue/1', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const createdIssueRef = 'o/r#123';
    const createdIssueUrl = 'https://github.com/o/r/issues/123';

    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
      initialIssue: initialIssueRef,
      createGitHubIssue: async () => ({ issue_ref: createdIssueRef, issue_url: createdIssueUrl }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { repo: 'o/r', title: 'My Title', body: 'Hello', init: {}, auto_select: false },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok?: unknown; init?: { ok?: unknown } }).ok).toBe(true);
    expect((res.json() as { ok?: unknown; init?: { ok?: unknown } }).init?.ok).toBe(true);

    const stateRes = await app.inject({ method: 'GET', url: '/api/state' });
    expect((stateRes.json() as { issue_ref?: unknown }).issue_ref).toBe(initialIssueRef);

    const activeIssueRaw = await fs.readFile(path.join(dataDir, 'active-issue.json'), 'utf-8');
    expect(JSON.parse(activeIssueRaw).issue_ref).toBe(initialIssueRef);

    const createdStateDir = getIssueStateDir('o', 'r', 123, dataDir);
    const createdIssueJson = await readIssueJson(createdStateDir);
    expect(createdIssueJson).toBeTruthy();
    const createdIssue = (createdIssueJson as { issue?: unknown }).issue as Record<string, unknown> | undefined;
    expect(createdIssue?.title).toBe('My Title');
    expect(createdIssue?.url).toBe(createdIssueUrl);

    await app.close();
  });

  it('returns v1 limitation error for non-github.com issue URLs when init is requested', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-create-init-host-limitation-');

    const { app } = await buildServer({
      host: '127.0.0.1',
      port: 0,
      allowRemoteRun: false,
      dataDir,
      repoRoot: path.resolve(process.cwd()),
      createGitHubIssue: async () => ({ issue_ref: 'o/r#123', issue_url: 'https://github.enterprise.example/o/r/issues/123' }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/github/issues/create',
      remoteAddress: '127.0.0.1',
      payload: { repo: 'o/r', title: 't', body: 'b', init: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok?: unknown; init?: { ok?: unknown; error?: unknown }; run?: unknown };
    expect(body.ok).toBe(true);
    expect(body.init?.ok).toBe(false);
    expect(body.init?.error).toBe('Only github.com issue URLs are supported in v1.');
    expect(body.run).toBeTruthy();

    await app.close();
  });
});
