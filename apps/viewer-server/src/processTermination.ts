import { spawn as spawnDefault } from 'node:child_process';

export interface ProcessKillTarget {
  pid?: number | null;
  kill: (signal?: NodeJS.Signals) => boolean;
}

type TaskKillSpawnResult = {
  unref: () => void;
  once: (event: 'error', listener: () => void) => unknown;
};

type TaskKillSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: 'ignore'; windowsHide: true },
) => TaskKillSpawnResult;

export interface TerminateProcessOptions {
  platform?: NodeJS.Platform;
  spawnImpl?: TaskKillSpawn;
}

/**
 * Best-effort process termination helper.
 * - Always attempts Node's standard kill() first.
 * - On Windows, force kills also attempt `taskkill /T /F` to terminate the tree.
 */
export function terminateProcess(
  proc: ProcessKillTarget,
  signal: NodeJS.Signals,
  options: TerminateProcessOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const spawnImpl: TaskKillSpawn = options.spawnImpl ?? ((command, args, spawnOptions) => spawnDefault(command, args, spawnOptions));

  try {
    proc.kill(signal);
  } catch {
    // ignore
  }

  if (platform !== 'win32') return;
  if (signal !== 'SIGKILL') return;
  if (!proc.pid || proc.pid <= 0) return;

  try {
    const killer = spawnImpl('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
    killer.once('error', () => void 0);
  } catch {
    // ignore
  }
}
