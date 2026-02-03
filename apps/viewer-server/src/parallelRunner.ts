/**
 * Parallel task runner for wave-based parallel task execution.
 *
 * This module implements §6.2.4/§6.2.7 of the parallel execution design (Issue #78):
 * - Execute up to maxParallelTasks workers concurrently
 * - Wave-based execution: implement_task wave, then task_spec_check wave
 * - Non-cancelling failure handling: if one worker fails, others continue
 * - TaskId-prefixed logging for readable interleaved output
 * - Integration with canonical workflow phase transitions
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn as spawnDefault } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  scheduleReadyTasks,
  type TasksFile,
} from '@jeeves/core';

import {
  createCompletionMarker,
  createWorkerSandbox,
  getImplementDoneMarkerPath,
  getSpecCheckDoneMarkerPath,
  getWorkerSandboxPaths,
  hasCompletionMarker,
  cleanupWorkerSandboxOnSuccess,
  type WorkerSandbox,
} from './workerSandbox.js';
import { readIssueJson, writeIssueJson } from './issueJson.js';
import { writeJsonAtomic } from './jsonAtomic.js';
import {
  mergePassedBranches,
  appendMergeProgress,
  updateWaveSummaryWithMerge,
  type WaveMergeResult,
} from './waveResultMerge.js';

/** Maximum allowed parallel tasks (hard cap per §6.2.1) */
export const MAX_PARALLEL_TASKS = 8;

/** Phase types for workers */
export type WorkerPhase = 'implement_task' | 'task_spec_check';

/** Worker status during execution */
export type WorkerStatus = 'running' | 'passed' | 'failed' | 'timed_out';

/** Per-worker process tracking */
export interface WorkerProcess {
  taskId: string;
  phase: WorkerPhase;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  returncode: number | null;
  status: WorkerStatus;
  sandbox: WorkerSandbox;
  proc: ChildProcessWithoutNullStreams | null;
}

/** Wave execution result */
export interface WaveResult {
  waveId: string;
  phase: WorkerPhase;
  taskIds: string[];
  startedAt: string;
  endedAt: string;
  workers: WorkerOutcome[];
  allPassed: boolean;
  anyFailed: boolean;
}

/** Individual worker outcome */
export interface WorkerOutcome {
  taskId: string;
  phase: WorkerPhase;
  status: WorkerStatus;
  exitCode: number | null;
  taskPassed: boolean;
  taskFailed: boolean;
  startedAt: string;
  endedAt: string;
}

/** Parallel execution state stored in issue.json.status.parallel */
export interface ParallelState {
  runId: string;
  activeWaveId: string;
  activeWavePhase: WorkerPhase;
  activeWaveTaskIds: string[];
  reservedStatusByTaskId: Record<string, 'pending' | 'failed'>;
  reservedAt: string;
}

/** Options for parallel wave execution */
export interface ParallelRunnerOptions {
  /** Path to canonical state directory */
  canonicalStateDir: string;
  /** Path to canonical worktree directory */
  canonicalWorkDir: string;
  /** Path to shared repo clone directory */
  repoDir: string;
  /** Jeeves data directory */
  dataDir: string;
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Issue number */
  issueNumber: number;
  /** Canonical issue branch (e.g., issue/78) */
  canonicalBranch: string;
  /** Run ID for this execution */
  runId: string;
  /** Workflow name */
  workflowName: string;
  /** Provider name */
  provider: string;
  /** Workflows directory */
  workflowsDir: string;
  /** Prompts directory */
  promptsDir: string;
  /** Path to viewer-run.log for logging */
  viewerLogPath: string;
  /** Maximum parallel tasks (bounded by MAX_PARALLEL_TASKS) */
  maxParallelTasks: number;
  /** Callback for appending to viewer log */
  appendLog: (line: string) => Promise<void>;
  /** Callback for broadcasting status updates */
  broadcast: (event: string, data: unknown) => void;
  /** Callback to get the current full run status (for broadcasting) */
  getRunStatus?: () => unknown;
  /** Spawn implementation (for testing) */
  spawn?: typeof spawnDefault;
  /** Path to runner binary */
  runnerBinPath: string;
  /** Optional model override */
  model?: string;
}

/** Result of a parallel wave step */
export interface ParallelWaveStepResult {
  waveResult: WaveResult;
  /** Whether to continue to next phase (false if errors or stop requested) */
  continueExecution: boolean;
  /** Error message if setup/orchestration failed */
  error?: string;
  /** Merge result after spec-check wave (if merging was performed) */
  mergeResult?: WaveMergeResult;
  /** True if a merge conflict occurred (run should stop as errored) */
  mergeConflict?: boolean;
}

