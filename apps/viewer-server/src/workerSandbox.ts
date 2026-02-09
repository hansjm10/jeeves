/**
 * Worker sandbox creation and cleanup for parallel task execution.
 *
 * This module implements §6.2.3 of the parallel execution design (Issue #78):
 * - Worker state dir: STATE/.runs/<runId>/workers/<taskId>/
 * - Worker worktree dir: WORKTREES/<owner>/<repo>/issue-<N>-workers/<runId>/<taskId>/
 * - .jeeves symlink in worktree pointing to worker state dir
 * - Completion marker files for deterministic resume
 * - Cleanup on success: delete worktree + branch, retain state dir
 * - On failure: retain both worktree and state dir
 */

import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getWorktreesDir } from '@jeeves/core';
import { writeIssueToDb, writeTasksToDb } from '@jeeves/state-db';

import { runGit } from './git.js';
import { ensureJeevesExcludedFromGitStatus } from './gitExclude.js';
import { writeJsonAtomic } from './jsonAtomic.js';
import { writeTextAtomicNew } from './textAtomic.js';

/**
 * Error thrown when a task ID fails validation.
 */
export class InvalidTaskIdError extends Error {
  constructor(
    message: string,
    public readonly taskId: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'InvalidTaskIdError';
  }
}

/**
 * Validates a task ID for safe use in filesystem paths and git refs.
 *
 * Security: Task IDs come from .jeeves/tasks.json and are used directly in:
 * - Filesystem paths (state dir, worktree dir)
 * - Git branch names (issue/<N>-<taskId>)
 *
 * Without validation, a malicious or malformed task ID could:
 * - Escape intended directories via path traversal (e.g., "../../../etc")
 * - Create invalid or confusing git refs
 *
 * Validation rules:
 * 1. Must be a non-empty string
 * 2. Must not contain path separators (/, \)
 * 3. Must not contain .. sequences
 * 4. Must not contain null bytes
 * 5. Must only contain safe characters: alphanumeric, dash, underscore
 * 6. Must not start with a dash (git ref safety)
 * 7. Reasonable length limit (1-128 characters)
 *
 * @param taskId The task ID to validate
 * @throws InvalidTaskIdError if validation fails
 */
export function validateTaskId(taskId: string): void {
  // Rule 1: Non-empty string
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new InvalidTaskIdError(
      'Task ID must be a non-empty string',
      String(taskId),
      'empty',
    );
  }

  // Rule 7: Length limit
  if (taskId.length > 128) {
    throw new InvalidTaskIdError(
      `Task ID exceeds maximum length of 128 characters: ${taskId.substring(0, 20)}...`,
      taskId,
      'too_long',
    );
  }

  // Rule 2: No path separators
  if (taskId.includes('/') || taskId.includes('\\')) {
    throw new InvalidTaskIdError(
      `Task ID contains path separator: ${taskId}`,
      taskId,
      'path_separator',
    );
  }

  // Rule 3: No .. sequences
  if (taskId.includes('..')) {
    throw new InvalidTaskIdError(
      `Task ID contains path traversal sequence: ${taskId}`,
      taskId,
      'path_traversal',
    );
  }

  // Rule 4: No null bytes
  if (taskId.includes('\0')) {
    throw new InvalidTaskIdError(
      `Task ID contains null byte`,
      taskId,
      'null_byte',
    );
  }

  // Rule 5: Only safe characters (alphanumeric, dash, underscore)
  // This is intentionally restrictive to prevent any filesystem or git ref issues
  const safePattern = /^[a-zA-Z0-9_-]+$/;
  if (!safePattern.test(taskId)) {
    throw new InvalidTaskIdError(
      `Task ID contains unsafe characters (only alphanumeric, dash, underscore allowed): ${taskId}`,
      taskId,
      'unsafe_characters',
    );
  }

  // Rule 6: Must not start with a dash (git ref safety)
  if (taskId.startsWith('-')) {
    throw new InvalidTaskIdError(
      `Task ID must not start with a dash: ${taskId}`,
      taskId,
      'starts_with_dash',
    );
  }
}

