import type { GrepToolInput } from '../../../api/types.js';

type Props = {
  input: Record<string, unknown>;
};

export function GrepTool({ input }: Props) {
  const data = input as GrepToolInput;

  return (
    <div className="sdk-tool-grep">
      <div className="sdk-grep-pattern">
        <svg className="sdk-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.35-4.35"/>
        </svg>
        <code className="sdk-pattern">{data.pattern}</code>
      </div>
      <div className="sdk-grep-options">
        {data.path && (
          <span className="sdk-grep-option">
            <span className="sdk-option-label">path:</span> <code>{data.path}</code>
          </span>
        )}
        {data.glob && (
          <span className="sdk-grep-option">
            <span className="sdk-option-label">glob:</span> <code>{data.glob}</code>
          </span>
        )}
        {data.type && (
          <span className="sdk-grep-option">
            <span className="sdk-option-label">type:</span> <code>{data.type}</code>
          </span>
        )}
      </div>
    </div>
  );
}
