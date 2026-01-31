import type { BashToolInput } from '../../../api/types.js';

type Props = {
  input: Record<string, unknown>;
};

export function BashTool({ input }: Props) {
  const data = input as BashToolInput;

  return (
    <div className="sdk-tool-bash">
      <div className="sdk-bash-command">
        <span className="sdk-bash-prompt">$</span>
        <code>{data.command}</code>
      </div>
      {data.description && (
        <p className="sdk-tool-description">{data.description}</p>
      )}
    </div>
  );
}
