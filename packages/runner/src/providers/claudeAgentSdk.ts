import type { AgentProvider, ProviderEvent, ProviderRunOptions } from '../provider.js';

// NOTE: Keep all SDK imports in this file so the rest of the runner is provider-agnostic.
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallbackMatcher,
  type HookInput,
  type Options,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

function nowIso(): string {
  return new Date().toISOString();
}

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function envFloat(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function envInt(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
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

function extractTextFromToolResponse(toolResponse: unknown): string {
  if (typeof toolResponse === 'string') return toolResponse;
  if (toolResponse && typeof toolResponse === 'object') {
    const content = (toolResponse as { content?: unknown }).content;
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
  }

  return safeCompactString(toolResponse);
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
  opus: 'claude-opus-4-5-20251101',
  haiku: 'claude-haiku-4-5-20251001',
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

    const prunerEnabled = envFlag('JEEVES_PRUNER_ENABLED');
    const prunerUrl = process.env.JEEVES_PRUNER_URL ?? 'http://localhost:8000/prune';
    const prunerThreshold = envFloat('JEEVES_PRUNER_THRESHOLD') ?? undefined;
    const prunerDefaultQuery = process.env.JEEVES_PRUNER_QUERY ?? prompt;
    const prunerTimeoutMs = envInt('JEEVES_PRUNER_TIMEOUT_MS') ?? 30_000;

    const prunedReadServer = prunerEnabled
      ? createSdkMcpServer({
        name: 'jeeves_pruned',
        version: '1.0.0',
        tools: [
          tool(
            'Read',
            [
              'Read file contents (Jeeves pruned Read).',
              'When pruning is enabled, this tool will call an external pruner service and return pruned output.',
              '',
              'ARGS:',
              '- path (string): file path to read (relative to cwd or absolute under cwd)',
              '- context_focus_question (string | null, optional): question used to focus pruning; defaults to current prompt',
            ].join('\n'),
            {
              path: z.string(),
              context_focus_question: z.string().nullable().optional(),
            },
            async (args) => {
              const cwdAbs = path.resolve(options.cwd);
              const requested = String(args.path);
              const resolved = path.resolve(cwdAbs, requested);
              if (resolved !== cwdAbs && !resolved.startsWith(`${cwdAbs}${path.sep}`)) {
                return {
                  isError: true,
                  content: [{ type: 'text', text: `Read denied: path outside cwd (${requested})` }],
                };
              }

              let content: string;
              try {
                content = await fs.readFile(resolved, 'utf-8');
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                  isError: true,
                  content: [{ type: 'text', text: `Read failed: ${msg}` }],
                };
              }

              const queryText = (args.context_focus_question ?? prunerDefaultQuery).trim();
              if (!queryText) {
                return { content: [{ type: 'text', text: content }] };
              }

              try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), prunerTimeoutMs);
                try {
                  const res = await fetch(prunerUrl, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      query: queryText,
                      code: content,
                      ...(prunerThreshold !== undefined ? { threshold: prunerThreshold } : {}),
                    }),
                    signal: controller.signal,
                  });
                  if (!res.ok) return { content: [{ type: 'text', text: content }] };
                  const data = (await res.json().catch(() => null)) as unknown;
                  if (data && typeof data === 'object') {
                    const prunedCode = (data as Record<string, unknown>).pruned_code;
                    if (typeof prunedCode === 'string' && prunedCode.trim()) {
                      return { content: [{ type: 'text', text: prunedCode }] };
                    }
                  }
                  return { content: [{ type: 'text', text: content }] };
                } finally {
                  clearTimeout(timeout);
                }
              } catch {
                return { content: [{ type: 'text', text: content }] };
              }
            },
          ),
        ],
      })
      : null;

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
                content: truncate(extractTextFromToolResponse(input.tool_response)),
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
      ...(prunedReadServer
        ? {
          // Replace built-in Read with our pruned MCP tool so pruning impacts
          // the model's live context, not just recorded output.
          disallowedTools: ['Read'],
          mcpServers: { jeeves_pruned: prunedReadServer },
        }
        : {}),
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
