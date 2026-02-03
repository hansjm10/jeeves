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
  reuseWorkerSandbox,
  getImplementDoneMarkerPath,
  getSpecCheckDoneMarkerPath,
  getWorkerSandboxPaths,
  hasCompletionMarker,
  cleanupWorkerSandboxOnSuccess,
  validateTaskId,
  validatePathSafeId,
  type WorkerSandbox,
} from './workerSandbox.js';
import { readIssueJson, writeIssueJson } from './issueJson.js';
import { writeJsonAtomic } from './jsonAtomic.js';
import {
  mergePassedBranches,
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
  /** Branch name used for this worker (for wave summary metadata) */
  branch?: string;
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
  /** Iteration timeout in seconds (per §6.2.4) */
  iterationTimeoutSec?: number;
  /** Inactivity timeout in seconds (per §6.2.4) */
  inactivityTimeoutSec?: number;
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
  /** True if wave was stopped due to timeout */
  timedOut?: boolean;
  /** Type of timeout that occurred */
  timeoutType?: 'iteration' | 'inactivity';
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
 *
 * SECURITY: Validates all taskIds in activeWaveTaskIds and reservedStatusByTaskId
 * to prevent path traversal attacks when the state is later used to construct paths.
 *
 * @throws Error if taskIds contain unsafe characters
 */
export async function readParallelState(stateDir: string): Promise<ParallelState | null> {
  const issueJson = await readIssueJson(stateDir);
  if (!issueJson) return null;
  const status = issueJson.status as Record<string, unknown> | undefined;
  if (!status) return null;
  const parallel = status.parallel as ParallelState | undefined;
  if (!parallel || !parallel.runId || !parallel.activeWaveId) return null;

  // SECURITY: Validate runId and activeWaveId to prevent path traversal when
  // constructing filesystem paths (§6.2.8 resume safety)
  validatePathSafeId(parallel.runId, 'status.parallel.runId');
  validatePathSafeId(parallel.activeWaveId, 'status.parallel.activeWaveId');

  // Validate shape: activeWaveTaskIds must be an array
  if (!Array.isArray(parallel.activeWaveTaskIds)) {
    throw new Error('Corrupted parallel state: activeWaveTaskIds is not an array');
  }

  // Validate shape: reservedStatusByTaskId must be an object
  if (
    parallel.reservedStatusByTaskId !== null &&
    parallel.reservedStatusByTaskId !== undefined &&
    (typeof parallel.reservedStatusByTaskId !== 'object' || Array.isArray(parallel.reservedStatusByTaskId))
  ) {
    throw new Error('Corrupted parallel state: reservedStatusByTaskId is not an object');
  }

  // SECURITY: Validate all taskIds to prevent path traversal
  for (const taskId of parallel.activeWaveTaskIds) {
    validateTaskId(taskId);
  }

  // Also validate taskIds in reservedStatusByTaskId
  if (parallel.reservedStatusByTaskId) {
    for (const taskId of Object.keys(parallel.reservedStatusByTaskId)) {
      validateTaskId(taskId);
    }
  }

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
 * Result of orphan repair operation.
 */
export interface OrphanRepairResult {
  /** Task IDs that were repaired (orphaned in_progress -> failed) */
  repairedTaskIds: string[];
  /** Paths to feedback files written for each repaired task */
  feedbackFilesWritten: string[];
}

/**
 * Writes a synthetic feedback file for a recovered/orphaned task.
 *
 * Per §6.2.8 of the design, this writes a canonical feedback file to
 * `.jeeves/task-feedback/<taskId>.md` explaining the recovery.
 */
export async function writeCanonicalFeedback(
  stateDir: string,
  taskId: string,
  reason: string,
  details: string,
): Promise<string> {
  // Validate taskId to prevent path traversal attacks (per code review)
  validateTaskId(taskId);

  const feedbackDir = path.join(stateDir, 'task-feedback');
  await fs.mkdir(feedbackDir, { recursive: true });
  const feedbackPath = path.join(feedbackDir, `${taskId}.md`);
  const content = `# Task Recovery Feedback: ${taskId}

## Reason
${reason}

## Details
${details}

## Timestamp
${nowIso()}

---
*This feedback was automatically generated by the parallel execution orchestrator.*
`;
  await fs.writeFile(feedbackPath, content, 'utf-8');
  return feedbackPath;
}

/**
 * Repairs orphaned in_progress tasks at start of run.
 *
 * Per §6.2.8 of the design:
 * - Invariant: A task may be `status="in_progress"` only when
 *   `issue.json.status.parallel` is present and the task ID is in `activeWaveTaskIds`.
 * - If any task violates this invariant, it is an orphan and must be repaired by:
 *   1. Setting `task.status = "failed"`
 *   2. Writing a synthetic canonical feedback file explaining the recovery
 */
export async function repairOrphanedInProgressTasks(
  stateDir: string,
): Promise<OrphanRepairResult> {
  const result: OrphanRepairResult = {
    repairedTaskIds: [],
    feedbackFilesWritten: [],
  };

  const tasksJson = await readTasksJson(stateDir);
  if (!tasksJson) return result;

  const parallelState = await readParallelState(stateDir);
  const activeWaveTaskIds = parallelState?.activeWaveTaskIds ?? [];

  let modified = false;
  for (const task of tasksJson.tasks) {
    if (task.status === 'in_progress') {
      // Check if task is in active wave
      const isInActiveWave = activeWaveTaskIds.includes(task.id);
      if (!isInActiveWave) {
        // This is an orphaned in_progress task - repair it
        task.status = 'failed';
        result.repairedTaskIds.push(task.id);
        modified = true;

        // Write canonical feedback file
        const feedbackPath = await writeCanonicalFeedback(
          stateDir,
          task.id,
          'Orphaned in_progress task recovered',
          `Task ${task.id} was found in \`status="in_progress"\` without a corresponding ` +
          `active wave in \`issue.json.status.parallel\`. This typically occurs when:\n\n` +
          `- The server crashed or was stopped unexpectedly during parallel execution\n` +
          `- A manual stop was performed but cleanup did not complete\n` +
          `- The parallel state was corrupted\n\n` +
          `The task has been automatically marked as \`failed\` and is eligible for retry ` +
          `in the next wave. Review the worker artifacts (if any) for debugging information.`,
        );
        result.feedbackFilesWritten.push(feedbackPath);
      }
    }
  }

  if (modified) {
    await writeTasksJson(stateDir, tasksJson);
  }

  return result;
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
 * Enhanced wave summary with required metadata per §6.2.5.
 */
export interface EnhancedWaveSummary extends WaveResult {
  /** Per-task verdicts with detailed outcomes */
  taskVerdicts: Record<string, {
    status: 'passed' | 'failed' | 'timed_out';
    exitCode: number | null;
    branch: string;
    taskPassed: boolean;
    taskFailed: boolean;
  }>;
  /** Merge order (task IDs in order they were merged) */
  mergeOrder?: string[];
  /** Merge results per task */
  mergeResults?: Record<string, {
    success: boolean;
    conflict: boolean;
    commitSha?: string;
    error?: string;
  }>;
  /** Error if setup/orchestration failed */
  error?: string;
  /** State if setup failed */
  state?: 'setup_failed';
}

/**
 * Writes a wave summary artifact with enhanced metadata (§6.2.5).
 *
 * The wave summary JSON includes:
 * - Per-task verdicts (status, exit code, branch, taskPassed, taskFailed)
 * - Wave timestamps and task IDs
 * - Worker outcomes
 */
export async function writeWaveSummary(
  stateDir: string,
  runId: string,
  waveResult: WaveResult,
): Promise<void> {
  const wavesDir = path.join(stateDir, '.runs', runId, 'waves');
  await fs.mkdir(wavesDir, { recursive: true });

  // Build enhanced wave summary with taskVerdicts
  const taskVerdicts: Record<string, {
    status: 'passed' | 'failed' | 'timed_out';
    exitCode: number | null;
    branch: string;
    taskPassed: boolean;
    taskFailed: boolean;
  }> = {};

  for (const worker of waveResult.workers) {
    taskVerdicts[worker.taskId] = {
      status: worker.status as 'passed' | 'failed' | 'timed_out',
      exitCode: worker.exitCode,
      branch: worker.branch ?? `issue/-${worker.taskId}`,
      taskPassed: worker.taskPassed,
      taskFailed: worker.taskFailed,
    };
  }

  const enhancedWave: EnhancedWaveSummary = {
    ...waveResult,
    taskVerdicts,
  };

  await writeJsonAtomic(path.join(wavesDir, `${waveResult.waveId}.json`), enhancedWave);
}

/**
 * Copies worker task-feedback.md to canonical .jeeves/task-feedback/<taskId>.md on failures.
 *
 * Per §6.2.5 of the design, worker feedback should be propagated to canonical state
 * for failed tasks to enable retries with proper context.
 */
export async function copyWorkerFeedbackToCanonical(
  canonicalStateDir: string,
  sandbox: WorkerSandbox,
): Promise<string | null> {
  const workerFeedbackPath = path.join(sandbox.stateDir, 'task-feedback.md');

  try {
    const feedbackExists = await fs
      .stat(workerFeedbackPath)
      .then((s) => s.isFile())
      .catch(() => false);

    if (!feedbackExists) {
      return null;
    }

    const feedbackContent = await fs.readFile(workerFeedbackPath, 'utf-8');
    const feedbackDir = path.join(canonicalStateDir, 'task-feedback');
    await fs.mkdir(feedbackDir, { recursive: true });
    const canonicalFeedbackPath = path.join(feedbackDir, `${sandbox.taskId}.md`);
    await fs.writeFile(canonicalFeedbackPath, feedbackContent, 'utf-8');
    return canonicalFeedbackPath;
  } catch {
    return null;
  }
}

/**
 * Writes a wave summary entry to canonical progress.txt.
 *
 * Per §6.2.5, canonical progress.txt receives a single wave summary entry per wave
 * (covering both implement + spec-check phases).
 */
export async function appendWaveProgressEntry(
  stateDir: string,
  runId: string,
  waveId: string,
  implementResult: WaveResult | null,
  specCheckResult: WaveResult | null,
  mergeResult: WaveMergeResult | null,
): Promise<void> {
  const progressPath = path.join(stateDir, 'progress.txt');
  const now = new Date().toISOString();

  const lines: string[] = [];
  lines.push(`## [${now}] - Parallel Wave Summary: ${waveId}`);
  lines.push('');

  // Wave info
  const taskIds = specCheckResult?.taskIds ?? implementResult?.taskIds ?? [];
  lines.push(`### Wave Tasks`);
  lines.push(`- Run ID: ${runId}`);
  lines.push(`- Tasks: ${taskIds.join(', ')}`);
  lines.push('');

  // Implement phase summary
  if (implementResult) {
    const implPassedCount = implementResult.workers.filter((w) => w.exitCode === 0 || w.status === 'passed').length;
    const implTimedOutCount = implementResult.workers.filter((w) => w.status === 'timed_out').length;
    lines.push(`### Implement Phase`);
    lines.push(`- Started: ${implementResult.startedAt}`);
    lines.push(`- Ended: ${implementResult.endedAt}`);
    lines.push(`- Passed: ${implPassedCount}/${implementResult.workers.length}`);
    if (implTimedOutCount > 0) {
      lines.push(`- Timed out: ${implTimedOutCount}`);
    }
    lines.push('');
  }

  // Spec-check phase summary
  if (specCheckResult) {
    const specPassedCount = specCheckResult.workers.filter((w) => w.taskPassed).length;
    const specFailedCount = specCheckResult.workers.filter((w) => w.taskFailed || !w.taskPassed).length;
    const specTimedOutCount = specCheckResult.workers.filter((w) => w.status === 'timed_out').length;
    lines.push(`### Spec-Check Phase`);
    lines.push(`- Started: ${specCheckResult.startedAt}`);
    lines.push(`- Ended: ${specCheckResult.endedAt}`);
    lines.push(`- Passed: ${specPassedCount}/${specCheckResult.workers.length}`);
    if (specFailedCount > 0) {
      lines.push(`- Failed: ${specFailedCount}`);
    }
    if (specTimedOutCount > 0) {
      lines.push(`- Timed out: ${specTimedOutCount}`);
    }
    lines.push('');
  }

  // Merge summary
  if (mergeResult) {
    lines.push(`### Merge Results`);
    lines.push(`- Merged: ${mergeResult.mergedCount}`);
    lines.push(`- Failed: ${mergeResult.failedCount}`);
    if (mergeResult.hasConflict) {
      lines.push(`- **Conflict on task**: ${mergeResult.conflictTaskId}`);
    }
    lines.push('');
    lines.push(`#### Merge Order`);
    for (const merge of mergeResult.merges) {
      if (merge.success) {
        lines.push(`- [x] ${merge.taskId}: merged (${merge.commitSha?.substring(0, 7) ?? 'unknown'})`);
      } else if (merge.conflict) {
        lines.push(`- [ ] ${merge.taskId}: CONFLICT`);
      } else {
        lines.push(`- [ ] ${merge.taskId}: skipped/failed`);
      }
    }
    lines.push('');
  }

  // Per-task verdicts
  const allWorkers = [
    ...(implementResult?.workers ?? []),
    ...(specCheckResult?.workers ?? []),
  ];
  const verdictsByTask = new Map<string, { impl?: WorkerOutcome; spec?: WorkerOutcome }>();
  for (const w of allWorkers) {
    const entry = verdictsByTask.get(w.taskId) ?? {};
    if (w.phase === 'implement_task') entry.impl = w;
    if (w.phase === 'task_spec_check') entry.spec = w;
    verdictsByTask.set(w.taskId, entry);
  }

  if (verdictsByTask.size > 0) {
    lines.push(`### Per-Task Verdicts`);
    for (const [taskId, v] of verdictsByTask) {
      const implStatus = v.impl ? (v.impl.exitCode === 0 ? '✓' : '✗') : '-';
      const specStatus = v.spec ? (v.spec.taskPassed ? '✓' : '✗') : '-';
      const finalStatus = v.spec?.taskPassed ? 'passed' : 'failed';
      lines.push(`- ${taskId}: impl=${implStatus}, spec=${specStatus}, verdict=${finalStatus}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  const entry = lines.join('\n');

  try {
    await fs.appendFile(progressPath, entry, 'utf-8');
  } catch {
    // If append fails, try to create the file
    await fs.writeFile(progressPath, entry, 'utf-8');
  }
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
  /** Tracks if wave was stopped due to timeout */
  private timedOut = false;
  private timeoutType: 'iteration' | 'inactivity' | null = null;
  /** Timestamp when wave started (for iteration timeout) */
  private waveStartedAtMs: number | null = null;
  /** Timestamp of last activity (for inactivity timeout) */
  private lastActivityAtMs: number | null = null;
  /** Stores the last implement wave result to include in the combined progress entry */
  private lastImplementWaveResult: WaveResult | null = null;
  /**
   * The effective runId for sandbox paths. When resuming an active wave from a previous
   * run/server restart, this is set to the persisted parallel state's runId to ensure
   * spec-check finds the correct worker state directories. (§6.2.8 restart-safe resume)
   */
  private effectiveRunId: string;

  constructor(options: ParallelRunnerOptions) {
    this.options = {
      ...options,
      maxParallelTasks: Math.min(Math.max(1, options.maxParallelTasks), MAX_PARALLEL_TASKS),
    };
    this.spawn = options.spawn ?? spawnDefault;
    // Default to current run's ID; updated when resuming an active wave
    this.effectiveRunId = options.runId;
  }

  /**
   * Gets the list of currently active workers for status reporting.
   */
  getActiveWorkers(): {
    taskId: string;
    phase: WorkerPhase;
    pid: number | null;
    startedAt: string;
    endedAt: string | null;
    returncode: number | null;
    status: WorkerStatus;
  }[] {
    return Array.from(this.activeWorkers.values()).map((w) => ({
      taskId: w.taskId,
      phase: w.phase,
      pid: w.pid,
      startedAt: w.startedAt,
      endedAt: w.endedAt,
      returncode: w.returncode,
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
   * Records activity (log output, progress) to reset inactivity timer.
   */
  private recordActivity(): void {
    this.lastActivityAtMs = Date.now();
  }

  /**
   * Terminates all active workers due to timeout.
   */
  private terminateAllWorkersForTimeout(type: 'iteration' | 'inactivity'): void {
    this.timedOut = true;
    this.timeoutType = type;
    for (const worker of this.activeWorkers.values()) {
      if (worker.proc && worker.proc.exitCode === null) {
        try {
          // Use SIGKILL for immediate termination on timeout
          worker.proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        // Mark worker as timed_out
        worker.status = 'timed_out';
      }
    }
    // Broadcast updated status showing workers as timed_out
    this.broadcastRunStatus();
  }

  /**
   * Checks if iteration or inactivity timeout has occurred.
   * Returns true if wave should stop due to timeout.
   */
  private checkTimeouts(): { timedOut: boolean; type: 'iteration' | 'inactivity' | null } {
    if (this.timedOut) {
      return { timedOut: true, type: this.timeoutType };
    }

    const now = Date.now();
    const iterationTimeoutSec = this.options.iterationTimeoutSec;
    const inactivityTimeoutSec = this.options.inactivityTimeoutSec;

    // Check iteration timeout
    if (iterationTimeoutSec && this.waveStartedAtMs) {
      const elapsedSec = (now - this.waveStartedAtMs) / 1000;
      if (elapsedSec > iterationTimeoutSec) {
        return { timedOut: true, type: 'iteration' };
      }
    }

    // Check inactivity timeout
    if (inactivityTimeoutSec && this.lastActivityAtMs) {
      const idleSec = (now - this.lastActivityAtMs) / 1000;
      if (idleSec > inactivityTimeoutSec) {
        return { timedOut: true, type: 'inactivity' };
      }
    }

    return { timedOut: false, type: null };
  }

  /**
   * Returns whether the wave was stopped due to timeout.
   */
  wasTimedOut(): boolean {
    return this.timedOut;
  }

  /**
   * Returns the type of timeout that occurred, if any.
   */
  getTimeoutType(): 'iteration' | 'inactivity' | null {
    return this.timeoutType;
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
    if (existingState) {
      // IMPORTANT: Use the persisted runId for sandbox paths when resuming across
      // run/server restarts. This ensures spec-check finds the worker state directories
      // created by the previous run. (§6.2.8 restart-safe resume)
      this.effectiveRunId = existingState.runId;

      if (existingState.activeWavePhase === 'implement_task') {
        const result = await this.resumeImplementWave(existingState);
        // Store implement wave result for combined progress entry
        if (result) {
          this.lastImplementWaveResult = result.waveResult;
        }
        return result;
      } else {
        // Phase mismatch: canonical phase is implement_task but parallel state says task_spec_check
        // Per §6.2.8 resume corruption handling: treat as state corruption, fix and warn
        await this.handleActiveWavePhaseMismatch(
          existingState,
          'implement_task',
          existingState.activeWavePhase,
        );
        // After fixing, resume as implement_task
        const fixedState: ParallelState = {
          ...existingState,
          activeWavePhase: 'implement_task',
        };
        await writeParallelState(this.options.canonicalStateDir, fixedState);
        const result = await this.resumeImplementWave(fixedState);
        if (result) {
          this.lastImplementWaveResult = result.waveResult;
        }
        return result;
      }
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
    const result = await this.executeWave(waveId, 'implement_task', taskIds, reservedStatusByTaskId);

    // Store implement wave result for combined progress entry
    this.lastImplementWaveResult = result.waveResult;

    return result;
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

    // IMPORTANT: Use the persisted runId for sandbox paths when resuming across
    // run/server restarts. This ensures spec-check finds the worker state directories
    // created by the previous run. (§6.2.8 restart-safe resume)
    this.effectiveRunId = state.runId;

    // Check for activeWavePhase mismatch per §6.2.8 resume corruption handling
    // If canonical phase is task_spec_check but parallel state says implement_task, warn and fix
    if (state.activeWavePhase !== 'task_spec_check') {
      // Phase mismatch: canonical phase is task_spec_check but parallel state says implement_task
      // Per §6.2.8 resume corruption handling: treat as state corruption, fix and warn
      await this.handleActiveWavePhaseMismatch(
        state,
        'task_spec_check',
        state.activeWavePhase,
      );
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
        branch: sandbox.branch,
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

    // Copy worker task-feedback.md to canonical for failed tasks (§6.2.5)
    for (const outcome of outcomes) {
      if (!outcome.taskPassed || outcome.taskFailed) {
        const sandbox = sandboxes.find((s) => s.taskId === outcome.taskId);
        if (sandbox) {
          const copied = await copyWorkerFeedbackToCanonical(
            this.options.canonicalStateDir,
            sandbox,
          );
          if (copied) {
            await this.options.appendLog(
              `[WORKER ${outcome.taskId}] Copied task feedback to canonical: ${copied}`,
            );
          }
        }
      }
    }

    // Write wave summary BEFORE merge so updateWaveSummaryWithMerge has something to update
    await writeWaveSummary(this.options.canonicalStateDir, this.effectiveRunId, waveResult);

    // Merge passed branches into canonical branch (§6.2.5)
    // Note: mergePassedBranchesAfterSpecCheck calls updateWaveSummaryWithMerge internally
    const mergeResult = await this.mergePassedBranchesAfterSpecCheck(waveId, sandboxes, outcomes);

    // Update canonical status flags AFTER merge (so it reflects merge failures in tasks.json)
    await updateCanonicalStatusFlags(this.options.canonicalStateDir, waveResult);

    // If merge conflict, write synthetic feedback and return with mergeConflict flag
    if (mergeResult.hasConflict && mergeResult.conflictTaskId) {
      // Write synthetic feedback for merge conflict (§6.2.5)
      await writeCanonicalFeedback(
        this.options.canonicalStateDir,
        mergeResult.conflictTaskId,
        'Merge conflict during branch integration',
        `The task passed spec-check but encountered a merge conflict when integrating ` +
        `into the canonical issue branch.\n\n` +
        `## Conflict Details\n` +
        `- Wave ID: ${waveId}\n` +
        `- Run ID: ${this.options.runId}\n` +
        `- Branch: issue/${this.options.issueNumber}-${mergeResult.conflictTaskId}\n\n` +
        `## Resolution Steps\n` +
        `1. Check the worker worktree for the conflicting changes\n` +
        `2. Manually resolve the conflict or adjust task file patterns to reduce overlap\n` +
        `3. Reset the task status to "pending" and retry\n\n` +
        `## Artifacts Location\n` +
        `- Worker state: ${this.options.canonicalStateDir}/.runs/${this.effectiveRunId}/workers/${mergeResult.conflictTaskId}/\n` +
        `- Wave summary: ${this.options.canonicalStateDir}/.runs/${this.effectiveRunId}/waves/${waveId}.json`,
      );

      // Write combined wave progress entry (implement + spec-check) even on conflict (§6.2.5)
      await appendWaveProgressEntry(
        this.options.canonicalStateDir,
        this.effectiveRunId,
        waveId,
        this.lastImplementWaveResult,
        waveResult,
        mergeResult,
      );
      this.lastImplementWaveResult = null;

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

    // Write combined wave progress entry (implement + spec-check) (§6.2.5)
    await appendWaveProgressEntry(
      this.options.canonicalStateDir,
      this.effectiveRunId,
      waveId,
      this.lastImplementWaveResult,
      waveResult,
      mergeResult,
    );
    // Clear stored implement result
    this.lastImplementWaveResult = null;

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

    // Initialize timeout tracking for this wave
    this.timedOut = false;
    this.timeoutType = null;
    this.waveStartedAtMs = Date.now();
    this.lastActivityAtMs = Date.now();

    // Create or reuse sandboxes based on phase
    // - implement_task: Create fresh sandboxes (may reset branch from canonical)
    // - task_spec_check: Reuse existing sandboxes from implement_task (DO NOT reset branch)
    try {
      for (const taskId of taskIds) {
        if (this.stopRequested) break;

        let sandbox: WorkerSandbox;

        if (phase === 'implement_task') {
          // For implement_task: create fresh sandbox
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

          // Use effectiveRunId for restart-safe resume (§6.2.8). When resuming after a
          // server restart, effectiveRunId is set to the persisted parallel state's runId.
          const result = await createWorkerSandbox({
            taskId,
            runId: this.effectiveRunId,
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
          sandbox = result.sandbox;
          await this.options.appendLog(`[WORKER ${taskId}] Sandbox created: ${sandbox.worktreeDir}`);
        } else {
          // For task_spec_check: reuse existing sandbox from implement_task
          // This ensures spec-check runs against the worker's implemented changes, not canonical
          // IMPORTANT: Use effectiveRunId for restart-safe resume (§6.2.8). When resuming after
          // a server restart, effectiveRunId is set to the persisted parallel state's runId,
          // ensuring we find the worker directories created by the previous run.
          sandbox = await reuseWorkerSandbox({
            taskId,
            runId: this.effectiveRunId,
            issueNumber: this.options.issueNumber,
            owner: this.options.owner,
            repo: this.options.repo,
            canonicalStateDir: this.options.canonicalStateDir,
            repoDir: this.options.repoDir,
            dataDir: this.options.dataDir,
            canonicalBranch: this.options.canonicalBranch,
          });
          await this.options.appendLog(`[WORKER ${taskId}] Sandbox reused for spec-check: ${sandbox.worktreeDir}`);
        }

        sandboxes.push(sandbox);
        this.recordActivity();
      }
    } catch (err) {
      // Rollback on sandbox creation failure
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
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
      // Build setup failure details for wave summary (§6.2.8 AC3)
      const setupFailureDetails = {
        ...failedWave,
        error: errMsg,
        errorStack: errStack,
        state: 'setup_failed',
        partialSetup: {
          createdSandboxes: sandboxes.map((s) => ({
            taskId: s.taskId,
            stateDir: s.stateDir,
            worktreeDir: s.worktreeDir,
            branch: s.branch,
          })),
          startedWorkers: [] as string[], // No workers started yet (sandbox creation phase)
        },
      };
      await writeWaveSummary(
        this.options.canonicalStateDir,
        this.effectiveRunId,
        setupFailureDetails as WaveResult & { error: string; state: string },
      );

      // Append progress entry for setup failure (§6.2.8 step 5, AC2)
      await this.appendSetupFailureProgressEntry(
        waveId,
        phase,
        taskIds,
        sandboxes,
        [] as string[], // No workers started yet (sandbox creation phase)
        errMsg,
        errStack,
      );

      return {
        waveResult: failedWave,
        continueExecution: false,
        error: `Sandbox creation failed: ${errMsg}`,
      };
    }

    // Phase 1: Spawn workers synchronously - this allows catching spawn failures
    // We spawn all workers first, tracking which ones started, before awaiting any of them.
    // This enables proper rollback if a spawn fails midway through.
    const startedWorkers: { sandbox: WorkerSandbox; worker: WorkerProcess }[] = [];
    try {
      for (const sandbox of sandboxes) {
        if (this.stopRequested) break;
        const worker = this.startWorkerProcess(sandbox, phase);
        startedWorkers.push({ sandbox, worker });
      }
    } catch (err) {
      // Worker spawn failed - handle rollback per §6.2.8 "Wave setup failure"
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      await this.options.appendLog(`[PARALLEL] Worker spawn failed: ${errMsg}`);

      const startedWorkerTaskIds = startedWorkers.map(sw => sw.sandbox.taskId);

      // Best-effort terminate any already-started workers
      for (const { sandbox, worker } of startedWorkers) {
        if (worker.proc && worker.proc.exitCode === null) {
          try {
            worker.proc.kill('SIGKILL');
            await this.options.appendLog(`[WORKER ${sandbox.taskId}] Terminated due to spawn failure`);
          } catch {
            // Ignore kill errors
          }
        }
        this.activeWorkers.delete(sandbox.taskId);
      }

      // Wait briefly for terminated processes to exit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Rollback task reservations
      await rollbackTaskReservations(this.options.canonicalStateDir, reservedStatusByTaskId);

      // Write failed wave summary with spawn failure details (§6.2.8 AC3)
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
      const setupFailureDetails = {
        ...failedWave,
        error: errMsg,
        errorStack: errStack,
        state: 'setup_failed',
        partialSetup: {
          createdSandboxes: sandboxes.map((s) => ({
            taskId: s.taskId,
            stateDir: s.stateDir,
            worktreeDir: s.worktreeDir,
            branch: s.branch,
          })),
          startedWorkers: startedWorkerTaskIds,
        },
      };
      await writeWaveSummary(
        this.options.canonicalStateDir,
        this.effectiveRunId,
        setupFailureDetails as WaveResult & { error: string; state: string },
      );

      // Append progress entry for spawn setup failure (§6.2.8 step 5, AC2)
      await this.appendSetupFailureProgressEntry(
        waveId,
        phase,
        taskIds,
        sandboxes,
        startedWorkerTaskIds,
        errMsg,
        errStack,
      );

      return {
        waveResult: failedWave,
        continueExecution: false,
        error: `Worker spawn failed: ${errMsg}`,
      };
    }

    // Phase 2: Create completion promises for all started workers
    const workerPromises = startedWorkers.map(({ sandbox, worker }) =>
      this.waitForWorkerCompletion(sandbox, worker, phase)
    );

    // Start timeout monitoring if timeouts are configured
    const hasTimeouts = this.options.iterationTimeoutSec || this.options.inactivityTimeoutSec;
    let timeoutCheckInterval: ReturnType<typeof setInterval> | null = null;

    if (hasTimeouts) {
      timeoutCheckInterval = setInterval(() => {
        const { timedOut, type } = this.checkTimeouts();
        if (timedOut && type && !this.timedOut) {
          const timeoutSec = type === 'iteration'
            ? this.options.iterationTimeoutSec
            : this.options.inactivityTimeoutSec;
          void this.options.appendLog(
            `[PARALLEL] Wave ${phase} timed out: ${type}_timeout (${timeoutSec}s)`,
          );
          this.terminateAllWorkersForTimeout(type);
        }
      }, 500); // Check every 500ms
    }

    // Wait for all workers to complete
    let outcomes: WorkerOutcome[];
    try {
      outcomes = await Promise.all(workerPromises);
    } finally {
      // Clear timeout check interval
      if (timeoutCheckInterval) {
        clearInterval(timeoutCheckInterval);
      }
    }

    // If wave timed out, mark all tasks as failed with timed_out status
    if (this.timedOut) {
      // Update outcomes for any workers that were running when timeout hit
      for (const outcome of outcomes) {
        const worker = this.activeWorkers.get(outcome.taskId);
        if (worker?.status === 'timed_out' || outcome.status === 'running') {
          outcome.status = 'timed_out';
          outcome.taskFailed = true;
          outcome.taskPassed = false;
        }
      }
    }

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
    await writeWaveSummary(this.options.canonicalStateDir, this.effectiveRunId, waveResult);

    // If this is spec_check phase, update canonical statuses and merge passed branches
    if (phase === 'task_spec_check') {
      // If wave timed out, handle cleanup per §6.2.8 "Timeout stop" (no merging)
      if (this.timedOut) {
        await this.handleSpecCheckWaveTimeout(waveId, outcomes);
        return {
          waveResult,
          continueExecution: false,
          timedOut: true,
          timeoutType: this.timeoutType ?? undefined,
        };
      }

      await updateCanonicalTaskStatuses(this.options.canonicalStateDir, outcomes);

      // Copy worker task-feedback.md to canonical for failed tasks (§6.2.5)
      for (const outcome of outcomes) {
        if (!outcome.taskPassed || outcome.taskFailed) {
          const sandbox = sandboxes.find((s) => s.taskId === outcome.taskId);
          if (sandbox) {
            const copied = await copyWorkerFeedbackToCanonical(
              this.options.canonicalStateDir,
              sandbox,
            );
            if (copied) {
              await this.options.appendLog(
                `[WORKER ${outcome.taskId}] Copied task feedback to canonical: ${copied}`,
              );
            }
          }
        }
      }

      // Merge passed branches into canonical branch (§6.2.5)
      const mergeResult = await this.mergePassedBranchesAfterSpecCheck(waveId, sandboxes, outcomes);

      // Update canonical status flags (reflecting both spec-check and merge outcomes)
      await updateCanonicalStatusFlags(this.options.canonicalStateDir, waveResult);

      // If merge conflict, write synthetic feedback and return with mergeConflict flag
      if (mergeResult.hasConflict && mergeResult.conflictTaskId) {
        // Write synthetic feedback for merge conflict (§6.2.5)
        await writeCanonicalFeedback(
          this.options.canonicalStateDir,
          mergeResult.conflictTaskId,
          'Merge conflict during branch integration',
          `The task passed spec-check but encountered a merge conflict when integrating ` +
          `into the canonical issue branch.\n\n` +
          `## Conflict Details\n` +
          `- Wave ID: ${waveId}\n` +
          `- Run ID: ${this.options.runId}\n` +
          `- Branch: issue/${this.options.issueNumber}-${mergeResult.conflictTaskId}\n\n` +
          `## Resolution Steps\n` +
          `1. Check the worker worktree for the conflicting changes\n` +
          `2. Manually resolve the conflict or adjust task file patterns to reduce overlap\n` +
          `3. Reset the task status to "pending" and retry\n\n` +
          `## Artifacts Location\n` +
          `- Worker state: ${this.options.canonicalStateDir}/.runs/${this.effectiveRunId}/workers/${mergeResult.conflictTaskId}/\n` +
          `- Wave summary: ${this.options.canonicalStateDir}/.runs/${this.effectiveRunId}/waves/${waveId}.json`,
        );

        // Write combined wave progress entry (implement + spec-check) even on conflict (§6.2.5)
        await appendWaveProgressEntry(
          this.options.canonicalStateDir,
          this.effectiveRunId,
          waveId,
          this.lastImplementWaveResult,
          waveResult,
          mergeResult,
        );
        this.lastImplementWaveResult = null;

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
      const timedOutCount = outcomes.filter((o) => o.status === 'timed_out').length;
      if (timedOutCount > 0) {
        await this.options.appendLog(
          `[PARALLEL] Wave ${phase} completed: ${passedCount}/${outcomes.length} passed, ${timedOutCount} timed out, ${mergeResult.mergedCount} merged`,
        );
      } else {
        await this.options.appendLog(
          `[PARALLEL] Wave ${phase} completed: ${passedCount}/${outcomes.length} passed, ${mergeResult.mergedCount} merged`,
        );
      }

      // Write combined wave progress entry (implement + spec-check) (§6.2.5)
      await appendWaveProgressEntry(
        this.options.canonicalStateDir,
        this.effectiveRunId,
        waveId,
        this.lastImplementWaveResult,
        waveResult,
        mergeResult,
      );
      this.lastImplementWaveResult = null;

      return {
        waveResult,
        continueExecution: !this.stopRequested && !this.timedOut,
        mergeResult,
        timedOut: this.timedOut,
        timeoutType: this.timeoutType ?? undefined,
      };
    }

    // For implement_task phase, count by exit code since taskPassed isn't set yet
    const passedCount = outcomes.filter((o) => o.status === 'passed' || o.exitCode === 0).length;
    const timedOutCount = outcomes.filter((o) => o.status === 'timed_out').length;
    if (timedOutCount > 0) {
      await this.options.appendLog(
        `[PARALLEL] Wave ${phase} completed: ${passedCount}/${outcomes.length} passed, ${timedOutCount} timed out`,
      );
    } else {
      await this.options.appendLog(
        `[PARALLEL] Wave ${phase} completed: ${passedCount}/${outcomes.length} passed`,
      );
    }

    // If wave timed out during implement_task, handle cleanup per §6.2.8 "Timeout stop"
    if (this.timedOut && phase === 'implement_task') {
      await this.handleImplementWaveTimeout(waveId, outcomes);
    }

    return {
      waveResult,
      continueExecution: !this.stopRequested && !this.timedOut,
      timedOut: this.timedOut,
      timeoutType: this.timeoutType ?? undefined,
    };
  }

  /**
   * Handles timeout during implement_task wave.
   *
   * Per §6.2.8 "Timeout stop":
   * - Mark all tasks in activeWaveTaskIds as status="failed"
   * - Write synthetic feedback for each timed-out task
   * - Clear issue.json.status.parallel
   * - Update canonical status flags (taskFailed=true, hasMoreTasks=true)
   */
  private async handleImplementWaveTimeout(
    waveId: string,
    outcomes: WorkerOutcome[],
  ): Promise<void> {
    const timeoutType = this.timeoutType ?? 'unknown';

    // 1. Mark all wave tasks as failed in canonical tasks.json
    const tasksPath = path.join(this.options.canonicalStateDir, 'tasks.json');
    try {
      const tasksRaw = await fs.readFile(tasksPath, 'utf-8');
      const tasksJson = JSON.parse(tasksRaw) as { tasks: { id: string; status: string }[] };

      for (const outcome of outcomes) {
        const task = tasksJson.tasks.find((t) => t.id === outcome.taskId);
        if (task) {
          task.status = 'failed';
        }
      }

      await writeJsonAtomic(tasksPath, tasksJson);
      await this.options.appendLog(
        `[PARALLEL] Marked ${outcomes.length} task(s) as failed due to timeout`,
      );
    } catch (err) {
      await this.options.appendLog(
        `[PARALLEL] Warning: Could not update tasks.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 2. Write synthetic feedback for ALL wave tasks (per §6.2.8 "Timeout stop")
    // Per design: "Mark all tasks in activeWaveTaskIds as status='failed' and write synthetic feedback"
    for (const outcome of outcomes) {
      const workerStatus = outcome.status === 'timed_out' ? 'terminated due to timeout' :
        outcome.status === 'passed' ? 'completed before wave timeout' :
        outcome.status === 'failed' ? 'failed before wave timeout' : 'interrupted by timeout';
      await writeCanonicalFeedback(
        this.options.canonicalStateDir,
        outcome.taskId,
        `Task affected by wave timeout during implement_task`,
        `The wave was terminated due to ${timeoutType}_timeout during the implement_task phase.\n\n` +
        `## Worker Status\n` +
        `- Status at timeout: ${workerStatus}\n` +
        `- Exit code: ${outcome.exitCode ?? 'N/A'}\n\n` +
        `## Wave Details\n` +
        `- Wave ID: ${waveId}\n` +
        `- Run ID: ${this.options.runId}\n` +
        `- Timeout Type: ${timeoutType}\n\n` +
        `## Artifacts Location\n` +
        `- Worker state: ${this.options.canonicalStateDir}/.runs/${this.effectiveRunId}/workers/${outcome.taskId}/\n\n` +
        `The task is eligible for retry in the next wave.`,
      );
      await this.options.appendLog(
        `[WORKER ${outcome.taskId}] Wrote synthetic timeout feedback`,
      );
    }

    // 3. Update canonical status flags (so workflow returns to implement_task for retries)
    const issueJson = await readIssueJson(this.options.canonicalStateDir);
    if (issueJson) {
      const status = (issueJson.status as Record<string, unknown>) ?? {};
      status.taskPassed = false;
      status.taskFailed = true;
      status.hasMoreTasks = true;
      status.allTasksComplete = false;

      // 4. Clear parallel state
      delete status.parallel;

      issueJson.status = status;
      await writeIssueJson(this.options.canonicalStateDir, issueJson);
      await this.options.appendLog(
        `[PARALLEL] Cleared parallel state and updated canonical status flags`,
      );
    }

    // 5. Write progress entry for timeout
    await this.appendTimeoutProgressEntry(waveId, 'implement_task', outcomes);
  }

  /**
   * Handles timeout during task_spec_check wave.
   *
   * Per §6.2.8 "Timeout stop":
   * - Mark all tasks in activeWaveTaskIds as status="failed" (regardless of individual outcomes)
   * - Write synthetic feedback for each wave task explaining the timeout
   * - Clear issue.json.status.parallel
   * - Update canonical status flags (taskFailed=true, hasMoreTasks=true)
   * - Skip merging (per design: timeout = failed, no integration)
   */
  private async handleSpecCheckWaveTimeout(
    waveId: string,
    outcomes: WorkerOutcome[],
  ): Promise<void> {
    const timeoutType = this.timeoutType ?? 'unknown';

    // 1. Mark ALL wave tasks as failed in canonical tasks.json (not based on individual outcomes)
    const tasksPath = path.join(this.options.canonicalStateDir, 'tasks.json');
    try {
      const tasksRaw = await fs.readFile(tasksPath, 'utf-8');
      const tasksJson = JSON.parse(tasksRaw) as { tasks: { id: string; status: string }[] };

      for (const outcome of outcomes) {
        const task = tasksJson.tasks.find((t) => t.id === outcome.taskId);
        if (task) {
          task.status = 'failed';
        }
      }

      await writeJsonAtomic(tasksPath, tasksJson);
      await this.options.appendLog(
        `[PARALLEL] Marked ${outcomes.length} task(s) as failed due to timeout`,
      );
    } catch (err) {
      await this.options.appendLog(
        `[PARALLEL] Warning: Could not update tasks.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 2. Write synthetic feedback for ALL wave tasks (per §6.2.8)
    for (const outcome of outcomes) {
      const workerStatus = outcome.status === 'timed_out' ? 'terminated due to timeout' :
        outcome.status === 'passed' ? 'completed before wave timeout' :
        outcome.status === 'failed' ? 'failed before wave timeout' : 'interrupted by timeout';
      const specCheckResult = outcome.taskPassed ? 'passed spec-check before timeout' :
        outcome.taskFailed ? 'failed spec-check before timeout' : 'spec-check interrupted by timeout';
      await writeCanonicalFeedback(
        this.options.canonicalStateDir,
        outcome.taskId,
        `Task affected by wave timeout during task_spec_check`,
        `The wave was terminated due to ${timeoutType}_timeout during the task_spec_check phase.\n\n` +
        `## Worker Status\n` +
        `- Status at timeout: ${workerStatus}\n` +
        `- Spec-check result: ${specCheckResult}\n` +
        `- Exit code: ${outcome.exitCode ?? 'N/A'}\n\n` +
        `## Wave Details\n` +
        `- Wave ID: ${waveId}\n` +
        `- Run ID: ${this.options.runId}\n` +
        `- Timeout Type: ${timeoutType}\n\n` +
        `## Note\n` +
        `Because the wave timed out, no branches were merged. The task is marked as failed ` +
        `and is eligible for retry in the next wave.\n\n` +
        `## Artifacts Location\n` +
        `- Worker state: ${this.options.canonicalStateDir}/.runs/${this.effectiveRunId}/workers/${outcome.taskId}/\n`,
      );
      await this.options.appendLog(
        `[WORKER ${outcome.taskId}] Wrote synthetic timeout feedback`,
      );
    }

    // 3. Update canonical status flags (so workflow returns to implement_task for retries)
    const issueJson = await readIssueJson(this.options.canonicalStateDir);
    if (issueJson) {
      const status = (issueJson.status as Record<string, unknown>) ?? {};
      status.taskPassed = false;
      status.taskFailed = true;
      status.hasMoreTasks = true;
      status.allTasksComplete = false;

      // 4. Clear parallel state
      delete status.parallel;

      issueJson.status = status;
      await writeIssueJson(this.options.canonicalStateDir, issueJson);
      await this.options.appendLog(
        `[PARALLEL] Cleared parallel state and updated canonical status flags`,
      );
    }

    // 5. Write combined wave progress entry for timeout
    await this.appendTimeoutProgressEntry(waveId, 'task_spec_check', outcomes);
  }

  /**
   * Appends a progress entry for wave timeout.
   */
  private async appendTimeoutProgressEntry(
    waveId: string,
    phase: WorkerPhase,
    outcomes: WorkerOutcome[],
  ): Promise<void> {
    const progressPath = path.join(this.options.canonicalStateDir, 'progress.txt');
    const timeoutType = this.timeoutType ?? 'unknown';
    const progressEntry = `\n## [${nowIso()}] - Parallel Wave Timeout\n\n` +
      `### Wave\n` +
      `- Wave ID: ${waveId}\n` +
      `- Phase: ${phase}\n` +
      `- Tasks: ${outcomes.map((o) => o.taskId).join(', ')}\n` +
      `- Timeout Type: ${timeoutType}\n\n` +
      `### Worker Statuses at Timeout\n` +
      outcomes.map((o) => `- ${o.taskId}: ${o.status} (exit code: ${o.exitCode ?? 'N/A'})`).join('\n') + '\n\n' +
      `### Action\n` +
      `- All wave tasks marked as failed\n` +
      `- Synthetic feedback written for each task\n` +
      `- Parallel state cleared from issue.json\n` +
      `- No branches merged (due to timeout)\n` +
      `- Run ended as failed (eligible for retry)\n\n` +
      `---\n`;
    await fs.appendFile(progressPath, progressEntry, 'utf-8').catch(() => void 0);
  }

  /**
   * Appends a progress entry for wave setup failure (§6.2.8 step 5).
   *
   * Per design §6.2.8 "Wave setup failure", step 5:
   * - Append a progress entry describing the setup failure, rollback, and artifact location
   *
   * Handles both sandbox creation failures and worker spawn failures.
   */
  private async appendSetupFailureProgressEntry(
    waveId: string,
    phase: WorkerPhase,
    taskIds: string[],
    createdSandboxes: WorkerSandbox[],
    startedWorkerTaskIds: string[],
    errorMessage: string,
    errorStack?: string,
  ): Promise<void> {
    const progressPath = path.join(this.options.canonicalStateDir, 'progress.txt');
    const failureStage = startedWorkerTaskIds.length > 0
      ? 'worker spawn'
      : 'sandbox creation';
    const progressEntry = `\n## [${nowIso()}] - Parallel Wave Setup Failure\n\n` +
      `### Wave\n` +
      `- Wave ID: ${waveId}\n` +
      `- Phase: ${phase}\n` +
      `- Selected Tasks: ${taskIds.join(', ')}\n\n` +
      `### Error\n` +
      `\`\`\`\n${errorMessage}\n\`\`\`\n\n` +
      (errorStack
        ? `### Stack Trace\n\`\`\`\n${errorStack}\n\`\`\`\n\n`
        : '') +
      `### Partial Setup State\n` +
      `- Sandboxes created: ${createdSandboxes.length}/${taskIds.length}\n` +
      (createdSandboxes.length > 0
        ? `- Created sandbox tasks: ${createdSandboxes.map((s) => s.taskId).join(', ')}\n`
        : '') +
      `- Worker processes started: ${startedWorkerTaskIds.length}/${taskIds.length}` +
      (startedWorkerTaskIds.length === 0
        ? ` (failure occurred during ${failureStage})\n`
        : `\n`) +
      (startedWorkerTaskIds.length > 0
        ? `- Started worker tasks: ${startedWorkerTaskIds.join(', ')}\n` +
          `- Started workers terminated: best-effort SIGKILL sent\n`
        : '') +
      `\n### Rollback Action\n` +
      `- Task statuses restored to pre-reservation values via reservedStatusByTaskId\n` +
      `- Parallel state cleared from issue.json\n` +
      `- No taskFailed/taskPassed flags updated (setup failure ≠ task failure)\n\n` +
      `### Artifacts\n` +
      `- Wave summary: ${this.options.canonicalStateDir}/.runs/${this.effectiveRunId}/waves/${waveId}.json\n\n` +
      `---\n`;
    await fs.appendFile(progressPath, progressEntry, 'utf-8').catch(() => void 0);
  }

  /**
   * Handles activeWavePhase mismatch by appending a warning to progress.txt.
   *
   * Per §6.2.8 resume corruption handling:
   * - If canonical phase doesn't match status.parallel.activeWavePhase, treat as state corruption
   * - Fix activeWavePhase to match the canonical phase
   * - Append a warning to progress.txt
   */
  private async handleActiveWavePhaseMismatch(
    state: ParallelState,
    canonicalPhase: WorkerPhase,
    parallelStatePhase: WorkerPhase,
  ): Promise<void> {
    const progressPath = path.join(this.options.canonicalStateDir, 'progress.txt');
    const warningEntry = `\n## [${nowIso()}] - Parallel State Corruption Warning\n\n` +
      `### Mismatch Detected\n` +
      `- Canonical issue.json.phase: ${canonicalPhase}\n` +
      `- status.parallel.activeWavePhase: ${parallelStatePhase}\n` +
      `- Wave ID: ${state.activeWaveId}\n` +
      `- Active tasks: ${state.activeWaveTaskIds.join(', ')}\n\n` +
      `### Recovery Action\n` +
      `Per §6.2.8 resume corruption handling, treating as state corruption:\n` +
      `- activeWavePhase corrected from "${parallelStatePhase}" to "${canonicalPhase}"\n` +
      `- Resuming wave execution with corrected phase\n\n` +
      `### Context\n` +
      `This mismatch can occur if the orchestrator crashed between updating issue.json.phase ` +
      `and status.parallel.activeWavePhase, or if external tooling modified the state files.\n\n` +
      `---\n`;
    await fs.appendFile(progressPath, warningEntry, 'utf-8').catch(() => void 0);
    await this.options.appendLog(
      `[PARALLEL] Warning: activeWavePhase mismatch (${parallelStatePhase} vs ${canonicalPhase}), correcting`,
    );
  }

  /**
   * Starts a worker process synchronously (spawns the process, sets up tracking).
   * This method is synchronous so spawn failures can be caught with try/catch.
   *
   * @throws {Error} if spawn fails
   */
  private startWorkerProcess(sandbox: WorkerSandbox, phase: WorkerPhase): WorkerProcess {
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

    // Log synchronously (fire-and-forget) to avoid making this method async
    void this.options.appendLog(`[WORKER ${taskId}][${phase}] Starting...`);

    // This spawn call can throw synchronously - that's the key behavior we need
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

    // Handle stdout/stderr with taskId prefix and record activity for inactivity timeout
    proc.stdout.on('data', (chunk) => {
      this.recordActivity();
      const lines = String(chunk).trimEnd().split('\n');
      for (const line of lines) {
        void this.options.appendLog(`[WORKER ${taskId}][STDOUT] ${line}`);
      }
    });
    proc.stderr.on('data', (chunk) => {
      this.recordActivity();
      const lines = String(chunk).trimEnd().split('\n');
      for (const line of lines) {
        void this.options.appendLog(`[WORKER ${taskId}][STDERR] ${line}`);
      }
    });

    return worker;
  }

  /**
   * Waits for a worker process to complete and returns the outcome.
   * This is the async part of worker execution, separated from spawn for error handling.
   */
  private async waitForWorkerCompletion(
    sandbox: WorkerSandbox,
    worker: WorkerProcess,
    phase: WorkerPhase,
  ): Promise<WorkerOutcome> {
    const taskId = sandbox.taskId;
    const proc = worker.proc;

    if (!proc) {
      // Worker was never properly started
      return {
        taskId,
        phase,
        status: 'failed',
        exitCode: -1,
        taskPassed: false,
        taskFailed: true,
        startedAt: worker.startedAt,
        endedAt: nowIso(),
        branch: sandbox.branch,
      };
    }

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
    // Check if this worker was terminated due to timeout
    if (worker.status === 'timed_out' || this.timedOut) {
      status = 'timed_out';
    } else if (phase === 'implement_task') {
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
      startedAt: worker.startedAt,
      endedAt,
      branch: sandbox.branch,
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

    // Update wave summary with merge results
    await updateWaveSummaryWithMerge(
      this.options.canonicalStateDir,
      this.effectiveRunId,
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
 * Handles canonical state cleanup on wave timeout.
 *
 * Per §6.2.8 "Timeout stop" of the design:
 * - Terminate all worker processes
 * - Mark all tasks in activeWaveTaskIds as status="failed"
 * - Write synthetic feedback explaining the timeout type and wave phase
 * - Clear issue.json.status.parallel
 * - End the run as failed (so the workflow returns to implement_task for retries)
 */
export async function handleWaveTimeoutCleanup(
  stateDir: string,
  timeoutType: 'iteration' | 'inactivity' | string,
  wavePhase: WorkerPhase,
  runId?: string,
): Promise<{ tasksMarkedFailed: string[]; feedbackFilesWritten: string[] }> {
  const result = {
    tasksMarkedFailed: [] as string[],
    feedbackFilesWritten: [] as string[],
  };

  // Read the current parallel state to get activeWaveTaskIds
  const parallelState = await readParallelState(stateDir);
  if (!parallelState) {
    return result;
  }

  const { activeWaveTaskIds, activeWaveId } = parallelState;

  // 1. Mark all activeWaveTaskIds as failed in canonical tasks.json
  // Per §6.2.8: ALL wave tasks should be marked failed on timeout, regardless of their individual outcomes
  const tasksPath = path.join(stateDir, 'tasks.json');
  try {
    const tasksRaw = await fs.readFile(tasksPath, 'utf-8');
    const tasksJson = JSON.parse(tasksRaw) as { tasks: { id: string; status: string }[] };

    for (const task of tasksJson.tasks) {
      if (activeWaveTaskIds.includes(task.id)) {
        task.status = 'failed';
        result.tasksMarkedFailed.push(task.id);
      }
    }

    await writeJsonAtomic(tasksPath, tasksJson);
  } catch {
    // If we can't read/write tasks.json, continue with cleanup
  }

  // 2. Write synthetic feedback for each timed-out task
  for (const taskId of activeWaveTaskIds) {
    const feedbackPath = await writeCanonicalFeedback(
      stateDir,
      taskId,
      `Task timed out during ${wavePhase}`,
      `The task was terminated due to ${timeoutType}_timeout during the ${wavePhase} phase.\n\n` +
      `## Wave Details\n` +
      `- Wave ID: ${activeWaveId}\n` +
      `- Run ID: ${runId ?? 'unknown'}\n` +
      `- Timeout Type: ${timeoutType}\n\n` +
      `## Artifacts Location\n` +
      `- Worker state: ${stateDir}/.runs/${runId ?? 'unknown'}/workers/${taskId}/\n\n` +
      `The task is eligible for retry in the next wave.`,
    );
    result.feedbackFilesWritten.push(feedbackPath);
  }

  // 3. Update canonical status flags to indicate failure (workflow can retry)
  const issueJson = await readIssueJson(stateDir);
  if (issueJson) {
    const status = (issueJson.status as Record<string, unknown>) ?? {};
    status.taskPassed = false;
    status.taskFailed = true;
    status.hasMoreTasks = true;
    status.allTasksComplete = false;

    // 4. Clear parallel state
    delete status.parallel;

    issueJson.status = status;
    await writeIssueJson(stateDir, issueJson);
  }

  // 5. Append progress entry
  const progressPath = path.join(stateDir, 'progress.txt');
  const progressEntry = `\n## [${nowIso()}] - Parallel Wave Timeout\n\n` +
    `### Wave\n` +
    `- Wave ID: ${activeWaveId}\n` +
    `- Phase: ${wavePhase}\n` +
    `- Tasks: ${activeWaveTaskIds.join(', ')}\n` +
    `- Timeout Type: ${timeoutType}\n\n` +
    `### Action\n` +
    `- All wave tasks marked as failed\n` +
    `- Synthetic feedback written for each task\n` +
    `- Parallel state cleared from issue.json\n` +
    `- Run ended as failed (eligible for retry)\n\n` +
    `---\n`;
  await fs.appendFile(progressPath, progressEntry, 'utf-8').catch(() => void 0);

  return result;
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
