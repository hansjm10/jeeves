export type ProviderRunOptions = Readonly<{
  cwd: string;
}>;

export type ProviderEvent =
  | Readonly<{
      type: 'system';
      subtype?: 'init' | 'error';
      content: string;
      timestamp?: string;
      sessionId?: string | null;
    }>
  | Readonly<{
      type: 'user' | 'assistant' | 'result';
      content: string;
      timestamp?: string;
    }>
  | Readonly<{
      type: 'tool_use';
      name: string;
      input: Record<string, unknown>;
      id: string;
      timestamp?: string;
    }>
  | Readonly<{
      type: 'tool_result';
      toolUseId: string;
      content: string;
      isError?: boolean;
      durationMs?: number | null;
      timestamp?: string;
    }>;

export interface AgentProvider {
  readonly name: string;
  run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent>;
}
