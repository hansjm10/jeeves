import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mergePassedBranches,
  formatMergeProgressEntry,
  appendMergeProgress,
  updateWaveSummaryWithMerge,
  type MergePassedBranchesOptions,
  type WaveMergeResult,
} from './waveResultMerge.js';
import type { WorkerOutcome } from './parallelRunner.js';
import type { WorkerSandbox } from './workerSandbox.js';

// Mock git operations
const mockRunGit = vi.fn();
vi.mock('./git.js', () => ({
  runGit: (...args: unknown[]) => mockRunGit(...args),
}));

describe('waveResultMerge', () => {
  let tmpDir: string;
  let canonicalWorkDir: string;
  let stateDir: string;
  const appendLog = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jeeves-merge-test-'));
    canonicalWorkDir = path.join(tmpDir, 'worktree');
    stateDir = path.join(tmpDir, 'state');

    await fs.mkdir(canonicalWorkDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(path.join(stateDir, '.runs', 'run-123', 'waves'), { recursive: true });

    mockRunGit.mockReset();
    appendLog.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function createSandbox(taskId: string): WorkerSandbox {
    const worktreeDir = path.join(tmpDir, 'worktrees', taskId);
    return {
      taskId,
      runId: 'run-123',
      issueNumber: 42,
      owner: 'owner',
      repo: 'repo',
      worktreeDir,
      stateDir: path.join(worktreeDir, '.jeeves'),
      retainedStateDir: path.join(stateDir, '.runs', 'run-123', 'workers', taskId),
      branch: `issue/42-${taskId}-run-123`,
      repoDir: path.join(tmpDir, 'repo'),
      canonicalBranch: 'issue/42',
    };
  }

  function createOutcome(taskId: string, passed: boolean): WorkerOutcome {
    return {
      taskId,
      phase: 'task_spec_check',
      status: passed ? 'passed' : 'failed',
      exitCode: passed ? 0 : 1,
      taskPassed: passed,
      taskFailed: !passed,
      startedAt: '2024-01-01T00:00:00Z',
      endedAt: '2024-01-01T00:01:00Z',
    };
  }

  describe('mergePassedBranches', () => {
    it('returns empty result when no passed tasks', async () => {
      const options: MergePassedBranchesOptions = {
        canonicalWorkDir,
        canonicalBranch: 'issue/42',
        sandboxes: [createSandbox('T1')],
        outcomes: [createOutcome('T1', false)], // T1 failed
        appendLog,
      };

      const result = await mergePassedBranches(options);

      expect(result.merges).toHaveLength(0);
      expect(result.mergedCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(result.allMerged).toBe(true);
      expect(result.hasConflict).toBe(false);
    });

    it('merges passed branches in lexicographic taskId order', async () => {
      // Mock successful git operations
      mockRunGit.mockResolvedValue({ stdout: 'abc123\n', stderr: '' });

      const options: MergePassedBranchesOptions = {
        canonicalWorkDir,
        canonicalBranch: 'issue/42',
        sandboxes: [createSandbox('T3'), createSandbox('T1'), createSandbox('T2')],
        outcomes: [createOutcome('T3', true), createOutcome('T1', true), createOutcome('T2', true)],
        appendLog,
      };

      const result = await mergePassedBranches(options);

      expect(result.mergedCount).toBe(3);
      expect(result.allMerged).toBe(true);
      expect(result.hasConflict).toBe(false);

      // Verify merge order: T1, T2, T3 (lexicographic)
      expect(result.merges[0].taskId).toBe('T1');
      expect(result.merges[1].taskId).toBe('T2');
      expect(result.merges[2].taskId).toBe('T3');

      // Verify git checkout and merge calls
      const checkoutCalls = mockRunGit.mock.calls.filter(
        (call) => call[0][0] === 'checkout',
      );
      const mergeCalls = mockRunGit.mock.calls.filter(
        (call) => call[0][0] === 'merge',
      );

      // Each branch requires checkout + merge
      expect(checkoutCalls).toHaveLength(3);
      expect(mergeCalls).toHaveLength(3);
    });

    it('uses git merge --no-ff for each branch', async () => {
      mockRunGit.mockResolvedValue({ stdout: 'abc123\n', stderr: '' });

      const options: MergePassedBranchesOptions = {
        canonicalWorkDir,
        canonicalBranch: 'issue/42',
        sandboxes: [createSandbox('T1')],
        outcomes: [createOutcome('T1', true)],
        appendLog,
      };

      await mergePassedBranches(options);

      // Find the merge call
      const mergeCall = mockRunGit.mock.calls.find((call) => call[0][0] === 'merge');
      expect(mergeCall).toBeDefined();
      expect(mergeCall![0]).toContain('--no-ff');
      expect(mergeCall![0]).toContain('issue/42-T1-run-123');
    });

    it('aborts cleanly on merge conflict', async () => {
      // First call (checkout T1) succeeds
      // Second call (merge T1) fails with conflict
      // Third call (merge --abort) succeeds
      mockRunGit
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout T1
        .mockRejectedValueOnce({ message: 'CONFLICT', stderr: 'Automatic merge failed' }) // merge T1
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // merge --abort

      const options: MergePassedBranchesOptions = {
        canonicalWorkDir,
        canonicalBranch: 'issue/42',
        sandboxes: [createSandbox('T1'), createSandbox('T2')],
        outcomes: [createOutcome('T1', true), createOutcome('T2', true)],
        appendLog,
      };

      const result = await mergePassedBranches(options);

      expect(result.hasConflict).toBe(true);
      expect(result.conflictTaskId).toBe('T1');
      expect(result.mergedCount).toBe(0);
      expect(result.failedCount).toBe(2); // T1 failed, T2 skipped

      // Verify T1 shows as conflict
      expect(result.merges[0].taskId).toBe('T1');
      expect(result.merges[0].conflict).toBe(true);
      expect(result.merges[0].success).toBe(false);

      // Verify T2 was skipped due to earlier conflict
      expect(result.merges[1].taskId).toBe('T2');
      expect(result.merges[1].conflict).toBe(false);
      expect(result.merges[1].success).toBe(false);
      expect(result.merges[1].error).toContain('earlier merge conflict');

      // Verify merge --abort was called
      const abortCall = mockRunGit.mock.calls.find(
        (call) => call[0][0] === 'merge' && call[0][1] === '--abort',
      );
      expect(abortCall).toBeDefined();
    });

    it('continues with other tasks when one passes and one fails (not conflict)', async () => {
      // Only T1 passed (T2 failed spec-check)
      mockRunGit.mockResolvedValue({ stdout: 'abc123\n', stderr: '' });

      const options: MergePassedBranchesOptions = {
        canonicalWorkDir,
        canonicalBranch: 'issue/42',
        sandboxes: [createSandbox('T1'), createSandbox('T2')],
        outcomes: [createOutcome('T1', true), createOutcome('T2', false)],
        appendLog,
      };

      const result = await mergePassedBranches(options);

      expect(result.mergedCount).toBe(1);
      expect(result.allMerged).toBe(true);
      expect(result.hasConflict).toBe(false);
      expect(result.merges).toHaveLength(1);
      expect(result.merges[0].taskId).toBe('T1');
    });

    it('skips tasks without matching sandbox', async () => {
      mockRunGit.mockResolvedValue({ stdout: 'abc123\n', stderr: '' });

      const options: MergePassedBranchesOptions = {
        canonicalWorkDir,
        canonicalBranch: 'issue/42',
        sandboxes: [createSandbox('T1')], // Only T1 sandbox
        outcomes: [createOutcome('T1', true), createOutcome('T2', true)], // Both passed
        appendLog,
      };

      const result = await mergePassedBranches(options);

      // T1 merged, T2 skipped (no sandbox)
      expect(result.merges).toHaveLength(2);
      expect(result.merges[0].taskId).toBe('T1');
      expect(result.merges[0].success).toBe(true);
      expect(result.merges[1].taskId).toBe('T2');
      expect(result.merges[1].success).toBe(false);
      expect(result.merges[1].error).toBe('Sandbox not found');
    });

    it('preserves merge commit SHA in result', async () => {
      mockRunGit
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // merge
        .mockResolvedValueOnce({ stdout: 'deadbeef123456\n', stderr: '' }); // rev-parse HEAD

      const options: MergePassedBranchesOptions = {
        canonicalWorkDir,
        canonicalBranch: 'issue/42',
        sandboxes: [createSandbox('T1')],
        outcomes: [createOutcome('T1', true)],
        appendLog,
      };

      const result = await mergePassedBranches(options);

      expect(result.merges[0].commitSha).toBe('deadbeef123456');
    });
  });

  describe('formatMergeProgressEntry', () => {
    it('formats successful merge correctly', () => {
      const mergeResult: WaveMergeResult = {
        merges: [
          { taskId: 'T1', branch: 'issue/42-T1-run-123', success: true, conflict: false, commitSha: 'abc1234' },
          { taskId: 'T2', branch: 'issue/42-T2-run-123', success: true, conflict: false, commitSha: 'def5678' },
        ],
        mergedCount: 2,
        failedCount: 0,
        allMerged: true,
        hasConflict: false,
      };

      const entry = formatMergeProgressEntry('wave-123', mergeResult);

      expect(entry).toContain('Wave Merge: wave-123');
      expect(entry).toContain('Total passed tasks: 2');
      expect(entry).toContain('Successfully merged: 2');
      expect(entry).toContain('Failed to merge: 0');
      expect(entry).toContain('[x] T1: merged (abc1234)');
      expect(entry).toContain('[x] T2: merged (def5678)');
    });

    it('formats merge conflict correctly', () => {
      const mergeResult: WaveMergeResult = {
        merges: [
          { taskId: 'T1', branch: 'issue/42-T1-run-123', success: false, conflict: true, error: 'CONFLICT in file.ts' },
          { taskId: 'T2', branch: 'issue/42-T2-run-123', success: false, conflict: false, error: 'Skipped due to earlier merge conflict' },
        ],
        mergedCount: 0,
        failedCount: 2,
        allMerged: false,
        hasConflict: true,
        conflictTaskId: 'T1',
      };

      const entry = formatMergeProgressEntry('wave-123', mergeResult);

      expect(entry).toContain('Merge Conflict');
      expect(entry).toContain('Conflict on task: T1');
      expect(entry).toContain('Run marked as errored');
      expect(entry).toContain('[ ] T1: CONFLICT');
      expect(entry).toContain('[ ] T2: failed - Skipped due to earlier merge conflict');
    });
  });

  describe('appendMergeProgress', () => {
    it('appends merge progress to progress.txt', async () => {
      const progressPath = path.join(stateDir, 'progress.txt');
      await fs.writeFile(progressPath, 'Previous content\n');

      const mergeResult: WaveMergeResult = {
        merges: [{ taskId: 'T1', branch: 'issue/42-T1-run-123', success: true, conflict: false, commitSha: 'abc' }],
        mergedCount: 1,
        failedCount: 0,
        allMerged: true,
        hasConflict: false,
      };

      await appendMergeProgress(stateDir, 'wave-123', mergeResult);

      const content = await fs.readFile(progressPath, 'utf-8');
      expect(content).toContain('Previous content');
      expect(content).toContain('Wave Merge: wave-123');
    });

    it('creates progress.txt if it does not exist', async () => {
      const progressPath = path.join(stateDir, 'progress.txt');

      const mergeResult: WaveMergeResult = {
        merges: [],
        mergedCount: 0,
        failedCount: 0,
        allMerged: true,
        hasConflict: false,
      };

      await appendMergeProgress(stateDir, 'wave-123', mergeResult);

      const content = await fs.readFile(progressPath, 'utf-8');
      expect(content).toContain('Wave Merge: wave-123');
    });
  });

  describe('updateWaveSummaryWithMerge', () => {
    it('updates wave summary JSON with merge results', async () => {
      const wavePath = path.join(stateDir, '.runs', 'run-123', 'waves', 'wave-123.json');
      await fs.writeFile(wavePath, JSON.stringify({ waveId: 'wave-123', phase: 'task_spec_check' }));

      const mergeResult: WaveMergeResult = {
        merges: [{ taskId: 'T1', branch: 'issue/42-T1-run-123', success: true, conflict: false, commitSha: 'abc' }],
        mergedCount: 1,
        failedCount: 0,
        allMerged: true,
        hasConflict: false,
      };

      await updateWaveSummaryWithMerge(stateDir, 'run-123', 'wave-123', mergeResult);

      const content = JSON.parse(await fs.readFile(wavePath, 'utf-8'));
      expect(content.waveId).toBe('wave-123');
      expect(content.mergeResult).toBeDefined();
      expect(content.mergeResult.mergedCount).toBe(1);
      expect(content.mergeResult.allMerged).toBe(true);
      expect(content.mergeResult.merges).toHaveLength(1);
    });

    it('handles missing wave file gracefully', async () => {
      const mergeResult: WaveMergeResult = {
        merges: [],
        mergedCount: 0,
        failedCount: 0,
        allMerged: true,
        hasConflict: false,
      };

      // Should not throw
      await expect(
        updateWaveSummaryWithMerge(stateDir, 'run-123', 'nonexistent-wave', mergeResult),
      ).resolves.toBeUndefined();
    });
  });

  describe('lexicographic ordering', () => {
    it('sorts task IDs strictly lexicographically (T1 < T10 < T2)', async () => {
      mockRunGit.mockResolvedValue({ stdout: 'abc123\n', stderr: '' });

      const options: MergePassedBranchesOptions = {
        canonicalWorkDir,
        canonicalBranch: 'issue/42',
        sandboxes: [createSandbox('T2'), createSandbox('T10'), createSandbox('T1')],
        outcomes: [createOutcome('T2', true), createOutcome('T10', true), createOutcome('T1', true)],
        appendLog,
      };

      const result = await mergePassedBranches(options);

      // Lexicographic: T1 < T10 < T2 (not numeric: T1 < T2 < T10)
      expect(result.merges[0].taskId).toBe('T1');
      expect(result.merges[1].taskId).toBe('T10');
      expect(result.merges[2].taskId).toBe('T2');
    });
  });
});
