/**
 * Metrics store for Issue #80 estimation.
 *
 * Stores historical metrics from run archives in METRICS/<owner>-<repo>.json
 * (default: $JEEVES_DATA_DIR/metrics/).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeJsonAtomic } from './jsonAtomic.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Schema for METRICS/<owner>-<repo>.json
 */
export type RepoMetricsFileV1 = {
  schemaVersion: 1;
  repo: string; // "owner/repo"
  updated_at: string; // ISO-8601

  /** Run IDs already incorporated (dedup) */
  processed_run_ids: string[];

  /**
   * One sample per issue per workflow (most recent eligible run wins).
   * Missing phase keys imply 0.
   */
  iterations_per_phase_per_issue: Record<
    string, // issue_ref: "owner/repo#N"
    Record<string, Record<string, number>> // workflow -> (phase -> iteration count)
  >;

  /** Source-run metadata for deterministic updates */
  iterations_per_phase_per_issue_sources: Record<
    string, // issue_ref
    Record<
      string, // workflow
      {
        run_id: string;
        started_at: string; // ISO-8601
      }
    >
  >;

  /** Task retry counts per workflow */
  task_retry_counts: Record<
    string, // workflow
    {
      total_retries: number;
      total_tasks_at_decomposition: number;
      retries_per_task: number | null; // null when denominator is 0
    }
  >;

  /** Design review pass rates per workflow */
  design_review_pass_rates: Record<
    string, // workflow
    {
      attempts: number;
      passes: number;
      pass_rate: number | null; // null when attempts === 0
    }
  >;

  /** Implementation iteration counts per workflow */
  implementation_iteration_counts: Record<
    string, // workflow
    {
      implement_task_iterations: number;
      tasks_at_decomposition: number;
      iterations_per_task: number | null; // null when denominator is 0
    }
  >;
};