/**
 * Error thrown when a path-safe ID fails validation.
 */
export class InvalidPathSafeIdError extends Error {
  constructor(
    message: string,
    public readonly id: string,
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'InvalidPathSafeIdError';
  }
}

/**
 * Validates a path-safe ID (runId, waveId) for safe use in filesystem paths.
 *
 * Security: These IDs come from issue.json.status.parallel and are used in:
 * - Filesystem paths (STATE/.runs/<runId>/..., .../waves/<waveId>.json)
 *
 * Without validation, a corrupted or maliciously edited issue.json could:
 * - Escape intended directories via path traversal (e.g., "../../../etc")
 * - Read/write files outside the intended run directory
 *
 * Validation rules (looser than taskId to allow runId format like "20260202T033802Z-12345.ABC123"):
 * 1. Must be a non-empty string
 * 2. Must not contain path separators (/, \)
 * 3. Must not contain .. sequences
 * 4. Must not contain null bytes
 * 5. Must only contain safe characters: alphanumeric, dash, underscore, dot
 * 6. Reasonable length limit (1-256 characters)
 *
 * @param id The ID to validate
 * @param field Name of the field (for error messages)
 * @throws InvalidPathSafeIdError if validation fails
 */
export function validatePathSafeId(id: unknown, field: string): void {
  // Rule 1: Non-empty string
  if (typeof id !== 'string' || id.length === 0) {
    throw new InvalidPathSafeIdError(
      `${field} must be a non-empty string`,
      String(id),
      field,
      'empty',
    );
  }

  // Rule 6: Length limit (256 to accommodate longer waveId format)
  if (id.length > 256) {
    throw new InvalidPathSafeIdError(
      `${field} exceeds maximum length of 256 characters: ${id.substring(0, 20)}...`,
      id,
      field,
      'too_long',
    );
  }

  // Rule 2: No path separators
  if (id.includes('/') || id.includes('\\')) {
    throw new InvalidPathSafeIdError(
      `${field} contains path separator: ${id}`,
      id,
      field,
      'path_separator',
    );
  }

  // Rule 3: No .. sequences
  if (id.includes('..')) {
    throw new InvalidPathSafeIdError(
      `${field} contains path traversal sequence: ${id}`,
      id,
      field,
      'path_traversal',
    );
  }

  // Rule 4: No null bytes
  if (id.includes('\0')) {
    throw new InvalidPathSafeIdError(
      `${field} contains null byte`,
      id,
      field,
      'null_byte',
    );
  }

  // Rule 5: Only safe characters (alphanumeric, dash, underscore, dot)
  // Allows runId format "20260202T033802Z-12345.ABC123"
  // and waveId format "20260202T033802Z-12345.ABC123-wave1-implement_task-20260202T033802Z"
  const safePattern = /^[a-zA-Z0-9_.-]+$/;
  if (!safePattern.test(id)) {
    throw new InvalidPathSafeIdError(
      `${field} contains unsafe characters (only alphanumeric, dash, underscore, dot allowed): ${id}`,
      id,
      field,
      'unsafe_characters',
    );
  }
}

/**
 * Validates a git branch name using git check-ref-format.
 *
 * @param branchName The branch name to validate
 * @param repoDir The repository directory to run git in
 * @throws InvalidTaskIdError if the branch name is invalid
 */
export async function validateGitBranchName(branchName: string, repoDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFileCb(
      'git',
      ['check-ref-format', '--branch', branchName],
      { cwd: repoDir, timeout: 5000 },
      (err) => {
        if (err) {
          reject(new InvalidTaskIdError(
            `Invalid git branch name derived from task ID: ${branchName}`,
            branchName,
            'invalid_git_ref',
          ));
        } else {
          resolve();
        }
      },
    );
  });
}

