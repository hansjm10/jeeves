import { useCallback, useEffect, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { WorkerStatusInfo } from '../api/types.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { LogPanel } from '../ui/LogPanel.js';
import { SdkPage } from './SdkPage.js';
import './WatchPage.css';

/**
 * Valid view modes for the Watch page.
 * - combined: SDK + Logs side-by-side
 * - sdk: SDK events only
 * - logs: Logs panel only
 * - viewer-logs: Viewer logs panel only
 */
export type WatchViewMode = 'combined' | 'sdk' | 'logs' | 'viewer-logs';

const VALID_VIEWS: WatchViewMode[] = ['combined', 'sdk', 'logs', 'viewer-logs'];
const DEFAULT_VIEW: WatchViewMode = 'combined';

/**
 * Checks if a string is a valid view mode.
 */
export function isValidViewMode(view: string | null): view is WatchViewMode {
  return view !== null && VALID_VIEWS.includes(view as WatchViewMode);
}

/**
 * Normalizes a view parameter to a valid view mode.
 * Returns the view if valid, otherwise returns 'combined'.
 */
export function normalizeViewMode(view: string | null): WatchViewMode {
  return isValidViewMode(view) ? view : DEFAULT_VIEW;
}

// Inline styles using CSS token variables
const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 160px)',
    overflow: 'hidden',
  } satisfies CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'var(--space-5) var(--space-6)',
    background: 'var(--color-surface-1)',
    borderBottom: '1px solid var(--color-border)',
    gap: 'var(--space-6)',
    flexWrap: 'wrap',
  } satisfies CSSProperties,
  contextStrip: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-6)',
    flexWrap: 'wrap',
  } satisfies CSSProperties,
  contextItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
  } satisfies CSSProperties,
  contextLabel: {
    fontSize: 'var(--font-size-ui-xs)',
    color: 'var(--color-text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  } satisfies CSSProperties,
  contextValue: {
    fontSize: 'var(--font-size-ui-sm)',
    color: 'var(--color-text)',
  } satisfies CSSProperties,
  contextIterations: {
    padding: 'var(--space-2) var(--space-4)',
    background: 'rgba(88, 166, 255, 0.15)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid rgba(88, 166, 255, 0.4)',
  } satisfies CSSProperties,
  viewToggle: {
    display: 'flex',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
  } satisfies CSSProperties,
  viewBtn: {
    padding: 'var(--space-3) var(--space-5)',
    background: 'transparent',
    border: 'none',
    borderRight: '1px solid var(--color-border)',
    color: 'var(--color-text-muted)',
    fontSize: 'var(--font-size-ui-xs)',
    fontFamily: 'inherit',
    fontWeight: 500,
    cursor: 'pointer',
    textTransform: 'lowercase',
  } satisfies CSSProperties,
  viewBtnLast: {
    borderRight: 'none',
  } satisfies CSSProperties,
  viewBtnActive: {
    background: 'rgba(88, 166, 255, 0.15)',
    color: 'var(--color-accent-blue)',
  } satisfies CSSProperties,
  /**
   * Content grid: 3-column layout for SDK | Logs | ViewerLogs
   * Columns are sized/hidden based on view mode
   */
  content: {
    flex: 1,
    overflow: 'hidden',
    display: 'grid',
    gap: 'var(--space-5)',
    padding: 'var(--space-5)',
  } satisfies CSSProperties,
  /**
   * Panel wrapper - contains each panel instance (only one per panel type)
   */
  panel: {
    overflow: 'hidden',
    minWidth: 0,
    minHeight: 0,
  } satisfies CSSProperties,
  /**
   * Hidden panel - still mounted but not visible
   * Using visibility: hidden preserves scroll position
   * Stays in grid flow so grid-template-columns controls sizing
   */
  panelHidden: {
    visibility: 'hidden',
    overflow: 'hidden',
    pointerEvents: 'none',
    minWidth: 0,
    minHeight: 0,
  } satisfies CSSProperties,
  /**
   * Workers strip container - shown between header and content when workers are active
   */
  workersStrip: {
    display: 'flex',
    alignItems: 'center',
    padding: 'var(--space-3) var(--space-6)',
    background: 'rgba(88, 166, 255, 0.08)',
    borderBottom: '1px solid var(--color-border)',
    gap: 'var(--space-4)',
    flexWrap: 'wrap',
  } satisfies CSSProperties,
  workersLabel: {
    fontSize: 'var(--font-size-ui-xs)',
    color: 'var(--color-accent-blue)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontWeight: 600,
  } satisfies CSSProperties,
  workerCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    padding: 'var(--space-2) var(--space-4)',
    background: 'var(--color-surface-1)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    fontSize: 'var(--font-size-ui-sm)',
  } satisfies CSSProperties,
  workerTaskId: {
    fontWeight: 600,
    color: 'var(--color-text)',
    fontFamily: 'var(--font-mono)',
  } satisfies CSSProperties,
  workerPhase: {
    color: 'var(--color-text-muted)',
    fontSize: 'var(--font-size-ui-xs)',
  } satisfies CSSProperties,
  workerStatus: {
    padding: 'var(--space-1) var(--space-2)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--font-size-ui-xs)',
    fontWeight: 500,
    textTransform: 'uppercase',
  } satisfies CSSProperties,
};

