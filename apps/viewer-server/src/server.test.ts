import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

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
});