/** Worker sandbox paths and identifiers */
export interface WorkerSandbox {
  /** Task ID this worker is executing */
  taskId: string;
  /** Run ID this worker belongs to */
  runId: string;
  /** Issue number */
  issueNumber: number;
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Worker state directory (STATE/.runs/<runId>/workers/<taskId>/) */
  stateDir: string;
  /** Worker git worktree directory */
  worktreeDir: string;
  /** Worker branch name (issue/<N>-<taskId>-<shortRunId>) */
  branch: string;
  /** Path to shared repo clone directory */
  repoDir: string;
  /** Canonical issue branch (e.g., issue/78) */
  canonicalBranch: string;
}

/** Options for creating a worker sandbox */
export interface CreateWorkerSandboxOptions {
  /** Task ID to create sandbox for */
  taskId: string;
  /** Run ID for this execution wave */
  runId: string;
  /** Issue number */
  issueNumber: number;
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Canonical issue state directory */
  canonicalStateDir: string;
  /** Path to shared repo clone directory */
  repoDir: string;
  /** Jeeves data directory */
  dataDir: string;
  /** Canonical issue branch (e.g., issue/78) */
  canonicalBranch: string;
  /** Canonical issue.json content to copy (with modifications) */
  canonicalIssueJson: Record<string, unknown>;
  /** Canonical tasks.json content to copy */
  canonicalTasksJson: Record<string, unknown>;
  /** Optional: path to task feedback file for retry */
  taskFeedbackPath?: string;
}

/** Result of worker sandbox creation */
export interface CreateWorkerSandboxResult {
  sandbox: WorkerSandbox;
  /** Whether the worktree was created fresh (vs reused from prior run) */
  createdFresh: boolean;
}

/**
 * Creates paths for a worker sandbox without creating any files.
 * Useful for computing paths before creation or for cleanup.
 *
 * @throws InvalidTaskIdError if taskId contains unsafe characters
 */
export function getWorkerSandboxPaths(params: {
  taskId: string;
  runId: string;
  issueNumber: number;
  owner: string;
  repo: string;
  canonicalStateDir: string;
  repoDir: string;
  dataDir: string;
  canonicalBranch: string;
}): WorkerSandbox {
  const { taskId, runId, issueNumber, owner, repo, canonicalStateDir, repoDir, dataDir, canonicalBranch } = params;

  // SECURITY: Validate taskId before using in paths/refs to prevent path traversal
  // and invalid git refs. This is the centralized validation point for all taskId usage.
  validateTaskId(taskId);

  // Worker state dir: STATE/.runs/<runId>/workers/<taskId>/
  const stateDir = path.join(canonicalStateDir, '.runs', runId, 'workers', taskId);

  // Worker worktree dir: WORKTREES/<owner>/<repo>/issue-<N>-workers/<runId>/<taskId>/
  const worktreesDir = getWorktreesDir(dataDir);
  const worktreeDir = path.join(worktreesDir, owner, repo, `issue-${issueNumber}-workers`, runId, taskId);

  // Worker branch name: issue/<N>-<taskId>-<shortRunId>
  // Include shortRunId (random suffix from runId) to ensure uniqueness across runs,
  // preventing conflicts when a prior run's failed worktree retains the branch checked out.
  // The runId format is "20260203T213123Z-12345.ABC123" where ABC123 is a base64url-encoded
  // random suffix. We extract the random part (after the '.') for uniqueness.
  const dotIndex = runId.lastIndexOf('.');
  const shortRunId = dotIndex !== -1 ? runId.slice(dotIndex + 1) : runId.slice(0, 8);
  const branch = `issue/${issueNumber}-${taskId}-${shortRunId}`;

  return {
    taskId,
    runId,
    issueNumber,
    owner,
    repo,
    stateDir,
    worktreeDir,
    branch,
    repoDir,
    canonicalBranch,
  };
}

/**
 * Creates a worker sandbox for parallel task execution.
 *
 * Per §6.2.3:
 * 1. Create worker state directory with:
 *    - issue.json (copy with currentTaskId set, task-loop flags cleared)
 *    - tasks.json (copy of canonical)
 *    - Optional: task-feedback.md for retries
 * 2. Create worker git worktree:
 *    - Branch: issue/<N>-<taskId>-<shortRunId>
 *    - Based on canonical issue branch HEAD
 * 3. Create .jeeves symlink in worktree pointing to worker state dir
 */
