import type { AgentProvider, ProviderEvent, ProviderRunOptions } from '../provider.js';

// NOTE: Keep all SDK imports in this file so the rest of the runner is provider-agnostic.
import {
  query,
  type HookCallbackMatcher,
  type HookInput,
  type Options,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

function nowIso(): string {
  return new Date().toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  return { value };
}

function safeCompactString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(input: string, max = 2000): string {
  if (input.length <= max) return input;
  return input.slice(0, max);
}

function extractTextFromMessageParam(message: SDKUserMessage['message']): string {
  if (typeof message === 'string') return message;

  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const text = (block as { type?: unknown; text?: unknown }).type === 'text'
        ? (block as { text?: unknown }).text
        : undefined;
      if (typeof text === 'string') parts.push(text);
    }
    if (parts.length) return parts.join('');
  }

  return JSON.stringify(message);
}

function extractTextFromAssistantMessage(message: SDKAssistantMessage['message']): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    if (parts.length) return parts.join('');
  }
  return JSON.stringify(message);
}

function extractResultContent(result: SDKResultMessage): string {
  if (result.subtype === 'success') return result.result;
  return result.errors.join('\n');
}

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-4-5-20250929',
  opus: 'claude-opus-4-20250514',
  haiku: 'claude-haiku-3-5-20241022',
};

function resolveClaudeModel(modelAlias: string | undefined): string | undefined {
  if (!modelAlias) return undefined;
  const normalized = modelAlias.trim().toLowerCase();
  return CLAUDE_MODEL_ALIASES[normalized] ?? modelAlias;
}

function validateModel(modelAlias: string | undefined): void {
  if (!modelAlias) return;
  const normalized = modelAlias.trim().toLowerCase();
  // Allow known aliases or full model IDs starting with 'claude-'
  if (CLAUDE_MODEL_ALIASES[normalized]) return;
  if (normalized.startsWith('claude-')) return;
  throw new Error(`Invalid model for Claude provider: '${modelAlias}'. Supported aliases: ${Object.keys(CLAUDE_MODEL_ALIASES).join(', ')}`);
}

export class ClaudeAgentProvider implements AgentProvider {
  readonly name = 'claude-agent-sdk';

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    // Get model from environment variable (set by viewer-server)
    const envModel = process.env.JEEVES_MODEL;
    validateModel(envModel);
    const resolvedModel = resolveClaudeModel(envModel);

    const pendingEvents: ProviderEvent[] = [];
    const toolStartMsById = new Map<string, number>();

    const hooks: Partial<Record<string, HookCallbackMatcher[]>> = {
      PreToolUse: [
        {
          hooks: [
            async (input: HookInput) => {
              if (input.hook_event_name !== 'PreToolUse') return { continue: true };
              toolStartMsById.set(input.tool_use_id, Date.now());
              pendingEvents.push({
                type: 'tool_use',
                name: input.tool_name,
                input: toRecord(input.tool_input),
                id: input.tool_use_id,
                timestamp: nowIso(),
              });
              return { continue: true };
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (input: HookInput) => {
              if (input.hook_event_name !== 'PostToolUse') return { continue: true };
              const startedMs = toolStartMsById.get(input.tool_use_id);
              const durationMs = startedMs ? Date.now() - startedMs : null;
              pendingEvents.push({
                type: 'tool_result',
                toolUseId: input.tool_use_id,
                content: truncate(safeCompactString(input.tool_response)),
                durationMs,
                isError: false,
                timestamp: nowIso(),
              });
              return { continue: true };
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          hooks: [
            async (input: HookInput) => {
              if (input.hook_event_name !== 'PostToolUseFailure') return { continue: true };
              const startedMs = toolStartMsById.get(input.tool_use_id);
              const durationMs = startedMs ? Date.now() - startedMs : null;
              pendingEvents.push({
                type: 'tool_result',
                toolUseId: input.tool_use_id,
                content: truncate(input.error),
                durationMs,
                isError: true,
                timestamp: nowIso(),
              });
              return { continue: true };
            },
          ],
        },
      ],
    };

    const sdkOptions: Options = {
      cwd: options.cwd,
      includePartialMessages: false,
      // Intentional default for now: trusted local automation should run without prompts.
      // (Not configurable yet; if/when we expose config, we can offer stricter modes.)
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: hooks as Options['hooks'],
      ...(resolvedModel ? { model: resolvedModel } : {}),
    };
    const modelInfo = resolvedModel ? ` (model=${resolvedModel})` : '';
    yield {
      type: 'system',
      subtype: 'init',
      content: `Starting Claude Agent SDK session${modelInfo}`,
      timestamp: nowIso(),
    };

    const q = query({ prompt, options: sdkOptions });

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      while (pendingEvents.length) yield pendingEvents.shift()!;
      const ts = nowIso();
      if (msg.type === 'assistant') {
        yield { type: 'assistant', content: extractTextFromAssistantMessage(msg.message), timestamp: ts };
        continue;
      }

      if (msg.type === 'user') {
        // The SDK may emit synthetic `user` messages for tool results. Since we
        // separately capture tool outcomes via hooks, suppress these to avoid
        // duplicating tool results in the output stream.
        if (msg.parent_tool_use_id !== null && (msg as SDKUserMessage).tool_use_result !== undefined) {
          continue;
        }
        yield { type: 'user', content: extractTextFromMessageParam(msg.message), timestamp: ts };
        continue;
      }

      if (msg.type === 'result') {
        yield { type: 'result', content: extractResultContent(msg), timestamp: ts };
        continue;
      }

      if (msg.type === 'tool_progress') {
        yield {
          type: 'system',
          content: `[tool_progress] ${msg.tool_name} (${msg.tool_use_id}) ${msg.elapsed_time_seconds}s`,
          timestamp: ts,
          sessionId: msg.session_id,
        };
        continue;
      }

      if (msg.type === 'tool_use_summary') {
        yield {
          type: 'system',
          content: `[tool_use_summary] ${msg.summary}`,
          timestamp: ts,
          sessionId: msg.session_id,
        };
        continue;
      }

      if (msg.type === 'auth_status') {
        const content = msg.error
          ? `[auth_status] error: ${msg.error}`
          : `[auth_status] authenticating=${msg.isAuthenticating}`;
        yield { type: 'system', content, timestamp: ts, sessionId: msg.session_id };
        continue;
      }

      yield { type: 'system', content: `[sdk] ${JSON.stringify(msg)}`, timestamp: ts, sessionId: (msg as { session_id?: string }).session_id ?? null };
      while (pendingEvents.length) yield pendingEvents.shift()!;
    }

    while (pendingEvents.length) yield pendingEvents.shift()!;
  }
}
