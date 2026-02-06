import type { RunStatus } from './types.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Resolve the runId that worker artifacts (STATE/.runs/<runId>/workers/...) live under.
 *
 * Important: In parallel mode, the orchestrator may resume an active wave from a previous run.
 * In that case, worker artifacts are written under `issue.json.status.parallel.runId`, which can
 * differ from the viewer-server RunManager's current `run.run_id`.
 */
export function resolveWorkerArtifactsRunId(params: {
  run: RunStatus;
  issueJson: Record<string, unknown> | null;
}): string | null {
  const { run, issueJson } = params;

  const status = issueJson?.status;
  if (status && typeof status === 'object' && !Array.isArray(status)) {
    const parallel = (status as { parallel?: unknown }).parallel;
    if (parallel && typeof parallel === 'object' && !Array.isArray(parallel)) {
      const runId = (parallel as { runId?: unknown }).runId;
      if (isNonEmptyString(runId)) return runId.trim();
    }
  }

  const fallback = run.run_id;
  return isNonEmptyString(fallback) ? fallback.trim() : null;
}

