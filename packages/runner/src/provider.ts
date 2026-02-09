export type McpServerConfig = Readonly<{
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}>;

export type ProviderRunOptions = Readonly<{
  cwd: string;
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
  permissionMode?: string;
}>;

export type UsageData = Readonly<{
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_cost_usd?: number | null;
  num_turns?: number;
}>;

export type ProviderEvent =
  | Readonly<{
      type: 'system';
      subtype?: 'init' | 'error' | 'compaction';
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
      response_text?: string;
      response_truncated?: boolean;
      timestamp?: string;
    }>
  | Readonly<{
      type: 'usage';
      usage: UsageData;
      timestamp?: string;
    }>;

export interface AgentProvider {
  readonly name: string;
  run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent>;
}
