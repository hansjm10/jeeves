import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupWorkerSandboxOnFailure,
  cleanupWorkerSandboxOnSuccess,
  createCompletionMarker,
  createWorkerSandbox,
  getImplementDoneMarkerPath,
  getSpecCheckDoneMarkerPath,
  getWorkerSandboxPaths,
  hasCompletionMarker,
  readWorkerIssueJson,
  readWorkerTasksJson,
  reuseWorkerSandbox,
  WorkerSandboxReuseError,
  type WorkerSandbox,
} from './workerSandbox.js';

// Mock git operations
vi.mock('./git.js', () => ({
  runGit: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

// Mock gitExclude
vi.mock('./gitExclude.js', () => ({
  ensureJeevesExcludedFromGitStatus: vi.fn().mockResolvedValue(undefined),
}));

describe('workerSandbox', () => {
  let tmpDir: string;
  let dataDir: string;
  let canonicalStateDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jeeves-worker-sandbox-test-'));
    dataDir = path.join(tmpDir, 'data');
    canonicalStateDir = path.join(dataDir, 'issues', 'owner', 'repo', '42');
    repoDir = path.join(dataDir, 'repos', 'owner', 'repo');

    // Create directories
    await fs.mkdir(canonicalStateDir, { recursive: true });
    await fs.mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('getWorkerSandboxPaths', () => {
    it('computes correct worker state directory path', () => {
      const paths = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      expect(paths.stateDir).toBe(path.join(canonicalStateDir, '.runs', 'run-123', 'workers', 'T1'));
    });

    it('computes correct worker worktree directory path', () => {
      const paths = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      // WORKTREES/<owner>/<repo>/issue-<N>-workers/<runId>/<taskId>/
      expect(paths.worktreeDir).toBe(
        path.join(dataDir, 'worktrees', 'owner', 'repo', 'issue-42-workers', 'run-123', 'T1'),
      );
    });

    it('computes correct worker branch name using random suffix from runId', () => {
      // Use realistic runId format: "20260203T213123Z-12345.ABC123"
      const paths = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: '20260203T213123Z-12345.ABC123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      // Branch includes shortRunId (random suffix after '.') for uniqueness across runs
      expect(paths.branch).toBe('issue/42-T1-ABC123');
    });

    it('produces unique branch names for different runIds on the same day', () => {
      // Regression test: Two runs on the same day with same timestamp prefix but different
      // random suffixes must produce different branch names to avoid worktree conflicts.
      const runId1 = '20260203T213123Z-12345.ABC123';
      const runId2 = '20260203T213123Z-12345.XYZ789';

      const paths1 = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: runId1,
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      const paths2 = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: runId2,
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      // Must have different branch names
      expect(paths1.branch).not.toBe(paths2.branch);
      expect(paths1.branch).toBe('issue/42-T1-ABC123');
      expect(paths2.branch).toBe('issue/42-T1-XYZ789');
    });

    it('falls back to first 8 chars if runId has no dot', () => {
      // Legacy/non-standard runId format without a dot
      const paths = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-12345',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      // Falls back to first 8 chars when no dot is present
      expect(paths.branch).toBe('issue/42-T1-run-1234');
    });

    it('includes all required fields in returned sandbox', () => {
      const paths = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      expect(paths.taskId).toBe('T1');
      expect(paths.runId).toBe('run-123');
      expect(paths.issueNumber).toBe(42);
      expect(paths.owner).toBe('owner');
      expect(paths.repo).toBe('repo');
      expect(paths.repoDir).toBe(repoDir);
      expect(paths.canonicalBranch).toBe('issue/42');
    });
  });

  describe('createWorkerSandbox', () => {
    const canonicalIssueJson = {
      schemaVersion: 1,
      repo: 'owner/repo',
      issue: { number: 42, repo: 'owner/repo' },
      branch: 'issue/42',
      phase: 'implement_task',
      workflow: 'default',
      notes: '',
      status: {
        currentTaskId: 'T0',
        taskPassed: true,
        taskFailed: false,
        hasMoreTasks: true,
      },
    };

    const canonicalTasksJson = {
      schemaVersion: 1,
      tasks: [
        { id: 'T1', title: 'Task 1', status: 'pending' },
        { id: 'T2', title: 'Task 2', status: 'pending' },
      ],
    };

    it('creates worker state directory', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);

      // Make git worktree add work by creating the directory
      mockRunGit.mockImplementation(async (args) => {
        if (args.includes('worktree') && args.includes('add')) {
          const worktreeDirIndex = args.indexOf('add') + 3; // -B branch dir canonical
          const worktreeDir = args[worktreeDirIndex];
          if (typeof worktreeDir === 'string') {
            await fs.mkdir(worktreeDir, { recursive: true });
          }
        }
        return { stdout: '', stderr: '' };
      });

      const result = await createWorkerSandbox({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
        canonicalIssueJson,
        canonicalTasksJson,
      });

      const stateDirExists = await fs
        .stat(result.sandbox.stateDir)
        .then(() => true)
        .catch(() => false);
      expect(stateDirExists).toBe(true);
    });

    it('creates worker issue.json with currentTaskId set and flags cleared', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);

      mockRunGit.mockImplementation(async (args) => {
        if (args.includes('worktree') && args.includes('add')) {
          const worktreeDirIndex = args.indexOf('add') + 3;
          const worktreeDir = args[worktreeDirIndex];
          if (typeof worktreeDir === 'string') {
            await fs.mkdir(worktreeDir, { recursive: true });
          }
        }
        return { stdout: '', stderr: '' };
      });

      const result = await createWorkerSandbox({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
        canonicalIssueJson,
        canonicalTasksJson,
      });

      const workerIssue = await readWorkerIssueJson(result.sandbox);
      expect(workerIssue).not.toBeNull();
      expect((workerIssue!.status as Record<string, unknown>).currentTaskId).toBe('T1');

      // Verify flags are cleared
      const status = workerIssue!.status as Record<string, unknown>;
      expect(status.taskPassed).toBeUndefined();
      expect(status.taskFailed).toBeUndefined();
      expect(status.hasMoreTasks).toBeUndefined();
    });

    it('creates worker tasks.json as copy of canonical', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);

      mockRunGit.mockImplementation(async (args) => {
        if (args.includes('worktree') && args.includes('add')) {
          const worktreeDirIndex = args.indexOf('add') + 3;
          const worktreeDir = args[worktreeDirIndex];
          if (typeof worktreeDir === 'string') {
            await fs.mkdir(worktreeDir, { recursive: true });
          }
        }
        return { stdout: '', stderr: '' };
      });

      const result = await createWorkerSandbox({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
        canonicalIssueJson,
        canonicalTasksJson,
      });

      const workerTasks = await readWorkerTasksJson(result.sandbox);
      expect(workerTasks).toEqual(canonicalTasksJson);
    });

    it('creates .jeeves symlink in worktree pointing to worker state dir', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);

      mockRunGit.mockImplementation(async (args) => {
        if (args.includes('worktree') && args.includes('add')) {
          const worktreeDirIndex = args.indexOf('add') + 3;
          const worktreeDir = args[worktreeDirIndex];
          if (typeof worktreeDir === 'string') {
            await fs.mkdir(worktreeDir, { recursive: true });
          }
        }
        return { stdout: '', stderr: '' };
      });

      const result = await createWorkerSandbox({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
        canonicalIssueJson,
        canonicalTasksJson,
      });

      const linkPath = path.join(result.sandbox.worktreeDir, '.jeeves');
      const linkTarget = await fs.readlink(linkPath);
      expect(linkTarget).toBe(result.sandbox.stateDir);
    });

    it('calls git worktree add with correct arguments', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);

      mockRunGit.mockImplementation(async (args) => {
        if (args.includes('worktree') && args.includes('add')) {
          const worktreeDirIndex = args.indexOf('add') + 3;
          const worktreeDir = args[worktreeDirIndex];
          if (typeof worktreeDir === 'string') {
            await fs.mkdir(worktreeDir, { recursive: true });
          }
        }
        return { stdout: '', stderr: '' };
      });

      await createWorkerSandbox({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
        canonicalIssueJson,
        canonicalTasksJson,
      });

      const worktreeAddCall = mockRunGit.mock.calls.find(
        (call) => call[0].includes('worktree') && call[0].includes('add'),
      );
      expect(worktreeAddCall).toBeDefined();

      const args = worktreeAddCall![0];
      expect(args).toContain('-C');
      expect(args).toContain(repoDir);
      expect(args).toContain('worktree');
      expect(args).toContain('add');
      expect(args).toContain('-B');
      expect(args).toContain('issue/42-T1-run-123'); // worker branch (includes short runId)
      expect(args).toContain('issue/42'); // canonical branch
    });

    it('copies task feedback for retries when provided', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);

      mockRunGit.mockImplementation(async (args) => {
        if (args.includes('worktree') && args.includes('add')) {
          const worktreeDirIndex = args.indexOf('add') + 3;
          const worktreeDir = args[worktreeDirIndex];
          if (typeof worktreeDir === 'string') {
            await fs.mkdir(worktreeDir, { recursive: true });
          }
        }
        return { stdout: '', stderr: '' };
      });

      // Create feedback file
      const feedbackDir = path.join(canonicalStateDir, 'task-feedback');
      await fs.mkdir(feedbackDir, { recursive: true });
      const feedbackPath = path.join(feedbackDir, 'T1.md');
      await fs.writeFile(feedbackPath, '# Retry feedback for T1\n\n- Fix issue X', 'utf-8');

      const result = await createWorkerSandbox({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
        canonicalIssueJson,
        canonicalTasksJson,
        taskFeedbackPath: feedbackPath,
      });

      const workerFeedbackPath = path.join(result.sandbox.stateDir, 'task-feedback.md');
      const feedback = await fs.readFile(workerFeedbackPath, 'utf-8');
      expect(feedback).toContain('Retry feedback for T1');
    });
  });

  describe('completion markers', () => {
    let sandbox: WorkerSandbox;

    beforeEach(() => {
      sandbox = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });
    });

    describe('getImplementDoneMarkerPath', () => {
      it('returns correct path for implement_task marker', () => {
        const markerPath = getImplementDoneMarkerPath(sandbox);
        expect(markerPath).toBe(path.join(sandbox.stateDir, 'implement_task.done'));
      });
    });

    describe('getSpecCheckDoneMarkerPath', () => {
      it('returns correct path for task_spec_check marker', () => {
        const markerPath = getSpecCheckDoneMarkerPath(sandbox);
        expect(markerPath).toBe(path.join(sandbox.stateDir, 'task_spec_check.done'));
      });
    });

    describe('createCompletionMarker', () => {
      it('creates marker file at specified path', async () => {
        await fs.mkdir(sandbox.stateDir, { recursive: true });
        const markerPath = getImplementDoneMarkerPath(sandbox);

        await createCompletionMarker(markerPath);

        const exists = await fs
          .stat(markerPath)
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(true);
      });

      it('creates marker file as zero-byte file', async () => {
        await fs.mkdir(sandbox.stateDir, { recursive: true });
        const markerPath = getImplementDoneMarkerPath(sandbox);

        await createCompletionMarker(markerPath);

        const stat = await fs.stat(markerPath);
        expect(stat.size).toBe(0);
      });
    });

    describe('hasCompletionMarker', () => {
      it('returns true when marker exists', async () => {
        await fs.mkdir(sandbox.stateDir, { recursive: true });
        const markerPath = getImplementDoneMarkerPath(sandbox);
        await createCompletionMarker(markerPath);

        const exists = await hasCompletionMarker(markerPath);
        expect(exists).toBe(true);
      });

      it('returns false when marker does not exist', async () => {
        const markerPath = getImplementDoneMarkerPath(sandbox);

        const exists = await hasCompletionMarker(markerPath);
        expect(exists).toBe(false);
      });
    });
  });

  describe('cleanupWorkerSandboxOnSuccess', () => {
    it('calls git worktree remove with correct arguments', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);

      const sandbox = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      await cleanupWorkerSandboxOnSuccess(sandbox);

      const removeCall = mockRunGit.mock.calls.find(
        (call) => call[0].includes('worktree') && call[0].includes('remove'),
      );
      expect(removeCall).toBeDefined();

      const args = removeCall![0];
      expect(args).toContain('-C');
      expect(args).toContain(repoDir);
      expect(args).toContain('worktree');
      expect(args).toContain('remove');
      expect(args).toContain('--force');
      expect(args).toContain(sandbox.worktreeDir);
    });

    it('calls git branch -D to delete worker branch', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);

      const sandbox = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      await cleanupWorkerSandboxOnSuccess(sandbox);

      const branchDeleteCall = mockRunGit.mock.calls.find(
        (call) => call[0].includes('branch') && call[0].includes('-D'),
      );
      expect(branchDeleteCall).toBeDefined();

      const args = branchDeleteCall![0];
      expect(args).toContain('-C');
      expect(args).toContain(repoDir);
      expect(args).toContain('branch');
      expect(args).toContain('-D');
      expect(args).toContain('issue/42-T1-run-123');
    });

    it('does not delete worker state directory', async () => {
      const sandbox = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      // Create state directory with a file
      await fs.mkdir(sandbox.stateDir, { recursive: true });
      await fs.writeFile(path.join(sandbox.stateDir, 'test.txt'), 'test', 'utf-8');

      await cleanupWorkerSandboxOnSuccess(sandbox);

      // State dir should still exist
      const stateDirExists = await fs
        .stat(sandbox.stateDir)
        .then(() => true)
        .catch(() => false);
      expect(stateDirExists).toBe(true);

      // File in state dir should still exist
      const testFile = await fs.readFile(path.join(sandbox.stateDir, 'test.txt'), 'utf-8');
      expect(testFile).toBe('test');
    });
  });

  describe('cleanupWorkerSandboxOnFailure', () => {
    it('does not delete worker state directory (retains for debugging)', async () => {
      const sandbox = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      // Create state directory with a file
      await fs.mkdir(sandbox.stateDir, { recursive: true });
      await fs.writeFile(path.join(sandbox.stateDir, 'test.txt'), 'test', 'utf-8');

      // Call cleanup (no-op by design)
      cleanupWorkerSandboxOnFailure();

      // State dir should still exist
      const stateDirExists = await fs
        .stat(sandbox.stateDir)
        .then(() => true)
        .catch(() => false);
      expect(stateDirExists).toBe(true);
    });

    it('does not call git to remove worktree or branch', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);
      mockRunGit.mockClear();

      // Call cleanup (no-op by design)
      cleanupWorkerSandboxOnFailure();

      // Should not have called git at all
      expect(mockRunGit).not.toHaveBeenCalled();
    });
  });

  describe('reuseWorkerSandbox', () => {
    it('throws WorkerSandboxReuseError if state directory does not exist', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);
      mockRunGit.mockClear();

      const error = await reuseWorkerSandbox({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      }).catch((e) => e);

      expect(error).toBeInstanceOf(WorkerSandboxReuseError);
      expect((error as WorkerSandboxReuseError).reason).toBe('state_dir_missing');
    });

    it('throws WorkerSandboxReuseError if branch does not exist', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);
      mockRunGit.mockClear();

      // Mock git to fail rev-parse (branch doesn't exist)
      mockRunGit.mockRejectedValueOnce(new Error('fatal: Needed a single revision'));

      // Create state directory
      const sandbox = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });
      await fs.mkdir(sandbox.stateDir, { recursive: true });

      await expect(
        reuseWorkerSandbox({
          taskId: 'T1',
          runId: 'run-123',
          issueNumber: 42,
          owner: 'owner',
          repo: 'repo',
          canonicalStateDir,
          repoDir,
          dataDir,
          canonicalBranch: 'issue/42',
        }),
      ).rejects.toThrow(WorkerSandboxReuseError);
    });

    it('re-attaches worktree without -B flag when worktree is missing but branch exists', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);
      mockRunGit.mockClear();

      // Create state directory
      const sandbox = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });
      await fs.mkdir(sandbox.stateDir, { recursive: true });

      // Mock git rev-parse to succeed (branch exists)
      mockRunGit.mockResolvedValueOnce({ stdout: 'abc123', stderr: '' });
      // Mock git worktree add to succeed - note: this creates the worktree dir
      mockRunGit.mockImplementationOnce(async (args) => {
        // Simulate git worktree add creating the directory
        if (args.includes('worktree') && args.includes('add')) {
          await fs.mkdir(sandbox.worktreeDir, { recursive: true });
        }
        return { stdout: '', stderr: '' };
      });

      // Do NOT create worktree directory - let the function detect it's missing and re-attach

      const result = await reuseWorkerSandbox({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      // Verify git worktree add was called WITHOUT -B flag
      const worktreeAddCall = mockRunGit.mock.calls.find(
        (call) => call[0].includes('worktree') && call[0].includes('add'),
      );
      expect(worktreeAddCall).toBeDefined();

      const args = worktreeAddCall![0];
      expect(args).not.toContain('-B');
      expect(args).toContain('worktree');
      expect(args).toContain('add');
      expect(args).toContain(sandbox.worktreeDir);
      expect(args).toContain(sandbox.branch);

      expect(result.taskId).toBe('T1');
      expect(result.branch).toBe('issue/42-T1-run-123');
    });

    it('reuses existing worktree when both worktree and branch exist', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);
      mockRunGit.mockClear();

      // Create state directory
      const sandbox = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });
      await fs.mkdir(sandbox.stateDir, { recursive: true });

      // Create worktree directory (simulating existing worktree)
      await fs.mkdir(sandbox.worktreeDir, { recursive: true });

      // Mock git rev-parse to succeed (branch exists)
      mockRunGit.mockResolvedValueOnce({ stdout: 'abc123', stderr: '' });

      const result = await reuseWorkerSandbox({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      // Should NOT call git worktree add since worktree already exists
      const worktreeAddCall = mockRunGit.mock.calls.find(
        (call) => call[0].includes('worktree') && call[0].includes('add'),
      );
      expect(worktreeAddCall).toBeUndefined();

      expect(result.taskId).toBe('T1');
      expect(result.branch).toBe('issue/42-T1-run-123');
    });

    it('creates .jeeves symlink pointing to state directory', async () => {
      const { runGit } = await import('./git.js');
      const mockRunGit = vi.mocked(runGit);
      mockRunGit.mockClear();

      // Create state directory
      const sandbox = getWorkerSandboxPaths({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });
      await fs.mkdir(sandbox.stateDir, { recursive: true });

      // Create worktree directory
      await fs.mkdir(sandbox.worktreeDir, { recursive: true });

      // Mock git rev-parse to succeed (branch exists)
      mockRunGit.mockResolvedValueOnce({ stdout: 'abc123', stderr: '' });

      await reuseWorkerSandbox({
        taskId: 'T1',
        runId: 'run-123',
        issueNumber: 42,
        owner: 'owner',
        repo: 'repo',
        canonicalStateDir,
        repoDir,
        dataDir,
        canonicalBranch: 'issue/42',
      });

      // Verify .jeeves symlink exists and points to state dir
      const linkPath = path.join(sandbox.worktreeDir, '.jeeves');
      const linkTarget = await fs.readlink(linkPath);
      expect(linkTarget).toBe(sandbox.stateDir);
    });
  });
});