/**
 * Get grid template columns based on view mode.
 * Each panel is rendered once and positioned via grid.
 */
function getGridTemplate(view: WatchViewMode): string {
  switch (view) {
    case 'combined':
      // SDK and Logs visible, ViewerLogs hidden
      return '1fr 1fr 0';
    case 'sdk':
      // Only SDK visible
      return '1fr 0 0';
    case 'logs':
      // Only Logs visible
      return '0 1fr 0';
    case 'viewer-logs':
      // Only ViewerLogs visible
      return '0 0 1fr';
    default:
      return '1fr 1fr 0';
  }
}

/**
 * Returns the color style for a worker status.
 */
export function getWorkerStatusColor(status: WorkerStatusInfo['status']): CSSProperties {
  switch (status) {
    case 'running':
      return { background: 'rgba(88, 166, 255, 0.15)', color: 'var(--color-accent-blue)' };
    case 'passed':
      return { background: 'rgba(63, 185, 80, 0.15)', color: 'var(--color-accent-green)' };
    case 'failed':
      return { background: 'rgba(248, 81, 73, 0.15)', color: 'var(--color-accent-red)' };
    case 'timed_out':
      return { background: 'rgba(255, 166, 87, 0.15)', color: 'var(--color-accent-orange)' };
    default:
      return { background: 'var(--color-surface-2)', color: 'var(--color-text-muted)' };
  }
}

/**
 * Formats a phase name for display.
 */
export function formatWorkerPhase(phase: WorkerStatusInfo['phase']): string {
  return phase === 'implement_task' ? 'implement' : 'spec-check';
}

/**
 * Extracts workflow name from issue_json.
 * Returns the workflow field if it's a string, otherwise null.
 */
export function extractWorkflowName(issueJson: Record<string, unknown> | null | undefined): string | null {
  if (!issueJson) return null;
  return typeof issueJson.workflow === 'string' ? issueJson.workflow : null;
}

/**
 * Extracts current phase from issue_json.
 * Returns the phase field if it's a string, otherwise null.
 */
export function extractCurrentPhase(issueJson: Record<string, unknown> | null | undefined): string | null {
  if (!issueJson) return null;
  return typeof issueJson.phase === 'string' ? issueJson.phase : null;
}

/**
 * Formats a run state as a human-readable string.
 * Returns 'Running' if running is true, 'Idle' otherwise.
 */
export function formatRunState(running: boolean | undefined | null): string {
  return running ? 'Running' : 'Idle';
}

/**
 * Formats a PID as a human-readable string.
 * Returns the PID as a string if present, '–' otherwise.
 */
export function formatPid(pid: number | null | undefined): string {
  return pid != null ? String(pid) : '–';
}

/**
 * Formats an ISO timestamp as a human-readable local time string.
 * Returns a formatted time string if valid, '–' if null/undefined/invalid.
 */
export function formatTimestamp(isoTimestamp: string | null | undefined): string {
  if (!isoTimestamp) return '–';
  try {
    const date = new Date(isoTimestamp);
    if (isNaN(date.getTime())) return '–';
    // Format as HH:MM:SS local time
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '–';
  }
}

/**
 * Formats a completion reason as a human-readable string.
 * Returns the reason if present, null otherwise (to hide the field).
 */
