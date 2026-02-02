import { useCallback, useEffect, useRef, useState } from 'react';

export interface LogPanelProps {
  title: string;
  lines: string[];
}

/**
 * State returned by useLogPanel hook for testing
 */
export interface LogPanelState {
  followTail: boolean;
  searchQuery: string;
  filteredLines: string[];
  clipboardError: boolean;
  setFollowTail: (value: boolean) => void;
  setSearchQuery: (value: string) => void;
  setClipboardError: (value: boolean) => void;
  handleResume: () => void;
  handleCopyVisible: () => Promise<void>;
  clearClipboardError: () => void;
}

/**
 * Filters log lines based on search query.
 * - Whitespace-only or empty query returns all lines
 * - Otherwise returns lines that contain the query (case-insensitive substring match)
 */
export function filterLines(lines: string[], query: string): string[] {
  const trimmed = query.trim();
  if (trimmed === '') {
    return lines;
  }
  const lowerQuery = trimmed.toLowerCase();
  return lines.filter(line => line.toLowerCase().includes(lowerQuery));
}

/**
 * Formats "copy visible" content.
 * All filtered lines joined by \n with trailing \n when non-empty.
 */
export function formatCopyContent(lines: string[]): string {
  if (lines.length === 0) {
    return '';
  }
  return lines.join('\n') + '\n';
}

/**
 * Copies text to clipboard with error handling.
 * Returns true on success, false on failure.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Custom hook encapsulating LogPanel state and behavior.
 * Exported for testability.
 */
export function useLogPanel(lines: string[]) {
  const [followTail, setFollowTail] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [clipboardError, setClipboardError] = useState(false);

  const filteredLines = filterLines(lines, searchQuery);

  const handleResume = useCallback(() => {
    setFollowTail(true);
  }, []);

  const handleCopyVisible = useCallback(async () => {
    const content = formatCopyContent(filteredLines);
    const success = await copyToClipboard(content);
    if (!success) {
      setClipboardError(true);
    }
  }, [filteredLines]);

  const clearClipboardError = useCallback(() => {
    setClipboardError(false);
  }, []);

  return {
    followTail,
    searchQuery,
    filteredLines,
    clipboardError,
    setFollowTail,
    setSearchQuery,
    setClipboardError,
    handleResume,
    handleCopyVisible,
    clearClipboardError,
  };
}

/**
 * Scroll detection threshold: if user scrolls more than this many pixels
 * from the bottom, we consider them as "scrolled up" and pause follow-tail.
 */
const SCROLL_THRESHOLD = 50;

export function LogPanel(props: LogPanelProps) {
  const { title, lines } = props;
  const logRef = useRef<HTMLPreElement>(null);
  const {
    followTail,
    searchQuery,
    filteredLines,
    clipboardError,
    setFollowTail,
    setSearchQuery,
    setClipboardError,
    handleResume,
    handleCopyVisible,
    clearClipboardError,
  } = useLogPanel(lines);

  // Handle scroll to detect if user scrolled up
  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > SCROLL_THRESHOLD) {
      setFollowTail(false);
    }
  }, [setFollowTail]);

  // Auto-scroll to bottom when following tail and lines change
  useEffect(() => {
    if (followTail && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [followTail, filteredLines]);

  // Copy selection handler - also surfaces clipboard error on failure
  const handleCopySelection = useCallback(async () => {
    const selection = window.getSelection()?.toString() ?? '';
    if (selection) {
      const success = await copyToClipboard(selection);
      if (!success) {
        setClipboardError(true);
      }
    }
  }, [setClipboardError]);

  // Clear clipboard error after a delay
  useEffect(() => {
    if (clipboardError) {
      const timer = setTimeout(clearClipboardError, 3000);
      return () => clearTimeout(timer);
    }
  }, [clipboardError, clearClipboardError]);

  const isFiltering = searchQuery.trim() !== '';
  const showEmptyState = isFiltering && filteredLines.length === 0;
  const copyDisabled = filteredLines.length === 0;

  return (
    <div className="panel">
      <div className="panelTitle">{title}</div>
      <div className="panelBody">
        {/* Toolbar: search, count, actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
          <input
            type="text"
            className="input"
            style={{ flex: '1', minWidth: '120px' }}
            placeholder="Search logs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search logs"
          />
          <span className="muted">
            {isFiltering
              ? `${filteredLines.length} of ${lines.length} shown`
              : `${lines.length} lines`}
          </span>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              type="button"
              className="btn"
              onClick={handleCopyVisible}
              disabled={copyDisabled}
              title={copyDisabled ? 'No lines to copy' : 'Copy visible lines'}
            >
              Copy
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleCopySelection}
              title="Copy selection"
            >
              Copy Selection
            </button>
          </div>
        </div>

        {/* Resume control when follow-tail is paused */}
        {!followTail && (
          <button
            type="button"
            className="btn primary"
            style={{ marginBottom: '8px' }}
            onClick={handleResume}
          >
            Resume
          </button>
        )}

        {/* Clipboard error state */}
        {clipboardError && (
          <div className="errorBox" style={{ marginBottom: '8px' }}>
            Failed to copy to clipboard
          </div>
        )}

        {/* Log content */}
        {showEmptyState ? (
          <div className="muted" style={{ padding: '20px', textAlign: 'center' }}>
            No matches found
          </div>
        ) : (
          <pre
            ref={logRef}
            className="log"
            onScroll={handleScroll}
          >
            {filteredLines.join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
}
