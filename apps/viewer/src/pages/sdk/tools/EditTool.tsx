import type { EditToolInput } from '../../../api/types.js';

type Props = {
  input: Record<string, unknown>;
};

export function EditTool({ input }: Props) {
  const data = input as EditToolInput;
  const oldPreview = data.old_string?.slice(0, 100) || '';
  const newPreview = data.new_string?.slice(0, 100) || '';
  const oldTruncated = (data.old_string?.length || 0) > 100;
  const newTruncated = (data.new_string?.length || 0) > 100;

  return (
    <div className="sdk-tool-edit">
      <div className="sdk-file-path">
        <svg className="sdk-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
        </svg>
        <code>{data.file_path}</code>
        {data.replace_all && <span className="sdk-edit-flag">replace all</span>}
      </div>
      <div className="sdk-diff-preview">
        <div className="sdk-diff-old">
          <span className="sdk-diff-marker">-</span>
          <pre>{oldPreview}{oldTruncated && '...'}</pre>
        </div>
        <div className="sdk-diff-new">
          <span className="sdk-diff-marker">+</span>
          <pre>{newPreview}{newTruncated && '...'}</pre>
        </div>
      </div>
    </div>
  );
}
