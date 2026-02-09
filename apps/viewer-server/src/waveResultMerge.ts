/**
 * Wave result aggregation and merge for parallel task execution.
 *
 * This module implements §6.2.5 of the parallel execution design (Issue #78):
 * - Merge passed worker branches into canonical branch via git merge --no-ff
 * - Merge order: taskId lexicographic ascending (strict, locale-independent)
 * - Merge conflicts abort cleanly and produce a clear progress log entry
 * - Partial success preserved: passed tasks merged even if others fail
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { appendProgressEvent } from './sqliteStorage.js';
import { runGit } from './git.js';
import { writeJsonAtomic } from './jsonAtomic.js';
import type { WorkerOutcome } from './parallelRunner.js';
import type { WorkerSandbox } from './workerSandbox.js';

/** Result of a single branch merge attempt */
export interface MergeAttemptResult {
  taskId: string;
  branch: string;
  success: boolean;
  /** True if merge conflict occurred */
  conflict: boolean;
  /** Error message if merge failed */
  error?: string;
  /** Git merge commit SHA if successful */
  commitSha?: string;
}

/** Result of merging all passed branches in a wave */
export interface WaveMergeResult {
  /** All merge attempts (in order) */
  merges: MergeAttemptResult[];
  /** Number of successfully merged branches */
  mergedCount: number;
  /** Number of failed merges (conflicts or errors) */
  failedCount: number;
  /** True if all attempted merges succeeded */
  allMerged: boolean;
  /** True if any merge had a conflict (run should stop) */
  hasConflict: boolean;
  /** Task ID that caused the first conflict (if any) */
  conflictTaskId?: string;
}

/** Options for merging passed branches */
export interface MergePassedBranchesOptions {
  /** Path to canonical worktree directory */
  canonicalWorkDir: string;
  /** Canonical issue branch (e.g., issue/78) */
  canonicalBranch: string;
  /** Worker sandboxes for passed tasks (will be filtered and sorted by taskId) */
  sandboxes: WorkerSandbox[];
  /** Worker outcomes from spec-check wave */
  outcomes: WorkerOutcome[];
  /** Callback for logging */
  appendLog: (line: string) => Promise<void>;
}

/**
 * Lexicographic string comparison (strict, locale-independent).
 * Per §6.2.5: use strict, locale-independent string compare (no numeric collation).
 */
function lexicographicCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Merges passed worker branches into the canonical branch.
 *
 * Per §6.2.5:
 * - Merge order: taskId lexicographic ascending
 * - Merge strategy: git merge --no-ff
 * - If merge conflict occurs:
 *   - Abort the merge (git merge --abort)
 *   - Stop merging remaining tasks
 *   - Mark run as errored
 *   - Retain worker worktrees/branches for debugging
 *
 * @returns WaveMergeResult with details of all merge attempts
 */
