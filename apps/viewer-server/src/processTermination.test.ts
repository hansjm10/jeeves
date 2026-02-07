import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { terminateProcess } from './processTermination.js';

describe('terminateProcess', () => {
  it('always attempts proc.kill with the provided signal', () => {
    const kill = vi.fn(() => true);
    terminateProcess(
      { pid: 1234, kill },
      'SIGTERM',
      { platform: 'linux' },
    );
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('uses taskkill on Windows for SIGKILL', () => {
    const kill = vi.fn(() => true);
    const unref = vi.fn();
    const once = vi.fn();
    const spawnImpl = vi.fn(
      () =>
        ({
          unref,
          once,
        }) as unknown as ChildProcess,
    );

    terminateProcess(
      { pid: 4321, kill },
      'SIGKILL',
      { platform: 'win32', spawnImpl },
    );

    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawnImpl).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4321', '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    );
    expect(unref).toHaveBeenCalled();
    expect(once).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('does not use taskkill for SIGTERM on Windows', () => {
    const spawnImpl = vi.fn();
    terminateProcess(
      { pid: 100, kill: vi.fn(() => true) },
      'SIGTERM',
      { platform: 'win32', spawnImpl },
    );
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
