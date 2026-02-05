import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SdkEvent } from '../api/types.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { JsonSyntax, SdkTimeline } from './sdk/index.js';
import './SdkPage.css';

type ViewMode = 'timeline' | 'events';
type EventWithMeta = SdkEvent & { id: number; timestamp: number };

const EVENT_COLORS: Record<string, string> = {
  message: 'var(--color-accent-cyan)',
  error: 'var(--color-accent-red)',
  warning: 'var(--color-accent-amber)',
  complete: 'var(--color-accent-green)',
  start: 'var(--color-accent-purple)',
  tool: 'var(--color-accent-blue)',
  response: 'var(--color-accent-cyan)',
};

function getEventColor(eventName: string): string {
  const lower = eventName.toLowerCase();
  for (const [key, color] of Object.entries(EVENT_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return 'var(--color-text-muted)';
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function EventCard({
  event,
  isExpanded,
  onToggle,
  onCopy
}: {
  event: EventWithMeta;
  isExpanded: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  const color = getEventColor(event.event);
  const bodyId = `sdk-event-body-${event.id}`;

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  }, [onToggle]);

  return (
    <div className="sdk-event" style={{ '--event-color': color } as React.CSSProperties}>
      <div
        className="sdk-event-header"
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        onClick={onToggle}
        onKeyDown={handleKeyDown}
      >
        <div className="sdk-event-left">
          <span className="sdk-event-chevron" data-expanded={isExpanded}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <span className="sdk-event-badge">{event.event}</span>
          <span className="sdk-event-time">{formatTimestamp(event.timestamp)}</span>
        </div>
        <div className="sdk-event-right">
          <button
            className="sdk-copy-btn"
            onClick={(e) => { e.stopPropagation(); onCopy(); }}
            title="Copy event"
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>
      </div>
      {isExpanded && (
        <div className="sdk-event-body" id={bodyId}>
          <JsonSyntax data={event.data} />
        </div>
      )}
    </div>
  );
}

function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div className="sdk-view-toggle">
      <button
        className={`sdk-view-toggle-btn ${mode === 'timeline' ? 'active' : ''}`}
        onClick={() => onChange('timeline')}
        type="button"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="2" x2="12" y2="22"/>
          <circle cx="12" cy="6" r="3"/>
          <circle cx="12" cy="18" r="3"/>
        </svg>
        Timeline
      </button>
      <button
        className={`sdk-view-toggle-btn ${mode === 'events' ? 'active' : ''}`}
        onClick={() => onChange('events')}
        type="button"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7"/>
          <rect x="14" y="3" width="7" height="7"/>
          <rect x="3" y="14" width="7" height="7"/>
          <rect x="14" y="14" width="7" height="7"/>
        </svg>
        Events
      </button>
    </div>
  );
}

