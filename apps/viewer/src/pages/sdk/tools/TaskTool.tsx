import type { TaskToolInput } from '../../../api/types.js';

type Props = {
  input: Record<string, unknown>;
};

export function TaskTool({ input }: Props) {
  const data = input as TaskToolInput;
  const promptPreview = data.prompt?.slice(0, 150) || '';
  const isTruncated = (data.prompt?.length || 0) > 150;

  return (
    <div className="sdk-tool-task">
      <div className="sdk-task-header">
        <span className="sdk-task-agent">
          <svg className="sdk-agent-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 1v6m0 6v10M1 12h6m6 0h10"/>
          </svg>
          {data.subagent_type}
        </span>
        {data.model && <span className="sdk-task-model">{data.model}</span>}
      </div>
      {data.description && (
        <p className="sdk-task-description">{data.description}</p>
      )}
      {promptPreview && (
        <div className="sdk-task-prompt">
          <pre>{promptPreview}{isTruncated && '...'}</pre>
        </div>
      )}
    </div>
  );
}
