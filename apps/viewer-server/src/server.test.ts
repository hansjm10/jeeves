import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
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
});
