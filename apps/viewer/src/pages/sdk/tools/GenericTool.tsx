import { JsonSyntax } from '../JsonSyntax.js';

type Props = {
  name: string;
  input: Record<string, unknown>;
};

export function GenericTool({ name, input }: Props) {
  return (
    <div className="sdk-tool-generic">
      <p className="sdk-tool-generic-name">Tool: {name}</p>
      <JsonSyntax data={input} className="sdk-tool-generic-json" />
    </div>
  );
}
