import path from 'node:path';

import { LogTailer, SdkOutputTailer } from './tailers.js';
import type { WorkerStatusInfo } from './types.js';

interface WorkerTailerSet {
  taskId: string;
  logTailer: LogTailer;
  sdkTailer: SdkOutputTailer;
  stateDir: string;
  /** When true, this worker has been removed but needs one more drain cycle. */
  draining: boolean;
}

export interface WorkerLogResult {
  taskId: string;
  lines: string[];
}

export interface WorkerSdkResult {
  taskId: string;
  event: string;
  data: unknown;
}

export interface WorkerPollResult {
  workerLogs: WorkerLogResult[];
  workerSdkEvents: WorkerSdkResult[];
}

export interface WorkerSnapshotResult {
  taskId: string;
  logLines: string[];
  sdkSnapshot: Record<string, unknown> | null;
}

export class WorkerTailerManager {
  private workers = new Map<string, WorkerTailerSet>();

  /**
   * Sync tailers with active workers list. Creates new tailers for new workers,
   * marks removed workers for draining.
   */
  reconcile(
    activeWorkers: WorkerStatusInfo[],
    resolveStateDir: (taskId: string) => string | null,
  ): void {
    const activeIds = new Set(activeWorkers.map((w) => w.taskId));

    // Mark removed workers for draining
    for (const [taskId, set] of this.workers) {
      if (!activeIds.has(taskId) && !set.draining) {
        set.draining = true;
      }
    }

    // Add new workers
    for (const worker of activeWorkers) {
      if (this.workers.has(worker.taskId)) continue;

      const stateDir = resolveStateDir(worker.taskId);
      if (!stateDir) continue;

      const logTailer = new LogTailer();
      logTailer.reset(path.join(stateDir, 'last-run.log'));

      const sdkTailer = new SdkOutputTailer();
      sdkTailer.reset(path.join(stateDir, 'sdk-output.json'));

      this.workers.set(worker.taskId, {
        taskId: worker.taskId,
        logTailer,
        sdkTailer,
        stateDir,
        draining: false,
      });
    }
  }

  /** Poll all worker tailers, return tagged events. Removes drained workers. */
  async poll(): Promise<WorkerPollResult> {
    const workerLogs: WorkerLogResult[] = [];
    const workerSdkEvents: WorkerSdkResult[] = [];
    const toRemove: string[] = [];

    for (const [taskId, set] of this.workers) {
      // Read logs
      const logs = await set.logTailer.getNewLines();
      if (logs.changed && logs.lines.length) {
        workerLogs.push({ taskId, lines: logs.lines });
      }

      // Read SDK events
      const sdk = await set.sdkTailer.readSnapshot();
      if (sdk) {
        const diff = set.sdkTailer.consumeAndDiff(sdk);
        if (diff.sessionChanged && diff.sessionId) {
          workerSdkEvents.push({
            taskId,
            event: 'sdk-init',
            data: { session_id: diff.sessionId, started_at: diff.startedAt, status: 'running' },
          });
        }
        for (const m of diff.newMessages) {
          workerSdkEvents.push({ taskId, event: 'sdk-message', data: m });
        }
        for (const tc of diff.toolStarts) {
          workerSdkEvents.push({ taskId, event: 'sdk-tool-start', data: tc });
        }
        for (const tc of diff.toolCompletes) {
          workerSdkEvents.push({ taskId, event: 'sdk-tool-complete', data: tc });
        }
        if (diff.justEnded) {
          workerSdkEvents.push({
            taskId,
            event: 'sdk-complete',
            data: { status: diff.success === false ? 'error' : 'success', summary: diff.stats ?? {} },
          });
        }
      }

      // Remove drained workers after one more cycle
      if (set.draining) {
        toRemove.push(taskId);
      }
    }

    for (const taskId of toRemove) {
      this.workers.delete(taskId);
    }

    return { workerLogs, workerSdkEvents };
  }

  /** Get initial snapshots for new client connections. */
  async getSnapshots(logLines: number): Promise<WorkerSnapshotResult[]> {
    const results: WorkerSnapshotResult[] = [];

    for (const [, set] of this.workers) {
      if (set.draining) continue;

      const lines = await set.logTailer.getAllLines(logLines);
      const sdkSnapshot = await readWorkerSdkOutput(set.stateDir);

      results.push({
        taskId: set.taskId,
        logLines: lines,
        sdkSnapshot,
      });
    }

    return results;
  }

  /** Clear all tailers (run ended). */
  clear(): void {
    this.workers.clear();
  }

  /** Get the set of currently tracked worker IDs (for testing). */
  get trackedWorkerIds(): string[] {
    return Array.from(this.workers.keys());
  }
}

async function readWorkerSdkOutput(stateDir: string): Promise<Record<string, unknown> | null> {
  const fs = await import('node:fs/promises');
  const filePath = path.join(stateDir, 'sdk-output.json');
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