export function formatCompletionReason(reason: string | null | undefined): string | null {
  return reason || null;
}

/**
 * Formats a last error as a human-readable string.
 * Returns the error if present, null otherwise (to hide the field).
 * Truncates long errors to prevent layout breakage.
 */
export function formatLastError(error: string | null | undefined): string | null {
  if (!error) return null;
  // Truncate long errors to prevent layout issues (max 100 chars)
  return error.length > 100 ? `${error.slice(0, 100)}…` : error;
}

/**
 * Represents a field that would be rendered in the Run Context Strip.
 * Used for testing that the correct fields are present in the UI.
 */
export interface RunContextField {
  /** The label displayed for this field (e.g., "State", "PID") */
  label: string;
  /** The value displayed for this field */
  value: string;
  /** Whether this field is visible (some fields are conditionally shown) */
  visible: boolean;
  /** For error field: the full untruncated error (shown in title attribute) */
  fullValue?: string;
}

/**
 * Input state for computing run context fields.
 * This mirrors the relevant parts of ExtendedStreamState for testing.
 */
export interface RunContextInput {
  issue_ref?: string | null;
  issue_json?: Record<string, unknown> | null;
  run?: {
    running?: boolean | null;
    pid?: number | null;
    started_at?: string | null;
    ended_at?: string | null;
    completion_reason?: string | null;
    last_error?: string | null;
    current_iteration?: number;
    max_iterations?: number;
  } | null;
}

/**
 * Computes the fields that would be rendered in the Run Context Strip.
 * This is a pure function that can be tested without rendering React components.
 * The returned array describes which fields are visible and their values.
 *
 * @param input The stream state input
 * @returns Array of RunContextField describing the rendered fields
 */
export function computeRunContextFields(input: RunContextInput): RunContextField[] {
  const issueRef = input.issue_ref ?? null;
  const workflowName = extractWorkflowName(input.issue_json);
  const currentPhase = extractCurrentPhase(input.issue_json);
  const run = input.run ?? null;

  const isRunning = run?.running ?? false;
  const runState = formatRunState(run?.running);
  const pidDisplay = formatPid(run?.pid);
  const startedAt = formatTimestamp(run?.started_at);
  const endedAt = formatTimestamp(run?.ended_at);
  const completionReason = formatCompletionReason(run?.completion_reason);
  const lastError = formatLastError(run?.last_error);

  const currentIteration = run?.current_iteration ?? 0;
  const maxIterations = run?.max_iterations ?? 0;

  const fields: RunContextField[] = [
    // State is always visible
    { label: 'State', value: runState, visible: true },
    // Issue is always visible
    { label: 'Issue', value: issueRef ?? '(none)', visible: true },
    // Workflow is always visible
    { label: 'Workflow', value: workflowName ?? '(none)', visible: true },
    // Phase is always visible
    { label: 'Phase', value: currentPhase ?? '(none)', visible: true },
    // PID is shown when running or when PID is present
    { label: 'PID', value: pidDisplay, visible: isRunning || run?.pid != null },
    // Iteration is shown only when running
    { label: 'Iteration', value: `${currentIteration}/${maxIterations}`, visible: isRunning },
    // Started is shown when started_at is present
    { label: 'Started', value: startedAt, visible: !!run?.started_at },
    // Ended is shown when ended_at is present
    { label: 'Ended', value: endedAt, visible: !!run?.ended_at },
    // Completed is shown when completion_reason is present
    { label: 'Completed', value: completionReason ?? '', visible: !!completionReason },
    // Error is shown when last_error is present
    {
      label: 'Error',
      value: lastError ?? '',
      visible: !!lastError,
      fullValue: run?.last_error ?? undefined,
    },
  ];

  return fields;
}

/**
 * Run context strip showing issue, workflow, phase, iteration status,
 * run state, PID, timestamps, completion reason, and last error.
 * Derives workflow/phase from stream state (issue_json) so updates are reflected
 * immediately when websocket `state` snapshots arrive.
 * Fields update live based on websocket `run` and `state` events via stream state.
 */
