import { useCallback, useEffect, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { LogPanel } from '../ui/LogPanel.js';
import { SdkPage } from './SdkPage.js';

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
   */
  panelHidden: {
    visibility: 'hidden',
    position: 'absolute',
    width: 0,
    height: 0,
    overflow: 'hidden',
    pointerEvents: 'none',
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
 * Run context strip showing issue, workflow, phase, and iteration status.
 * Derives workflow/phase from stream state (issue_json) so updates are reflected
 * immediately when websocket `state` snapshots arrive.
 */
function RunContextStrip() {
  const stream = useViewerStream();

  const issueRef = stream.state?.issue_ref ?? null;
  // Derive workflow/phase from stream state for live updates
  const workflowName = extractWorkflowName(stream.state?.issue_json);
  const currentPhase = extractCurrentPhase(stream.state?.issue_json);
  const run = stream.state?.run ?? null;

  // Show iterations only when running
  const showIterations = run?.running ?? false;
  const currentIteration = run?.current_iteration ?? 0;
  const maxIterations = run?.max_iterations ?? 0;

  return (
    <div style={styles.contextStrip}>
      <div style={styles.contextItem}>
        <span style={styles.contextLabel}>Issue</span>
        <span style={styles.contextValue} className="mono">{issueRef ?? '(none)'}</span>
      </div>
      <div style={styles.contextItem}>
        <span style={styles.contextLabel}>Workflow</span>
        <span style={styles.contextValue} className="mono">{workflowName ?? '(none)'}</span>
      </div>
      <div style={styles.contextItem}>
        <span style={styles.contextLabel}>Phase</span>
        <span style={styles.contextValue} className="mono">{currentPhase ?? '(none)'}</span>
      </div>
      {showIterations && (
        <div style={{ ...styles.contextItem, ...styles.contextIterations }}>
          <span style={styles.contextLabel}>Iteration</span>
          <span style={styles.contextValue} className="mono">
            {currentIteration}/{maxIterations}
          </span>
        </div>
      )}
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
    <div style={styles.viewToggle}>
      {VALID_VIEWS.map((v, index) => {
        const isLast = index === VALID_VIEWS.length - 1;
        const isActive = mode === v;
        return (
          <button
            key={v}
            type="button"
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
      <div style={styles.header}>
        <RunContextStrip />
        <ViewModeToggle mode={currentView} onChange={handleViewChange} />
      </div>

      {/*
        Content grid: SDK | Logs | ViewerLogs
        Each panel is rendered once and sized via grid-template-columns.
        Hidden panels have 0 width but remain mounted to preserve state.
      */}
      <div
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
