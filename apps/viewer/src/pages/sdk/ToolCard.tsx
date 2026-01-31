import { useState, useCallback } from 'react';
import type { ToolState, ToolStatus } from './useToolState.js';
import { JsonSyntax } from './JsonSyntax.js';
import { getToolRenderer, GenericTool } from './tools/index.js';

type Props = {
  tool: ToolState;
  onCopy: () => void;
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function StatusIndicator({ status }: { status: ToolStatus }) {
  return (
    <span className="sdk-tool-status" data-status={status}>
      {status === 'running' && (
        <svg className="sdk-status-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/>
        </svg>
      )}
      {status === 'completed' && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      )}
      {status === 'error' && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
      )}
    </span>
  );
}

export function ToolCard({ tool, onCopy }: Props) {
  const [showJson, setShowJson] = useState(false);
  const SpecificRenderer = getToolRenderer(tool.name);

  const toggleJson = useCallback(() => {
    setShowJson(prev => !prev);
  }, []);

  return (
    <div className="sdk-tool-card" data-status={tool.status}>
      <div className="sdk-tool-card-header">
        <div className="sdk-tool-card-left">
          <StatusIndicator status={tool.status} />
          <span className="sdk-tool-name">{tool.name}</span>
          {tool.duration_ms !== undefined && (
            <span className="sdk-tool-duration">{formatDuration(tool.duration_ms)}</span>
          )}
        </div>
        <div className="sdk-tool-card-actions">
          <button
            className="sdk-tool-json-toggle"
            onClick={toggleJson}
            data-active={showJson}
            type="button"
          >
            {showJson ? 'Hide JSON' : 'Show JSON'}
          </button>
          <button
            className="sdk-tool-copy-btn"
            onClick={onCopy}
            title="Copy tool input"
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>
      </div>
      <div className="sdk-tool-card-body">
        {showJson ? (
          <JsonSyntax data={tool.input} className="sdk-tool-json" />
        ) : SpecificRenderer ? (
          <SpecificRenderer input={tool.input} />
        ) : (
          <GenericTool name={tool.name} input={tool.input} />
        )}
      </div>
    </div>
  );
}
