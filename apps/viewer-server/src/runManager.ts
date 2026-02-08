import { execFile as execFileCb, spawn as spawnDefault, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WorkflowEngine, getIssueStateDir, getWorktreePath, loadWorkflowByName, parseIssueRef, getEffectiveModel, validModels, type ModelId } from '@jeeves/core';

function isValidModel(model: unknown): model is ModelId {
  return typeof model === 'string' && validModels.includes(model as ModelId);
}

import type { RunStatus } from './types.js';
import { ensureJeevesExcludedFromGitStatus } from './gitExclude.js';
import { readIssueJson, writeIssueJson } from './issueJson.js';
import { writeJsonAtomic } from './jsonAtomic.js';
import { expandTasksFilesAllowedForTests } from './tasksJson.js';
import {
  ParallelRunner,
  isParallelModeEnabled,
  getMaxParallelTasks,
  validateMaxParallelTasks,
  MAX_PARALLEL_TASKS,
  readParallelState,
  rollbackTaskReservations,
  repairOrphanedInProgressTasks,
  type ParallelRunnerOptions,
} from './parallelRunner.js';
import type { WorkerStatusInfo } from './types.js';
import {
  getWorkerSandboxPaths,
  getImplementDoneMarkerPath,
  hasCompletionMarker,
} from './workerSandbox.js';
import { decideQuickFixRouting } from './quickFixRouter.js';
import { terminateProcess } from './processTermination.js';

function nowIso(): string {
  return new Date().toISOString();
}

