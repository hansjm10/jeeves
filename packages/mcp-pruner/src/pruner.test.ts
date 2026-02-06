import http from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getPrunerConfig, pruneContent, type PrunerConfig } from './pruner.js';

// ---------------------------------------------------------------------------
// getPrunerConfig tests
// ---------------------------------------------------------------------------

describe('getPrunerConfig', () => {
  it('returns default URL when PRUNER_URL is not set', () => {
    const config = getPrunerConfig({});
    expect(config.url).toBe('http://localhost:8000/prune');
    expect(config.enabled).toBe(true);
  });

  it('uses PRUNER_URL when set', () => {
    const config = getPrunerConfig({ PRUNER_URL: 'http://custom:1234/prune' });
    expect(config.url).toBe('http://custom:1234/prune');
    expect(config.enabled).toBe(true);
  });

  it('disables pruning when PRUNER_URL is empty string', () => {
    const config = getPrunerConfig({ PRUNER_URL: '' });
    expect(config.url).toBe('');
    expect(config.enabled).toBe(false);
  });

  it('returns default timeout when PRUNER_TIMEOUT_MS is not set', () => {
    const config = getPrunerConfig({});
    expect(config.timeoutMs).toBe(30_000);
  });

  it('parses valid PRUNER_TIMEOUT_MS', () => {
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: '5000' });
    expect(config.timeoutMs).toBe(5000);
  });

  it('clamps PRUNER_TIMEOUT_MS below minimum to 100', () => {
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: '10' });
    expect(config.timeoutMs).toBe(100);
  });

  it('clamps PRUNER_TIMEOUT_MS above maximum to 300000', () => {
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: '999999' });
    expect(config.timeoutMs).toBe(300_000);
  });

  it('uses default timeout for non-integer PRUNER_TIMEOUT_MS', () => {
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: 'abc' });
    expect(config.timeoutMs).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// pruneContent tests — use a real local HTTP server for integration testing
// ---------------------------------------------------------------------------

describe('pruneContent', () => {
  let server: http.Server;
  let port: number;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer((req, res) => handler(req, res));
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve();
        });
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  function makeConfig(overrides?: Partial<PrunerConfig>): PrunerConfig {
    return {
      url: `http://127.0.0.1:${port}/prune`,
      timeoutMs: 5000,
      enabled: true,
      ...overrides,
    };
  }

  it('returns original content when pruning is disabled', async () => {
    const result = await pruneContent('original', 'query', {
      url: '',
      timeoutMs: 5000,
      enabled: false,
    });
    expect(result).toBe('original');
  });

  it('sends POST payload { code, query }', async () => {
    let receivedBody: unknown;
    handler = (req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pruned_code: 'pruned' }));
      });
    };

    await pruneContent('my code', 'my query', makeConfig());
    expect(receivedBody).toEqual({ code: 'my code', query: 'my query' });
  });

  it('accepts pruned_code as pruned output', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pruned_code: 'pruned via pruned_code' }));
    };

    const result = await pruneContent('original', 'query', makeConfig());
    expect(result).toBe('pruned via pruned_code');
  });

  it('accepts content as pruned output', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: 'pruned via content' }));
    };

    const result = await pruneContent('original', 'query', makeConfig());
    expect(result).toBe('pruned via content');
  });

  it('accepts text as pruned output', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'pruned via text' }));
    };

    const result = await pruneContent('original', 'query', makeConfig());
    expect(result).toBe('pruned via text');
  });

  it('prefers pruned_code over content and text', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          pruned_code: 'winner',
          content: 'loser1',
          text: 'loser2',
        }),
      );
    };

    const result = await pruneContent('original', 'query', makeConfig());
    expect(result).toBe('winner');
  });

  it('falls back to original on non-2xx response', async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end('server error');
    };

    const result = await pruneContent('original', 'query', makeConfig());
    expect(result).toBe('original');
  });

  it('falls back to original on invalid JSON response', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not json');
    };

    const result = await pruneContent('original', 'query', makeConfig());
    expect(result).toBe('original');
  });

  it('falls back to original on response missing pruned fields', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ other_field: 'value' }));
    };

    const result = await pruneContent('original', 'query', makeConfig());
    expect(result).toBe('original');
  });

  it('falls back to original on network error (connection refused)', async () => {
    const config: PrunerConfig = {
      url: 'http://127.0.0.1:1/prune', // Port 1 should refuse connections
      timeoutMs: 2000,
      enabled: true,
    };

    const result = await pruneContent('original', 'query', config);
    expect(result).toBe('original');
  });

  it('falls back to original when response body is not an object', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify('just a string'));
    };

    const result = await pruneContent('original', 'query', makeConfig());
    expect(result).toBe('original');
  });

  it('falls back to original when response body is null', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('null');
    };

    const result = await pruneContent('original', 'query', makeConfig());
    expect(result).toBe('original');
  });

  it('never throws on any failure mode', async () => {
    // Network error
    const config1: PrunerConfig = {
      url: 'http://127.0.0.1:1/prune',
      timeoutMs: 1000,
      enabled: true,
    };
    await expect(pruneContent('code', 'q', config1)).resolves.toBe('code');

    // Non-2xx
    handler = (_req, res) => {
      res.writeHead(502);
      res.end();
    };
    await expect(pruneContent('code', 'q', makeConfig())).resolves.toBe('code');

    // Invalid JSON
    handler = (_req, res) => {
      res.writeHead(200);
      res.end('not json at all');
    };
    await expect(pruneContent('code', 'q', makeConfig())).resolves.toBe('code');
  });
});
