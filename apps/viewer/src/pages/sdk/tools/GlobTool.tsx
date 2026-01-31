import type { GlobToolInput } from '../../../api/types.js';

type Props = {
  input: Record<string, unknown>;
};

export function GlobTool({ input }: Props) {
  const data = input as GlobToolInput;

  return (
    <div className="sdk-tool-glob">
      <div className="sdk-glob-pattern">
        <svg className="sdk-glob-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        </svg>
        <code className="sdk-pattern">{data.pattern}</code>
      </div>
      {data.path && (
        <span className="sdk-glob-path">in <code>{data.path}</code></span>
      )}
    </div>
  );
}
