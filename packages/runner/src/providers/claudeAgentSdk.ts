import type { AgentProvider, ProviderEvent, ProviderRunOptions } from '../provider.js';

// NOTE: Keep all SDK imports in this file so the rest of the runner is provider-agnostic.
import { query, type Options, type SDKAssistantMessage, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

function nowIso(): string {
  return new Date().toISOString();
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

export class ClaudeAgentProvider implements AgentProvider {
  readonly name = 'claude-agent-sdk';

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    const sdkOptions: Options = {
      cwd: options.cwd,
      includePartialMessages: false,
      permissionMode: 'bypassPermissions',
    };
    yield {
      type: 'system',
      subtype: 'init',
      content: 'Starting Claude Agent SDK session',
      timestamp: nowIso(),
    };

    const q = query({ prompt, options: sdkOptions });

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      const ts = nowIso();
      if (msg.type === 'assistant') {
        yield { type: 'assistant', content: extractTextFromAssistantMessage(msg.message), timestamp: ts };
        continue;
      }

      if (msg.type === 'user') {
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
    }
  }
}