export async function mergePassedBranches(options: MergePassedBranchesOptions): Promise<WaveMergeResult> {
  const { canonicalWorkDir, canonicalBranch, sandboxes, outcomes, appendLog } = options;

  // Filter to only passed tasks
  const passedOutcomes = outcomes.filter((o) => o.taskPassed);
  if (passedOutcomes.length === 0) {
    await appendLog('[MERGE] No passed tasks to merge');
    return {
      merges: [],
      mergedCount: 0,
      failedCount: 0,
      allMerged: true,
      hasConflict: false,
    };
  }

  // Sort by taskId lexicographically
  const sortedPassed = [...passedOutcomes].sort((a, b) => lexicographicCompare(a.taskId, b.taskId));

  await appendLog(`[MERGE] Merging ${sortedPassed.length} passed branches in order: ${sortedPassed.map((o) => o.taskId).join(', ')}`);

  const merges: MergeAttemptResult[] = [];
  let hasConflict = false;
  let conflictTaskId: string | undefined;

  for (const outcome of sortedPassed) {
    const sandbox = sandboxes.find((s) => s.taskId === outcome.taskId);
    if (!sandbox) {
      await appendLog(`[MERGE] Warning: sandbox not found for task ${outcome.taskId}, skipping`);
      merges.push({
        taskId: outcome.taskId,
        branch: `unknown`,
        success: false,
        conflict: false,
        error: 'Sandbox not found',
      });
      continue;
    }

    // Stop if we already hit a conflict
    if (hasConflict) {
      await appendLog(`[MERGE] Skipping ${outcome.taskId} due to earlier conflict`);
      merges.push({
        taskId: outcome.taskId,
        branch: sandbox.branch,
        success: false,
        conflict: false,
        error: 'Skipped due to earlier merge conflict',
      });
      continue;
    }

    const result = await mergeBranch(canonicalWorkDir, canonicalBranch, sandbox, appendLog);
    merges.push(result);

    if (result.conflict) {
      hasConflict = true;
      conflictTaskId = outcome.taskId;
    }
  }

  const mergedCount = merges.filter((m) => m.success).length;
  const failedCount = merges.filter((m) => !m.success).length;

  await appendLog(`[MERGE] Completed: ${mergedCount}/${merges.length} branches merged`);

  return {
    merges,
    mergedCount,
    failedCount,
    allMerged: failedCount === 0,
    hasConflict,
    conflictTaskId,
  };
}

/**
 * Merges a single worker branch into the canonical branch.
 *
 * Uses git merge --no-ff to preserve task commit history.
 */
