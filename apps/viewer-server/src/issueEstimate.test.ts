import { describe, it, expect } from 'vitest';
import {
  isValidIssueEstimate,
  computeIssueEstimate,
  computeIssueEstimateFromMetrics,
  MIN_DESIGN_PASS_RATE,
  MAX_EXPECTED_DESIGN_REVIEW_ATTEMPTS,
  type IssueEstimate,
} from './issueEstimate.js';
import { createEmptyMetrics, type RepoMetricsFileV1 } from './metricsStore.js';

describe('issueEstimate', () => {
  describe('isValidIssueEstimate', () => {
    function createValidEstimate(): IssueEstimate {
      return {
        estimatedIterations: 10,
        breakdown: {
          design: 2,
          implementation: 3,
          specCheck: 1,
          completenessVerification: 2,
          prAndReview: 2,
        },
        tasks: 5,
        historicalAverage: {
          iterationsPerTask: 0.6,
          designPassRate: 0.5,
        },
      };
    }

    it('accepts valid estimate', () => {
      expect(isValidIssueEstimate(createValidEstimate())).toBe(true);
    });

    it('rejects null', () => {
      expect(isValidIssueEstimate(null)).toBe(false);
    });

    it('rejects non-object', () => {
      expect(isValidIssueEstimate('string')).toBe(false);
      expect(isValidIssueEstimate(123)).toBe(false);
      expect(isValidIssueEstimate([])).toBe(false);
    });

    it('rejects non-integer estimatedIterations', () => {
      const estimate = createValidEstimate();
      estimate.estimatedIterations = 10.5;
      expect(isValidIssueEstimate(estimate)).toBe(false);
    });

    it('rejects negative estimatedIterations', () => {
      const estimate = createValidEstimate();
      estimate.estimatedIterations = -1;
      expect(isValidIssueEstimate(estimate)).toBe(false);
    });

    it('rejects missing breakdown keys', () => {
      const estimate = createValidEstimate() as Record<string, unknown>;
      estimate.breakdown = { design: 2, implementation: 3 }; // missing keys
      expect(isValidIssueEstimate(estimate)).toBe(false);
    });

    it('rejects non-integer breakdown values', () => {
      const estimate = createValidEstimate();
      estimate.breakdown.design = 1.5;
      expect(isValidIssueEstimate(estimate)).toBe(false);
    });

    it('rejects negative breakdown values', () => {
      const estimate = createValidEstimate();
      estimate.breakdown.design = -1;
      expect(isValidIssueEstimate(estimate)).toBe(false);
    });

    it('rejects non-integer tasks', () => {
      const estimate = createValidEstimate();
      estimate.tasks = 5.5;
      expect(isValidIssueEstimate(estimate)).toBe(false);
    });

    it('rejects negative tasks', () => {
      const estimate = createValidEstimate();
      estimate.tasks = -1;
      expect(isValidIssueEstimate(estimate)).toBe(false);
    });

    it('rejects non-finite iterationsPerTask', () => {
      const estimate = createValidEstimate();
      estimate.historicalAverage.iterationsPerTask = Infinity;
      expect(isValidIssueEstimate(estimate)).toBe(false);
    });

    it('rejects negative iterationsPerTask', () => {
      const estimate = createValidEstimate();
      estimate.historicalAverage.iterationsPerTask = -0.5;
      expect(isValidIssueEstimate(estimate)).toBe(false);
    });

    it('rejects designPassRate outside [0, 1]', () => {
      const estimate1 = createValidEstimate();
      estimate1.historicalAverage.designPassRate = -0.1;
      expect(isValidIssueEstimate(estimate1)).toBe(false);

      const estimate2 = createValidEstimate();
      estimate2.historicalAverage.designPassRate = 1.1;
      expect(isValidIssueEstimate(estimate2)).toBe(false);
    });

    it('rejects when sum(breakdown) !== estimatedIterations', () => {
      const estimate = createValidEstimate();
      estimate.estimatedIterations = 100; // doesn't match sum
      expect(isValidIssueEstimate(estimate)).toBe(false);
    });

    it('accepts zero values', () => {
      const estimate: IssueEstimate = {
        estimatedIterations: 0,
        breakdown: {
          design: 0,
          implementation: 0,
          specCheck: 0,
          completenessVerification: 0,
          prAndReview: 0,
        },
        tasks: 0,
        historicalAverage: {
          iterationsPerTask: 0,
          designPassRate: 0,
        },
      };
      expect(isValidIssueEstimate(estimate)).toBe(true);
    });
  });

  describe('constants', () => {
    it('has correct MIN_DESIGN_PASS_RATE', () => {
      expect(MIN_DESIGN_PASS_RATE).toBe(0.01);
    });

    it('has correct MAX_EXPECTED_DESIGN_REVIEW_ATTEMPTS', () => {
      expect(MAX_EXPECTED_DESIGN_REVIEW_ATTEMPTS).toBe(6);
    });
  });

  describe('computeIssueEstimate', () => {
    function createMetricsWithHistory(workflow: string): RepoMetricsFileV1 {
      const metrics = createEmptyMetrics('owner/repo');

      // Add implementation iteration counts
      metrics.implementation_iteration_counts[workflow] = {
        implement_task_iterations: 10,
        tasks_at_decomposition: 5,
        iterations_per_task: 2.0, // 10/5 = 2 iterations per task
      };

      // Add design review pass rates
      metrics.design_review_pass_rates[workflow] = {
        attempts: 10,
        passes: 5,
        pass_rate: 0.5, // 50% pass rate
      };

      // Add task retry counts
      metrics.task_retry_counts[workflow] = {
        total_retries: 5,
        total_tasks_at_decomposition: 10,
        retries_per_task: 0.5, // 5/10 = 0.5 retries per task
      };

      // Add iterations_per_phase_per_issue (one sample per issue for population)
      metrics.iterations_per_phase_per_issue = {
        'owner/repo#1': {
          [workflow]: {
            completeness_verification: 2,
            prepare_pr: 1,
            code_review: 1,
            code_fix: 0,
          },
        },
        'owner/repo#2': {
          [workflow]: {
            completeness_verification: 4,
            prepare_pr: 2,
            code_review: 2,
            code_fix: 1,
          },
        },
      };

      return metrics;
    }

    it('computes valid estimate from metrics', () => {
      const metrics = createMetricsWithHistory('default');
      const result = computeIssueEstimate({
        tasks: 5,
        workflow: 'default',
        metrics,
      });

      expect(result).not.toBeNull();
      expect(isValidIssueEstimate(result)).toBe(true);
    });

    it('computes correct breakdown values', () => {
      const metrics = createMetricsWithHistory('default');
      const result = computeIssueEstimate({
        tasks: 5,
        workflow: 'default',
        metrics,
      })!;

      // design: ceil(1 / 0.5) = 2
      expect(result.breakdown.design).toBe(2);

      // implementation: ceil(5 * 2.0) = 10
      expect(result.breakdown.implementation).toBe(10);

      // specCheck: ceil(5 * 0.5) = 3
      expect(result.breakdown.specCheck).toBe(3);

      // completenessVerification: mean(2, 4) = 3, ceil(3) = 3
      expect(result.breakdown.completenessVerification).toBe(3);

      // prAndReview: mean((1+1+0), (2+2+1)) = mean(2, 5) = 3.5, ceil(3.5) = 4
      expect(result.breakdown.prAndReview).toBe(4);

      // estimatedIterations = sum(breakdown)
      expect(result.estimatedIterations).toBe(
        result.breakdown.design +
          result.breakdown.implementation +
          result.breakdown.specCheck +
          result.breakdown.completenessVerification +
          result.breakdown.prAndReview,
      );
    });

    it('includes tasks and historicalAverage in result', () => {
      const metrics = createMetricsWithHistory('default');
      const result = computeIssueEstimate({
        tasks: 5,
        workflow: 'default',
        metrics,
      })!;

      expect(result.tasks).toBe(5);
      expect(result.historicalAverage.iterationsPerTask).toBe(2.0);
      expect(result.historicalAverage.designPassRate).toBe(0.5);
    });

    it('returns null for invalid tasks', () => {
      const metrics = createMetricsWithHistory('default');

      expect(
        computeIssueEstimate({
          tasks: -1,
          workflow: 'default',
          metrics,
        }),
      ).toBeNull();

      expect(
        computeIssueEstimate({
          tasks: 1.5,
          workflow: 'default',
          metrics,
        }),
      ).toBeNull();
    });

    it('returns null when implementation_iteration_counts missing', () => {
      const metrics = createMetricsWithHistory('default');
      delete metrics.implementation_iteration_counts['default'];

      expect(
        computeIssueEstimate({
          tasks: 5,
          workflow: 'default',
          metrics,
        }),
      ).toBeNull();
    });

    it('returns null when iterations_per_task is null', () => {
      const metrics = createMetricsWithHistory('default');
      metrics.implementation_iteration_counts['default'].iterations_per_task = null;

      expect(
        computeIssueEstimate({
          tasks: 5,
          workflow: 'default',
          metrics,
        }),
      ).toBeNull();
    });

    it('returns null when design_review_pass_rates missing', () => {
      const metrics = createMetricsWithHistory('default');
      delete metrics.design_review_pass_rates['default'];

      expect(
        computeIssueEstimate({
          tasks: 5,
          workflow: 'default',
          metrics,
        }),
      ).toBeNull();
    });

    it('returns null when pass_rate is null', () => {
      const metrics = createMetricsWithHistory('default');
      metrics.design_review_pass_rates['default'].pass_rate = null;

      expect(
        computeIssueEstimate({
          tasks: 5,
          workflow: 'default',
          metrics,
        }),
      ).toBeNull();
    });

    it('returns null when task_retry_counts missing', () => {
      const metrics = createMetricsWithHistory('default');
      delete metrics.task_retry_counts['default'];

      expect(
        computeIssueEstimate({
          tasks: 5,
          workflow: 'default',
          metrics,
        }),
      ).toBeNull();
    });

    it('returns null when retries_per_task is null', () => {
      const metrics = createMetricsWithHistory('default');
      metrics.task_retry_counts['default'].retries_per_task = null;

      expect(
        computeIssueEstimate({
          tasks: 5,
          workflow: 'default',
          metrics,
        }),
      ).toBeNull();
    });

    it('returns null when no population (no iterations_per_phase_per_issue for workflow)', () => {
      const metrics = createMetricsWithHistory('default');
      metrics.iterations_per_phase_per_issue = {};

      expect(
        computeIssueEstimate({
          tasks: 5,
          workflow: 'default',
          metrics,
        }),
      ).toBeNull();
    });

    it('returns null for different workflow', () => {
      const metrics = createMetricsWithHistory('default');

      expect(
        computeIssueEstimate({
          tasks: 5,
          workflow: 'quick-fix', // different workflow
          metrics,
        }),
      ).toBeNull();
    });

    it('caps design at MAX_EXPECTED_DESIGN_REVIEW_ATTEMPTS for low pass rate', () => {
      const metrics = createMetricsWithHistory('default');
      metrics.design_review_pass_rates['default'].pass_rate = 0.001; // very low

      const result = computeIssueEstimate({
        tasks: 5,
        workflow: 'default',
        metrics,
      })!;

      // design should be capped at 6
      expect(result.breakdown.design).toBe(MAX_EXPECTED_DESIGN_REVIEW_ATTEMPTS);
    });

    it('uses MIN_DESIGN_PASS_RATE to avoid division by zero', () => {
      const metrics = createMetricsWithHistory('default');
      metrics.design_review_pass_rates['default'].pass_rate = 0.005; // below MIN_DESIGN_PASS_RATE

      const result = computeIssueEstimate({
        tasks: 5,
        workflow: 'default',
        metrics,
      })!;

      // With effective pass rate of 0.01, design = ceil(1/0.01) = 100, but capped at 6
      expect(result.breakdown.design).toBe(MAX_EXPECTED_DESIGN_REVIEW_ATTEMPTS);
    });

    it('design is at least 1', () => {
      const metrics = createMetricsWithHistory('default');
      metrics.design_review_pass_rates['default'].pass_rate = 1.0; // 100% pass rate

      const result = computeIssueEstimate({
        tasks: 5,
        workflow: 'default',
        metrics,
      })!;

      // ceil(1 / 1.0) = 1, and min is 1
      expect(result.breakdown.design).toBe(1);
    });

    it('handles zero tasks correctly', () => {
      const metrics = createMetricsWithHistory('default');

      const result = computeIssueEstimate({
        tasks: 0,
        workflow: 'default',
        metrics,
      })!;

      expect(result.tasks).toBe(0);
      expect(result.breakdown.implementation).toBe(0);
      expect(result.breakdown.specCheck).toBe(0);
      expect(isValidIssueEstimate(result)).toBe(true);
    });

    it('treats missing phase counts as 0', () => {
      const metrics = createMetricsWithHistory('default');
      // Remove completeness_verification from one issue
      metrics.iterations_per_phase_per_issue['owner/repo#1']['default'] = {
        prepare_pr: 1,
        code_review: 1,
      };

      const result = computeIssueEstimate({
        tasks: 5,
        workflow: 'default',
        metrics,
      })!;

      // completenessVerification: mean(0, 4) = 2, ceil(2) = 2
      expect(result.breakdown.completenessVerification).toBe(2);
    });
  });

  describe('computeIssueEstimateFromMetrics', () => {
    it('returns null for null metrics', () => {
      expect(computeIssueEstimateFromMetrics(5, 'default', null)).toBeNull();
    });

    it('delegates to computeIssueEstimate', () => {
      const metrics = createEmptyMetrics('owner/repo');
      metrics.implementation_iteration_counts['default'] = {
        implement_task_iterations: 10,
        tasks_at_decomposition: 5,
        iterations_per_task: 2.0,
      };
      metrics.design_review_pass_rates['default'] = {
        attempts: 10,
        passes: 5,
        pass_rate: 0.5,
      };
      metrics.task_retry_counts['default'] = {
        total_retries: 5,
        total_tasks_at_decomposition: 10,
        retries_per_task: 0.5,
      };
      metrics.iterations_per_phase_per_issue = {
        'owner/repo#1': {
          default: {
            completeness_verification: 2,
            prepare_pr: 1,
          },
        },
      };

      const result = computeIssueEstimateFromMetrics(5, 'default', metrics);
      expect(result).not.toBeNull();
      expect(isValidIssueEstimate(result)).toBe(true);
    });
  });

  describe('sum(breakdown) === estimatedIterations invariant', () => {
    it('holds for various inputs', () => {
      const metrics = createEmptyMetrics('owner/repo');
      metrics.implementation_iteration_counts['default'] = {
        implement_task_iterations: 15,
        tasks_at_decomposition: 10,
        iterations_per_task: 1.5,
      };
      metrics.design_review_pass_rates['default'] = {
        attempts: 20,
        passes: 16,
        pass_rate: 0.8,
      };
      metrics.task_retry_counts['default'] = {
        total_retries: 3,
        total_tasks_at_decomposition: 10,
        retries_per_task: 0.3,
      };
      metrics.iterations_per_phase_per_issue = {
        'owner/repo#1': {
          default: {
            completeness_verification: 1,
            prepare_pr: 1,
            code_review: 2,
            code_fix: 1,
          },
        },
        'owner/repo#2': {
          default: {
            completeness_verification: 3,
            prepare_pr: 1,
            code_review: 1,
            code_fix: 0,
          },
        },
        'owner/repo#3': {
          default: {
            completeness_verification: 2,
            prepare_pr: 2,
            code_review: 1,
            code_fix: 1,
          },
        },
      };

      // Test with various task counts
      for (const tasks of [1, 5, 10, 20, 100]) {
        const result = computeIssueEstimate({
          tasks,
          workflow: 'default',
          metrics,
        })!;

        const sum =
          result.breakdown.design +
          result.breakdown.implementation +
          result.breakdown.specCheck +
          result.breakdown.completenessVerification +
          result.breakdown.prAndReview;

        expect(result.estimatedIterations).toBe(sum);
        expect(isValidIssueEstimate(result)).toBe(true);
      }
    });
  });
});
