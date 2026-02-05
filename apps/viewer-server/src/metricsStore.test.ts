import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createEmptyMetrics,
  isValidMetricsFile,
  readMetricsFile,
  writeMetricsFile,
  getMetricsDir,
  getMetricsFilePath,
  isRunEligible,
  resolveRunWorkflow,
  readRunJson,
  countPhases,
  getTasksAtDecomposition,
  countTaskRetries,
  countDesignReviewStats,
  extractRunArchiveData,
  ingestRunArchiveIntoMetrics,
} from './metricsStore.js';

describe('metricsStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metrics-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getMetricsDir', () => {
    it('returns metrics directory under data dir', () => {
      expect(getMetricsDir('/data')).toBe('/data/metrics');
    });
  });

  describe('getMetricsFilePath', () => {
    it('returns correct path for owner-repo.json', () => {
      expect(getMetricsFilePath('/data', 'owner', 'repo')).toBe('/data/metrics/owner-repo.json');
    });
  });

  describe('createEmptyMetrics', () => {
    it('creates valid empty metrics structure', () => {
      const metrics = createEmptyMetrics('owner/repo');
      expect(metrics.schemaVersion).toBe(1);
      expect(metrics.repo).toBe('owner/repo');
      expect(metrics.processed_run_ids).toEqual([]);
      expect(metrics.iterations_per_phase_per_issue).toEqual({});
      expect(metrics.iterations_per_phase_per_issue_sources).toEqual({});
      expect(metrics.task_retry_counts).toEqual({});
      expect(metrics.design_review_pass_rates).toEqual({});
      expect(metrics.implementation_iteration_counts).toEqual({});
      expect(isValidMetricsFile(metrics)).toBe(true);
    });

    it('sets updated_at to current ISO timestamp', () => {
      const before = new Date().toISOString();
      const metrics = createEmptyMetrics('owner/repo');
      const after = new Date().toISOString();
      expect(metrics.updated_at >= before).toBe(true);
      expect(metrics.updated_at <= after).toBe(true);
    });
  });

  describe('isValidMetricsFile', () => {
    it('accepts valid metrics file', () => {
      const metrics = createEmptyMetrics('owner/repo');
      expect(isValidMetricsFile(metrics)).toBe(true);
    });

    it('rejects null', () => {
      expect(isValidMetricsFile(null)).toBe(false);
    });

    it('rejects non-object', () => {
      expect(isValidMetricsFile('string')).toBe(false);
      expect(isValidMetricsFile(123)).toBe(false);
      expect(isValidMetricsFile([])).toBe(false);
    });

    it('rejects wrong schemaVersion', () => {
      const metrics = { ...createEmptyMetrics('owner/repo'), schemaVersion: 2 };
      expect(isValidMetricsFile(metrics)).toBe(false);
    });

    it('rejects missing required fields', () => {
      const base = createEmptyMetrics('owner/repo');

      expect(isValidMetricsFile({ ...base, repo: undefined })).toBe(false);
      expect(isValidMetricsFile({ ...base, updated_at: undefined })).toBe(false);
      expect(isValidMetricsFile({ ...base, processed_run_ids: undefined })).toBe(false);
      expect(isValidMetricsFile({ ...base, iterations_per_phase_per_issue: undefined })).toBe(false);
      expect(isValidMetricsFile({ ...base, iterations_per_phase_per_issue_sources: undefined })).toBe(false);
      expect(isValidMetricsFile({ ...base, task_retry_counts: undefined })).toBe(false);
      expect(isValidMetricsFile({ ...base, design_review_pass_rates: undefined })).toBe(false);
      expect(isValidMetricsFile({ ...base, implementation_iteration_counts: undefined })).toBe(false);
    });

    it('rejects non-array processed_run_ids', () => {
      const metrics = { ...createEmptyMetrics('owner/repo'), processed_run_ids: {} };
      expect(isValidMetricsFile(metrics)).toBe(false);
    });
  });

  describe('readMetricsFile / writeMetricsFile', () => {
    it('returns null for non-existent file', async () => {
      const result = await readMetricsFile(tmpDir, 'owner', 'repo');
      expect(result).toBeNull();
    });

    it('writes and reads metrics file', async () => {
      const metrics = createEmptyMetrics('owner/repo');
      metrics.processed_run_ids.push('run-1');

      await writeMetricsFile(tmpDir, 'owner', 'repo', metrics);
      const read = await readMetricsFile(tmpDir, 'owner', 'repo');

      expect(read).not.toBeNull();
      expect(read!.repo).toBe('owner/repo');
      expect(read!.processed_run_ids).toContain('run-1');
    });

    it('creates metrics directory if missing', async () => {
      const metrics = createEmptyMetrics('owner/repo');
      await writeMetricsFile(tmpDir, 'owner', 'repo', metrics);

      const dirExists = await fs
        .access(path.join(tmpDir, 'metrics'))
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);
    });

    it('returns null for invalid JSON', async () => {
      const filePath = getMetricsFilePath(tmpDir, 'owner', 'repo');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'invalid json');

      const result = await readMetricsFile(tmpDir, 'owner', 'repo');
      expect(result).toBeNull();
    });

    it('returns null for valid JSON but invalid schema', async () => {
      const filePath = getMetricsFilePath(tmpDir, 'owner', 'repo');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ invalid: 'data' }));

      const result = await readMetricsFile(tmpDir, 'owner', 'repo');
      expect(result).toBeNull();
    });
  });

  describe('isRunEligible', () => {
    async function createRunDir(
      runJson: Record<string, unknown>,
      iterations: { phase: string }[] = [],
    ): Promise<string> {
      const runDir = path.join(tmpDir, 'run-test');
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(runJson));

      const iterationsDir = path.join(runDir, 'iterations');
      await fs.mkdir(iterationsDir, { recursive: true });

      for (let i = 0; i < iterations.length; i++) {
        const iterDir = path.join(iterationsDir, String(i + 1).padStart(3, '0'));
        await fs.mkdir(iterDir, { recursive: true });
        await fs.writeFile(path.join(iterDir, 'iteration.json'), JSON.stringify(iterations[i]));
      }

      return runDir;
    }

    it('returns true for completed run with exit_code 0 and iterations', async () => {
      const runDir = await createRunDir(
        { completed_via_state: true, exit_code: 0 },
        [{ phase: 'implement_task' }],
      );
      expect(await isRunEligible(runDir)).toBe(true);
    });

    it('returns true for completed_via_promise', async () => {
      const runDir = await createRunDir(
        { completed_via_promise: true, exit_code: 0 },
        [{ phase: 'implement_task' }],
      );
      expect(await isRunEligible(runDir)).toBe(true);
    });

    it('returns false when neither completion flag is set', async () => {
      const runDir = await createRunDir({ exit_code: 0 }, [{ phase: 'implement_task' }]);
      expect(await isRunEligible(runDir)).toBe(false);
    });

    it('returns false for non-zero exit_code', async () => {
      const runDir = await createRunDir(
        { completed_via_state: true, exit_code: 1 },
        [{ phase: 'implement_task' }],
      );
      expect(await isRunEligible(runDir)).toBe(false);
    });

    it('returns false for missing iterations', async () => {
      const runDir = await createRunDir({ completed_via_state: true, exit_code: 0 }, []);
      expect(await isRunEligible(runDir)).toBe(false);
    });

    it('returns false for non-existent run.json', async () => {
      const runDir = path.join(tmpDir, 'nonexistent');
      expect(await isRunEligible(runDir)).toBe(false);
    });
  });

  describe('resolveRunWorkflow', () => {
    it('returns workflow from iterations/001/iteration.json', async () => {
      const runDir = path.join(tmpDir, 'run-workflow');
      await fs.mkdir(path.join(runDir, 'iterations', '001'), { recursive: true });
      await fs.writeFile(
        path.join(runDir, 'iterations', '001', 'iteration.json'),
        JSON.stringify({ workflow: 'default' }),
      );

      expect(await resolveRunWorkflow(runDir)).toBe('default');
    });

    it('falls back to final-issue.json.workflow', async () => {
      const runDir = path.join(tmpDir, 'run-workflow-fallback');
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, 'final-issue.json'), JSON.stringify({ workflow: 'quick-fix' }));

      expect(await resolveRunWorkflow(runDir)).toBe('quick-fix');
    });

    it('prefers iterations/001 over final-issue.json', async () => {
      const runDir = path.join(tmpDir, 'run-workflow-both');
      await fs.mkdir(path.join(runDir, 'iterations', '001'), { recursive: true });
      await fs.writeFile(
        path.join(runDir, 'iterations', '001', 'iteration.json'),
        JSON.stringify({ workflow: 'default' }),
      );
      await fs.writeFile(path.join(runDir, 'final-issue.json'), JSON.stringify({ workflow: 'quick-fix' }));

      expect(await resolveRunWorkflow(runDir)).toBe('default');
    });

    it('returns null when no workflow found', async () => {
      const runDir = path.join(tmpDir, 'run-no-workflow');
      await fs.mkdir(runDir, { recursive: true });

      expect(await resolveRunWorkflow(runDir)).toBeNull();
    });

    it('returns null for empty workflow string', async () => {
      const runDir = path.join(tmpDir, 'run-empty-workflow');
      await fs.mkdir(path.join(runDir, 'iterations', '001'), { recursive: true });
      await fs.writeFile(path.join(runDir, 'iterations', '001', 'iteration.json'), JSON.stringify({ workflow: '' }));

      expect(await resolveRunWorkflow(runDir)).toBeNull();
    });
  });

  describe('readRunJson', () => {
    it('extracts run metadata', async () => {
      const runDir = path.join(tmpDir, 'run-meta');
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, 'run.json'),
        JSON.stringify({
          run_id: 'run-123',
          issue_ref: 'owner/repo#42',
          started_at: '2024-01-01T00:00:00Z',
        }),
      );

      const result = await readRunJson(runDir);
      expect(result).toEqual({
        run_id: 'run-123',
        issue_ref: 'owner/repo#42',
        started_at: '2024-01-01T00:00:00Z',
      });
    });

    it('returns null for missing run.json', async () => {
      expect(await readRunJson(path.join(tmpDir, 'nonexistent'))).toBeNull();
    });

    it('returns null for missing required fields', async () => {
      const runDir = path.join(tmpDir, 'run-incomplete');
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ run_id: 'run-123' }));

      expect(await readRunJson(runDir)).toBeNull();
    });
  });

  describe('countPhases', () => {
    it('counts phase occurrences across iterations', async () => {
      const runDir = path.join(tmpDir, 'run-phases');
      const iterDir = path.join(runDir, 'iterations');

      for (const [idx, phase] of ['implement_task', 'implement_task', 'task_spec_check'].entries()) {
        const dir = path.join(iterDir, String(idx + 1).padStart(3, '0'));
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'iteration.json'), JSON.stringify({ phase }));
      }

      const counts = await countPhases(runDir);
      expect(counts).toEqual({
        implement_task: 2,
        task_spec_check: 1,
      });
    });

    it('returns empty object for no iterations', async () => {
      const runDir = path.join(tmpDir, 'run-no-phases');
      await fs.mkdir(runDir, { recursive: true });

      const counts = await countPhases(runDir);
      expect(counts).toEqual({});
    });
  });

  describe('getTasksAtDecomposition', () => {
    it('gets tasks from final-issue.json.estimate.tasks', async () => {
      const runDir = path.join(tmpDir, 'run-tasks');
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, 'final-issue.json'),
        JSON.stringify({ estimate: { tasks: 5 } }),
      );

      expect(await getTasksAtDecomposition(runDir)).toBe(5);
    });

    it('falls back to earliest post-decomposition tasks.json', async () => {
      const runDir = path.join(tmpDir, 'run-tasks-fallback');
      const iterDir = path.join(runDir, 'iterations');

      // Create iteration 001 with design_plan (pre-decomposition)
      await fs.mkdir(path.join(iterDir, '001'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '001', 'iteration.json'),
        JSON.stringify({ phase: 'design_plan' }),
      );

      // Create iteration 002 with implement_task (post-decomposition)
      await fs.mkdir(path.join(iterDir, '002'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '002', 'iteration.json'),
        JSON.stringify({ phase: 'implement_task' }),
      );
      await fs.writeFile(
        path.join(iterDir, '002', 'tasks.json'),
        JSON.stringify({ tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }] }),
      );

      expect(await getTasksAtDecomposition(runDir)).toBe(3);
    });

    it('returns null when no tasks found', async () => {
      const runDir = path.join(tmpDir, 'run-no-tasks');
      await fs.mkdir(runDir, { recursive: true });

      expect(await getTasksAtDecomposition(runDir)).toBeNull();
    });
  });

  describe('countTaskRetries', () => {
    it('counts retries when task status regresses', async () => {
      const runDir = path.join(tmpDir, 'run-retries');
      const iterDir = path.join(runDir, 'iterations');

      // Iteration 1: T1 pending
      await fs.mkdir(path.join(iterDir, '001'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '001', 'tasks.json'),
        JSON.stringify({ tasks: [{ id: 'T1', status: 'pending' }] }),
      );

      // Iteration 2: T1 completed
      await fs.mkdir(path.join(iterDir, '002'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '002', 'tasks.json'),
        JSON.stringify({ tasks: [{ id: 'T1', status: 'completed' }] }),
      );

      // Iteration 3: T1 back to pending (retry!)
      await fs.mkdir(path.join(iterDir, '003'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '003', 'tasks.json'),
        JSON.stringify({ tasks: [{ id: 'T1', status: 'pending' }] }),
      );

      expect(await countTaskRetries(runDir)).toBe(1);
    });

    it('counts multiple retries across multiple tasks', async () => {
      const runDir = path.join(tmpDir, 'run-multi-retries');
      const iterDir = path.join(runDir, 'iterations');

      // Iteration 1: both pending
      await fs.mkdir(path.join(iterDir, '001'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '001', 'tasks.json'),
        JSON.stringify({
          tasks: [
            { id: 'T1', status: 'pending' },
            { id: 'T2', status: 'pending' },
          ],
        }),
      );

      // Iteration 2: both completed
      await fs.mkdir(path.join(iterDir, '002'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '002', 'tasks.json'),
        JSON.stringify({
          tasks: [
            { id: 'T1', status: 'completed' },
            { id: 'T2', status: 'failed' },
          ],
        }),
      );

      // Iteration 3: both retry
      await fs.mkdir(path.join(iterDir, '003'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '003', 'tasks.json'),
        JSON.stringify({
          tasks: [
            { id: 'T1', status: 'pending' },
            { id: 'T2', status: 'in_progress' },
          ],
        }),
      );

      expect(await countTaskRetries(runDir)).toBe(2);
    });

    it('returns 0 for no retries', async () => {
      const runDir = path.join(tmpDir, 'run-no-retries');
      const iterDir = path.join(runDir, 'iterations');

      await fs.mkdir(path.join(iterDir, '001'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '001', 'tasks.json'),
        JSON.stringify({ tasks: [{ id: 'T1', status: 'pending' }] }),
      );

      await fs.mkdir(path.join(iterDir, '002'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '002', 'tasks.json'),
        JSON.stringify({ tasks: [{ id: 'T1', status: 'completed' }] }),
      );

      expect(await countTaskRetries(runDir)).toBe(0);
    });
  });

  describe('countDesignReviewStats', () => {
    it('counts design review attempts and passes', async () => {
      const runDir = path.join(tmpDir, 'run-design');
      const iterDir = path.join(runDir, 'iterations');

      // Iteration 1: design_review, not passed
      await fs.mkdir(path.join(iterDir, '001'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '001', 'iteration.json'),
        JSON.stringify({ phase: 'design_review' }),
      );
      await fs.writeFile(
        path.join(iterDir, '001', 'issue.json'),
        JSON.stringify({ status: { designApproved: false } }),
      );

      // Iteration 2: design_review, passed
      await fs.mkdir(path.join(iterDir, '002'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '002', 'iteration.json'),
        JSON.stringify({ phase: 'design_review' }),
      );
      await fs.writeFile(
        path.join(iterDir, '002', 'issue.json'),
        JSON.stringify({
          status: { designApproved: true, designNeedsChanges: false, designFeedback: null },
        }),
      );

      const stats = await countDesignReviewStats(runDir);
      expect(stats.attempts).toBe(2);
      expect(stats.passes).toBe(1);
    });

    it('does not count pass if designNeedsChanges is true', async () => {
      const runDir = path.join(tmpDir, 'run-design-needs-changes');
      const iterDir = path.join(runDir, 'iterations');

      await fs.mkdir(path.join(iterDir, '001'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '001', 'iteration.json'),
        JSON.stringify({ phase: 'design_review' }),
      );
      await fs.writeFile(
        path.join(iterDir, '001', 'issue.json'),
        JSON.stringify({
          status: { designApproved: true, designNeedsChanges: true, designFeedback: null },
        }),
      );

      const stats = await countDesignReviewStats(runDir);
      expect(stats.attempts).toBe(1);
      expect(stats.passes).toBe(0);
    });

    it('does not count pass if designFeedback is present', async () => {
      const runDir = path.join(tmpDir, 'run-design-feedback');
      const iterDir = path.join(runDir, 'iterations');

      await fs.mkdir(path.join(iterDir, '001'), { recursive: true });
      await fs.writeFile(
        path.join(iterDir, '001', 'iteration.json'),
        JSON.stringify({ phase: 'design_review' }),
      );
      await fs.writeFile(
        path.join(iterDir, '001', 'issue.json'),
        JSON.stringify({
          status: { designApproved: true, designNeedsChanges: false, designFeedback: 'some feedback' },
        }),
      );

      const stats = await countDesignReviewStats(runDir);
      expect(stats.attempts).toBe(1);
      expect(stats.passes).toBe(0);
    });
  });

  describe('extractRunArchiveData', () => {
    async function createCompleteRun(overrides: {
      runJson?: Record<string, unknown>;
      workflow?: string;
      phases?: string[];
      tasks?: number;
    }): Promise<string> {
      const runDir = path.join(tmpDir, `run-${Date.now()}`);
      const iterDir = path.join(runDir, 'iterations');

      // run.json
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, 'run.json'),
        JSON.stringify({
          run_id: 'run-123',
          issue_ref: 'owner/repo#42',
          started_at: '2024-01-01T00:00:00Z',
          completed_via_state: true,
          exit_code: 0,
          ...overrides.runJson,
        }),
      );

      // iterations with phase
      const phases = overrides.phases ?? ['implement_task'];
      for (let i = 0; i < phases.length; i++) {
        const dir = path.join(iterDir, String(i + 1).padStart(3, '0'));
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, 'iteration.json'),
          JSON.stringify({ phase: phases[i], workflow: overrides.workflow ?? 'default' }),
        );
        // Add tasks.json for implement_task phase
        if (phases[i] === 'implement_task' && i === 0) {
          const taskCount = overrides.tasks ?? 3;
          await fs.writeFile(
            path.join(dir, 'tasks.json'),
            JSON.stringify({ tasks: Array.from({ length: taskCount }, (_, j) => ({ id: `T${j + 1}`, status: 'pending' })) }),
          );
        }
      }

      return runDir;
    }

    it('extracts all data from valid run', async () => {
      const runDir = await createCompleteRun({
        phases: ['implement_task', 'implement_task', 'task_spec_check'],
        tasks: 5,
      });

      const data = await extractRunArchiveData(runDir);
      expect(data).not.toBeNull();
      expect(data!.run_id).toBe('run-123');
      expect(data!.issue_ref).toBe('owner/repo#42');
      expect(data!.workflow).toBe('default');
      expect(data!.started_at).toBe('2024-01-01T00:00:00Z');
      expect(data!.phase_counts).toEqual({
        implement_task: 2,
        task_spec_check: 1,
      });
      expect(data!.tasks_at_decomposition).toBe(5);
      expect(data!.implement_task_iterations).toBe(2);
    });

    it('returns null for ineligible run', async () => {
      const runDir = await createCompleteRun({ runJson: { exit_code: 1 } });
      expect(await extractRunArchiveData(runDir)).toBeNull();
    });

    it('returns null when workflow cannot be resolved', async () => {
      const runDir = path.join(tmpDir, 'run-no-workflow');
      await fs.mkdir(path.join(runDir, 'iterations', '001'), { recursive: true });
      await fs.writeFile(
        path.join(runDir, 'run.json'),
        JSON.stringify({
          run_id: 'run-123',
          issue_ref: 'owner/repo#42',
          started_at: '2024-01-01T00:00:00Z',
          completed_via_state: true,
          exit_code: 0,
        }),
      );
      await fs.writeFile(
        path.join(runDir, 'iterations', '001', 'iteration.json'),
        JSON.stringify({ phase: 'implement_task' }), // no workflow field
      );

      expect(await extractRunArchiveData(runDir)).toBeNull();
    });
  });

  describe('ingestRunArchiveIntoMetrics', () => {
    async function createValidRun(params: {
      runId: string;
      issueRef: string;
      workflow: string;
      startedAt: string;
      phases: string[];
      tasks: number;
    }): Promise<string> {
      const runDir = path.join(tmpDir, `run-${params.runId}`);
      const iterDir = path.join(runDir, 'iterations');

      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, 'run.json'),
        JSON.stringify({
          run_id: params.runId,
          issue_ref: params.issueRef,
          started_at: params.startedAt,
          completed_via_state: true,
          exit_code: 0,
        }),
      );

      for (let i = 0; i < params.phases.length; i++) {
        const dir = path.join(iterDir, String(i + 1).padStart(3, '0'));
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, 'iteration.json'),
          JSON.stringify({ phase: params.phases[i], workflow: params.workflow }),
        );
        // Add tasks.json for first implement_task
        if (params.phases[i] === 'implement_task' && !params.phases.slice(0, i).includes('implement_task')) {
          await fs.writeFile(
            path.join(dir, 'tasks.json'),
            JSON.stringify({
              tasks: Array.from({ length: params.tasks }, (_, j) => ({
                id: `T${j + 1}`,
                status: 'pending',
              })),
            }),
          );
        }
      }

      return runDir;
    }

    it('creates new metrics file and ingests run', async () => {
      const runDir = await createValidRun({
        runId: 'run-1',
        issueRef: 'owner/repo#42',
        workflow: 'default',
        startedAt: '2024-01-01T00:00:00Z',
        phases: ['implement_task', 'task_spec_check'],
        tasks: 3,
      });

      const result = await ingestRunArchiveIntoMetrics(tmpDir, runDir, 'owner', 'repo');
      expect(result).toBe(true);

      const metrics = await readMetricsFile(tmpDir, 'owner', 'repo');
      expect(metrics).not.toBeNull();
      expect(metrics!.processed_run_ids).toContain('run-1');
      expect(metrics!.iterations_per_phase_per_issue['owner/repo#42']['default']).toEqual({
        implement_task: 1,
        task_spec_check: 1,
      });
    });

    it('deduplicates by run_id', async () => {
      const runDir = await createValidRun({
        runId: 'run-1',
        issueRef: 'owner/repo#42',
        workflow: 'default',
        startedAt: '2024-01-01T00:00:00Z',
        phases: ['implement_task'],
        tasks: 3,
      });

      await ingestRunArchiveIntoMetrics(tmpDir, runDir, 'owner', 'repo');
      const result = await ingestRunArchiveIntoMetrics(tmpDir, runDir, 'owner', 'repo');

      expect(result).toBe(false); // Already processed
    });

    it('updates iterations_per_phase_per_issue with newer run', async () => {
      // First run (older)
      const runDir1 = await createValidRun({
        runId: 'run-1',
        issueRef: 'owner/repo#42',
        workflow: 'default',
        startedAt: '2024-01-01T00:00:00Z',
        phases: ['implement_task'],
        tasks: 3,
      });
      await ingestRunArchiveIntoMetrics(tmpDir, runDir1, 'owner', 'repo');

      // Second run (newer, same issue)
      const runDir2 = await createValidRun({
        runId: 'run-2',
        issueRef: 'owner/repo#42',
        workflow: 'default',
        startedAt: '2024-01-02T00:00:00Z',
        phases: ['implement_task', 'implement_task', 'task_spec_check'],
        tasks: 5,
      });
      await ingestRunArchiveIntoMetrics(tmpDir, runDir2, 'owner', 'repo');

      const metrics = await readMetricsFile(tmpDir, 'owner', 'repo');
      // Should have newer run's phase counts
      expect(metrics!.iterations_per_phase_per_issue['owner/repo#42']['default']).toEqual({
        implement_task: 2,
        task_spec_check: 1,
      });
      expect(metrics!.iterations_per_phase_per_issue_sources['owner/repo#42']['default'].run_id).toBe('run-2');
    });

    it('does not update iterations_per_phase_per_issue with older run', async () => {
      // First run (newer)
      const runDir1 = await createValidRun({
        runId: 'run-2',
        issueRef: 'owner/repo#42',
        workflow: 'default',
        startedAt: '2024-01-02T00:00:00Z',
        phases: ['implement_task', 'implement_task'],
        tasks: 5,
      });
      await ingestRunArchiveIntoMetrics(tmpDir, runDir1, 'owner', 'repo');

      // Second run (older, same issue) - should not overwrite
      const runDir2 = await createValidRun({
        runId: 'run-1',
        issueRef: 'owner/repo#42',
        workflow: 'default',
        startedAt: '2024-01-01T00:00:00Z',
        phases: ['implement_task'],
        tasks: 3,
      });
      await ingestRunArchiveIntoMetrics(tmpDir, runDir2, 'owner', 'repo');

      const metrics = await readMetricsFile(tmpDir, 'owner', 'repo');
      // Should still have first run's phase counts
      expect(metrics!.iterations_per_phase_per_issue['owner/repo#42']['default']).toEqual({
        implement_task: 2,
      });
      expect(metrics!.iterations_per_phase_per_issue_sources['owner/repo#42']['default'].run_id).toBe('run-2');
    });

    it('accumulates task_retry_counts across runs', async () => {
      // First run
      const runDir1 = await createValidRun({
        runId: 'run-1',
        issueRef: 'owner/repo#42',
        workflow: 'default',
        startedAt: '2024-01-01T00:00:00Z',
        phases: ['implement_task'],
        tasks: 3,
      });
      await ingestRunArchiveIntoMetrics(tmpDir, runDir1, 'owner', 'repo');

      // Second run (different issue)
      const runDir2 = await createValidRun({
        runId: 'run-2',
        issueRef: 'owner/repo#43',
        workflow: 'default',
        startedAt: '2024-01-02T00:00:00Z',
        phases: ['implement_task'],
        tasks: 5,
      });
      await ingestRunArchiveIntoMetrics(tmpDir, runDir2, 'owner', 'repo');

      const metrics = await readMetricsFile(tmpDir, 'owner', 'repo');
      expect(metrics!.task_retry_counts['default'].total_tasks_at_decomposition).toBe(8);
    });

    it('computes iterations_per_task correctly', async () => {
      const runDir = await createValidRun({
        runId: 'run-1',
        issueRef: 'owner/repo#42',
        workflow: 'default',
        startedAt: '2024-01-01T00:00:00Z',
        phases: ['implement_task', 'implement_task', 'implement_task'], // 3 implement_task iterations
        tasks: 3, // 3 tasks
      });
      await ingestRunArchiveIntoMetrics(tmpDir, runDir, 'owner', 'repo');

      const metrics = await readMetricsFile(tmpDir, 'owner', 'repo');
      expect(metrics!.implementation_iteration_counts['default'].implement_task_iterations).toBe(3);
      expect(metrics!.implementation_iteration_counts['default'].tasks_at_decomposition).toBe(3);
      expect(metrics!.implementation_iteration_counts['default'].iterations_per_task).toBe(1);
    });

    it('returns false for ineligible run', async () => {
      const runDir = path.join(tmpDir, 'ineligible-run');
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, 'run.json'),
        JSON.stringify({ exit_code: 1 }), // ineligible
      );

      const result = await ingestRunArchiveIntoMetrics(tmpDir, runDir, 'owner', 'repo');
      expect(result).toBe(false);
    });
  });
});