async function mergeBranch(
  canonicalWorkDir: string,
  canonicalBranch: string,
  sandbox: WorkerSandbox,
  appendLog: (line: string) => Promise<void>,
): Promise<MergeAttemptResult> {
  const { taskId, branch } = sandbox;

  await appendLog(`[MERGE] Merging branch ${branch} for task ${taskId}`);

  try {
    // Ensure we're on the canonical branch in the canonical worktree
    await runGit(['checkout', canonicalBranch], { cwd: canonicalWorkDir });

    // Attempt the merge with --no-ff
    // git merge --no-ff <branch> -m "Merge task <taskId> from branch <branch>"
    const mergeResult = await runGitMerge(canonicalWorkDir, branch, taskId);

    if (mergeResult.conflict) {
      // Abort the merge and return conflict result
      await appendLog(`[MERGE] Conflict detected merging ${branch}, aborting`);
      await runGit(['merge', '--abort'], { cwd: canonicalWorkDir }).catch(() => {
        // Merge abort may fail if no merge in progress, ignore
      });

      return {
        taskId,
        branch,
        success: false,
        conflict: true,
        error: mergeResult.error,
      };
    }

    if (!mergeResult.success) {
      await appendLog(`[MERGE] Failed to merge ${branch}: ${mergeResult.error}`);
      return {
        taskId,
        branch,
        success: false,
        conflict: false,
        error: mergeResult.error,
      };
    }

    await appendLog(`[MERGE] Successfully merged ${branch} (${mergeResult.commitSha})`);

    return {
      taskId,
      branch,
      success: true,
      conflict: false,
      commitSha: mergeResult.commitSha,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await appendLog(`[MERGE] Error merging ${branch}: ${errMsg}`);

    // Try to abort any in-progress merge
    await runGit(['merge', '--abort'], { cwd: canonicalWorkDir }).catch(() => void 0);

    return {
      taskId,
      branch,
      success: false,
      conflict: errMsg.includes('CONFLICT') || errMsg.includes('Merge conflict'),
      error: errMsg,
    };
  }
}

/**
 * Runs git merge and detects conflicts.
 */
async function runGitMerge(
  workDir: string,
  branch: string,
  taskId: string,
): Promise<{ success: boolean; conflict: boolean; error?: string; commitSha?: string }> {
  try {
    const message = `Merge task ${taskId} from branch ${branch}`;
    // Run merge command (output not needed, just need to succeed)
    await runGit(['merge', '--no-ff', '-m', message, branch], { cwd: workDir });

    // Get the merge commit SHA
    const headResult = await runGit(['rev-parse', 'HEAD'], { cwd: workDir });
    const commitSha = headResult.stdout.trim();

    return { success: true, conflict: false, commitSha };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr ?? '';

    // Check for merge conflict indicators
    const isConflict =
      errMsg.includes('CONFLICT') ||
      stderr.includes('CONFLICT') ||
      errMsg.includes('Automatic merge failed') ||
      stderr.includes('Automatic merge failed') ||
      errMsg.includes('fix conflicts') ||
      stderr.includes('fix conflicts');

    return {
      success: false,
      conflict: isConflict,
      error: stderr || errMsg,
    };
  }
}

/**
 * Creates a progress log entry for a wave merge result.
 *
 * Per §6.2.5: "Merge conflicts abort cleanly and produce a clear progress log entry"
 */
export function formatMergeProgressEntry(
  waveId: string,
  mergeResult: WaveMergeResult,
): string {
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push(`## [${now}] - Wave Merge: ${waveId}`);
  lines.push('');
  lines.push(`### Merge Summary`);
  lines.push(`- Total passed tasks: ${mergeResult.merges.length}`);
  lines.push(`- Successfully merged: ${mergeResult.mergedCount}`);
  lines.push(`- Failed to merge: ${mergeResult.failedCount}`);

  if (mergeResult.hasConflict) {
    lines.push('');
    lines.push(`### Merge Conflict`);
    lines.push(`- Conflict on task: ${mergeResult.conflictTaskId}`);
    lines.push(`- Run marked as errored`);
    lines.push(`- Worker worktrees/branches retained for debugging`);
  }

  lines.push('');
  lines.push(`### Merge Details`);
  for (const merge of mergeResult.merges) {
    if (merge.success) {
      lines.push(`- [x] ${merge.taskId}: merged (${merge.commitSha?.substring(0, 7) ?? 'unknown'})`);
    } else if (merge.conflict) {
      lines.push(`- [ ] ${merge.taskId}: CONFLICT - ${merge.error ?? 'merge conflict'}`);
    } else {
      lines.push(`- [ ] ${merge.taskId}: failed - ${merge.error ?? 'unknown error'}`);
    }
  }

  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

/**
 * Appends a merge progress entry to the canonical progress event log.
 */
export async function appendMergeProgress(
  stateDir: string,
  waveId: string,
  mergeResult: WaveMergeResult,
): Promise<void> {
  const entry = formatMergeProgressEntry(waveId, mergeResult);
  appendProgressEvent({
    stateDir,
    source: 'wave-merge',
    message: entry,
  });
}

/**
 * Updates the wave summary artifact with merge results.
 */
export async function updateWaveSummaryWithMerge(
  stateDir: string,
  runId: string,
  waveId: string,
  mergeResult: WaveMergeResult,
): Promise<void> {
  const wavePath = path.join(stateDir, '.runs', runId, 'waves', `${waveId}.json`);

  try {
    const rawWave = await fs.readFile(wavePath, 'utf-8');
    const wave = JSON.parse(rawWave) as Record<string, unknown>;

    // Add merge result to wave summary
    wave.mergeResult = {
      mergedCount: mergeResult.mergedCount,
      failedCount: mergeResult.failedCount,
      allMerged: mergeResult.allMerged,
      hasConflict: mergeResult.hasConflict,
      conflictTaskId: mergeResult.conflictTaskId,
      merges: mergeResult.merges.map((m) => ({
        taskId: m.taskId,
        branch: m.branch,
        success: m.success,
        conflict: m.conflict,
        error: m.error,
        commitSha: m.commitSha,
      })),
    };

    await writeJsonAtomic(wavePath, wave);
  } catch {
    // Wave file may not exist yet, that's okay
  }
}
