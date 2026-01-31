import type { WriteToolInput } from '../../../api/types.js';

type Props = {
  input: Record<string, unknown>;
};

export function WriteTool({ input }: Props) {
  const data = input as WriteToolInput;
  const contentPreview = data.content?.slice(0, 200) || '';
  const isTruncated = (data.content?.length || 0) > 200;

  return (
    <div className="sdk-tool-write">
      <div className="sdk-file-path">
        <svg className="sdk-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        <code>{data.file_path}</code>
      </div>
      {contentPreview && (
        <div className="sdk-content-preview">
          <pre>{contentPreview}{isTruncated && '...'}</pre>
        </div>
      )}
    </div>
  );
}
