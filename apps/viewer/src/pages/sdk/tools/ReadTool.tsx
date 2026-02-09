import type { ReadToolInput } from '../../../api/types.js';

type Props = {
  input: Record<string, unknown>;
};

export function ReadTool({ input }: Props) {
  const data = input as ReadToolInput & {
    start_line?: number;
    end_line?: number;
  };
  const hasRange =
    data.offset !== undefined ||
    data.limit !== undefined ||
    data.start_line !== undefined ||
    data.end_line !== undefined;

  const rangeText = data.start_line !== undefined || data.end_line !== undefined
    ? [
        data.start_line !== undefined ? `line ${data.start_line}` : '',
        data.end_line !== undefined ? `line ${data.end_line}` : '',
      ].filter(Boolean).join(' to ')
    : [
        data.offset !== undefined ? `from line ${data.offset}` : '',
        data.limit !== undefined ? `${data.limit} lines` : '',
      ].filter(Boolean).join(', ');

  return (
    <div className="sdk-tool-read">
      <div className="sdk-file-path">
        <svg className="sdk-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <code>{data.file_path}</code>
      </div>
      {hasRange && (
        <span className="sdk-file-range">
          {rangeText}
        </span>
      )}
    </div>
  );
}
