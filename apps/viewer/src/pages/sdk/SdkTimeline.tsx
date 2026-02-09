import { useCallback, useEffect, useRef, useState } from 'react';
import type { SdkEvent, SdkInitData, SdkCompleteData } from '../../api/types.js';
import { useToolState } from './useToolState.js';
import { ToolCard } from './ToolCard.js';
import { buildTimelineEntries, entryMatchesFilter, type TimelineMessage } from './timelineEntries.js';

type Props = {
  sdkEvents: readonly SdkEvent[];
  filter: string;
  onCopy: (data: Record<string, unknown>) => void;
};

function MessageCard({ message }: { message: TimelineMessage }) {
  return (
    <div className="sdk-message-card" data-role={message.type}>
      <div className="sdk-message-card-header">
        <span className="sdk-message-role">{message.type}</span>
      </div>
      <pre className="sdk-message-content">{message.content}</pre>
    </div>
  );
}

function SessionHeader({ data }: { data: SdkInitData }) {
  return (
    <div className="sdk-timeline-session sdk-timeline-session-start">
      <div className="sdk-timeline-dot sdk-timeline-dot-session" />
      <div className="sdk-timeline-session-content">
        <span className="sdk-timeline-session-label">Session Started</span>
        <span className="sdk-timeline-session-id">{data.session_id}</span>
        {data.started_at && (
          <span className="sdk-timeline-session-time">{new Date(data.started_at).toLocaleTimeString()}</span>
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function SessionFooter({ data }: { data: SdkCompleteData }) {
  const summary = data.summary;
  return (
    <div className="sdk-timeline-session sdk-timeline-session-end">
      <div className="sdk-timeline-dot sdk-timeline-dot-session" data-status={data.status} />
      <div className="sdk-timeline-session-content">
        <span className="sdk-timeline-session-label">Session {data.status}</span>
        {summary && (
          <span className="sdk-timeline-session-summary">
            {summary.tool_call_count !== undefined && `${summary.tool_call_count} tools`}
            {summary.message_count !== undefined && ` · ${summary.message_count} messages`}
            {summary.duration_seconds !== undefined && ` · ${formatDuration(summary.duration_seconds)}`}
            {summary.input_tokens !== undefined && ` · ${formatTokens(summary.input_tokens)} in`}
            {summary.output_tokens !== undefined && ` · ${formatTokens(summary.output_tokens)} out`}
            {summary.total_cost_usd != null && ` · ${formatCost(summary.total_cost_usd)}`}
          </span>
        )}
      </div>
    </div>
  );
}

export function SdkTimeline({ sdkEvents, filter, onCopy }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevEntryLength = useRef(0);

  const tools = useToolState(sdkEvents);
  const entries = buildTimelineEntries(sdkEvents, tools);

  // Find init and complete events
  const initEvent = sdkEvents.find(e => e.event === 'sdk-init');
  const completeEvent = sdkEvents.find(e => e.event === 'sdk-complete');

  const filteredEntries = entries.filter(entry => entryMatchesFilter(entry, filter));

  // Auto-scroll when new timeline entries arrive
  useEffect(() => {
    if (autoScroll && containerRef.current && entries.length > prevEntryLength.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    prevEntryLength.current = entries.length;
  }, [entries.length, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(isAtBottom);
  }, []);

  const handleCopy = useCallback((input: Record<string, unknown>) => {
    onCopy(input);
  }, [onCopy]);

  if (entries.length === 0 && !initEvent) {
    return (
      <div className="sdk-timeline-empty">
        <div className="sdk-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
        </div>
        <p className="sdk-empty-title">Waiting for timeline events</p>
        <p className="sdk-empty-subtitle">Messages and tools will appear here as they run</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="sdk-timeline"
      onScroll={handleScroll}
    >
      <div className="sdk-timeline-track">
        {initEvent && <SessionHeader data={initEvent.data as SdkInitData} />}

        {filteredEntries.map(entry => {
          if (entry.kind === 'tool') {
            const tool = entry.tool;
            return (
              <div key={entry.key} className="sdk-timeline-item">
                <div className="sdk-timeline-connector" />
                <div className="sdk-timeline-dot" data-status={tool.status} />
                <div className="sdk-timeline-content">
                  <ToolCard
                    tool={tool}
                    onCopy={() => handleCopy(tool.input)}
                  />
                </div>
              </div>
            );
          }

          return (
            <div key={entry.key} className="sdk-timeline-item">
              <div className="sdk-timeline-connector" />
              <div className="sdk-timeline-dot" data-status={entry.message.type} />
              <div className="sdk-timeline-content">
                <MessageCard message={entry.message} />
              </div>
            </div>
          );
        })}

        {completeEvent && <SessionFooter data={completeEvent.data as SdkCompleteData} />}
      </div>

      {filter && filteredEntries.length === 0 && (
        <div className="sdk-timeline-no-results">
          <p>No timeline events match "{filter}"</p>
        </div>
      )}
    </div>
  );
}