/** Input data extracted from a run archive */
export type RunArchiveData = {
  run_id: string;
  issue_ref: string;
  workflow: string;
  started_at: string;
  /** phase -> iteration count for this run */
  phase_counts: Record<string, number>;
  /** Number of task retries detected in this run */
  task_retries: number;
  /** Number of tasks at decomposition time */
  tasks_at_decomposition: number;
  /** Design review attempts in this run */
  design_review_attempts: number;
  /** Design review passes in this run */
  design_review_passes: number;
  /** Number of implement_task iterations in this run */
  implement_task_iterations: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the metrics directory path.
 */
export function getMetricsDir(dataDir: string): string {
  return path.join(dataDir, 'metrics');
}

/**
 * Get the metrics file path for a repo.
 */
export function getMetricsFilePath(dataDir: string, owner: string, repo: string): string {
  return path.join(getMetricsDir(dataDir), `${owner}-${repo}.json`);
}

/**
 * Create an empty metrics file structure.
 */
export function createEmptyMetrics(repo: string): RepoMetricsFileV1 {
  return {
    schemaVersion: 1,
    repo,
    updated_at: new Date().toISOString(),
    processed_run_ids: [],
    iterations_per_phase_per_issue: {},
    iterations_per_phase_per_issue_sources: {},
    task_retry_counts: {},
    design_review_pass_rates: {},
    implementation_iteration_counts: {},
  };
}

/**
 * Read metrics file, returns null if not found or invalid.
 */
export async function readMetricsFile(
  dataDir: string,
  owner: string,
  repo: string,
): Promise<RepoMetricsFileV1 | null> {
  const filePath = getMetricsFilePath(dataDir, owner, repo);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (isValidMetricsFile(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write metrics file atomically.
 */
export async function writeMetricsFile(
  dataDir: string,
  owner: string,
  repo: string,
  metrics: RepoMetricsFileV1,
): Promise<void> {
  const filePath = getMetricsFilePath(dataDir, owner, repo);
  await writeJsonAtomic(filePath, metrics);
}

/**
 * Type guard for RepoMetricsFileV1.
 */
export function isValidMetricsFile(data: unknown): data is RepoMetricsFileV1 {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;

  if (obj.schemaVersion !== 1) return false;
  if (typeof obj.repo !== 'string') return false;
  if (typeof obj.updated_at !== 'string') return false;
  if (!Array.isArray(obj.processed_run_ids)) return false;
  if (!obj.iterations_per_phase_per_issue || typeof obj.iterations_per_phase_per_issue !== 'object') return false;
  if (
    !obj.iterations_per_phase_per_issue_sources ||
    typeof obj.iterations_per_phase_per_issue_sources !== 'object'
  )
    return false;
  if (!obj.task_retry_counts || typeof obj.task_retry_counts !== 'object') return false;
  if (!obj.design_review_pass_rates || typeof obj.design_review_pass_rates !== 'object') return false;
  if (!obj.implementation_iteration_counts || typeof obj.implementation_iteration_counts !== 'object') return false;

  return true;
}

// ---------------------------------------------------------------------------
// Run Archive Reading
// ---------------------------------------------------------------------------

/**
 * Check if a run is eligible for metrics ingestion.
 *
 * Eligible runs:
 * - MUST have run.json with completed_via_state === true OR completed_via_promise === true
 * - MUST have exit_code === 0
 * - MUST have at least 1 iteration.json
 */
export async function isRunEligible(runDir: string): Promise<boolean> {
  const runJsonPath = path.join(runDir, 'run.json');
  try {
    const raw = await fs.readFile(runJsonPath, 'utf-8');
    const runJson = JSON.parse(raw) as Record<string, unknown>;

    const completedViaState = runJson.completed_via_state === true;
    const completedViaPromise = runJson.completed_via_promise === true;
    const exitCode = runJson.exit_code;

    if (!completedViaState && !completedViaPromise) return false;
    if (exitCode !== 0) return false;

    // Check for at least one iteration
    const iterationsDir = path.join(runDir, 'iterations');
    try {
      const entries = await fs.readdir(iterationsDir);
      for (const entry of entries) {
        const iterJsonPath = path.join(iterationsDir, entry, 'iteration.json');
        try {
          await fs.access(iterJsonPath);
          return true;
        } catch {
          // continue
        }
      }
    } catch {
      return false;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Resolve workflow name from a run archive.
 *
 * Order:
 * 1. iterations/001/iteration.json.workflow
 * 2. final-issue.json.workflow
 * 3. null (ineligible)
 */
export async function resolveRunWorkflow(runDir: string): Promise<string | null> {
  // Try iterations/001/iteration.json first
  const iter001Path = path.join(runDir, 'iterations', '001', 'iteration.json');
  try {
    const raw = await fs.readFile(iter001Path, 'utf-8');
    const iterJson = JSON.parse(raw) as Record<string, unknown>;
    if (typeof iterJson.workflow === 'string' && iterJson.workflow.trim()) {
      return iterJson.workflow.trim();
    }
  } catch {
    // continue to fallback
  }

  // Fallback: final-issue.json
  const finalIssuePath = path.join(runDir, 'final-issue.json');
  try {
    const raw = await fs.readFile(finalIssuePath, 'utf-8');
    const finalIssue = JSON.parse(raw) as Record<string, unknown>;
    if (typeof finalIssue.workflow === 'string' && finalIssue.workflow.trim()) {
      return finalIssue.workflow.trim();
    }
  } catch {
    // continue
  }

  return null;
}

/**
 * Read run.json and extract basic run metadata.
 */
export async function readRunJson(
  runDir: string,
): Promise<{ run_id: string; issue_ref: string; started_at: string } | null> {
  const runJsonPath = path.join(runDir, 'run.json');
  try {
    const raw = await fs.readFile(runJsonPath, 'utf-8');
    const runJson = JSON.parse(raw) as Record<string, unknown>;

    const run_id = typeof runJson.run_id === 'string' ? runJson.run_id : null;
    const issue_ref = typeof runJson.issue_ref === 'string' ? runJson.issue_ref : null;
    const started_at = typeof runJson.started_at === 'string' ? runJson.started_at : null;

    if (!run_id || !issue_ref || !started_at) return null;
    return { run_id, issue_ref, started_at };
  } catch {
    return null;
  }
}

/**
 * Count phase occurrences from iteration.json files in a run.
 */
export async function countPhases(runDir: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const iterationsDir = path.join(runDir, 'iterations');

  try {
    const entries = await fs.readdir(iterationsDir);
    for (const entry of entries) {
      const iterJsonPath = path.join(iterationsDir, entry, 'iteration.json');
      try {
        const raw = await fs.readFile(iterJsonPath, 'utf-8');
        const iterJson = JSON.parse(raw) as Record<string, unknown>;
        const phase = typeof iterJson.phase === 'string' ? iterJson.phase : null;
        if (phase) {
          counts[phase] = (counts[phase] ?? 0) + 1;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // no iterations dir
  }

  return counts;
}

/**
 * Post-decomposition phases used to find tasks_at_decomposition.
 */
const POST_DECOMPOSITION_PHASES = new Set([
  'implement_task',
  'task_spec_check',
  'completeness_verification',
  'prepare_pr',
  'code_review',
  'code_fix',
]);

/**
 * Get tasks_at_decomposition from a run archive.
 *
 * Order:
 * 1. final-issue.json.estimate.tasks (if non-negative integer)
 * 2. Earliest tasks.json in a post-decomposition iteration
 */
export async function getTasksAtDecomposition(runDir: string): Promise<number | null> {
  // Try final-issue.json.estimate.tasks first
  const finalIssuePath = path.join(runDir, 'final-issue.json');
  try {
    const raw = await fs.readFile(finalIssuePath, 'utf-8');
    const finalIssue = JSON.parse(raw) as Record<string, unknown>;
    const estimate = finalIssue.estimate as Record<string, unknown> | undefined;
    if (estimate && typeof estimate.tasks === 'number' && Number.isInteger(estimate.tasks) && estimate.tasks >= 0) {
      return estimate.tasks;
    }
  } catch {
    // continue
  }

  // Fallback: earliest tasks.json in post-decomposition iteration
  const iterationsDir = path.join(runDir, 'iterations');
  try {
    const entries = await fs.readdir(iterationsDir);
    // Sort by iteration number
    const sorted = entries.filter((e) => /^\d+$/.test(e)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    for (const entry of sorted) {
      const iterPath = path.join(iterationsDir, entry);
      const iterJsonPath = path.join(iterPath, 'iteration.json');
      const tasksJsonPath = path.join(iterPath, 'tasks.json');

      try {
        const iterRaw = await fs.readFile(iterJsonPath, 'utf-8');
        const iterJson = JSON.parse(iterRaw) as Record<string, unknown>;
        const phase = typeof iterJson.phase === 'string' ? iterJson.phase : null;

        if (phase && POST_DECOMPOSITION_PHASES.has(phase)) {
          try {
            const tasksRaw = await fs.readFile(tasksJsonPath, 'utf-8');
            const tasksJson = JSON.parse(tasksRaw) as Record<string, unknown>;
            const tasks = tasksJson.tasks;
            if (Array.isArray(tasks)) {
              return tasks.length;
            }
          } catch {
            // continue
          }
        }
      } catch {
        // continue
      }
    }
  } catch {
    // no iterations dir
  }

  return null;
}

/**
 * Count task retries by comparing consecutive tasks.json snapshots.
 *
 * A retry is detected when a task transitions from status !== "pending"/"in_progress"
 * back to "pending" or "in_progress" in a later snapshot.
 */
export async function countTaskRetries(runDir: string): Promise<number> {
  const iterationsDir = path.join(runDir, 'iterations');
  let retries = 0;

  try {
    const entries = await fs.readdir(iterationsDir);
    const sorted = entries.filter((e) => /^\d+$/.test(e)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    type TaskSnapshot = { id: string; status: string };
    let prevSnapshot: TaskSnapshot[] | null = null;

    for (const entry of sorted) {
      const tasksJsonPath = path.join(iterationsDir, entry, 'tasks.json');
      try {
        const raw = await fs.readFile(tasksJsonPath, 'utf-8');
        const tasksJson = JSON.parse(raw) as Record<string, unknown>;
        const tasks = tasksJson.tasks;
        if (!Array.isArray(tasks)) continue;

        const currentSnapshot: TaskSnapshot[] = tasks
          .filter((t): t is Record<string, unknown> => t && typeof t === 'object')
          .map((t) => ({
            id: typeof t.id === 'string' ? t.id : '',
            status: typeof t.status === 'string' ? t.status : '',
          }))
          .filter((t) => t.id);

        if (prevSnapshot) {
          // Compare snapshots for retries
          for (const curr of currentSnapshot) {
            const prev = prevSnapshot.find((p) => p.id === curr.id);
            if (prev) {
              // A retry is when status went from a terminal state back to pending/in_progress
              const wasTerminal = prev.status !== 'pending' && prev.status !== 'in_progress';
              const isRetrying = curr.status === 'pending' || curr.status === 'in_progress';
              if (wasTerminal && isRetrying) {
                retries++;
              }
            }
          }
        }

        prevSnapshot = currentSnapshot;
      } catch {
        // skip iterations without tasks.json
      }
    }
  } catch {
    // no iterations dir
  }

  return retries;
}

/**
 * Count design review attempts and passes.
 *
 * An attempt is any iteration where phase === "design_review".
 * A pass is when issue.json shows:
 * - status.designApproved === true
 * - status.designNeedsChanges !== true
 * - status.designFeedback == null
 */
export async function countDesignReviewStats(
  runDir: string,
): Promise<{ attempts: number; passes: number }> {
  const iterationsDir = path.join(runDir, 'iterations');
  let attempts = 0;
  let passes = 0;

  try {
    const entries = await fs.readdir(iterationsDir);
    const sorted = entries.filter((e) => /^\d+$/.test(e)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    for (const entry of sorted) {
      const iterJsonPath = path.join(iterationsDir, entry, 'iteration.json');
      const issueJsonPath = path.join(iterationsDir, entry, 'issue.json');

      try {
        const iterRaw = await fs.readFile(iterJsonPath, 'utf-8');
        const iterJson = JSON.parse(iterRaw) as Record<string, unknown>;
        const phase = typeof iterJson.phase === 'string' ? iterJson.phase : null;

        if (phase === 'design_review') {
          attempts++;

          // Check if this was a pass
          try {
            const issueRaw = await fs.readFile(issueJsonPath, 'utf-8');
            const issueJson = JSON.parse(issueRaw) as Record<string, unknown>;
            const status = issueJson.status as Record<string, unknown> | undefined;

            if (status) {
              const designApproved = status.designApproved === true;
              const designNeedsChanges = status.designNeedsChanges === true;
              const designFeedback = status.designFeedback;

              if (designApproved && !designNeedsChanges && (designFeedback === null || designFeedback === undefined)) {
                passes++;
              }
            }
          } catch {
            // no issue.json or invalid - not a pass
          }
        }
      } catch {
        // skip
      }
    }
  } catch {
    // no iterations dir
  }

  return { attempts, passes };
}

/**
 * Extract all data needed from a run archive.
 */
export async function extractRunArchiveData(runDir: string): Promise<RunArchiveData | null> {
  // Check eligibility
  if (!(await isRunEligible(runDir))) return null;

  // Get workflow
  const workflow = await resolveRunWorkflow(runDir);
  if (!workflow) return null;

  // Get run metadata
  const runMeta = await readRunJson(runDir);
  if (!runMeta) return null;

  // Extract all metrics
  const [phase_counts, task_retries, tasks_at_decomposition, design_stats] = await Promise.all([
    countPhases(runDir),
    countTaskRetries(runDir),
    getTasksAtDecomposition(runDir),
    countDesignReviewStats(runDir),
  ]);

  // tasks_at_decomposition is required
  if (tasks_at_decomposition === null) return null;

  return {
    run_id: runMeta.run_id,
    issue_ref: runMeta.issue_ref,
    workflow,
    started_at: runMeta.started_at,
    phase_counts,
    task_retries,
    tasks_at_decomposition,
    design_review_attempts: design_stats.attempts,
    design_review_passes: design_stats.passes,
    implement_task_iterations: phase_counts['implement_task'] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Metrics Ingestion
// ---------------------------------------------------------------------------

/**
 * Compare ordering keys for deterministic updates.
 * Returns true if newKey > existingKey (lexicographic by started_at, then run_id).
 */
function isNewerKey(
  newStartedAt: string,
  newRunId: string,
  existingStartedAt: string,
  existingRunId: string,
): boolean {
  if (newStartedAt > existingStartedAt) return true;
  if (newStartedAt < existingStartedAt) return false;
  return newRunId > existingRunId;
}

/**
 * Ingest a single run archive into the metrics store.
 *
 * Returns true if metrics were updated, false if run was already processed or ineligible.
 */
export async function ingestRunArchiveIntoMetrics(
  dataDir: string,
  runDir: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  // Extract data from run archive
  const runData = await extractRunArchiveData(runDir);
  if (!runData) return false;

  // Read or create metrics file
  let metrics = await readMetricsFile(dataDir, owner, repo);
  if (!metrics) {
    metrics = createEmptyMetrics(`${owner}/${repo}`);
  }

  // Check dedup
  if (metrics.processed_run_ids.includes(runData.run_id)) {
    return false;
  }

  // Update metrics
  metrics.processed_run_ids.push(runData.run_id);
  metrics.updated_at = new Date().toISOString();

  // 1. Update iterations_per_phase_per_issue
  const { issue_ref, workflow, started_at, run_id } = runData;

  if (!metrics.iterations_per_phase_per_issue[issue_ref]) {
    metrics.iterations_per_phase_per_issue[issue_ref] = {};
  }
  if (!metrics.iterations_per_phase_per_issue_sources[issue_ref]) {
    metrics.iterations_per_phase_per_issue_sources[issue_ref] = {};
  }

  const existingSource = metrics.iterations_per_phase_per_issue_sources[issue_ref]?.[workflow];
  if (!existingSource || isNewerKey(started_at, run_id, existingSource.started_at, existingSource.run_id)) {
    metrics.iterations_per_phase_per_issue[issue_ref][workflow] = runData.phase_counts;
    metrics.iterations_per_phase_per_issue_sources[issue_ref][workflow] = { run_id, started_at };
  }

  // 2. Update task_retry_counts
  if (!metrics.task_retry_counts[workflow]) {
    metrics.task_retry_counts[workflow] = {
      total_retries: 0,
      total_tasks_at_decomposition: 0,
      retries_per_task: null,
    };
  }
  const retryStats = metrics.task_retry_counts[workflow];
  retryStats.total_retries += runData.task_retries;
  retryStats.total_tasks_at_decomposition += runData.tasks_at_decomposition;
  retryStats.retries_per_task =
    retryStats.total_tasks_at_decomposition > 0
      ? retryStats.total_retries / retryStats.total_tasks_at_decomposition
      : null;

  // 3. Update design_review_pass_rates
  if (!metrics.design_review_pass_rates[workflow]) {
    metrics.design_review_pass_rates[workflow] = {
      attempts: 0,
      passes: 0,
      pass_rate: null,
    };
  }
  const designStats = metrics.design_review_pass_rates[workflow];
  designStats.attempts += runData.design_review_attempts;
  designStats.passes += runData.design_review_passes;
  designStats.pass_rate = designStats.attempts > 0 ? designStats.passes / designStats.attempts : null;

  // 4. Update implementation_iteration_counts
  if (!metrics.implementation_iteration_counts[workflow]) {
    metrics.implementation_iteration_counts[workflow] = {
      implement_task_iterations: 0,
      tasks_at_decomposition: 0,
      iterations_per_task: null,
    };
  }
  const implStats = metrics.implementation_iteration_counts[workflow];
  implStats.implement_task_iterations += runData.implement_task_iterations;
  implStats.tasks_at_decomposition += runData.tasks_at_decomposition;
  implStats.iterations_per_task =
    implStats.tasks_at_decomposition > 0
      ? implStats.implement_task_iterations / implStats.tasks_at_decomposition
      : null;

  // Write updated metrics
  await writeMetricsFile(dataDir, owner, repo, metrics);
  return true;
}
