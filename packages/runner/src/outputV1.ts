export type SdkOutputV1Message = Readonly<{
  type: 'system' | 'user' | 'assistant' | 'tool_result' | 'result';
  timestamp: string;
  subtype?: 'init' | 'error' | null;
  content?: string | null;
  tool_use?: Readonly<{ name: string; input: Record<string, unknown>; id: string }> | null;
  tool_use_id?: string | null;
  session_id?: string | null;
  [key: string]: unknown;
}>;

export type SdkOutputV1ToolCall = Readonly<{
  name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
  duration_ms?: number | null;
  timestamp?: string;
  is_error?: boolean;
  [key: string]: unknown;
}>;

export type SdkOutputV1 = Readonly<{
  schema: 'jeeves.sdk.v1';
  session_id: string | null;
  started_at: string;
  ended_at: string;
  success: boolean;
  messages: SdkOutputV1Message[];
  tool_calls: SdkOutputV1ToolCall[];
  stats: Readonly<{
    message_count: number;
    tool_call_count: number;
    duration_seconds: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    total_cost_usd?: number | null;
    num_turns?: number;
  }>;
  error?: string | null;
  error_type?: string | null;
}>;