export async function createWorkerSandbox(options: CreateWorkerSandboxOptions): Promise<CreateWorkerSandboxResult> {
  const sandbox = getWorkerSandboxPaths({
    taskId: options.taskId,
    runId: options.runId,
    issueNumber: options.issueNumber,
    owner: options.owner,
    repo: options.repo,
    canonicalStateDir: options.canonicalStateDir,
    repoDir: options.repoDir,
    dataDir: options.dataDir,
    canonicalBranch: options.canonicalBranch,
  });

  // 1. Create worker state directory
  await fs.mkdir(sandbox.stateDir, { recursive: true });

  // 1a. Create worker issue.json with currentTaskId set and task-loop flags cleared
  const workerIssueJson = createWorkerIssueJson(options.canonicalIssueJson, options.taskId);
  await writeJsonAtomic(path.join(sandbox.stateDir, 'issue.json'), workerIssueJson);
  writeIssueToDb(sandbox.stateDir, workerIssueJson);

  // 1b. Copy canonical tasks.json
  await writeJsonAtomic(path.join(sandbox.stateDir, 'tasks.json'), options.canonicalTasksJson);
  writeTasksToDb(sandbox.stateDir, options.canonicalTasksJson);

  // 1c. Optional: copy task feedback for retries
  if (options.taskFeedbackPath) {
    const feedbackExists = await fs
      .stat(options.taskFeedbackPath)
      .then((s) => s.isFile())
      .catch(() => false);
    if (feedbackExists) {
      const feedback = await fs.readFile(options.taskFeedbackPath, 'utf-8');
      await fs.writeFile(path.join(sandbox.stateDir, 'task-feedback.md'), feedback, 'utf-8');
    }
  }

  // 2. Create worker git worktree
  const createdFresh = true;

  // Check if worktree already exists (from prior run)
  const worktreeExists = await fs
    .stat(sandbox.worktreeDir)
    .then(() => true)
    .catch(() => false);

  if (worktreeExists) {
    // Remove existing worktree (force removal from prior run)
    await runGit(['-C', sandbox.repoDir, 'worktree', 'remove', '--force', sandbox.worktreeDir]).catch(() => {
      // Worktree may not be registered, try rm directly
    });
    await fs.rm(sandbox.worktreeDir, { recursive: true, force: true });
  }

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(sandbox.worktreeDir), { recursive: true });

  // Create worktree on a new branch based on canonical branch
  // git -C <REPO> worktree add -B <workerBranch> <workerWorktreeDir> <canonicalBranch>
  await runGit([
    '-C',
    sandbox.repoDir,
    'worktree',
    'add',
    '-B',
    sandbox.branch,
    sandbox.worktreeDir,
    sandbox.canonicalBranch,
  ]);

  // 3. Create .jeeves symlink in worktree pointing to worker state dir
  const linkPath = path.join(sandbox.worktreeDir, '.jeeves');
  await fs.rm(linkPath, { recursive: true, force: true }).catch(() => void 0);

  const type: 'dir' | 'junction' = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(sandbox.stateDir, linkPath, type);

  // 4. Ensure .jeeves is excluded from git status in worker worktree
  await ensureJeevesExcludedFromGitStatus(sandbox.worktreeDir).catch(() => void 0);

  return { sandbox, createdFresh };
}

/**
 * Creates worker issue.json with currentTaskId set and task-loop flags cleared.
 *
 * Per §6.2.3:
 * - status.currentTaskId = <taskId>
 * - Clear task-loop flags: taskPassed, taskFailed, commitFailed, pushFailed, hasMoreTasks, allTasksComplete
 */
