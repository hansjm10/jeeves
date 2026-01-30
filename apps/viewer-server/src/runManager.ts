import { spawn as spawnDefault, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { WorkflowEngine, getIssueStateDir, getWorktreePath, loadWorkflowByName, parseIssueRef } from '@jeeves/core';

import type { RunStatus } from './types.js';
import { readIssueJson, writeIssueJson } from './issueJson.js';
import { writeJsonAtomic } from './jsonAtomic.js';

function nowIso(): string {
  return new Date().toISOString();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

function mapProvider(value: unknown): 'claude' | 'fake' {
  if (!isNonEmptyString(value)) return 'claude';
  const v = value.trim().toLowerCase();
  if (v === 'fake') return 'fake';
  if (v === 'claude' || v === 'claude-agent-sdk' || v === 'claude_agent_sdk') return 'claude';
  return 'claude';
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
    this.status = {
      running: true,
      pid: null,
      started_at: nowIso(),
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

  async stop(params?: { force?: boolean }): Promise<RunStatus> {
    const force = Boolean(params?.force ?? false);
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

  private async spawnRunner(args: string[], viewerLogPath: string): Promise<number> {
    const runnerBin = path.join(this.repoRoot, 'packages', 'runner', 'dist', 'bin.js');
    if (!(await pathExists(runnerBin))) {
      throw new Error(`Runner binary not found at ${runnerBin}. Run: pnpm --filter @jeeves/runner build`);
    }

    const cmd = process.execPath;
    const fullArgs = [runnerBin, ...args];
    this.status = { ...this.status, command: `${cmd} ${fullArgs.join(' ')}` };
    this.broadcast('run', { run: this.status });

    await this.appendViewerLog(viewerLogPath, `[RUNNER] ${this.status.command}`);

    const env = { ...process.env, JEEVES_DATA_DIR: this.dataDir };
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
      proc.once('exit', (code) => resolve(code ?? 0));
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
        const content = (m as { content?: unknown }).content;
        if (typeof content === 'string' && content.includes('<promise>COMPLETE</promise>')) return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  private async runLoop(params: {
    provider: 'claude' | 'fake';
    maxIterations: number;
    inactivityTimeoutSec: number;
    iterationTimeoutSec: number;
    workflowOverride: string | null;
    viewerLogPath: string;
  }): Promise<void> {
    const { viewerLogPath } = params;
    try {
      for (let iteration = 1; iteration <= params.maxIterations; iteration += 1) {
        if (this.stopRequested) {
          await this.appendViewerLog(viewerLogPath, `[ITERATION] Stop requested, ending at iteration ${iteration}`);
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

        const exitPromise = this.spawnRunner(
          [
            'run-phase',
            '--workflow',
            workflowName,
            '--phase',
            currentPhase,
            '--provider',
            params.provider,
            '--workflows-dir',
            this.workflowsDir,
            '--prompts-dir',
            this.promptsDir,
            '--issue',
            this.issueRef!,
          ],
          viewerLogPath,
        );

        const exitCode = await (async () => {
          while (true) {
            if (this.stopRequested) break;
            const elapsedSec = (Date.now() - startAtMs) / 1000;
            if (elapsedSec > params.iterationTimeoutSec) {
              await this.appendViewerLog(viewerLogPath, `[TIMEOUT] Iteration exceeded ${params.iterationTimeoutSec}s; stopping`);
              await this.stop({ force: true });
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
              await this.stop({ force: true });
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

        // Advance phase via workflow transitions (viewer-server owns orchestration)
        const updatedIssue = this.stateDir ? await readIssueJson(this.stateDir) : null;
        if (updatedIssue) {
          const nextPhase = engine.evaluateTransitions(currentPhase, updatedIssue);
          if (nextPhase) {
            updatedIssue.phase = nextPhase;
            await writeIssueJson(this.stateDir!, updatedIssue);
            this.broadcast('state', await this.getStateSnapshot());

            if (engine.isTerminal(nextPhase)) {
              await this.appendViewerLog(viewerLogPath, `[COMPLETE] Reached terminal phase: ${nextPhase}`);
              this.status = {
                ...this.status,
                completed_via_state: true,
                completion_reason: `reached terminal phase: ${nextPhase}`,
              };
              this.broadcast('run', { run: this.status });
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
          break;
        }

        if (exitCode !== 0) {
          await this.appendViewerLog(viewerLogPath, `[ITERATION] Iteration ${iteration} exited with code ${exitCode}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      this.status = { ...this.status, last_error: msg };
      this.broadcast('run', { run: this.status });
      if (this.status.viewer_log_file) await this.appendViewerLog(this.status.viewer_log_file, `[ERROR] ${msg}`);
    } finally {
      this.proc = null;
      this.status = { ...this.status, running: false, ended_at: nowIso(), pid: null };
      this.broadcast('run', { run: this.status });
      await this.persistLastRunStatus().catch(() => void 0);
    }
  }

  private async persistLastRunStatus(): Promise<void> {
    if (!this.stateDir) return;
    const outPath = path.join(this.stateDir, 'viewer-run-status.json');
    await writeJsonAtomic(outPath, this.status);
  }
}