export function SdkPage({ sdkEvents: sdkEventsProp }: { sdkEvents?: SdkEvent[] } = {}) {
  const stream = useViewerStream();
  const sdkEvents = sdkEventsProp ?? stream.sdkEvents;
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const prevEventsLength = useRef(0);

  // Assign IDs and timestamps to events
  const eventsWithMeta = useMemo<EventWithMeta[]>(() => {
    return sdkEvents.map((e, i) => ({
      ...e,
      id: i,
      timestamp: Date.now() - (sdkEvents.length - i) * 100, // Approximate timestamps
    }));
  }, [sdkEvents]);

  // Filter events
  const filteredEvents = useMemo(() => {
    if (!filter.trim()) return eventsWithMeta;
    const q = filter.toLowerCase();
    return eventsWithMeta.filter(e =>
      e.event.toLowerCase().includes(q) ||
      JSON.stringify(e.data).toLowerCase().includes(q)
    );
  }, [eventsWithMeta, filter]);

  // Auto-expand new events
  useEffect(() => {
    if (sdkEvents.length > prevEventsLength.current) {
      const newIds = Array.from(
        { length: sdkEvents.length - prevEventsLength.current },
        (_, i) => prevEventsLength.current + i
      );
      setExpandedIds(prev => {
        const next = new Set(prev);
        newIds.forEach(id => next.add(id));
        return next;
      });
    }
    prevEventsLength.current = sdkEvents.length;
  }, [sdkEvents.length]);

  // Auto-scroll behavior (for events view)
  useEffect(() => {
    if (viewMode === 'events' && autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filteredEvents, autoScroll, viewMode]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(isAtBottom);
  }, []);

  const toggleExpanded = useCallback((id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const showToast = useCallback((kind: 'success' | 'error', message: string) => {
    setToast({ kind, message });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  const copyEvent = useCallback(async (event: EventWithMeta) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ event: event.event, data: event.data }, null, 2));
      showToast('success', 'Copied to clipboard');
    } catch {
      showToast('error', 'Copy failed');
    }
  }, [showToast]);

  const copyData = useCallback(async (data: Record<string, unknown>) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      showToast('success', 'Copied to clipboard');
    } catch {
      showToast('error', 'Copy failed');
    }
  }, [showToast]);

  const expandAll = useCallback(() => {
    setExpandedIds(new Set(filteredEvents.map(e => e.id)));
  }, [filteredEvents]);

  const collapseAll = useCallback(() => {
    setExpandedIds(new Set());
  }, []);

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setAutoScroll(true);
    }
  }, []);

  const clearFilter = useCallback(() => {
    setFilter('');
  }, []);

  const uniqueEventTypes = useMemo(() => {
    const types = new Set(sdkEvents.map(e => e.event));
    return Array.from(types);
  }, [sdkEvents]);

  return (
    <div className="sdk-container">
      {/* Header */}
      <div className="sdk-header">
        <div className="sdk-header-left">
          <h2 className="sdk-title">
            SDK Events
            <span className="sdk-count">{sdkEvents.length}</span>
          </h2>
          {filter && (
            <span className="sdk-filter-indicator">
              {filteredEvents.length} of {sdkEvents.length} shown
            </span>
          )}
        </div>
        <div className="sdk-header-right">
          <ViewToggle mode={viewMode} onChange={setViewMode} />
          {!autoScroll && viewMode === 'events' && (
            <button className="sdk-action-btn sdk-scroll-btn" onClick={scrollToBottom} type="button">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M19 12l-7 7-7-7"/>
              </svg>
              Resume auto-scroll
            </button>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="sdk-toolbar">
        <div className="sdk-search-container">
          <svg className="sdk-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            type="text"
            className="sdk-search"
            placeholder={viewMode === 'timeline' ? 'Filter tools...' : 'Filter events...'}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button className="sdk-search-clear" onClick={clearFilter} type="button">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          )}
        </div>
        <div className="sdk-toolbar-actions">
          {viewMode === 'events' && (
            <>
              <button className="sdk-action-btn" onClick={expandAll} type="button">Expand all</button>
              <button className="sdk-action-btn" onClick={collapseAll} type="button">Collapse all</button>
            </>
          )}
        </div>
      </div>

      {/* Event type chips (only in events view) */}
      {viewMode === 'events' && uniqueEventTypes.length > 0 && (
        <div className="sdk-type-chips">
          {uniqueEventTypes.map(type => (
            <button
              key={type}
              className={`sdk-type-chip ${filter === type ? 'active' : ''}`}
              style={{ '--chip-color': getEventColor(type) } as React.CSSProperties}
              onClick={() => setFilter(filter === type ? '' : type)}
              type="button"
            >
              {type}
              <span className="sdk-type-chip-count">
                {sdkEvents.filter(e => e.event === type).length}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Main content area */}
      {viewMode === 'timeline' ? (
        <SdkTimeline
          sdkEvents={sdkEvents}
          filter={filter}
          onCopy={copyData}
        />
      ) : (
        <div
          ref={containerRef}
          className="sdk-events-container"
          onScroll={handleScroll}
        >
          {filteredEvents.length === 0 ? (
            <div className="sdk-empty">
              {sdkEvents.length === 0 ? (
                <>
                  <div className="sdk-empty-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                      <path d="M2 17l10 5 10-5"/>
                      <path d="M2 12l10 5 10-5"/>
                    </svg>
                  </div>
                  <p className="sdk-empty-title">Waiting for SDK events</p>
                  <p className="sdk-empty-subtitle">Events will appear here as they stream in</p>
                </>
              ) : (
                <>
                  <p className="sdk-empty-title">No matching events</p>
                  <p className="sdk-empty-subtitle">Try adjusting your filter</p>
                </>
              )}
            </div>
          ) : (
            <div className="sdk-events-list">
              {filteredEvents.map(event => (
                <EventCard
                  key={event.id}
                  event={event}
                  isExpanded={expandedIds.has(event.id)}
                  onToggle={() => toggleExpanded(event.id)}
                  onCopy={() => copyEvent(event)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Status bar */}
      <div className="sdk-status-bar">
        <span className={`sdk-connection-dot ${stream.connected ? 'connected' : 'disconnected'}`} />
        <span className="sdk-status-text">
          {stream.connected ? 'Connected' : 'Disconnected'}
        </span>
        {autoScroll && (
          <span className="sdk-autoscroll-indicator">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M19 12l-7 7-7-7"/>
            </svg>
            Auto-scroll
          </span>
        )}
      </div>

      {/* Copy toast */}
      {toast && (
        <div className="sdk-copy-toast" data-kind={toast.kind}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          {toast.message}
        </div>
      )}
    </div>
  );
}
