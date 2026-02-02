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
import { readIssueJson, writeIssueJson } from './issueJson.js';
import { writeJsonAtomic } from './jsonAtomic.js';
import { expandTasksFilesAllowedForTests } from './tasksJson.js';

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
  const normalized = path.posix.normalize(withSlashes);
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
    return this.status;
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
    max_iterations?: unknown;
    inactivity_timeout_sec?: unknown;
    iteration_timeout_sec?: unknown;
  }): Promise<RunStatus> {
    if (this.status.running) throw new Error('Jeeves is already running');
    if (!this.issueRef || !this.stateDir || !this.workDir) throw new Error('No issue selected. Use /api/issues/select or /api/init/issue.');
    if (!(await pathExists(this.workDir))) {
      throw new Error(`Worktree not found at ${this.workDir}. Run init first.`);
    }

    const provider = mapProvider(params.provider);
    const maxIterations = Number.isFinite(Number(params.max_iterations)) ? Math.max(1, Number(params.max_iterations)) : 10;
    const inactivityTimeoutSec = Number.isFinite(Number(params.inactivity_timeout_sec)) ? Math.max(1, Number(params.inactivity_timeout_sec)) : 600;
    const iterationTimeoutSec = Number.isFinite(Number(params.iteration_timeout_sec)) ? Math.max(1, Number(params.iteration_timeout_sec)) : 3600;

    const viewerLogPath = path.join(this.stateDir, 'viewer-run.log');
    await fs.mkdir(path.dirname(viewerLogPath), { recursive: true });
    await fs.writeFile(viewerLogPath, '', 'utf-8');

    this.stopRequested = false;
    this.stopReason = null;
    this.runArchiveMeta = null;
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

    this.broadcast('run', { run: this.status });
    void this.runLoop({
      provider,
      maxIterations,
      inactivityTimeoutSec,
      iterationTimeoutSec,
      workflowOverride,
      viewerLogPath,
    });

    return this.status;
  }

  async stop(params?: { force?: boolean; reason?: string }): Promise<RunStatus> {
    const force = Boolean(params?.force ?? false);
    if (isNonEmptyString(params?.reason)) this.stopReason = params?.reason.trim();
    this.stopRequested = true;
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      try {
        proc.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // ignore
      }
    }
    return this.status;
  }

  private async appendViewerLog(viewerLogPath: string, line: string): Promise<void> {
    await fs.appendFile(viewerLogPath, `${line}\n`, 'utf-8').catch(() => void 0);
  }

  private async spawnRunner(args: string[], viewerLogPath: string, options?: { model?: string }): Promise<number> {
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

    const env: Record<string, string | undefined> = { ...process.env, JEEVES_DATA_DIR: this.dataDir };
    if (options?.model) {
      env.JEEVES_MODEL = options.model;
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
      proc.once('exit', (code, signal) => resolve(exitCodeFromExitEvent(code, signal)));
    });
    return exitCode;
  }

  private async getStateSnapshot() {
    const issueJson = this.stateDir ? await readIssueJson(this.stateDir) : null;
    return {
      issue_ref: this.issueRef,
      issue_json: issueJson,
      run: this.status,
    };
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
    viewerLogPath: string;
  }): Promise<void> {
    const { viewerLogPath } = params;
    try {
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
        const workflowName = params.workflowOverride ?? (isNonEmptyString(issueJson.workflow) ? issueJson.workflow : 'default');
        const currentPhase = isNonEmptyString(issueJson.phase) ? issueJson.phase : 'design_draft';

        const workflow = await loadWorkflowByName(workflowName, { workflowsDir: this.workflowsDir });
        const engine = new WorkflowEngine(workflow);
        const effectiveProvider = mapProvider(workflow.phases[currentPhase]?.provider ?? workflow.defaultProvider ?? params.provider);

        // Compute effective model: phase.model ?? workflow.defaultModel ?? (provider default = undefined)
        const effectiveModel = getEffectiveModel(workflow, currentPhase);

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

        const lastRunLog = path.join(this.stateDir!, 'last-run.log');
        let lastSize = 0;
        let lastChangeAtMs = Date.now();
        const startAtMs = Date.now();
        const iterStartedAt = nowIso();

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
          { model: effectiveModel },
        );

        const exitCode = await (async () => {
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

        this.status = { ...this.status, returncode: exitCode };
        this.broadcast('run', { run: this.status });

        await this.archiveIteration({
          iteration,
          workflow: workflowName,
          phase: currentPhase,
          provider: effectiveProvider,
          model: effectiveModel ?? null,
          started_at: iterStartedAt,
          ended_at: nowIso(),
          exit_code: exitCode,
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
        const updatedIssue = this.stateDir ? await readIssueJson(this.stateDir) : null;
        if (updatedIssue) {
          await this.commitDesignDocCheckpoint({ phase: currentPhase, issueJson: updatedIssue });
          const nextPhase = engine.evaluateTransitions(currentPhase, updatedIssue);
          if (nextPhase) {
            updatedIssue.phase = nextPhase;
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
    if (params.phase !== 'design_draft' && params.phase !== 'design_edit') return;

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
    if (!statusLine) return; // already clean + tracked

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