/**
 * Creates a unique wave ID for tracking.
 */
function makeWaveId(runId: string, phase: WorkerPhase, waveNum: number): string {
  const compact = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${runId}-wave${waveNum}-${phase}-${compact}`;
}

/**
 * Gets current ISO timestamp.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Converts exit event to exit code.
 */
function exitCodeFromExitEvent(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') return code;
  if (signal) {
    const signals = os.constants.signals as unknown as Record<string, number | undefined>;
    const n = signals[signal];
    if (typeof n === 'number') return 128 + n;
    return 1;
  }
  return 0;
}

/**
 * Reads tasks.json from a directory.
 */
async function readTasksJson(dir: string): Promise<TasksFile | null> {
  const tasksPath = path.join(dir, 'tasks.json');
  try {
    const raw = await fs.readFile(tasksPath, 'utf-8');
    return JSON.parse(raw) as TasksFile;
  } catch {
    return null;
  }
}

/**
 * Writes tasks.json to a directory.
 */
async function writeTasksJson(dir: string, data: TasksFile): Promise<void> {
  await writeJsonAtomic(path.join(dir, 'tasks.json'), data);
}

/**
 * Reads the parallel state from issue.json.
 */
export async function readParallelState(stateDir: string): Promise<ParallelState | null> {
  const issueJson = await readIssueJson(stateDir);
  if (!issueJson) return null;
  const status = issueJson.status as Record<string, unknown> | undefined;
  if (!status) return null;
  const parallel = status.parallel as ParallelState | undefined;
  if (!parallel || !parallel.runId || !parallel.activeWaveId) return null;
  return parallel;
}

/**
 * Writes the parallel state to issue.json.
 */
export async function writeParallelState(
  stateDir: string,
  parallelState: ParallelState | null,
): Promise<void> {
  const issueJson = await readIssueJson(stateDir);
  if (!issueJson) throw new Error('issue.json not found');
  const status = (issueJson.status as Record<string, unknown>) ?? {};
  if (parallelState) {
    status.parallel = parallelState;
  } else {
    delete status.parallel;
  }
  issueJson.status = status;
  await writeIssueJson(stateDir, issueJson);
}

/**
 * Reserves tasks by setting their status to in_progress and recording parallel state.
 */
export async function reserveTasksForWave(
  stateDir: string,
  runId: string,
  waveId: string,
  phase: WorkerPhase,
  taskIds: string[],
): Promise<Record<string, 'pending' | 'failed'>> {
  // Read current tasks
  const tasksJson = await readTasksJson(stateDir);
  if (!tasksJson) throw new Error('tasks.json not found');

  // Build map of previous statuses for rollback
  const reservedStatusByTaskId: Record<string, 'pending' | 'failed'> = {};
  for (const task of tasksJson.tasks) {
    if (taskIds.includes(task.id)) {
      if (task.status === 'pending' || task.status === 'failed') {
        reservedStatusByTaskId[task.id] = task.status;
        task.status = 'in_progress';
      }
    }
  }

  // Write updated tasks
  await writeTasksJson(stateDir, tasksJson);

  // Write parallel state
  const parallelState: ParallelState = {
    runId,
    activeWaveId: waveId,
    activeWavePhase: phase,
    activeWaveTaskIds: taskIds,
    reservedStatusByTaskId,
    reservedAt: nowIso(),
  };
  await writeParallelState(stateDir, parallelState);

  return reservedStatusByTaskId;
}

/**
 * Rolls back task reservations using saved statuses.
 */
export async function rollbackTaskReservations(
  stateDir: string,
  reservedStatusByTaskId: Record<string, 'pending' | 'failed'>,
): Promise<void> {
  const tasksJson = await readTasksJson(stateDir);
  if (!tasksJson) return;

  for (const task of tasksJson.tasks) {
    const previousStatus = reservedStatusByTaskId[task.id];
    if (previousStatus !== undefined) {
      task.status = previousStatus;
    }
  }

  await writeTasksJson(stateDir, tasksJson);
  await writeParallelState(stateDir, null);
}

/**
 * Updates canonical task statuses after wave completion.
 */
export async function updateCanonicalTaskStatuses(
  stateDir: string,
  outcomes: WorkerOutcome[],
): Promise<void> {
  const tasksJson = await readTasksJson(stateDir);
  if (!tasksJson) return;

  for (const outcome of outcomes) {
    const task = tasksJson.tasks.find((t) => t.id === outcome.taskId);
    if (task) {
      if (outcome.taskPassed) {
        task.status = 'passed';
      } else {
        task.status = 'failed';
      }
    }
  }

  await writeTasksJson(stateDir, tasksJson);
}

/**
 * Updates canonical issue.json status flags after spec-check wave.
 * Per §6.2.7, sets taskPassed, taskFailed, hasMoreTasks, allTasksComplete.
 */
export async function updateCanonicalStatusFlags(
  stateDir: string,
  waveResult: WaveResult,
): Promise<void> {
  const issueJson = await readIssueJson(stateDir);
  if (!issueJson) return;

  const status = (issueJson.status as Record<string, unknown>) ?? {};
  const tasksJson = await readTasksJson(stateDir);
  if (!tasksJson) return;

  // Check if all tasks are passed
  const allPassed = tasksJson.tasks.every((t) => t.status === 'passed');
  // Check if any task is not passed (pending, failed, in_progress)
  const hasRemaining = tasksJson.tasks.some((t) => t.status !== 'passed');

  if (waveResult.anyFailed) {
    // If any task failed spec-check
    status.taskPassed = false;
    status.taskFailed = true;
    status.hasMoreTasks = true;
    status.allTasksComplete = false;
  } else if (allPassed) {
    // All tasks are passed
    status.taskPassed = true;
    status.taskFailed = false;
    status.hasMoreTasks = false;
    status.allTasksComplete = true;
  } else {
    // All wave tasks passed but there are remaining tasks
    status.taskPassed = true;
    status.taskFailed = false;
    status.hasMoreTasks = hasRemaining;
    status.allTasksComplete = false;
  }

  // Clear parallel state after spec-check completes
  delete status.parallel;

  issueJson.status = status;
  await writeIssueJson(stateDir, issueJson);
}

/**
 * Writes a wave summary artifact.
 */
export async function writeWaveSummary(
  stateDir: string,
  runId: string,
  waveResult: WaveResult,
): Promise<void> {
  const wavesDir = path.join(stateDir, '.runs', runId, 'waves');
  await fs.mkdir(wavesDir, { recursive: true });
  await writeJsonAtomic(path.join(wavesDir, `${waveResult.waveId}.json`), waveResult);
}

/**
 * Parallel runner for executing task waves.
 */
export class ParallelRunner {
  private readonly options: ParallelRunnerOptions;
  private readonly spawn: typeof spawnDefault;
  private activeWorkers = new Map<string, WorkerProcess>();
  private stopRequested = false;
  private waveNum = 0;

  constructor(options: ParallelRunnerOptions) {
    this.options = {
      ...options,
      maxParallelTasks: Math.min(Math.max(1, options.maxParallelTasks), MAX_PARALLEL_TASKS),
    };
    this.spawn = options.spawn ?? spawnDefault;
  }

  /**
   * Gets the list of currently active workers for status reporting.
   */
  getActiveWorkers(): {
    taskId: string;
    phase: WorkerPhase;
    pid: number | null;
    startedAt: string;
    status: WorkerStatus;
  }[] {
    return Array.from(this.activeWorkers.values()).map((w) => ({
      taskId: w.taskId,
      phase: w.phase,
      pid: w.pid,
      startedAt: w.startedAt,
      status: w.status,
    }));
  }

  /**
   * Broadcasts the current run status including active workers.
   * Called when worker state changes (spawn, exit, status update).
   */
  private broadcastRunStatus(): void {
    if (this.options.getRunStatus) {
      this.options.broadcast('run', { run: this.options.getRunStatus() });
    }
  }

  /**
   * Requests stop of all active workers.
   */
  requestStop(): void {
    this.stopRequested = true;
    for (const worker of this.activeWorkers.values()) {
      if (worker.proc && worker.proc.exitCode === null) {
        try {
          worker.proc.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Checks if there is an active wave that needs resuming.
   */
  async checkForActiveWave(): Promise<ParallelState | null> {
    return readParallelState(this.options.canonicalStateDir);
  }

  /**
   * Runs an implement_task wave for selected ready tasks.
   * Returns the wave result or null if no tasks are ready.
   */
  async runImplementWave(): Promise<ParallelWaveStepResult | null> {
    if (this.stopRequested) return null;

    // Check for active wave to resume
    const existingState = await this.checkForActiveWave();
    if (existingState && existingState.activeWavePhase === 'implement_task') {
      return this.resumeImplementWave(existingState);
    }

    // Select ready tasks
    const tasksJson = await readTasksJson(this.options.canonicalStateDir);
    if (!tasksJson) {
      return {
        waveResult: this.emptyWaveResult('implement_task'),
        continueExecution: false,
        error: 'tasks.json not found',
      };
    }

    const selectedTasks = scheduleReadyTasks(tasksJson, this.options.maxParallelTasks);
    if (selectedTasks.length === 0) {
      return null; // No ready tasks
    }

    const taskIds = selectedTasks.map((t) => t.id);
    this.waveNum += 1;
    const waveId = makeWaveId(this.options.runId, 'implement_task', this.waveNum);

    await this.options.appendLog(`[PARALLEL] Starting implement_task wave: ${taskIds.join(', ')}`);

    // Reserve tasks
    let reservedStatusByTaskId: Record<string, 'pending' | 'failed'>;
    try {
      reservedStatusByTaskId = await reserveTasksForWave(
        this.options.canonicalStateDir,
        this.options.runId,
        waveId,
        'implement_task',
        taskIds,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.options.appendLog(`[PARALLEL] Failed to reserve tasks: ${errMsg}`);
      return {
        waveResult: this.emptyWaveResult('implement_task'),
        continueExecution: false,
        error: `Task reservation failed: ${errMsg}`,
      };
    }

    // Create sandboxes and run workers
    return this.executeWave(waveId, 'implement_task', taskIds, reservedStatusByTaskId);
  }

  /**
   * Resumes an implement_task wave from saved parallel state.
   */
  private async resumeImplementWave(state: ParallelState): Promise<ParallelWaveStepResult> {
    await this.options.appendLog(
      `[PARALLEL] Resuming implement_task wave: ${state.activeWaveTaskIds.join(', ')}`,
    );

    // Filter tasks that haven't completed yet
    const tasksToRun: string[] = [];
    for (const taskId of state.activeWaveTaskIds) {
      const sandbox = getWorkerSandboxPaths({
        taskId,
        runId: state.runId,
        issueNumber: this.options.issueNumber,
        owner: this.options.owner,
        repo: this.options.repo,
        canonicalStateDir: this.options.canonicalStateDir,
        repoDir: this.options.repoDir,
        dataDir: this.options.dataDir,
        canonicalBranch: this.options.canonicalBranch,
      });
      const done = await hasCompletionMarker(getImplementDoneMarkerPath(sandbox));
      if (!done) {
        tasksToRun.push(taskId);
      } else {
        await this.options.appendLog(`[PARALLEL] Task ${taskId} already completed implement_task`);
      }
    }

    if (tasksToRun.length === 0) {
      // All tasks already completed, return success
      const waveResult: WaveResult = {
        waveId: state.activeWaveId,
        phase: 'implement_task',
        taskIds: state.activeWaveTaskIds,
        startedAt: state.reservedAt,
        endedAt: nowIso(),
        workers: [],
        allPassed: true,
        anyFailed: false,
      };
      return { waveResult, continueExecution: true };
    }

    return this.executeWave(
      state.activeWaveId,
      'implement_task',
      tasksToRun,
      state.reservedStatusByTaskId,
    );
  }

  /**
   * Runs a task_spec_check wave for the tasks from the preceding implement wave.
   */
  async runSpecCheckWave(): Promise<ParallelWaveStepResult | null> {
    if (this.stopRequested) return null;

    // Read the parallel state to get tasks from implement wave
    const state = await this.checkForActiveWave();
    if (!state) {
      return {
        waveResult: this.emptyWaveResult('task_spec_check'),
        continueExecution: false,
        error: 'No active wave state found for spec check',
      };
    }

    // Update phase to spec_check
    const updatedState: ParallelState = {
      ...state,
      activeWavePhase: 'task_spec_check',
    };
    await writeParallelState(this.options.canonicalStateDir, updatedState);

    await this.options.appendLog(
      `[PARALLEL] Starting task_spec_check wave: ${state.activeWaveTaskIds.join(', ')}`,
    );

    // Filter tasks that haven't completed spec check yet
    const tasksToRun: string[] = [];
    for (const taskId of state.activeWaveTaskIds) {
      const sandbox = getWorkerSandboxPaths({
        taskId,
        runId: state.runId,
        issueNumber: this.options.issueNumber,
        owner: this.options.owner,
        repo: this.options.repo,
        canonicalStateDir: this.options.canonicalStateDir,
        repoDir: this.options.repoDir,
        dataDir: this.options.dataDir,
        canonicalBranch: this.options.canonicalBranch,
      });
      const done = await hasCompletionMarker(getSpecCheckDoneMarkerPath(sandbox));
      if (!done) {
        tasksToRun.push(taskId);
      } else {
        await this.options.appendLog(`[PARALLEL] Task ${taskId} already completed task_spec_check`);
      }
    }

    if (tasksToRun.length === 0) {
      // All tasks already completed, need to read their results
      return this.collectSpecCheckResults(state.activeWaveId, state.activeWaveTaskIds, state);
    }

    return this.executeWave(
      state.activeWaveId,
      'task_spec_check',
      tasksToRun,
      state.reservedStatusByTaskId,
    );
  }

  /**
   * Collects spec check results when all tasks already completed.
   */
  private async collectSpecCheckResults(
    waveId: string,
    taskIds: string[],
    state: ParallelState,
  ): Promise<ParallelWaveStepResult> {
    const outcomes: WorkerOutcome[] = [];
    const sandboxes: WorkerSandbox[] = [];
    const now = nowIso();

    for (const taskId of taskIds) {
      const sandbox = getWorkerSandboxPaths({
        taskId,
        runId: state.runId,
        issueNumber: this.options.issueNumber,
        owner: this.options.owner,
        repo: this.options.repo,
        canonicalStateDir: this.options.canonicalStateDir,
        repoDir: this.options.repoDir,
        dataDir: this.options.dataDir,
        canonicalBranch: this.options.canonicalBranch,
      });
      sandboxes.push(sandbox);

      const workerIssue = await readIssueJson(sandbox.stateDir);
      const workerStatus = workerIssue?.status as Record<string, unknown> | undefined;
      const taskPassed = workerStatus?.taskPassed === true;
      const taskFailed = workerStatus?.taskFailed === true;

      outcomes.push({
        taskId,
        phase: 'task_spec_check',
        status: taskPassed ? 'passed' : 'failed',
        exitCode: 0,
        taskPassed,
        taskFailed,
        startedAt: state.reservedAt,
        endedAt: now,
      });
    }

    const allPassed = outcomes.every((o) => o.taskPassed);
    const anyFailed = outcomes.some((o) => o.taskFailed || !o.taskPassed);

    const waveResult: WaveResult = {
      waveId,
      phase: 'task_spec_check',
      taskIds,
      startedAt: state.reservedAt,
      endedAt: now,
      workers: outcomes,
      allPassed,
      anyFailed,
    };

    // Update canonical statuses initially based on spec-check outcomes
    await updateCanonicalTaskStatuses(this.options.canonicalStateDir, outcomes);

    // Merge passed branches into canonical branch (§6.2.5)
    const mergeResult = await this.mergePassedBranchesAfterSpecCheck(waveId, sandboxes, outcomes);

    // Update canonical status flags (reflecting both spec-check and merge outcomes)
    await updateCanonicalStatusFlags(this.options.canonicalStateDir, waveResult);
    await writeWaveSummary(this.options.canonicalStateDir, this.options.runId, waveResult);

    // If merge conflict, return with mergeConflict flag
    if (mergeResult.hasConflict) {
      return {
        waveResult,
        continueExecution: false,
        mergeResult,
        mergeConflict: true,
        error: `Merge conflict on task ${mergeResult.conflictTaskId}`,
      };
    }

    // Cleanup successfully merged workers
    for (const outcome of outcomes) {
      if (outcome.taskPassed) {
        const merge = mergeResult.merges.find((m) => m.taskId === outcome.taskId);
        // Only cleanup if task passed spec-check AND merged successfully
        if (merge?.success) {
          const sandbox = sandboxes.find((s) => s.taskId === outcome.taskId);
          if (sandbox) {
            await cleanupWorkerSandboxOnSuccess(sandbox).catch((e) => {
              void this.options.appendLog(
                `[WORKER ${outcome.taskId}] Cleanup warning: ${e instanceof Error ? e.message : String(e)}`,
              );
            });
          }
        }
      }
    }

    return { waveResult, continueExecution: true, mergeResult };
  }

  /**
   * Executes a wave of workers.
   */
  private async executeWave(
    waveId: string,
    phase: WorkerPhase,
    taskIds: string[],
    reservedStatusByTaskId: Record<string, 'pending' | 'failed'>,
  ): Promise<ParallelWaveStepResult> {
    const startedAt = nowIso();
    const sandboxes: WorkerSandbox[] = [];

    // Create sandboxes
    try {
      for (const taskId of taskIds) {
        if (this.stopRequested) break;

        const canonicalIssueJson = await readIssueJson(this.options.canonicalStateDir);
        const canonicalTasksJson = await readTasksJson(this.options.canonicalStateDir);
        if (!canonicalIssueJson || !canonicalTasksJson) {
          throw new Error('Cannot read canonical state files');
        }

        // Check for task feedback for retries
        const taskFeedbackPath = path.join(
          this.options.canonicalStateDir,
          'task-feedback',
          `${taskId}.md`,
        );

        const { sandbox } = await createWorkerSandbox({
          taskId,
          runId: this.options.runId,
          issueNumber: this.options.issueNumber,
          owner: this.options.owner,
          repo: this.options.repo,
          canonicalStateDir: this.options.canonicalStateDir,
          repoDir: this.options.repoDir,
          dataDir: this.options.dataDir,
          canonicalBranch: this.options.canonicalBranch,
          canonicalIssueJson,
          canonicalTasksJson: canonicalTasksJson as unknown as Record<string, unknown>,
          taskFeedbackPath,
        });

        sandboxes.push(sandbox);
        await this.options.appendLog(`[WORKER ${taskId}] Sandbox created: ${sandbox.worktreeDir}`);
      }
    } catch (err) {
      // Rollback on sandbox creation failure
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.options.appendLog(`[PARALLEL] Sandbox creation failed: ${errMsg}`);
      await rollbackTaskReservations(this.options.canonicalStateDir, reservedStatusByTaskId);

      // Write failed wave summary
      const failedWave: WaveResult = {
        waveId,
        phase,
        taskIds,
        startedAt,
        endedAt: nowIso(),
        workers: [],
        allPassed: false,
        anyFailed: true,
      };
      await writeWaveSummary(this.options.canonicalStateDir, this.options.runId, {
        ...failedWave,
        error: errMsg,
        state: 'setup_failed',
      } as WaveResult & { error: string; state: string });

      return {
        waveResult: failedWave,
        continueExecution: false,
        error: `Sandbox creation failed: ${errMsg}`,
      };
    }

    // Spawn workers
    const workerPromises: Promise<WorkerOutcome>[] = [];
    for (const sandbox of sandboxes) {
      if (this.stopRequested) break;
      workerPromises.push(this.spawnWorker(sandbox, phase));
    }

    // Wait for all workers to complete
    const outcomes = await Promise.all(workerPromises);

    // Create completion markers
    for (const sandbox of sandboxes) {
      const markerPath =
        phase === 'implement_task'
          ? getImplementDoneMarkerPath(sandbox)
          : getSpecCheckDoneMarkerPath(sandbox);
      await createCompletionMarker(markerPath);
    }

    const allPassed = outcomes.every((o) => o.status === 'passed' || (phase === 'implement_task' && o.exitCode === 0));
    const anyFailed = outcomes.some((o) => o.status === 'failed' || o.status === 'timed_out');

    const waveResult: WaveResult = {
      waveId,
      phase,
      taskIds,
      startedAt,
      endedAt: nowIso(),
      workers: outcomes,
      allPassed,
      anyFailed,
    };

    // Write wave summary
    await writeWaveSummary(this.options.canonicalStateDir, this.options.runId, waveResult);

    // If this is spec_check phase, update canonical statuses and merge passed branches
    if (phase === 'task_spec_check') {
      await updateCanonicalTaskStatuses(this.options.canonicalStateDir, outcomes);

      // Merge passed branches into canonical branch (§6.2.5)
      const mergeResult = await this.mergePassedBranchesAfterSpecCheck(waveId, sandboxes, outcomes);

      // Update canonical status flags (reflecting both spec-check and merge outcomes)
      await updateCanonicalStatusFlags(this.options.canonicalStateDir, waveResult);

      // If merge conflict, return with mergeConflict flag
      if (mergeResult.hasConflict) {
        await this.options.appendLog(
          `[PARALLEL] Wave ${phase} completed with merge conflict on task ${mergeResult.conflictTaskId}`,
        );
        return {
          waveResult,
          continueExecution: false,
          mergeResult,
          mergeConflict: true,
          error: `Merge conflict on task ${mergeResult.conflictTaskId}`,
        };
      }

      // Cleanup successfully merged workers
      for (const outcome of outcomes) {
        if (outcome.taskPassed) {
          const merge = mergeResult.merges.find((m) => m.taskId === outcome.taskId);
          // Only cleanup if task passed spec-check AND merged successfully
          if (merge?.success) {
            const sandbox = sandboxes.find((s) => s.taskId === outcome.taskId);
            if (sandbox) {
              await cleanupWorkerSandboxOnSuccess(sandbox).catch((e) => {
                void this.options.appendLog(
                  `[WORKER ${outcome.taskId}] Cleanup warning: ${e instanceof Error ? e.message : String(e)}`,
                );
              });
            }
          }
        }
      }

      const passedCount = outcomes.filter((o) => o.status === 'passed').length;
      await this.options.appendLog(
        `[PARALLEL] Wave ${phase} completed: ${passedCount}/${outcomes.length} passed, ${mergeResult.mergedCount} merged`,
      );

      return { waveResult, continueExecution: !this.stopRequested, mergeResult };
    }

    // For implement_task phase, count by exit code since taskPassed isn't set yet
    const passedCount = outcomes.filter((o) => o.status === 'passed' || o.exitCode === 0).length;
    await this.options.appendLog(
      `[PARALLEL] Wave ${phase} completed: ${passedCount}/${outcomes.length} passed`,
    );

    return { waveResult, continueExecution: !this.stopRequested };
  }

  /**
   * Spawns a single worker process and waits for completion.
   */
  private async spawnWorker(sandbox: WorkerSandbox, phase: WorkerPhase): Promise<WorkerOutcome> {
    const startedAt = nowIso();
    const taskId = sandbox.taskId;

    // Build runner args per §6.2.4
    const args = [
      this.options.runnerBinPath,
      'run-phase',
      '--workflow',
      this.options.workflowName,
      '--phase',
      phase,
      '--provider',
      this.options.provider,
      '--workflows-dir',
      this.options.workflowsDir,
      '--prompts-dir',
      this.options.promptsDir,
      '--state-dir',
      sandbox.stateDir,
      '--work-dir',
      sandbox.worktreeDir,
    ];

    const env: Record<string, string | undefined> = {
      ...process.env,
      JEEVES_DATA_DIR: this.options.dataDir,
    };
    if (this.options.model) {
      env.JEEVES_MODEL = this.options.model;
    }

    await this.options.appendLog(`[WORKER ${taskId}][${phase}] Starting...`);

    const proc = this.spawn(process.execPath, args, {
      cwd: sandbox.worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    proc.stdin.end();

    const worker: WorkerProcess = {
      taskId,
      phase,
      pid: proc.pid ?? null,
      startedAt,
      endedAt: null,
      returncode: null,
      status: 'running',
      sandbox,
      proc,
    };
    this.activeWorkers.set(taskId, worker);

    // Broadcast worker spawn - now has 'running' status
    this.broadcastRunStatus();

    // Handle stdout/stderr with taskId prefix
    proc.stdout.on('data', (chunk) => {
      const lines = String(chunk).trimEnd().split('\n');
      for (const line of lines) {
        void this.options.appendLog(`[WORKER ${taskId}][STDOUT] ${line}`);
      }
    });
    proc.stderr.on('data', (chunk) => {
      const lines = String(chunk).trimEnd().split('\n');
      for (const line of lines) {
        void this.options.appendLog(`[WORKER ${taskId}][STDERR] ${line}`);
      }
    });

    // Wait for exit
    const exitCode = await new Promise<number>((resolve) => {
      proc.once('exit', (code, signal) => resolve(exitCodeFromExitEvent(code, signal)));
    });

    const endedAt = nowIso();
    worker.endedAt = endedAt;
    worker.returncode = exitCode;

    // Read worker's issue.json to determine pass/fail
    const workerIssue = await readIssueJson(sandbox.stateDir);
    const workerStatus = workerIssue?.status as Record<string, unknown> | undefined;
    const taskPassed = workerStatus?.taskPassed === true;
    const taskFailed = workerStatus?.taskFailed === true;

    let status: WorkerStatus;
    if (phase === 'implement_task') {
      // For implement phase, success is based on exit code
      status = exitCode === 0 ? 'passed' : 'failed';
    } else {
      // For spec_check phase, use taskPassed/taskFailed flags
      status = taskPassed ? 'passed' : 'failed';
    }
    worker.status = status;

    // Broadcast worker status update - now has final status (passed/failed)
    this.broadcastRunStatus();

    await this.options.appendLog(
      `[WORKER ${taskId}][${phase}] Completed with exit code ${exitCode}, status=${status}`,
    );

    this.activeWorkers.delete(taskId);

    // Broadcast worker removal
    this.broadcastRunStatus();

    return {
      taskId,
      phase,
      status,
      exitCode,
      taskPassed,
      taskFailed,
      startedAt,
      endedAt,
    };
  }

  /**
   * Creates an empty wave result for error cases.
   */
  private emptyWaveResult(phase: WorkerPhase): WaveResult {
    const now = nowIso();
    return {
      waveId: makeWaveId(this.options.runId, phase, this.waveNum),
      phase,
      taskIds: [],
      startedAt: now,
      endedAt: now,
      workers: [],
      allPassed: false,
      anyFailed: true,
    };
  }

  /**
   * Merges passed branches after spec-check wave.
   *
   * Per §6.2.5:
   * - Merge order: taskId lexicographic ascending
   * - Merge strategy: git merge --no-ff
   * - If merge conflict: abort cleanly, mark task as failed, log progress entry
   */
  private async mergePassedBranchesAfterSpecCheck(
    waveId: string,
    sandboxes: WorkerSandbox[],
    outcomes: WorkerOutcome[],
  ): Promise<WaveMergeResult> {
    const mergeResult = await mergePassedBranches({
      canonicalWorkDir: this.options.canonicalWorkDir,
      canonicalBranch: this.options.canonicalBranch,
      sandboxes,
      outcomes,
      appendLog: this.options.appendLog,
    });

    // Append merge progress entry to canonical progress.txt
    await appendMergeProgress(this.options.canonicalStateDir, waveId, mergeResult);

    // Update wave summary with merge results
    await updateWaveSummaryWithMerge(
      this.options.canonicalStateDir,
      this.options.runId,
      waveId,
      mergeResult,
    );

    // If a merge conflict occurred, update the conflicted task status to 'failed'
    if (mergeResult.hasConflict && mergeResult.conflictTaskId) {
      await this.markTaskAsFailedDueToMergeConflict(mergeResult.conflictTaskId);
    }

    // Also mark any other tasks that failed to merge as 'failed'
    for (const merge of mergeResult.merges) {
      if (!merge.success && !merge.conflict) {
        await this.markTaskAsFailedDueToMergeConflict(merge.taskId);
      }
    }

    return mergeResult;
  }

  /**
   * Marks a task as failed due to merge conflict.
   */
  private async markTaskAsFailedDueToMergeConflict(taskId: string): Promise<void> {
    const tasksJson = await readTasksJson(this.options.canonicalStateDir);
    if (!tasksJson) return;

    const task = tasksJson.tasks.find((t) => t.id === taskId);
    if (task && task.status === 'passed') {
      task.status = 'failed';
      await writeTasksJson(this.options.canonicalStateDir, tasksJson);
      await this.options.appendLog(`[MERGE] Marked task ${taskId} as failed due to merge conflict`);
    }
  }
}

/**
 * Checks if parallel execution mode is enabled for an issue.
 */
export async function isParallelModeEnabled(stateDir: string): Promise<boolean> {
  const issueJson = await readIssueJson(stateDir);
  if (!issueJson) return false;
  const settings = issueJson.settings as Record<string, unknown> | undefined;
  if (!settings) return false;
  const taskExecution = settings.taskExecution as Record<string, unknown> | undefined;
  if (!taskExecution) return false;
  return taskExecution.mode === 'parallel';
}

/**
 * Gets the configured maxParallelTasks from issue settings.
 */
export async function getMaxParallelTasks(stateDir: string): Promise<number> {
  const issueJson = await readIssueJson(stateDir);
  if (!issueJson) return 1;
  const settings = issueJson.settings as Record<string, unknown> | undefined;
  if (!settings) return 1;
  const taskExecution = settings.taskExecution as Record<string, unknown> | undefined;
  if (!taskExecution) return 1;
  const maxTasks = taskExecution.maxParallelTasks;
  if (typeof maxTasks === 'number' && maxTasks >= 1) {
    return Math.min(maxTasks, MAX_PARALLEL_TASKS);
  }
  return 1;
}

/**
 * Validates max_parallel_tasks parameter.
 */
export function validateMaxParallelTasks(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > MAX_PARALLEL_TASKS) {
    return null;
  }
  return num;
}