function createWorkerIssueJson(canonicalIssueJson: Record<string, unknown>, taskId: string): Record<string, unknown> {
  // Deep clone to avoid mutating the original
  const workerIssue = JSON.parse(JSON.stringify(canonicalIssueJson)) as Record<string, unknown>;

  // Ensure status object exists
  if (!workerIssue.status || typeof workerIssue.status !== 'object') {
    workerIssue.status = {};
  }

  const status = workerIssue.status as Record<string, unknown>;

  // Set currentTaskId
  status.currentTaskId = taskId;

  // Clear task-loop flags that can be stale
  delete status.taskPassed;
  delete status.taskFailed;
  delete status.commitFailed;
  delete status.pushFailed;
  delete status.hasMoreTasks;
  delete status.allTasksComplete;

  return workerIssue;
}

/**
 * Path to the implement_task completion marker file.
 */
export function getImplementDoneMarkerPath(sandbox: WorkerSandbox): string {
  return path.join(sandbox.stateDir, 'implement_task.done');
}

/**
 * Path to the task_spec_check completion marker file.
 */
export function getSpecCheckDoneMarkerPath(sandbox: WorkerSandbox): string {
  return path.join(sandbox.stateDir, 'task_spec_check.done');
}

/**
 * Creates a completion marker file atomically.
 *
 * Per §6.2.3: A marker file is a zero-byte file created atomically
 * (write temp + rename) so existence is a reliable signal.
 */
export async function createCompletionMarker(markerPath: string): Promise<void> {
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await writeTextAtomicNew(markerPath, '');
}

/**
 * Checks if a completion marker exists.
 */
export async function hasCompletionMarker(markerPath: string): Promise<boolean> {
  return fs
    .stat(markerPath)
    .then(() => true)
    .catch(() => false);
}

/**
 * Cleans up a worker sandbox after successful completion.
 *
 * Per §6.2.3:
 * - On success: Delete worker git worktree and branch, retain state dir
 */
export async function cleanupWorkerSandboxOnSuccess(sandbox: WorkerSandbox): Promise<void> {
  // 1. Remove the git worktree
  await runGit(['-C', sandbox.repoDir, 'worktree', 'remove', '--force', sandbox.worktreeDir]).catch(() => {
    // Worktree may not exist or already removed
  });

  // 2. Clean up worktree directory if still exists
  await fs.rm(sandbox.worktreeDir, { recursive: true, force: true }).catch(() => void 0);

  // 3. Delete the worker branch (to reduce repo clutter)
  await runGit(['-C', sandbox.repoDir, 'branch', '-D', sandbox.branch]).catch(() => {
    // Branch may not exist or already deleted
  });

  // 4. State dir is retained for observability (do not delete)
}

/**
 * Cleanup behavior for worker sandbox after failure or timeout.
 *
 * Per §6.2.3:
 * - On failure/timeout: Retain both worktree and state dir for debugging
 *
 * This is a no-op function that documents the retention policy.
 * The caller already has the sandbox reference and should simply not clean it up.
 */
export function cleanupWorkerSandboxOnFailure(): void {
  // This function intentionally does nothing.
  // Worker state directory is retained for debugging.
  // Worker git worktree directory and branch are retained for debugging/manual remediation.
}

/**
 * Gets the worker's issue.json from its state directory.
 */