function RunContextStrip() {
  const stream = useViewerStream();

  const issueRef = stream.state?.issue_ref ?? null;
  // Derive workflow/phase from stream state for live updates
  const workflowName = extractWorkflowName(stream.state?.issue_json);
  const currentPhase = extractCurrentPhase(stream.state?.issue_json);
  const run = stream.state?.run ?? null;

  // Run status fields
  const isRunning = run?.running ?? false;
  const runState = formatRunState(run?.running);
  const pidDisplay = formatPid(run?.pid);
  const startedAt = formatTimestamp(run?.started_at);
  const endedAt = formatTimestamp(run?.ended_at);
  const completionReason = formatCompletionReason(run?.completion_reason);
  const lastError = formatLastError(run?.last_error);

  // Show iterations only when running
  const currentIteration = run?.current_iteration ?? 0;
  const maxIterations = run?.max_iterations ?? 0;

  return (
    <div style={styles.contextStrip} className="watch-context-strip">
      {/* Run state indicator */}
      <div style={styles.contextItem} className="watch-context-item">
        <span style={styles.contextLabel}>State</span>
        <span
          style={{
            ...styles.contextValue,
            color: isRunning ? 'var(--color-accent-green)' : 'var(--color-text-muted)',
          }}
        >
          {runState}
        </span>
      </div>
      <div style={styles.contextItem} className="watch-context-item">
        <span style={styles.contextLabel}>Issue</span>
        <span style={styles.contextValue} className="mono">{issueRef ?? '(none)'}</span>
      </div>
      <div style={styles.contextItem} className="watch-context-item">
        <span style={styles.contextLabel}>Workflow</span>
        <span style={styles.contextValue} className="mono">{workflowName ?? '(none)'}</span>
      </div>
      <div style={styles.contextItem} className="watch-context-item">
        <span style={styles.contextLabel}>Phase</span>
        <span style={styles.contextValue} className="mono">{currentPhase ?? '(none)'}</span>
      </div>
      {/* Show PID when running or when PID is present */}
      {(isRunning || run?.pid != null) && (
        <div style={styles.contextItem} className="watch-context-item">
          <span style={styles.contextLabel}>PID</span>
          <span style={styles.contextValue} className="mono">{pidDisplay}</span>
        </div>
      )}
      {/* Show iterations only when running */}
      {isRunning && (
        <div style={{ ...styles.contextItem, ...styles.contextIterations }} className="watch-context-item">
          <span style={styles.contextLabel}>Iteration</span>
          <span style={styles.contextValue} className="mono">
            {currentIteration}/{maxIterations}
          </span>
        </div>
      )}
      {/* Show timestamps when present */}
      {run?.started_at && (
        <div style={styles.contextItem} className="watch-context-item">
          <span style={styles.contextLabel}>Started</span>
          <span style={styles.contextValue} className="mono">{startedAt}</span>
        </div>
      )}
      {run?.ended_at && (
        <div style={styles.contextItem} className="watch-context-item">
          <span style={styles.contextLabel}>Ended</span>
          <span style={styles.contextValue} className="mono">{endedAt}</span>
        </div>
      )}
      {/* Show completion reason when present (run ended) */}
      {completionReason && (
        <div style={styles.contextItem} className="watch-context-item">
          <span style={styles.contextLabel}>Completed</span>
          <span style={styles.contextValue}>{completionReason}</span>
        </div>
      )}
      {/* Show last error when present (without breaking layout) */}
      {lastError && (
        <div style={{ ...styles.contextItem, maxWidth: '300px' }} className="watch-context-item">
          <span style={styles.contextLabel}>Error</span>
          <span
            style={{
              ...styles.contextValue,
              color: 'var(--color-accent-red)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={run?.last_error ?? undefined}
          >
            {lastError}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Workers strip component showing active parallel workers.
 * Only renders when workers array is present and non-empty.
 * Updates live based on websocket `run` events.
 */
function WorkersStrip() {
  const stream = useViewerStream();
  const workers = stream.state?.run?.workers;

  // Don't render if no workers
  if (!workers || workers.length === 0) {
    return null;
  }

  return (
    <div style={styles.workersStrip} className="watch-workers-strip" data-testid="workers-strip">
      <span style={styles.workersLabel}>Workers</span>
      {workers.map((worker) => (
        <div
          key={worker.taskId}
          style={styles.workerCard}
          className="watch-worker-card"
          data-testid={`worker-${worker.taskId}`}
        >
          <span style={styles.workerTaskId}>{worker.taskId}</span>
          <span style={styles.workerPhase}>{formatWorkerPhase(worker.phase)}</span>
          <span
            style={{
              ...styles.workerStatus,
              ...getWorkerStatusColor(worker.status),
            }}
          >
            {worker.status}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * View mode segmented toggle.
 */
function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: WatchViewMode;
  onChange: (mode: WatchViewMode) => void;
}) {
  return (
    <div style={styles.viewToggle} className="watch-view-toggle">
      {VALID_VIEWS.map((v, index) => {
        const isLast = index === VALID_VIEWS.length - 1;
        const isActive = mode === v;
        return (
          <button
            key={v}
            type="button"
            className="watch-view-btn"
            style={{
              ...styles.viewBtn,
              ...(isLast ? styles.viewBtnLast : {}),
              ...(isActive ? styles.viewBtnActive : {}),
            }}
            onClick={() => onChange(v)}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Watch page with combined layout.
 * Uses URL-driven view mode via ?view= query parameter.
 * Preserves pane state by keeping all panels mounted and using CSS grid sizing.
 *
 * State preservation strategy:
 * - Each panel (SDK, Logs, ViewerLogs) is rendered exactly ONCE
 * - View switching is done via CSS grid column sizing (0 hides, 1fr shows)
 * - Hidden panels keep their scroll position and internal state
 * - No unmount/remount occurs when switching views
 */
export function WatchPage() {
  const stream = useViewerStream();
  const [searchParams, setSearchParams] = useSearchParams();

  // Get current view from URL, normalize invalid values
  const rawView = searchParams.get('view');
  const currentView = normalizeViewMode(rawView);

  // If URL has invalid view, replace with normalized value (preserving other params)
  useEffect(() => {
    if (rawView !== null && !isValidViewMode(rawView)) {
      const newParams = new URLSearchParams(searchParams);
      newParams.set('view', DEFAULT_VIEW);
      setSearchParams(newParams, { replace: true });
    }
  }, [rawView, searchParams, setSearchParams]);

  // Handle view change - update URL
  const handleViewChange = useCallback(
    (newView: WatchViewMode) => {
      const newParams = new URLSearchParams(searchParams);
      if (newView === DEFAULT_VIEW) {
        // Remove view param for default value (cleaner URLs)
        newParams.delete('view');
      } else {
        newParams.set('view', newView);
      }
      setSearchParams(newParams);
    },
    [searchParams, setSearchParams]
  );

  // Determine panel visibility for accessibility
  const sdkVisible = currentView === 'combined' || currentView === 'sdk';
  const logsVisible = currentView === 'combined' || currentView === 'logs';
  const viewerLogsVisible = currentView === 'viewer-logs';

  return (
    <div style={styles.container}>
      {/* Header with context strip and view toggle */}
      <div style={styles.header} className="watch-header">
        <RunContextStrip />
        <ViewModeToggle mode={currentView} onChange={handleViewChange} />
      </div>

      {/* Workers strip - shown only when parallel workers are active */}
      <WorkersStrip />

      {/*
        Content grid: SDK | Logs | ViewerLogs
        Each panel is rendered once and sized via grid-template-columns.
        Hidden panels have 0 width but remain mounted to preserve state.
      */}
      <div
        className="watch-content"
        data-view={currentView}
        style={{
          ...styles.content,
          gridTemplateColumns: getGridTemplate(currentView),
        }}
      >
        {/* SDK Panel - single instance */}
        <div
          style={sdkVisible ? styles.panel : styles.panelHidden}
          aria-hidden={!sdkVisible}
        >
          <SdkPage />
        </div>

        {/* Logs Panel - single instance */}
        <div
          style={logsVisible ? styles.panel : styles.panelHidden}
          aria-hidden={!logsVisible}
        >
          <LogPanel title="Live logs" lines={stream.logs} />
        </div>

        {/* Viewer Logs Panel - single instance */}
        <div
          style={viewerLogsVisible ? styles.panel : styles.panelHidden}
          aria-hidden={!viewerLogsVisible}
        >
          <LogPanel title="Viewer logs" lines={stream.viewerLogs} />
        </div>
      </div>
    </div>
  );
}
