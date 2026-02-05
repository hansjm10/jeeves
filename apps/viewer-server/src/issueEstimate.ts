/**
 * Issue estimate computation for Issue #80.
 *
 * Computes iteration estimates based on historical metrics.
 */

import type { RepoMetricsFileV1 } from './metricsStore.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Issue #80 estimate payload.
 */
export type IssueEstimate = {
  /** Total estimated iterations. Must equal sum(breakdown.*) */
  estimatedIterations: number;

  /** Breakdown buckets */
  breakdown: {
    design: number;
    implementation: number;
    specCheck: number;
    completenessVerification: number;
    prAndReview: number;
  };

  /** Number of tasks at decomposition time */
  tasks: number;

  /** Historical averages used for computation */
  historicalAverage: {
    iterationsPerTask: number;
    designPassRate: number;
  };
};

/**
 * Input for estimate computation.
 */
export type ComputeEstimateInput = {
  /** Number of tasks at decomposition time */
  tasks: number;
  /** Active workflow name */
  workflow: string;
  /** Repo metrics */
  metrics: RepoMetricsFileV1;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum design pass rate to avoid division by zero */
export const MIN_DESIGN_PASS_RATE = 0.01;

/** Maximum expected design review attempts (hard cap) */
export const MAX_EXPECTED_DESIGN_REVIEW_ATTEMPTS = 6;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Type guard for IssueEstimate.
 */
export function isValidIssueEstimate(data: unknown): data is IssueEstimate {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;

  // estimatedIterations
  if (typeof obj.estimatedIterations !== 'number') return false;
  if (!Number.isInteger(obj.estimatedIterations) || obj.estimatedIterations < 0) return false;

  // breakdown
  if (!obj.breakdown || typeof obj.breakdown !== 'object') return false;
  const breakdown = obj.breakdown as Record<string, unknown>;
  const breakdownKeys = ['design', 'implementation', 'specCheck', 'completenessVerification', 'prAndReview'];
  for (const key of breakdownKeys) {
    if (typeof breakdown[key] !== 'number') return false;
    if (!Number.isInteger(breakdown[key] as number) || (breakdown[key] as number) < 0) return false;
  }

  // tasks
  if (typeof obj.tasks !== 'number') return false;
  if (!Number.isInteger(obj.tasks) || obj.tasks < 0) return false;

  // historicalAverage
  if (!obj.historicalAverage || typeof obj.historicalAverage !== 'object') return false;
  const hist = obj.historicalAverage as Record<string, unknown>;
  if (typeof hist.iterationsPerTask !== 'number') return false;
  if (!Number.isFinite(hist.iterationsPerTask) || hist.iterationsPerTask < 0) return false;
  if (typeof hist.designPassRate !== 'number') return false;
  if (!Number.isFinite(hist.designPassRate) || hist.designPassRate < 0 || hist.designPassRate > 1) return false;

  // Invariant: sum(breakdown) === estimatedIterations
  const sum =
    (breakdown.design as number) +
    (breakdown.implementation as number) +
    (breakdown.specCheck as number) +
    (breakdown.completenessVerification as number) +
    (breakdown.prAndReview as number);
  if (sum !== obj.estimatedIterations) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

/**
 * Compute issue estimate from metrics and task count.
 *
 * Returns null when required inputs/metrics are missing or insufficient.
 */
export function computeIssueEstimate(input: ComputeEstimateInput): IssueEstimate | null {
  const { tasks, workflow, metrics } = input;

  // Validate tasks
  if (!Number.isInteger(tasks) || tasks < 0) return null;

  // Get implementation iteration counts
  const implStats = metrics.implementation_iteration_counts[workflow];
  if (!implStats) return null;
  if (implStats.iterations_per_task === null) return null;
  const iterationsPerTask = implStats.iterations_per_task;
  if (!Number.isFinite(iterationsPerTask) || iterationsPerTask < 0) return null;

  // Get design review pass rates
  const designStats = metrics.design_review_pass_rates[workflow];
  if (!designStats) return null;
  if (designStats.pass_rate === null) return null;
  const designPassRate = designStats.pass_rate;
  if (!Number.isFinite(designPassRate) || designPassRate < 0 || designPassRate > 1) return null;

  // Get task retry counts
  const retryStats = metrics.task_retry_counts[workflow];
  if (!retryStats) return null;
  if (retryStats.retries_per_task === null) return null;
  const retriesPerTask = retryStats.retries_per_task;
  if (!Number.isFinite(retriesPerTask) || retriesPerTask < 0) return null;

  // Get iterations_per_phase_per_issue for completenessVerification and prAndReview
  const phaseData = metrics.iterations_per_phase_per_issue;
  const issueRefs = Object.keys(phaseData).filter((ref) => phaseData[ref][workflow] !== undefined);
  const populationSize = issueRefs.length;
  if (populationSize === 0) return null; // Insufficient history

  // Compute breakdown

  // design: expected number of design_review attempts remaining
  const effectivePassRate = Math.max(designPassRate, MIN_DESIGN_PASS_RATE);
  const rawDesignAttempts = Math.ceil(1 / effectivePassRate);
  const design = Math.max(1, Math.min(rawDesignAttempts, MAX_EXPECTED_DESIGN_REVIEW_ATTEMPTS));

  // implementation: ceil(tasks * iterationsPerTask)
  const implementation = Math.ceil(tasks * iterationsPerTask);

  // specCheck: ceil(tasks * retries_per_task) - retry buffer
  const specCheck = Math.ceil(tasks * retriesPerTask);

  // completenessVerification: mean iterations for completeness_verification phase
  let sumCV = 0;
  for (const ref of issueRefs) {
    const phases = phaseData[ref][workflow];
    sumCV += phases['completeness_verification'] ?? 0;
  }
  const meanCV = sumCV / populationSize;
  const completenessVerification = Math.ceil(meanCV);

  // prAndReview: mean iterations for prepare_pr + code_review + code_fix
  let sumPR = 0;
  for (const ref of issueRefs) {
    const phases = phaseData[ref][workflow];
    const pr = (phases['prepare_pr'] ?? 0) + (phases['code_review'] ?? 0) + (phases['code_fix'] ?? 0);
    sumPR += pr;
  }
  const meanPR = sumPR / populationSize;
  const prAndReview = Math.ceil(meanPR);

  // Total
  const estimatedIterations = design + implementation + specCheck + completenessVerification + prAndReview;

  const estimate: IssueEstimate = {
    estimatedIterations,
    breakdown: {
      design,
      implementation,
      specCheck,
      completenessVerification,
      prAndReview,
    },
    tasks,
    historicalAverage: {
      iterationsPerTask,
      designPassRate,
    },
  };

  // Sanity check
  if (!isValidIssueEstimate(estimate)) return null;

  return estimate;
}

/**
 * Compute issue estimate from metrics file data directly.
 *
 * This is the main entry point for T2 to call after reading metrics.
 */
export function computeIssueEstimateFromMetrics(
  tasks: number,
  workflow: string,
  metrics: RepoMetricsFileV1 | null,
): IssueEstimate | null {
  if (!metrics) return null;
  return computeIssueEstimate({ tasks, workflow, metrics });
}