export async function readWorkerIssueJson(sandbox: WorkerSandbox): Promise<Record<string, unknown> | null> {
  const issueFile = path.join(sandbox.stateDir, 'issue.json');
  try {
    const raw = await fs.readFile(issueFile, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Gets the worker's tasks.json from its state directory.
 */
export async function readWorkerTasksJson(sandbox: WorkerSandbox): Promise<Record<string, unknown> | null> {
  const tasksFile = path.join(sandbox.stateDir, 'tasks.json');
  try {
    const raw = await fs.readFile(tasksFile, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Error thrown when worker sandbox cannot be reused */
export class WorkerSandboxReuseError extends Error {
  constructor(
    message: string,
    public readonly taskId: string,
    public readonly reason: 'state_dir_missing' | 'worktree_missing' | 'branch_missing' | 'worktree_attach_failed',
  ) {
    super(message);
    this.name = 'WorkerSandboxReuseError';
  }
}

/** Options for reusing an existing worker sandbox */
export interface ReuseWorkerSandboxOptions {
  /** Task ID to reuse sandbox for */
  taskId: string;
  /** Run ID for this execution wave */
  runId: string;
  /** Issue number */
  issueNumber: number;
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Canonical issue state directory */
  canonicalStateDir: string;
  /** Path to shared repo clone directory */
  repoDir: string;
  /** Jeeves data directory */
  dataDir: string;
  /** Canonical issue branch (e.g., issue/78) */
  canonicalBranch: string;
}

/**
 * Reuses an existing worker sandbox for spec-check phase.
 *
 * This function verifies that the worker sandbox created during implement_task
 * still exists and is usable, then ensures the .jeeves symlink is in place.
 * Unlike createWorkerSandbox(), this function does NOT reset the worker branch -
 * the spec-check phase must see the changes made during implement_task.
 *
 * Per reviewer feedback: spec-check must reuse the existing worker branch/worktree
 * created during implement. If the worktree needs to be re-attached, use
 * `git worktree add <dir> <existingWorkerBranch>` (never `-B`).
 *
 * @throws WorkerSandboxReuseError if sandbox cannot be reused
 */
export async function reuseWorkerSandbox(options: ReuseWorkerSandboxOptions): Promise<WorkerSandbox> {
  const sandbox = getWorkerSandboxPaths({
    taskId: options.taskId,
    runId: options.runId,
    issueNumber: options.issueNumber,
    owner: options.owner,
    repo: options.repo,
    canonicalStateDir: options.canonicalStateDir,
    repoDir: options.repoDir,
    dataDir: options.dataDir,
    canonicalBranch: options.canonicalBranch,
  });

  // 1. Verify worker state directory exists
  const stateDirExists = await fs
    .stat(sandbox.stateDir)
    .then((s) => s.isDirectory())
    .catch(() => false);

  if (!stateDirExists) {
    throw new WorkerSandboxReuseError(
      `Worker state directory does not exist: ${sandbox.stateDir}`,
      options.taskId,
      'state_dir_missing',
    );
  }

  // 2. Check if worktree exists
  const worktreeExists = await fs
    .stat(sandbox.worktreeDir)
    .then((s) => s.isDirectory())
    .catch(() => false);

  // 3. Check if worker branch exists in git
  const branchExists = await runGit(['-C', sandbox.repoDir, 'rev-parse', '--verify', `refs/heads/${sandbox.branch}`])
    .then(() => true)
    .catch(() => false);

  if (!branchExists) {
    throw new WorkerSandboxReuseError(
      `Worker branch does not exist: ${sandbox.branch}`,
      options.taskId,
      'branch_missing',
    );
  }

  // 4. If worktree doesn't exist but branch does, re-attach the worktree
  //    IMPORTANT: Use `git worktree add <dir> <branch>` (without -B) to avoid resetting the branch
  if (!worktreeExists) {
    // Ensure parent directory exists
    await fs.mkdir(path.dirname(sandbox.worktreeDir), { recursive: true });

    try {
      // Re-attach worktree to existing branch (DO NOT use -B which would reset the branch)
      await runGit([
        '-C',
        sandbox.repoDir,
        'worktree',
        'add',
        sandbox.worktreeDir,
        sandbox.branch,
      ]);
    } catch (err) {
      throw new WorkerSandboxReuseError(
        `Failed to re-attach worktree for branch ${sandbox.branch}: ${err instanceof Error ? err.message : String(err)}`,
        options.taskId,
        'worktree_attach_failed',
      );
    }
  }

  // 5. Ensure .jeeves symlink exists and points to worker state dir
  const linkPath = path.join(sandbox.worktreeDir, '.jeeves');
  await fs.rm(linkPath, { recursive: true, force: true }).catch(() => void 0);

  const type: 'dir' | 'junction' = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(sandbox.stateDir, linkPath, type);

  // 6. Ensure .jeeves is excluded from git status in worker worktree
  await ensureJeevesExcludedFromGitStatus(sandbox.worktreeDir).catch(() => void 0);

  return sandbox;
}
