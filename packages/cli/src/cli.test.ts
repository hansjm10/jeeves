import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './cli.js';

describe('CLI: jeeves run', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('--iterations flag', () => {
    it('includes max_iterations in POST payload when --iterations is a valid positive integer', async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ ok: true, run: { running: true } }),
      });

      await main(['run', '--iterations', '5']);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://127.0.0.1:8081/api/run');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body as string)).toEqual({ max_iterations: 5 });
    });

    it('omits max_iterations from payload when --iterations is not provided', async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ ok: true, run: { running: true } }),
      });

      await main(['run']);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body).toEqual({});
      expect(body.max_iterations).toBeUndefined();
    });

    it('throws error for --iterations 0', async () => {
      await expect(main(['run', '--iterations', '0'])).rejects.toThrow(
        'Invalid iterations value: "0" must be a positive integer',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws error for negative --iterations', async () => {
      // Node's parseArgs requires --option=-value for negative numbers
      await expect(main(['run', '--iterations=-1'])).rejects.toThrow(
        'Invalid iterations value: "-1" must be a positive integer',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws error for non-integer --iterations (float)', async () => {
      await expect(main(['run', '--iterations', '2.5'])).rejects.toThrow(
        'Invalid iterations value: "2.5" is not an integer',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws error for non-numeric --iterations', async () => {
      await expect(main(['run', '--iterations', 'abc'])).rejects.toThrow(
        'Invalid iterations value: "abc" is not an integer',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('server response handling', () => {
    it('throws error when server response has ok:false', async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ ok: false, error: 'No issue selected' }),
      });

      await expect(main(['run'])).rejects.toThrow('Server returned error: No issue selected');
    });

    it('throws error with default message when ok:false and no error field', async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ ok: false }),
      });

      await expect(main(['run'])).rejects.toThrow('Server returned error: Unknown error');
    });

    it('prints JSON response to stdout on successful response', async () => {
      const response = { ok: true, run: { running: true, maxIterations: 10 } };
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve(response),
      });

      await main(['run']);

      expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify(response, null, 2));
    });
  });

  describe('network errors', () => {
    it('throws error on network failure (unreachable server)', async () => {
      mockFetch.mockRejectedValue(new Error('fetch failed'));

      await expect(main(['run'])).rejects.toThrow('Network error: fetch failed');
    });

    it('handles non-Error rejection types', async () => {
      mockFetch.mockRejectedValue('connection refused');

      await expect(main(['run'])).rejects.toThrow('Network error: connection refused');
    });
  });

  describe('--server flag', () => {
    it('uses custom server URL when --server is provided', async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ ok: true, run: { running: true } }),
      });

      await main(['run', '--server', 'http://custom.example:9000']);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://custom.example:9000/api/run');
    });

    it('defaults to http://127.0.0.1:8081 when --server is omitted', async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ ok: true, run: { running: true } }),
      });

      await main(['run']);

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://127.0.0.1:8081/api/run');
    });

    it('combines --server and --iterations correctly', async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ ok: true, run: { running: true } }),
      });

      await main(['run', '--server', 'http://other:8080', '--iterations', '3']);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://other:8080/api/run');
      expect(JSON.parse(options.body as string)).toEqual({ max_iterations: 3 });
    });
  });

  describe('--help flag', () => {
    it('prints usage information and exits successfully', async () => {
      await main(['--help']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('Usage:');
      expect(output).toContain('jeeves run');
      expect(output).toContain('--iterations');
      expect(output).toContain('--server');
      expect(output).toContain('--help');
      expect(output).toContain('--version');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('--help takes precedence over other arguments', async () => {
      await main(['run', '--help', '--iterations', '5']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('Usage:');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('--version flag', () => {
    it('prints version and exits successfully', async () => {
      await main(['--version']);

      expect(consoleLogSpy).toHaveBeenCalledWith('jeeves 0.0.0');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('-v short flag prints version', async () => {
      await main(['-v']);

      expect(consoleLogSpy).toHaveBeenCalledWith('jeeves 0.0.0');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('--version takes precedence over other arguments', async () => {
      await main(['run', '--version', '--iterations', '5']);

      expect(consoleLogSpy).toHaveBeenCalledWith('jeeves 0.0.0');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('command validation', () => {
    it('throws error when no command is specified', async () => {
      await expect(main([])).rejects.toThrow('Invalid command');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: No command specified\n');
    });

    it('throws error for unknown commands', async () => {
      await expect(main(['unknown'])).rejects.toThrow('Invalid command');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Unknown command "unknown"\n');
    });
  });
});