function makeRunId(pid: number = process.pid): string {
  // 20260202T033802Z-12345.ABC123
  const iso = nowIso(); // 2026-02-02T03:38:02.153Z
  const compact = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // 20260202T033802Z
  const rand = randomBytes(6).toString('base64url'); // url-safe
  return `${compact}-${pid}.${rand}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCompletionPromise(content: string): boolean {
  return content.trim() === '<promise>COMPLETE</promise>';
}

function getIssueNumber(issueJson: Record<string, unknown> | null): number | null {
  if (!issueJson) return null;
  const issue = issueJson.issue;
  if (!issue || typeof issue !== 'object') return null;
  const n = (issue as { number?: unknown }).number;
  if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n;
  return null;
}

function inferDesignDocPath(issueJson: Record<string, unknown> | null): string | null {
  if (!issueJson) return null;
  const direct = issueJson.designDocPath ?? issueJson.designDoc;
  if (isNonEmptyString(direct)) return direct.trim();
  const issueNumber = getIssueNumber(issueJson);
  if (issueNumber) return `docs/issue-${issueNumber}-design.md`;
  return null;
}

function normalizeRepoRelativePath(input: string): string {
  // Treat as repo-relative path. Normalize separators and forbid escaping the repo.
  const withSlashes = input.replace(/\\/g, '/').trim();
  if (!withSlashes) throw new Error('Refusing empty path');
  const normalized = path.posix.normalize(withSlashes);
  if (normalized === '.') throw new Error(`Refusing path that resolves to repo root: ${input}`);
  if (path.posix.isAbsolute(normalized)) throw new Error(`Refusing absolute path: ${input}`);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`Refusing path traversal: ${input}`);
  return normalized;
}

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

async function pathExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

function mapProvider(value: unknown): 'claude' | 'fake' | 'codex' {
  if (!isNonEmptyString(value)) return 'claude';
  const v = value.trim().toLowerCase();
  if (v === 'fake') return 'fake';
  if (v === 'claude' || v === 'claude-agent-sdk' || v === 'claude_agent_sdk') return 'claude';
  if (v === 'codex' || v === 'codex-sdk' || v === 'codex_sdk' || v === 'openai' || v === 'openai-codex') return 'codex';
  throw new Error(`Invalid provider '${value}'. Valid providers: claude, codex, fake`);
}

function validateQuick(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  throw new Error('Invalid quick: must be boolean');
}

const PHASE_REPORT_FILE = 'phase-report.json';

const TRANSITION_STATUS_FIELDS = [
  'designApproved',
  'designNeedsChanges',
  'taskPassed',
  'taskFailed',
  'hasMoreTasks',
  'allTasksComplete',
  'reviewClean',
  'reviewNeedsChanges',
  'preCheckPassed',
  'preCheckFailed',
  'implementationComplete',
  'missingWork',
  'needsDesign',
  'handoffComplete',
  'prCreated',
  'commitFailed',
  'pushFailed',
] as const;

type TransitionStatusField = (typeof TRANSITION_STATUS_FIELDS)[number];
type TransitionStatusUpdates = Partial<Record<TransitionStatusField, boolean>>;

const PHASE_ALLOWED_STATUS_UPDATES: Record<string, readonly TransitionStatusField[]> = {
  design_review: ['designApproved', 'designNeedsChanges'],
  design_edit: ['designNeedsChanges'],
  task_spec_check: ['taskPassed', 'taskFailed', 'hasMoreTasks', 'allTasksComplete'],
  implement_task: ['commitFailed', 'pushFailed'],
  code_review: ['reviewClean', 'reviewNeedsChanges'],
  code_fix: ['reviewNeedsChanges'],
  pre_implementation_check: ['preCheckPassed', 'preCheckFailed'],
  completeness_verification: ['implementationComplete', 'missingWork', 'allTasksComplete'],
  quick_fix: ['implementationComplete', 'needsDesign'],
  design_handoff: ['handoffComplete', 'needsDesign'],
  prepare_pr: ['prCreated'],
  fix_ci: ['commitFailed', 'pushFailed'],
};

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function getStatusRecord(issueJson: Record<string, unknown>): Record<string, unknown> {
  const status = issueJson.status;
  if (isPlainRecord(status)) return status;
  const next: Record<string, unknown> = {};
  issueJson.status = next;
  return next;
}

function copyStatusFieldFromSource(params: {
  target: Record<string, unknown>;
  source: Record<string, unknown>;
  key: TransitionStatusField;
}): void {
  const { target, source, key } = params;
  if (hasOwn(source, key)) target[key] = source[key];
  else delete target[key];
}

function extractBooleanStatusUpdates(
  statusLike: unknown,
  allowedKeys?: ReadonlySet<TransitionStatusField>,
): TransitionStatusUpdates {
  if (!isPlainRecord(statusLike)) return {};
  const out: TransitionStatusUpdates = {};
  for (const key of TRANSITION_STATUS_FIELDS) {
    if (allowedKeys && !allowedKeys.has(key)) continue;
    const value = statusLike[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function inferStatusUpdatesFromIssueDiff(params: {
  beforeIssue: Record<string, unknown>;
  afterIssue: Record<string, unknown>;
}): TransitionStatusUpdates {
  const beforeStatus = isPlainRecord(params.beforeIssue.status) ? params.beforeIssue.status : {};
  const afterStatus = isPlainRecord(params.afterIssue.status) ? params.afterIssue.status : {};
  const out: TransitionStatusUpdates = {};
  for (const key of TRANSITION_STATUS_FIELDS) {
    const beforeVal = beforeStatus[key];
    const afterVal = afterStatus[key];
    if (typeof afterVal === 'boolean' && afterVal !== beforeVal) out[key] = afterVal;
  }
  return out;
}

function normalizePhaseStatusUpdates(
  phase: string,
  updates: TransitionStatusUpdates,
): TransitionStatusUpdates {
  const next: TransitionStatusUpdates = { ...updates };

  if (phase === 'design_review') {
    if (next.designApproved === true) next.designNeedsChanges = false;
    if (next.designNeedsChanges === true) next.designApproved = false;
  }

  if (phase === 'code_review') {
    if (next.reviewClean === true) next.reviewNeedsChanges = false;
    if (next.reviewNeedsChanges === true) next.reviewClean = false;
  }

  if (phase === 'pre_implementation_check') {
    if (next.preCheckPassed === true) next.preCheckFailed = false;
    if (next.preCheckFailed === true) next.preCheckPassed = false;
  }

  if (phase === 'task_spec_check') {
    if (next.taskFailed === true) {
      next.taskPassed = false;
      next.hasMoreTasks = true;
      next.allTasksComplete = false;
    }
    if (next.allTasksComplete === true) {
      next.taskPassed = true;
      next.taskFailed = false;
      next.hasMoreTasks = false;
    }
    if (next.taskPassed === true && next.hasMoreTasks === true) {
      next.taskFailed = false;
      next.allTasksComplete = false;
    }
  }

  if (phase === 'completeness_verification') {
    if (next.implementationComplete === true) next.missingWork = false;
    if (next.missingWork === true) {
      next.implementationComplete = false;
      next.allTasksComplete = false;
    }
  }

  if (phase === 'quick_fix') {
    if (next.implementationComplete === true) next.needsDesign = false;
    if (next.needsDesign === true) next.implementationComplete = false;
  }

  if (phase === 'design_handoff') {
    if (next.handoffComplete === true) next.needsDesign = true;
  }

  if (phase === 'fix_ci') {
    if (next.commitFailed === false) next.pushFailed = false;
    if (next.pushFailed === false) next.commitFailed = false;
  }

  return next;
}

export class RunManager {
  private readonly promptsDir: string;
  private readonly workflowsDir: string;
  private readonly repoRoot: string;
  private readonly dataDir: string;
  private readonly broadcast: (event: string, data: unknown) => void;
  private readonly spawnImpl: typeof spawnDefault;

  private issueRef: string | null = null;
  private stateDir: string | null = null;
  private workDir: string | null = null;
  private runId: string | null = null;
  private runDir: string | null = null;
  private stopReason: string | null = null;
  private runArchiveMeta: Record<string, unknown> | null = null;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private stopRequested = false;
  private activeParallelRunner: ParallelRunner | null = null;
  private maxParallelTasksOverride: number | null = null;
  /** Tracks the effective max parallel tasks (override or issue setting) for status reporting */
  private effectiveMaxParallelTasks: number | null = null;

  private status: RunStatus = {
    running: false,
    pid: null,
    started_at: null,
    ended_at: null,
    returncode: null,
    command: null,
    max_iterations: 10,
    current_iteration: 0,
    completed_via_promise: false,
    completed_via_state: false,
    completion_reason: null,
    last_error: null,
    issue_ref: null,
    viewer_log_file: null,
  };

  constructor(params: {
    promptsDir: string;
    workflowsDir: string;
    repoRoot: string;
    dataDir: string;
    broadcast: (event: string, data: unknown) => void;
    spawn?: typeof spawnDefault;
  }) {
    this.promptsDir = params.promptsDir;
    this.workflowsDir = params.workflowsDir;
    this.repoRoot = params.repoRoot;
    this.dataDir = params.dataDir;
    this.broadcast = params.broadcast;
    this.spawnImpl = params.spawn ?? spawnDefault;
  }

  getIssue(): { issueRef: string | null; stateDir: string | null; workDir: string | null } {
    return { issueRef: this.issueRef, stateDir: this.stateDir, workDir: this.workDir };
  }

  getStatus(): RunStatus {
    // Include active workers if parallel execution is active
    const workers = this.activeParallelRunner?.getActiveWorkers() ?? null;
    const workerStatusInfo: WorkerStatusInfo[] | null = workers && workers.length > 0
      ? workers.map((w) => ({
          taskId: w.taskId,
          phase: w.phase,
          pid: w.pid,
          started_at: w.startedAt,
          ended_at: w.endedAt,
          returncode: w.returncode,
          status: w.status,
        }))
      : null;

    return {
      ...this.status,
      workers: workerStatusInfo,
      // Return the effective max_parallel_tasks (override if provided, otherwise issue setting)
      // This reflects the actual value being used, not just the API override
      max_parallel_tasks: this.effectiveMaxParallelTasks ?? this.maxParallelTasksOverride,
    };
  }

  async setIssue(issueRef: string): Promise<void> {
    const parsed = parseIssueRef(issueRef);
    const stateDir = getIssueStateDir(parsed.owner, parsed.repo, parsed.issueNumber, this.dataDir);
    const issueFile = path.join(stateDir, 'issue.json');
    if (!(await pathExists(issueFile))) {
      throw new Error(`issue.json not found for ${issueRef} at ${stateDir}`);
    }
    const workDir = getWorktreePath(parsed.owner, parsed.repo, parsed.issueNumber, this.dataDir);
    this.issueRef = `${parsed.owner}/${parsed.repo}#${parsed.issueNumber}`;
    this.stateDir = stateDir;
    this.workDir = workDir;

    this.status = {
      ...this.status,
      issue_ref: this.issueRef,
      viewer_log_file: path.join(stateDir, 'viewer-run.log'),
    };
    this.broadcast('state', await this.getStateSnapshot());
  }

  async start(params: {
    provider?: unknown;
    workflow?: unknown;
    quick?: unknown;
    max_iterations?: unknown;
    inactivity_timeout_sec?: unknown;
    iteration_timeout_sec?: unknown;
    max_parallel_tasks?: unknown;
  }): Promise<RunStatus> {
    if (this.status.running) throw new Error('Jeeves is already running');
    if (!this.issueRef || !this.stateDir || !this.workDir) throw new Error('No issue selected. Use /api/issues/select or /api/init/issue.');
    if (!(await pathExists(this.workDir))) {
      throw new Error(`Worktree not found at ${this.workDir}. Run init first.`);
    }
    await ensureJeevesExcludedFromGitStatus(this.workDir).catch(() => void 0);

    // Validate max_parallel_tasks if provided
    if (params.max_parallel_tasks !== undefined && params.max_parallel_tasks !== null) {
      const validatedMaxParallel = validateMaxParallelTasks(params.max_parallel_tasks);
      if (validatedMaxParallel === null) {
        throw new Error(`Invalid max_parallel_tasks: must be an integer between 1 and ${MAX_PARALLEL_TASKS}`);
      }
      this.maxParallelTasksOverride = validatedMaxParallel;
    } else {
      this.maxParallelTasksOverride = null;
    }

    const provider = mapProvider(params.provider);
    const quick = validateQuick(params.quick) ?? false;
    const maxIterations = Number.isFinite(Number(params.max_iterations)) ? Math.max(1, Number(params.max_iterations)) : 10;
    const inactivityTimeoutSec = Number.isFinite(Number(params.inactivity_timeout_sec)) ? Math.max(1, Number(params.inactivity_timeout_sec)) : 600;
    const iterationTimeoutSec = Number.isFinite(Number(params.iteration_timeout_sec)) ? Math.max(1, Number(params.iteration_timeout_sec)) : 3600;

    const viewerLogPath = path.join(this.stateDir, 'viewer-run.log');
    await fs.mkdir(path.dirname(viewerLogPath), { recursive: true });
    await fs.writeFile(viewerLogPath, '', 'utf-8');

    this.stopRequested = false;
    this.stopReason = null;
    this.runArchiveMeta = null;
    // Reset effectiveMaxParallelTasks to avoid carrying stale values across runs
    this.effectiveMaxParallelTasks = null;
    this.runId = makeRunId();
    this.runDir = path.join(this.stateDir, '.runs', this.runId);
    await fs.mkdir(path.join(this.runDir, 'iterations'), { recursive: true });

    const startedAt = nowIso();
    this.status = {
      run_id: this.runId,
      run_dir: this.runDir,
      running: true,
      pid: null,
      started_at: startedAt,
      ended_at: null,
      returncode: null,
      command: null,
      max_iterations: maxIterations,
      current_iteration: 0,
      completed_via_promise: false,
      completed_via_state: false,
      completion_reason: null,
      last_error: null,
      issue_ref: this.issueRef,
      viewer_log_file: viewerLogPath,
    };

    const workflowOverride = isNonEmptyString(params.workflow) ? params.workflow.trim() : null;

    await this.persistRunArchiveMeta({
      run_id: this.runId,
      issue_ref: this.issueRef,
      state_dir: this.stateDir,
      work_dir: this.workDir,
      started_at: startedAt,
      max_iterations: maxIterations,
      provider,
      workflow_override: workflowOverride,
      inactivity_timeout_sec: inactivityTimeoutSec,
      iteration_timeout_sec: iterationTimeoutSec,
    });

    this.broadcast('run', { run: this.getStatus() });
    void this.runLoop({
      provider,
      maxIterations,
      inactivityTimeoutSec,
      iterationTimeoutSec,
      workflowOverride,
      quick,
      viewerLogPath,
    });

    return this.getStatus();
  }

  async stop(params?: { force?: boolean; reason?: string }): Promise<RunStatus> {
    const force = Boolean(params?.force ?? false);
    if (isNonEmptyString(params?.reason)) this.stopReason = params?.reason.trim();
    this.stopRequested = true;
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      terminateProcess(proc, force ? 'SIGKILL' : 'SIGTERM');
    }
    // Also stop parallel runner if active
    if (this.activeParallelRunner) {
      this.activeParallelRunner.requestStop();
    }

    // Per §6.2.8: On manual stop during an active wave, roll back reserved task statuses
    if (this.stateDir) {
      await this.rollbackActiveWaveOnStop().catch(() => void 0);
    }

    return this.getStatus();
  }

  /**
   * Rolls back reserved task statuses on manual stop per §6.2.8.
   *
   * Per design doc §6.2.8 "Orchestration recovery / restart safety":
   * - Stop mid-implement wave: roll back task statuses, clear parallel state
   * - Stop between implement/spec-check waves: preserve parallel state for resume
   *
   * Detection: If all tasks in activeWaveTaskIds have implement_task.done markers,
   * the stop is "between phases" and we should preserve parallel state to allow
   * the next run to resume with spec-check (no reselection).
   */
  private async rollbackActiveWaveOnStop(): Promise<void> {
    if (!this.stateDir || !this.dataDir) return;

    const parallelState = await readParallelState(this.stateDir);
    if (!parallelState) return;

    // Check if we're "between phases": all implement_task.done markers exist
    // If so, preserve parallel state so next run can resume spec-check
    const issueJson = await readIssueJson(this.stateDir);
    if (!issueJson) return;

    const parsed = this.issueRef ? parseIssueRef(this.issueRef) : null;
    if (!parsed) return;

    // Check if all tasks have completed implement_task
    let allImplementDone = true;
    for (const taskId of parallelState.activeWaveTaskIds) {
      const sandbox = getWorkerSandboxPaths({
        taskId,
        runId: parallelState.runId,
        issueNumber: parsed.issueNumber,
        owner: parsed.owner,
        repo: parsed.repo,
        canonicalStateDir: this.stateDir,
        repoDir: path.join(this.dataDir, 'repos', parsed.owner, parsed.repo),
        dataDir: this.dataDir,
        canonicalBranch: typeof issueJson.branch === 'string' ? issueJson.branch : `issue/${parsed.issueNumber}`,
      });
      const markerPath = getImplementDoneMarkerPath(sandbox);
      const done = await hasCompletionMarker(markerPath);
      if (!done) {
        allImplementDone = false;
        break;
      }
    }

    // If stopped between implement/spec-check (all markers exist), preserve parallel state
    if (allImplementDone && parallelState.activeWavePhase === 'implement_task') {
      // Append progress entry noting preservation
      const progressPath = path.join(this.stateDir, 'progress.txt');
      const progressEntry = `\n## [${nowIso()}] - Manual Stop: Between Implement/Spec-Check\n\n` +
        `### Wave\n` +
        `- Wave ID: ${parallelState.activeWaveId}\n` +
        `- Phase: ${parallelState.activeWavePhase}\n` +
        `- Tasks: ${parallelState.activeWaveTaskIds.join(', ')}\n\n` +
        `### Action\n` +
        `- All implement_task.done markers present; wave is between phases\n` +
        `- Parallel state preserved for spec-check resume\n` +
        `- Task statuses NOT rolled back (remain in_progress)\n` +
        `- Worker artifacts retained at STATE/.runs/${parallelState.runId}/workers/\n\n` +
        `---\n`;
      await fs.appendFile(progressPath, progressEntry, 'utf-8').catch(() => void 0);

      if (this.status.viewer_log_file) {
        await this.appendViewerLog(
          this.status.viewer_log_file,
          `[STOP] Preserved parallel state for spec-check resume (all ${parallelState.activeWaveTaskIds.length} implement_task.done markers present)`,
        );
      }
      return;
    }

    // Mid-phase stop: roll back task reservations and clear parallel state
    await rollbackTaskReservations(this.stateDir, parallelState.reservedStatusByTaskId);

    // Append progress entry
    const progressPath = path.join(this.stateDir, 'progress.txt');
    const progressEntry = `\n## [${nowIso()}] - Manual Stop: Parallel Wave Aborted\n\n` +
      `### Wave\n` +
      `- Wave ID: ${parallelState.activeWaveId}\n` +
      `- Phase: ${parallelState.activeWavePhase}\n` +
      `- Tasks: ${parallelState.activeWaveTaskIds.join(', ')}\n\n` +
      `### Action\n` +
      `- Task statuses rolled back to pre-reservation state\n` +
      `- Parallel state cleared from issue.json\n` +
      `- Worker artifacts retained at STATE/.runs/${parallelState.runId}/workers/\n\n` +
      `---\n`;
    await fs.appendFile(progressPath, progressEntry, 'utf-8').catch(() => void 0);

    // Log if viewer log file is available
    if (this.status.viewer_log_file) {
      await this.appendViewerLog(
        this.status.viewer_log_file,
        `[STOP] Rolled back active wave ${parallelState.activeWaveId}, restored ${parallelState.activeWaveTaskIds.length} task(s) to pre-reservation status`,
      );
    }
  }

  private async appendViewerLog(viewerLogPath: string, line: string): Promise<void> {
    await fs.appendFile(viewerLogPath, `${line}\n`, 'utf-8').catch(() => void 0);
  }

  private async spawnRunner(args: string[], viewerLogPath: string, options?: { model?: string; permissionMode?: string }): Promise<number> {
    const runnerBin = path.join(this.repoRoot, 'packages', 'runner', 'dist', 'bin.js');
    if (!(await pathExists(runnerBin))) {
      throw new Error(`Runner binary not found at ${runnerBin}. Run: pnpm --filter @jeeves/runner build`);
    }

    const cmd = process.execPath;
    const fullArgs = [runnerBin, ...args];
    this.status = { ...this.status, command: `${cmd} ${fullArgs.join(' ')}` };
    this.broadcast('run', { run: this.status });

    await this.appendViewerLog(viewerLogPath, `[RUNNER] ${this.status.command}`);
    if (options?.model) {
      await this.appendViewerLog(viewerLogPath, `[RUNNER] model=${options.model}`);
    }
    if (options?.permissionMode) {
      await this.appendViewerLog(viewerLogPath, `[RUNNER] permissionMode=${options.permissionMode}`);
    }

    const env: Record<string, string | undefined> = { ...process.env, JEEVES_DATA_DIR: this.dataDir };
    if (options?.model) {
      env.JEEVES_MODEL = options.model;
    }
    if (options?.permissionMode) {
      env.JEEVES_PERMISSION_MODE = options.permissionMode;
    }
    const proc = this.spawnImpl(cmd, fullArgs, {
      cwd: this.repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    proc.stdin.end();
    this.proc = proc;
    this.status = { ...this.status, pid: proc.pid ?? null };
    this.broadcast('run', { run: this.status });

    proc.stdout.on('data', async (chunk) => {
      await this.appendViewerLog(viewerLogPath, `[STDOUT] ${String(chunk).trimEnd()}`);
    });
    proc.stderr.on('data', async (chunk) => {
      await this.appendViewerLog(viewerLogPath, `[STDERR] ${String(chunk).trimEnd()}`);
    });

    const exitCode = await new Promise<number>((resolve) => {
      let resolved = false;

      // Handle async spawn errors (e.g., invalid cwd, resource exhaustion, permission errors).
      // Without this handler, Node would throw on the unhandled 'error' event and crash the server.
      proc.once('error', async (err) => {
        await this.appendViewerLog(viewerLogPath, `[RUNNER] Spawn error: ${err.message}`);
        if (!resolved) {
          resolved = true;
          resolve(-1); // Synthetic non-zero exit code for spawn failure
        }
      });

      proc.once('exit', (code, signal) => {
        if (!resolved) {
          resolved = true;
          resolve(exitCodeFromExitEvent(code, signal));
        }
      });
    });
    return exitCode;
  }

  private async getStateSnapshot() {
    const issueJson = this.stateDir ? await readIssueJson(this.stateDir) : null;
    const taskCount = await this.readTaskCount();
    return {
      issue_ref: this.issueRef,
      issue_json: issueJson,
      run: this.status,
      task_count: taskCount,
    };
  }

  private async readTaskCount(): Promise<number | null> {
    if (!this.stateDir) return null;
    try {
      const raw = await fs.readFile(path.join(this.stateDir, 'tasks.json'), 'utf-8');
      const parsed = JSON.parse(raw) as { tasks?: unknown[] };
      return Array.isArray(parsed.tasks) ? parsed.tasks.length : null;
    } catch {
      return null;
    }
  }

  private async checkCompletionPromise(): Promise<boolean> {
    if (!this.stateDir) return false;
    const sdkPath = path.join(this.stateDir, 'sdk-output.json');
    const raw = await fs.readFile(sdkPath, 'utf-8').catch(() => null);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw) as { messages?: unknown[] };
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const tail = messages.slice(Math.max(0, messages.length - 50));
      for (const m of tail) {
        if (!m || typeof m !== 'object') continue;
        const msgType = (m as { type?: unknown }).type;
        if (msgType !== 'assistant' && msgType !== 'result') continue;
        const content = (m as { content?: unknown }).content;
        if (typeof content === 'string' && hasCompletionPromise(content)) return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  private async runLoop(params: {
    provider: 'claude' | 'fake' | 'codex';
    maxIterations: number;
    inactivityTimeoutSec: number;
    iterationTimeoutSec: number;
    workflowOverride: string | null;
    quick: boolean;
    viewerLogPath: string;
  }): Promise<void> {
    const { viewerLogPath } = params;
    try {
      // Per §6.2.8: Start-of-run recovery - repair orphaned in_progress tasks
      if (this.stateDir) {
        const repairResult = await repairOrphanedInProgressTasks(this.stateDir);
        if (repairResult.repairedTaskIds.length > 0) {
          await this.appendViewerLog(
            viewerLogPath,
            `[RECOVERY] Repaired ${repairResult.repairedTaskIds.length} orphaned in_progress task(s): ${repairResult.repairedTaskIds.join(', ')}`,
          );
          // Append progress entry for the repair
          const progressPath = path.join(this.stateDir, 'progress.txt');
          const progressEntry = `\n## [${nowIso()}] - Start-of-Run Recovery\n\n` +
            `### Orphaned Tasks Repaired\n` +
            repairResult.repairedTaskIds.map((id) => `- ${id}: in_progress -> failed`).join('\n') + '\n\n' +
            `### Canonical Feedback Written\n` +
            repairResult.feedbackFilesWritten.map((f) => `- ${path.basename(f)}`).join('\n') + '\n\n' +
            `---\n`;
          await fs.appendFile(progressPath, progressEntry, 'utf-8').catch(() => void 0);
        }
      }

      let completedNaturally = true;
      for (let iteration = 1; iteration <= params.maxIterations; iteration += 1) {
        if (this.stopRequested) {
          await this.appendViewerLog(viewerLogPath, `[ITERATION] Stop requested, ending at iteration ${iteration}`);
          completedNaturally = false;
          break;
        }

        this.status = { ...this.status, current_iteration: iteration };
        this.broadcast('run', { run: this.status });

        await this.appendViewerLog(viewerLogPath, '');
        await this.appendViewerLog(viewerLogPath, `${'='.repeat(60)}`);
        await this.appendViewerLog(viewerLogPath, `[ITERATION ${iteration}/${params.maxIterations}] Starting fresh context`);
        await this.appendViewerLog(viewerLogPath, `${'='.repeat(60)}`);

	        const issueJson = this.stateDir ? await readIssueJson(this.stateDir) : null;
	        if (!issueJson) throw new Error('issue.json not found or invalid');

	        // Auto-route to the `quick-fix` workflow at the beginning of the run (iteration 1).
	        // Guardrails:
	        // - Only if no workflow override is set (so the issue can change workflows)
	        // - Only if the issue is still at the start of the default workflow
	        if (iteration === 1 && params.workflowOverride === null) {
	          try {
	            const currentWorkflow = isNonEmptyString(issueJson.workflow) ? issueJson.workflow.trim() : 'default';
	            if (currentWorkflow === 'default') {
	              const defaultWorkflow = await loadWorkflowByName('default', { workflowsDir: this.workflowsDir });
	              const currentPhaseRaw = isNonEmptyString(issueJson.phase) ? issueJson.phase.trim() : '';
	              const currentPhase = currentPhaseRaw || defaultWorkflow.start;
	              if (currentPhase === defaultWorkflow.start) {
	                const repo = typeof issueJson.repo === 'string' ? issueJson.repo.trim() : '';
	                const issueNumber = getIssueNumber(issueJson);
	                if (repo && issueNumber) {
	                  const decision = await decideQuickFixRouting({
	                    explicitQuick: params.quick,
	                    repo,
	                    issueNumber,
	                    cwd: this.repoRoot,
	                    env: process.env,
	                  });
	                  if (decision.route) {
	                    const quickWorkflow = await loadWorkflowByName('quick-fix', { workflowsDir: this.workflowsDir });
	                    issueJson.workflow = 'quick-fix';
	                    issueJson.phase = quickWorkflow.start;
	                    await writeIssueJson(this.stateDir!, issueJson);
	                    this.broadcast('state', await this.getStateSnapshot());
	                    await this.appendViewerLog(
	                      viewerLogPath,
	                      `[QUICK_FIX] Routed to workflow=quick-fix phase=${quickWorkflow.start} (${decision.reason})`,
	                    );
	                  }
	                }
	              }
	            }
	          } catch (err) {
	            const msg = err instanceof Error ? err.message : String(err);
	            await this.appendViewerLog(viewerLogPath, `[QUICK_FIX] Auto-routing skipped: ${msg}`);
	          }
	        }

	        const workflowName = params.workflowOverride ?? (isNonEmptyString(issueJson.workflow) ? issueJson.workflow : 'default');
	        const workflow = await loadWorkflowByName(workflowName, { workflowsDir: this.workflowsDir });
	        const currentPhaseRaw = isNonEmptyString(issueJson.phase) ? issueJson.phase.trim() : '';
	        let currentPhase = currentPhaseRaw || workflow.start;
	        if (!workflow.phases[currentPhase]) {
	          if (currentPhaseRaw === 'design_draft') {
	            await this.appendViewerLog(
	              viewerLogPath,
	              `[MIGRATE] issue.json.phase=design_draft is not present in workflow '${workflowName}'. Using start phase '${workflow.start}'.`,
	            );
	            currentPhase = workflow.start;
	            issueJson.phase = currentPhase;
	            await writeIssueJson(this.stateDir!, issueJson);
	            this.broadcast('state', await this.getStateSnapshot());
	          } else {
	            throw new Error(
	              `Unknown phase '${currentPhase}' for workflow '${workflowName}'. Valid phases: ${Object.keys(workflow.phases).sort().join(', ')}`,
	            );
	          }
	        }
        const engine = new WorkflowEngine(workflow);
        const effectiveProvider = mapProvider(workflow.phases[currentPhase]?.provider ?? workflow.defaultProvider ?? params.provider);

        // Compute effective model: phase.model ?? workflow.defaultModel ?? (provider default = undefined)
        const effectiveModel = getEffectiveModel(workflow, currentPhase);
        const effectivePermissionMode = workflow.phases[currentPhase]?.permissionMode;

        // Validate model if specified - fail loudly for invalid models (no silent fallback)
        if (effectiveModel !== undefined && !isValidModel(effectiveModel)) {
          const errorMsg = `Invalid model '${effectiveModel}' for phase '${currentPhase}'. Valid models: ${validModels.join(', ')}`;
          await this.appendViewerLog(viewerLogPath, `[ERROR] ${errorMsg}`);
          throw new Error(errorMsg);
        }

        if (engine.isTerminal(currentPhase)) {
          await this.appendViewerLog(viewerLogPath, `[COMPLETE] Already in terminal phase: ${currentPhase}`);
          this.status = {
            ...this.status,
            completed_via_state: true,
            completion_reason: `already in terminal phase: ${currentPhase}`,
          };
          this.broadcast('run', { run: this.status });
          break;
        }

        const issueBeforeIteration = JSON.parse(JSON.stringify(issueJson)) as Record<string, unknown>;
        await this.clearPhaseReportFile();

        const lastRunLog = path.join(this.stateDir!, 'last-run.log');
        let lastSize = 0;
        let lastChangeAtMs = Date.now();
        const startAtMs = Date.now();
        const iterStartedAt = nowIso();

        // Check if parallel mode is enabled and applicable for this phase
        const isParallelPhase = currentPhase === 'implement_task' || currentPhase === 'task_spec_check';
        const parallelEnabled = isParallelPhase && await isParallelModeEnabled(this.stateDir!);

        let exitCode: number;
        let parallelWaveExecuted = false;

        if (parallelEnabled) {
          // Run parallel wave for task execution phases
          const parallelResult = await this.runParallelWave({
            currentPhase: currentPhase as 'implement_task' | 'task_spec_check',
            workflowName,
            effectiveProvider,
            effectiveModel,
            viewerLogPath,
            iterStartedAt,
            iterationTimeoutSec: params.iterationTimeoutSec,
            inactivityTimeoutSec: params.inactivityTimeoutSec,
          });
          exitCode = parallelResult.exitCode;
          parallelWaveExecuted = parallelResult.waveExecuted;

          // If wave timed out, handle cleanup and stop the run
          if (parallelResult.timedOut) {
            this.stopReason = `wave_timeout (parallel ${currentPhase})`;

            // Per §6.2.8 "Timeout stop":
            // - implement_task timeout: Keep phase at implement_task so next run can retry
            //   (transitioning to task_spec_check would create stuck state with no active wave)
            // - task_spec_check timeout: Evaluate transitions to go back to implement_task
            //   (taskFailed=true triggers the transition per workflows/default.yaml)
            if (currentPhase === 'task_spec_check') {
              const timeoutIssue = await readIssueJson(this.stateDir!);
              if (timeoutIssue) {
                const nextPhase = engine.evaluateTransitions(currentPhase, timeoutIssue);
                if (nextPhase && nextPhase !== currentPhase) {
                  timeoutIssue.phase = nextPhase;
                  await writeIssueJson(this.stateDir!, timeoutIssue);
                  await this.appendViewerLog(viewerLogPath, `[TIMEOUT] Transitioning phase: ${currentPhase} -> ${nextPhase}`);
                  this.broadcast('state', await this.getStateSnapshot());
                }
              }
            } else {
              // implement_task timeout: Stay at implement_task for retry
              await this.appendViewerLog(viewerLogPath, `[TIMEOUT] Keeping phase at ${currentPhase} for retry`);
            }

            completedNaturally = false;
            break;
          }

          // If merge conflict occurred, stop the run as errored (§6.2.5)
          // Per T15: Ensure the workflow is left in a resumable state
          if (parallelResult.mergeConflict) {
            this.stopReason = `merge_conflict (parallel ${currentPhase})`;
            this.status = { ...this.status, last_error: `Merge conflict during ${currentPhase}` };
            this.broadcast('run', { run: this.status });
            await this.appendViewerLog(viewerLogPath, `[ERROR] Run stopped due to merge conflict during ${currentPhase}`);

            // T15: Ensure issue.json is left in a resumable state (phase != task_spec_check when
            // status.parallel is cleared). The merge conflict handler in ParallelRunner already:
            // - Marks the conflicted task as 'failed' in tasks.json
            // - Writes canonical feedback pointing to retained artifacts
            // - Clears status.parallel via updateCanonicalStatusFlags
            //
            // However, it does NOT set status.taskFailed=true (which updateCanonicalStatusFlags
            // only sets based on spec-check outcomes, not merge outcomes). We need to:
            // 1. Ensure status.taskFailed=true so the workflow transition guard is satisfied
            // 2. Evaluate workflow transitions to move phase from task_spec_check to implement_task
            const conflictIssue = await readIssueJson(this.stateDir!);
            if (conflictIssue) {
              const conflictStatus = (conflictIssue.status as Record<string, unknown>) ?? {};
              // Set taskFailed=true to satisfy the workflow transition guard (task_spec_check -> implement_task)
              conflictStatus.taskFailed = true;
              conflictStatus.taskPassed = false;
              conflictStatus.hasMoreTasks = true;
              conflictStatus.allTasksComplete = false;
              conflictIssue.status = conflictStatus;

              // Evaluate workflow transitions to move phase back to implement_task
              const nextPhase = engine.evaluateTransitions(currentPhase, conflictIssue);
              if (nextPhase && nextPhase !== currentPhase) {
                conflictIssue.phase = nextPhase;
                await this.appendViewerLog(viewerLogPath, `[MERGE_CONFLICT] Transitioning phase: ${currentPhase} -> ${nextPhase}`);
              }

              await writeIssueJson(this.stateDir!, conflictIssue);
              this.broadcast('state', await this.getStateSnapshot());
            }

            completedNaturally = false;
            break;
          }

          // If setup/orchestration failure occurred, stop the run immediately as errored (§6.2.8 step 6)
          // Per T17: Setup failures should NOT continue iterating until max_iterations
          if (parallelResult.setupFailure) {
            this.stopReason = `setup_failure (parallel ${currentPhase})`;
            this.status = { ...this.status, last_error: parallelResult.setupError ?? `Setup failure during ${currentPhase}` };
            this.broadcast('run', { run: this.status });
            await this.appendViewerLog(viewerLogPath, `[ERROR] Run stopped due to setup failure during ${currentPhase}: ${parallelResult.setupError ?? 'unknown'}`);

            // Per §6.2.8 "Wave setup failure":
            // - Task statuses have already been rolled back via reservedStatusByTaskId
            // - status.parallel has been cleared
            // - Progress entry and wave artifact have been written
            // - Do NOT update taskFailed/taskPassed flags (setup failure ≠ task failure)
            // The issue state is already clean (tasks restored to pre-reservation status), so we
            // just stop the run immediately without modifying any flags.
            completedNaturally = false;
            break;
          }

          // If no wave was executed (no ready tasks), treat as success and let workflow transition
          if (!parallelWaveExecuted && exitCode === 0) {
            await this.appendViewerLog(viewerLogPath, `[PARALLEL] No ready tasks for ${currentPhase}, continuing workflow`);
          }
        } else {
          // Run single sequential subprocess (existing behavior)
          const exitPromise = this.spawnRunner(
            [
              'run-phase',
              '--workflow',
              workflowName,
              '--phase',
              currentPhase,
              '--provider',
              effectiveProvider,
              '--workflows-dir',
              this.workflowsDir,
              '--prompts-dir',
              this.promptsDir,
              '--issue',
              this.issueRef!,
            ],
            viewerLogPath,
            { model: effectiveModel, permissionMode: effectivePermissionMode },
          );

          exitCode = await (async () => {
            while (true) {
              if (this.stopRequested) break;
              const elapsedSec = (Date.now() - startAtMs) / 1000;
              if (elapsedSec > params.iterationTimeoutSec) {
                await this.appendViewerLog(viewerLogPath, `[TIMEOUT] Iteration exceeded ${params.iterationTimeoutSec}s; stopping`);
                await this.stop({ force: true, reason: `iteration_timeout (${params.iterationTimeoutSec}s)` });
                completedNaturally = false;
                break;
              }

              const stat = await fs.stat(lastRunLog).catch(() => null);
              if (stat && stat.isFile()) {
                if (stat.size !== lastSize) {
                  lastSize = stat.size;
                  lastChangeAtMs = Date.now();
                }
              }

              const idleSec = (Date.now() - lastChangeAtMs) / 1000;
              if (idleSec > params.inactivityTimeoutSec) {
                await this.appendViewerLog(viewerLogPath, `[TIMEOUT] No log activity for ${params.inactivityTimeoutSec}s; stopping`);
                await this.stop({ force: true, reason: `inactivity_timeout (${params.inactivityTimeoutSec}s)` });
                completedNaturally = false;
                break;
              }

              const done = await Promise.race([
                exitPromise.then((code) => ({ done: true as const, code })),
                new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false as const }), 150)),
              ]);
              if (done.done) return done.code;
            }

            return exitPromise;
          })();
        }

        this.status = { ...this.status, returncode: exitCode };
        this.broadcast('run', { run: this.status });

        const phaseCommitResult = !parallelEnabled
          ? await this.commitOrchestratorOwnedPhaseState({
              phase: currentPhase,
              issueBeforeIteration,
              exitCode,
              viewerLogPath,
            })
          : null;

        await this.archiveIteration({
          iteration,
          workflow: workflowName,
          phase: currentPhase,
          provider: effectiveProvider,
          model: effectiveModel ?? null,
          started_at: iterStartedAt,
          ended_at: nowIso(),
          exit_code: exitCode,
          phase_report_source: phaseCommitResult?.source ?? null,
          phase_report_committed_fields: Object.keys(phaseCommitResult?.committedStatusUpdates ?? {}).sort(),
          phase_report_ignored_fields: (phaseCommitResult?.ignoredStatusKeys ?? []).slice(),
        });

        if (exitCode !== 0) {
          await this.appendViewerLog(viewerLogPath, `[ITERATION] Iteration ${iteration} exited with code ${exitCode}`);
          if (!this.status.last_error) {
            this.status = { ...this.status, last_error: `runner exited with code ${exitCode} (phase=${currentPhase})` };
            this.broadcast('run', { run: this.status });
          }
          continue;
        }

        // Advance phase via workflow transitions (viewer-server owns orchestration)
        // Skip transitions if stopRequested is set, to avoid advancing to task_spec_check
        // after a mid-implement manual stop (which clears status.parallel via rollbackActiveWaveOnStop).
        // Per §6.2.8: On manual stop mid-wave, the phase should remain at implement_task so the
        // next run can re-select tasks rather than entering task_spec_check with no active wave.
        if (this.stopRequested) {
          await this.appendViewerLog(viewerLogPath, `[STOP] Stop requested; skipping phase transition`);
          continue;
        }

        let transitionedToPhase: string | null = null;
        const updatedIssue = this.stateDir ? await readIssueJson(this.stateDir) : null;
        if (updatedIssue) {
          // If a phase intentionally switched workflows by editing issue.json, honor it immediately.
          // This is only allowed when no workflow override is active.
          if (params.workflowOverride === null) {
            const nextWorkflowName = isNonEmptyString(updatedIssue.workflow) ? updatedIssue.workflow.trim() : workflowName;
            if (nextWorkflowName !== workflowName) {
              const nextWorkflow = await loadWorkflowByName(nextWorkflowName, { workflowsDir: this.workflowsDir });
              const requestedPhase = isNonEmptyString(updatedIssue.phase) ? updatedIssue.phase.trim() : '';
              const nextPhase = requestedPhase && nextWorkflow.phases[requestedPhase] ? requestedPhase : nextWorkflow.start;
              updatedIssue.workflow = nextWorkflowName;
              updatedIssue.phase = nextPhase;
              await writeIssueJson(this.stateDir!, updatedIssue);
              this.broadcast('state', await this.getStateSnapshot());
              await this.appendViewerLog(viewerLogPath, `[WORKFLOW] Switched: ${workflowName} -> ${nextWorkflowName} (phase=${nextPhase})`);
              continue;
            }
          }

          await this.commitDesignDocCheckpoint({ phase: currentPhase, issueJson: updatedIssue });
          const nextPhase = engine.evaluateTransitions(currentPhase, updatedIssue);
          if (nextPhase) {
            transitionedToPhase = nextPhase;
            updatedIssue.phase = nextPhase;

            const control = updatedIssue.control;
            if (isPlainRecord(control) && control.restartPhase === true) {
              delete control.restartPhase;
              if (Object.keys(control).length === 0) delete updatedIssue.control;
            }

            await writeIssueJson(this.stateDir!, updatedIssue);
            if (nextPhase === 'implement_task') {
              await expandTasksFilesAllowedForTests(this.stateDir!);
            }
            this.broadcast('state', await this.getStateSnapshot());

            if (engine.isTerminal(nextPhase)) {
              await this.appendViewerLog(viewerLogPath, `[COMPLETE] Reached terminal phase: ${nextPhase}`);
              this.status = {
                ...this.status,
                completed_via_state: true,
                completion_reason: `reached terminal phase: ${nextPhase}`,
              };
              this.broadcast('run', { run: this.status });
              completedNaturally = false;
              break;
            }
            await this.appendViewerLog(viewerLogPath, `[TRANSITION] ${currentPhase} -> ${nextPhase}`);
          }
        }

        if (await this.checkCompletionPromise()) {
          // Promise-based completion is only honored in terminal phase context.
          // Non-terminal phases should continue through workflow transitions.
          const completionPhase = transitionedToPhase ?? currentPhase;
          if (!engine.isTerminal(completionPhase)) {
            await this.appendViewerLog(
              viewerLogPath,
              `[COMPLETE] Ignoring completion promise in non-terminal phase: ${completionPhase}`,
            );
            continue;
          }
          await this.appendViewerLog(viewerLogPath, `[COMPLETE] Agent signaled completion after ${iteration} iteration(s)`);
          this.status = {
            ...this.status,
            completed_via_promise: true,
            completion_reason: 'completion promise found in output',
          };
          this.broadcast('run', { run: this.status });
          completedNaturally = false;
          break;
        }
      }

      if (
        completedNaturally &&
        !this.status.completed_via_promise &&
        !this.status.completed_via_state &&
        !this.status.completion_reason
      ) {
        this.status = { ...this.status, completion_reason: 'max_iterations' };
        this.broadcast('run', { run: this.status });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      this.status = { ...this.status, last_error: msg };
      this.broadcast('run', { run: this.status });
      if (this.status.viewer_log_file) await this.appendViewerLog(this.status.viewer_log_file, `[ERROR] ${msg}`);
    } finally {
      this.proc = null;
      if (this.stopReason && !this.status.completion_reason && !this.status.completed_via_promise && !this.status.completed_via_state) {
        this.status = { ...this.status, completion_reason: this.stopReason };
      }
      this.status = { ...this.status, running: false, ended_at: nowIso(), pid: null };
      this.broadcast('run', { run: this.status });
      await this.persistLastRunStatus().catch(() => void 0);
      await this.finalizeRunArchive().catch(() => void 0);
    }
  }

  /**
   * Executes a parallel wave for implement_task or task_spec_check phases.
   * Returns the effective exit code and whether a wave was actually executed.
   */
  private async runParallelWave(params: {
    currentPhase: 'implement_task' | 'task_spec_check';
    workflowName: string;
    effectiveProvider: string;
    effectiveModel?: string;
    viewerLogPath: string;
    iterStartedAt: string;
    iterationTimeoutSec: number;
    inactivityTimeoutSec: number;
  }): Promise<{ exitCode: number; waveExecuted: boolean; timedOut?: boolean; mergeConflict?: boolean; setupFailure?: boolean; setupError?: string }> {
    if (!this.stateDir || !this.workDir || !this.runId || !this.issueRef) {
      return { exitCode: 1, waveExecuted: false };
    }

    // Parse issue ref to get owner/repo/issueNumber
    const parsed = parseIssueRef(this.issueRef);
    const { owner, repo, issueNumber } = parsed;

    // Get repo directory path
    const repoDir = path.join(this.dataDir, 'repos', owner, repo);

    // Read issue.json to get canonical branch
    const issueJson = await readIssueJson(this.stateDir);
    if (!issueJson) {
      await this.appendViewerLog(params.viewerLogPath, '[PARALLEL] ERROR: issue.json not found');
      return { exitCode: 1, waveExecuted: false };
    }
    const canonicalBranch = typeof issueJson.branch === 'string' ? issueJson.branch : `issue/${issueNumber}`;

    // Get max parallel tasks: API override > issue settings > default (1)
    const maxParallelTasks = this.maxParallelTasksOverride ?? await getMaxParallelTasks(this.stateDir);
    // Track effective value for status reporting (per code review feedback)
    this.effectiveMaxParallelTasks = maxParallelTasks;

    // Get runner binary path
    const runnerBinPath = path.join(this.repoRoot, 'packages', 'runner', 'dist', 'bin.js');

    // Create parallel runner options
    const parallelOptions: ParallelRunnerOptions = {
      canonicalStateDir: this.stateDir,
      canonicalWorkDir: this.workDir,
      repoDir,
      dataDir: this.dataDir,
      owner,
      repo,
      issueNumber,
      canonicalBranch,
      runId: this.runId,
      workflowName: params.workflowName,
      provider: params.effectiveProvider,
      workflowsDir: this.workflowsDir,
      promptsDir: this.promptsDir,
      viewerLogPath: params.viewerLogPath,
      maxParallelTasks,
      appendLog: async (line: string) => {
        await this.appendViewerLog(params.viewerLogPath, line);
      },
      broadcast: (event: string, data: unknown) => {
        this.broadcast(event, data);
      },
      getRunStatus: () => this.getStatus(),
      spawn: this.spawnImpl,
      runnerBinPath,
      model: params.effectiveModel,
      iterationTimeoutSec: params.iterationTimeoutSec,
      inactivityTimeoutSec: params.inactivityTimeoutSec,
    };

    const parallelRunner = new ParallelRunner(parallelOptions);
    this.activeParallelRunner = parallelRunner;

    // Broadcast initial worker status
    this.status = { ...this.status };
    this.broadcast('run', { run: this.getStatus() });

    // Wire up stop handling
    if (this.stopRequested) {
      parallelRunner.requestStop();
    }

    try {
      if (params.currentPhase === 'implement_task') {
        // Run implement wave
        const result = await parallelRunner.runImplementWave();
        if (!result) {
          // No ready tasks to run
          return { exitCode: 0, waveExecuted: false };
        }
        if (result.timedOut) {
          await this.appendViewerLog(params.viewerLogPath, `[PARALLEL] Implement wave timed out (${result.timeoutType})`);
          return { exitCode: 1, waveExecuted: true, timedOut: true };
        }
        if (result.error) {
          await this.appendViewerLog(params.viewerLogPath, `[PARALLEL] Implement wave error: ${result.error}`);
          // Check if this is a setup/orchestration failure (continueExecution=false + error)
          // Per §6.2.8 step 6: setup failures should stop the run immediately as errored
          if (!result.continueExecution) {
            return { exitCode: 1, waveExecuted: true, setupFailure: true, setupError: result.error };
          }
          return { exitCode: 1, waveExecuted: true };
        }
        // Implement wave completed successfully, exit code 0 to proceed to spec check
        return { exitCode: 0, waveExecuted: true };
      } else {
        // Run spec check wave
        const result = await parallelRunner.runSpecCheckWave();
        if (!result) {
          // No active wave to run spec check
          await this.appendViewerLog(params.viewerLogPath, '[PARALLEL] No active wave state for spec check');
          return { exitCode: 1, waveExecuted: false };
        }
        if (result.timedOut) {
          await this.appendViewerLog(params.viewerLogPath, `[PARALLEL] Spec check wave timed out (${result.timeoutType})`);
          return { exitCode: 1, waveExecuted: true, timedOut: true };
        }
        if (result.mergeConflict) {
          await this.appendViewerLog(params.viewerLogPath, `[PARALLEL] Spec check wave completed with merge conflict: ${result.error}`);
          return { exitCode: 1, waveExecuted: true, mergeConflict: true };
        }
        if (result.error) {
          await this.appendViewerLog(params.viewerLogPath, `[PARALLEL] Spec check wave error: ${result.error}`);
          // Check if this is a setup/orchestration failure (continueExecution=false + error)
          // Per §6.2.8 step 6: setup failures should stop the run immediately as errored
          if (!result.continueExecution) {
            return { exitCode: 1, waveExecuted: true, setupFailure: true, setupError: result.error };
          }
          return { exitCode: 1, waveExecuted: true };
        }
        // Spec check wave completed - exit code based on results
        // The canonical status flags have already been updated by ParallelRunner
        return { exitCode: 0, waveExecuted: true };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.appendViewerLog(params.viewerLogPath, `[PARALLEL] Wave execution error: ${errMsg}`);
      return { exitCode: 1, waveExecuted: false };
    } finally {
      // Clear the parallel runner when wave completes
      this.activeParallelRunner = null;
      // Broadcast final status without workers
      this.broadcast('run', { run: this.getStatus() });
    }
  }

  private async clearPhaseReportFile(): Promise<void> {
    if (!this.stateDir) return;
    await fs.rm(path.join(this.stateDir, PHASE_REPORT_FILE), { force: true }).catch(() => void 0);
  }

  private parsePhaseReportFile(
    raw: string,
    expectedPhase: string,
  ): {
    statusUpdates: TransitionStatusUpdates;
    outcome: string | null;
    reasons: string[];
    evidenceRefs: string[];
    errors: string[];
  } {
    const errors: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        statusUpdates: {},
        outcome: null,
        reasons: [],
        evidenceRefs: [],
        errors: ['phase-report.json is not valid JSON'],
      };
    }

    if (!isPlainRecord(parsed)) {
      return {
        statusUpdates: {},
        outcome: null,
        reasons: [],
        evidenceRefs: [],
        errors: ['phase-report.json must be a JSON object'],
      };
    }

    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) {
      errors.push(`phase-report.json schemaVersion=${String(parsed.schemaVersion)} is unsupported (expected 1)`);
    }

    if (typeof parsed.phase === 'string' && parsed.phase.trim() && parsed.phase.trim() !== expectedPhase) {
      errors.push(`phase-report.json phase='${parsed.phase}' does not match current phase '${expectedPhase}'`);
    }

    let statusUpdates: TransitionStatusUpdates = {};
    if (hasOwn(parsed, 'statusUpdates')) {
      statusUpdates = extractBooleanStatusUpdates(parsed.statusUpdates);
      if (!isPlainRecord(parsed.statusUpdates)) {
        errors.push('phase-report.json.statusUpdates must be an object when provided');
      }
    }

    const outcome = typeof parsed.outcome === 'string' && parsed.outcome.trim()
      ? parsed.outcome.trim()
      : null;

    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];

    const evidenceRefs = Array.isArray(parsed.evidenceRefs)
      ? parsed.evidenceRefs.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];

    return { statusUpdates, outcome, reasons, evidenceRefs, errors };
  }

  private async commitOrchestratorOwnedPhaseState(params: {
    phase: string;
    issueBeforeIteration: Record<string, unknown>;
    exitCode: number;
    viewerLogPath: string;
  }): Promise<{
    source: 'agent_file' | 'inferred';
    claimedStatusUpdates: TransitionStatusUpdates;
    committedStatusUpdates: TransitionStatusUpdates;
    ignoredStatusKeys: string[];
    validationErrors: string[];
  } | null> {
    if (!this.stateDir) return null;

    const issueAfterIteration = await readIssueJson(this.stateDir);
    if (!issueAfterIteration) {
      await this.appendViewerLog(params.viewerLogPath, '[PHASE_REPORT] issue.json missing after phase run; skipping orchestrator commit');
      return null;
    }

    const beforeStatus = isPlainRecord(params.issueBeforeIteration.status)
      ? params.issueBeforeIteration.status
      : {};
    const afterIssueBeforeCommit = JSON.stringify(issueAfterIteration);

    const reportPath = path.join(this.stateDir, PHASE_REPORT_FILE);
    const reportRaw = await fs.readFile(reportPath, 'utf-8').catch(() => null);

    let source: 'agent_file' | 'inferred' = 'inferred';
    let claimedStatusUpdates: TransitionStatusUpdates = {};
    let outcome: string | null = null;
    let reasons: string[] = [];
    let evidenceRefs: string[] = [];
    const validationErrors: string[] = [];

    if (reportRaw) {
      source = 'agent_file';
      const parsed = this.parsePhaseReportFile(reportRaw, params.phase);
      claimedStatusUpdates = parsed.statusUpdates;
      outcome = parsed.outcome;
      reasons = parsed.reasons;
      evidenceRefs = parsed.evidenceRefs;
      validationErrors.push(...parsed.errors);
    } else {
      claimedStatusUpdates = inferStatusUpdatesFromIssueDiff({
        beforeIssue: params.issueBeforeIteration,
        afterIssue: issueAfterIteration,
      });
    }

    const allowedKeys = new Set(PHASE_ALLOWED_STATUS_UPDATES[params.phase] ?? []);
    const filtered: TransitionStatusUpdates = {};
    const ignoredStatusKeys: string[] = [];
    for (const [key, value] of Object.entries(claimedStatusUpdates)) {
      const typedKey = key as TransitionStatusField;
      if (!allowedKeys.has(typedKey)) {
        ignoredStatusKeys.push(key);
        continue;
      }
      if (typeof value === 'boolean') filtered[typedKey] = value;
    }

    let committedStatusUpdates = normalizePhaseStatusUpdates(params.phase, filtered);
    const committedFiltered: TransitionStatusUpdates = {};
    for (const [key, value] of Object.entries(committedStatusUpdates)) {
      const typedKey = key as TransitionStatusField;
      if (!allowedKeys.has(typedKey)) {
        ignoredStatusKeys.push(key);
        continue;
      }
      committedFiltered[typedKey] = value;
    }
    committedStatusUpdates = committedFiltered;

    if (params.exitCode !== 0 && Object.keys(committedStatusUpdates).length > 0) {
      validationErrors.push(`Ignored status updates because phase exited non-zero (exitCode=${params.exitCode})`);
      committedStatusUpdates = {};
    }

    const nextStatus = getStatusRecord(issueAfterIteration);
    for (const key of TRANSITION_STATUS_FIELDS) {
      copyStatusFieldFromSource({ target: nextStatus, source: beforeStatus, key });
    }

    if (hasOwn(params.issueBeforeIteration, 'phase')) issueAfterIteration.phase = params.issueBeforeIteration.phase;
    else delete issueAfterIteration.phase;

    for (const [key, value] of Object.entries(committedStatusUpdates)) {
      nextStatus[key] = value;
    }

    const afterIssueAfterCommit = JSON.stringify(issueAfterIteration);
    if (afterIssueAfterCommit !== afterIssueBeforeCommit) {
      await writeIssueJson(this.stateDir, issueAfterIteration);
    }

    const auditReport: Record<string, unknown> = {
      schemaVersion: 1,
      phase: params.phase,
      generatedAt: nowIso(),
      source,
      exitCode: params.exitCode,
      claimedStatusUpdates,
      committedStatusUpdates,
      ignoredStatusKeys: Array.from(new Set(ignoredStatusKeys)).sort(),
      validationErrors,
      outcome,
      reasons,
      evidenceRefs,
    };
    await writeJsonAtomic(reportPath, auditReport);

    const committedKeys = Object.keys(committedStatusUpdates);
    const ignoredKeys = Array.from(new Set(ignoredStatusKeys)).sort();
    await this.appendViewerLog(
      params.viewerLogPath,
      `[PHASE_REPORT] source=${source} committed=[${committedKeys.join(',') || 'none'}] ignored=[${ignoredKeys.join(',') || 'none'}]`,
    );
    for (const error of validationErrors) {
      await this.appendViewerLog(params.viewerLogPath, `[PHASE_REPORT] warning: ${error}`);
    }

    return {
      source,
      claimedStatusUpdates,
      committedStatusUpdates,
      ignoredStatusKeys: ignoredKeys,
      validationErrors,
    };
  }

  private async persistLastRunStatus(): Promise<void> {
    if (!this.stateDir) return;
    const outPath = path.join(this.stateDir, 'viewer-run-status.json');
    await writeJsonAtomic(outPath, this.status);
    if (this.runDir) {
      await writeJsonAtomic(path.join(this.runDir, 'viewer-run-status.json'), this.status);
    }
  }

  private async persistRunArchiveMeta(meta: Record<string, unknown>): Promise<void> {
    if (!this.runDir) return;
    this.runArchiveMeta = { ...(this.runArchiveMeta ?? {}), ...meta };
    await writeJsonAtomic(path.join(this.runDir, 'run.json'), this.runArchiveMeta);
  }

  private async archiveIteration(params: {
    iteration: number;
    workflow: string;
    phase: string;
    provider: string;
    model: string | null;
    started_at: string;
    ended_at: string;
    exit_code: number;
    phase_report_source?: string | null;
    phase_report_committed_fields?: string[];
    phase_report_ignored_fields?: string[];
  }): Promise<void> {
    if (!this.stateDir || !this.runDir) return;
    const iterDir = path.join(this.runDir, 'iterations', String(params.iteration).padStart(3, '0'));
    await fs.mkdir(iterDir, { recursive: true });
    await writeJsonAtomic(path.join(iterDir, 'iteration.json'), params);

    const copies: Promise<unknown>[] = [];
    const copyIfExists = (src: string, dstName: string) => {
      copies.push(fs.copyFile(src, path.join(iterDir, dstName)).catch(() => void 0));
    };
    copyIfExists(path.join(this.stateDir, 'last-run.log'), 'last-run.log');
    copyIfExists(path.join(this.stateDir, 'sdk-output.json'), 'sdk-output.json');
    copyIfExists(path.join(this.stateDir, 'issue.json'), 'issue.json');
    copyIfExists(path.join(this.stateDir, 'tasks.json'), 'tasks.json');
    copyIfExists(path.join(this.stateDir, 'progress.txt'), 'progress.txt');
    copyIfExists(path.join(this.stateDir, PHASE_REPORT_FILE), PHASE_REPORT_FILE);
    await Promise.allSettled(copies);

    await this.captureGitDebug(iterDir).catch(() => void 0);
  }

  private async finalizeRunArchive(): Promise<void> {
    if (!this.stateDir || !this.runDir || !this.runId) return;
    await fs.copyFile(path.join(this.stateDir, 'viewer-run.log'), path.join(this.runDir, 'viewer-run.log')).catch(() => void 0);
    await fs.copyFile(path.join(this.stateDir, 'issue.json'), path.join(this.runDir, 'final-issue.json')).catch(() => void 0);
    await fs.copyFile(path.join(this.stateDir, 'tasks.json'), path.join(this.runDir, 'final-tasks.json')).catch(() => void 0);
    await fs.copyFile(path.join(this.stateDir, 'progress.txt'), path.join(this.runDir, 'final-progress.txt')).catch(() => void 0);

    await this.persistRunArchiveMeta({
      run_id: this.runId,
      issue_ref: this.issueRef,
      state_dir: this.stateDir,
      work_dir: this.workDir,
      started_at: this.status.started_at,
      ended_at: this.status.ended_at,
      exit_code: this.status.returncode,
      completion_reason: this.status.completion_reason,
      completed_via_promise: this.status.completed_via_promise,
      completed_via_state: this.status.completed_via_state,
      last_error: this.status.last_error,
      max_iterations: this.status.max_iterations,
      current_iteration: this.status.current_iteration,
      command: this.status.command,
    });
  }

  private async captureGitDebug(iterDir: string): Promise<void> {
    if (!this.workDir) return;
    const status = await this.execCapture('git', ['status', '--porcelain=v1', '-b'], this.workDir).catch(() => null);
    if (status !== null) await fs.writeFile(path.join(iterDir, 'git-status.txt'), status, 'utf-8').catch(() => void 0);
    const stat = await this.execCapture('git', ['diff', '--stat'], this.workDir).catch(() => null);
    if (stat !== null) await fs.writeFile(path.join(iterDir, 'git-diff-stat.txt'), stat, 'utf-8').catch(() => void 0);
  }

  private async execCapture(cmd: string, args: string[], cwd: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      execFileCb(cmd, args, { cwd, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(err);
        const out = `${String(stdout)}${String(stderr)}`;
        resolve(out);
      });
    });
  }

  private async commitDesignDocCheckpoint(params: { phase: string; issueJson: Record<string, unknown> }): Promise<void> {
    if (!this.workDir) return;
    const checkpointPhases = new Set([
      // Legacy
      'design_draft',
      // Multi-phase design workflow (v3)
      'design_classify',
      'design_research',
      'design_workflow',
      'design_api',
      'design_data',
      'design_plan',
      // Design edits after review
      'design_edit',
    ]);
    if (!checkpointPhases.has(params.phase)) return;

    const inferred = inferDesignDocPath(params.issueJson);
    if (!inferred) return;
    const designDocPath = normalizeRepoRelativePath(inferred);
    const abs = path.resolve(this.workDir, designDocPath);
    const workRoot = path.resolve(this.workDir);
    if (!abs.startsWith(workRoot + path.sep) && abs !== workRoot) {
      throw new Error(`Resolved design doc path escapes worktree: ${designDocPath}`);
    }

    const exists = await fs
      .stat(abs)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!exists) {
      throw new Error(`Design doc not found after ${params.phase}: ${designDocPath}`);
    }

    const preStaged = (await this.execCapture('git', ['diff', '--cached', '--name-only'], this.workDir).catch(() => '')).trim();
    const stagedPaths = preStaged
      ? preStaged
          .split('\n')
          .map((p) => normalizeRepoRelativePath(p.trim()))
          .filter(Boolean)
      : [];
    const unexpectedStaged = stagedPaths.filter((p) => p !== designDocPath);
    if (unexpectedStaged.length > 0) {
      throw new Error(
        `Refusing to auto-commit design doc with other staged changes present:\n${unexpectedStaged.join(
          '\n',
        )}\n\nUnstage changes before retrying.`,
      );
    }

    const statusLine = (await this.execCapture('git', ['status', '--porcelain=v1', '--', designDocPath], this.workDir)).trim();
    if (!statusLine) {
      const tracked = await this.execCapture('git', ['ls-files', '--error-unmatch', '--', designDocPath], this.workDir)
        .then(() => true)
        .catch(() => false);
      if (!tracked) {
        throw new Error(
          `Design doc is not tracked (possibly ignored): ${designDocPath}\n` +
            `Add/commit the design doc or update .gitignore, then rerun.`,
        );
      }
      return; // clean + tracked
    }

    await this.execCapture('git', ['add', '--', designDocPath], this.workDir);

    const staged = (await this.execCapture('git', ['diff', '--cached', '--name-only'], this.workDir)).trim();
    if (!staged) return;
    if (staged.split('\n').some((p) => normalizeRepoRelativePath(p) !== designDocPath)) {
      throw new Error(`Refusing to auto-commit: staging included files other than ${designDocPath}:\n${staged}`);
    }

    const issueNumber = getIssueNumber(params.issueJson);
    const msg = issueNumber
      ? `chore(design): checkpoint issue #${issueNumber} design doc (${params.phase})`
      : `chore(design): checkpoint design doc (${params.phase})`;

    await this.execCapture(
      'git',
      [
        '-c',
        'user.name=Jeeves',
        '-c',
        'user.email=jeeves@local',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--no-verify',
        '-m',
        msg,
      ],
      this.workDir,
    );

    await this.execCapture('git', ['ls-files', '--error-unmatch', '--', designDocPath], this.workDir);
    if (this.status.viewer_log_file) {
      await this.appendViewerLog(this.status.viewer_log_file, `[DESIGN] Committed design doc checkpoint: ${designDocPath}`);
    }
  }
}
