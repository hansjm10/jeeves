import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrunerConfig, pruneContent, type PrunerConfig } from './pruner.js';

// ---------------------------------------------------------------------------
// getPrunerConfig
// ---------------------------------------------------------------------------

describe('getPrunerConfig', () => {
  it('returns default URL and timeout when env vars are unset', () => {
    const config = getPrunerConfig({});
    expect(config.url).toBe('http://localhost:8000/prune');
    expect(config.timeoutMs).toBe(30_000);
    expect(config.enabled).toBe(true);
  });

  it('uses PRUNER_URL when set', () => {
    const config = getPrunerConfig({ PRUNER_URL: 'http://custom:9000/prune' });
    expect(config.url).toBe('http://custom:9000/prune');
    expect(config.enabled).toBe(true);
  });

  it('disables pruning when PRUNER_URL is empty string', () => {
    const config = getPrunerConfig({ PRUNER_URL: '' });
    expect(config.url).toBe('');
    expect(config.enabled).toBe(false);
  });

  it('parses PRUNER_TIMEOUT_MS as integer', () => {
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

  it('uses default timeout when PRUNER_TIMEOUT_MS is NaN', () => {
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: 'abc' });
    expect(config.timeoutMs).toBe(30_000);
  });

  it('uses default timeout when PRUNER_TIMEOUT_MS is empty', () => {
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: '' });
    expect(config.timeoutMs).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// pruneContent
// ---------------------------------------------------------------------------

describe('pruneContent', () => {
  const enabledConfig: PrunerConfig = {
    url: 'http://localhost:8000/prune',
    timeoutMs: 5000,
    enabled: true,
  };

  const disabledConfig: PrunerConfig = {
    url: '',
    timeoutMs: 5000,
    enabled: false,
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns original content when config is disabled', async () => {
    const result = await pruneContent('original code', 'question', disabledConfig);
    expect(result).toBe('original code');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('sends POST { code, query } to PRUNER_URL', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ pruned_code: 'pruned' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await pruneContent('original code', 'my question', enabledConfig);

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://localhost:8000/prune',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'original code', query: 'my question' }),
      }),
    );
  });

  it('accepts pruned_code from response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ pruned_code: 'pruned via pruned_code' }), { status: 200 }),
    );
    const result = await pruneContent('original', 'q', enabledConfig);
    expect(result).toBe('pruned via pruned_code');
  });

  it('accepts content from response when pruned_code is absent', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ content: 'pruned via content' }), { status: 200 }),
    );
    const result = await pruneContent('original', 'q', enabledConfig);
    expect(result).toBe('pruned via content');
  });

  it('accepts text from response when pruned_code and content are absent', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ text: 'pruned via text' }), { status: 200 }),
    );
    const result = await pruneContent('original', 'q', enabledConfig);
    expect(result).toBe('pruned via text');
  });

  it('prefers pruned_code over content and text', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ pruned_code: 'pc', content: 'ct', text: 'tx' }),
        { status: 200 },
      ),
    );
    const result = await pruneContent('original', 'q', enabledConfig);
    expect(result).toBe('pc');
  });

  it('returns original on non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );
    const result = await pruneContent('original', 'q', enabledConfig);
    expect(result).toBe('original');
  });

  it('returns original on network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await pruneContent('original', 'q', enabledConfig);
    expect(result).toBe('original');
  });

  it('returns original on invalid JSON response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('not json', { status: 200 }),
    );
    const result = await pruneContent('original', 'q', enabledConfig);
    expect(result).toBe('original');
  });

  it('returns original when response JSON is not an object', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify('just a string'), { status: 200 }),
    );
    const result = await pruneContent('original', 'q', enabledConfig);
    expect(result).toBe('original');
  });

  it('returns original when response missing all pruned fields', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ other: 'value' }), { status: 200 }),
    );
    const result = await pruneContent('original', 'q', enabledConfig);
    expect(result).toBe('original');
  });

  it('returns original on abort/timeout error', async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
    const result = await pruneContent('original', 'q', enabledConfig);
    expect(result).toBe('original');
  });
});
