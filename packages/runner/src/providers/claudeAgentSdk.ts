import type { AgentProvider, ProviderEvent, ProviderRunOptions, UsageData } from '../provider.js';

// NOTE: Keep all SDK imports in this file so the rest of the runner is provider-agnostic.
import {
  query,
  type CanUseTool,
  type HookCallbackMatcher,
  type HookInput,
  type Options,
  type PermissionMode,
  type SDKAssistantMessage,
  type SDKCompactBoundaryMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKStatusMessage,
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

function truncateWithMeta(input: string, max = 2000): { text: string; truncated: boolean } {
  if (input.length <= max) return { text: input, truncated: false };
  return { text: input.slice(0, max), truncated: true };
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
  opus: 'claude-opus-4-6',
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

type DangerousBashPattern = Readonly<{
  label: string;
  pattern: RegExp;
}>;

const DANGEROUS_BASH_COMMAND_PATTERNS: readonly DangerousBashPattern[] = [
  { label: 'pkill', pattern: /(?:^|[;&|]\s*|\n\s*)(?:sudo\s+)?pkill(?:\s|$)/i },
  { label: 'killall', pattern: /(?:^|[;&|]\s*|\n\s*)(?:sudo\s+)?killall(?:\s|$)/i },
  { label: 'fuser -k', pattern: /(?:^|[;&|]\s*|\n\s*)(?:sudo\s+)?fuser\s+-k(?:\s|$)/i },
  {
    label: 'kill $(lsof ...)',
    pattern: /(?:^|[;&|]\s*|\n\s*)(?:sudo\s+)?kill\b[^\n]*\$\([^)]*lsof[^)]*\)/i,
  },
  { label: 'kill -1', pattern: /(?:^|[;&|]\s*|\n\s*)(?:sudo\s+)?kill(?:\s+-[A-Z0-9]+)?\s+-1(?:\s|$)/i },
];

const DANGEROUS_KILL_OVERRIDE_ENV = 'JEEVES_ALLOW_DANGEROUS_PROCESS_KILL';

type ResolvedPermissionMode = Readonly<{
  requestedPermissionMode: string;
  sdkPermissionMode: PermissionMode;
  allowDangerouslySkipPermissions: boolean;
}>;

export function resolveClaudePermissionMode(
  optionsPermissionMode: string | undefined,
  envPermissionMode: string | undefined,
): ResolvedPermissionMode {
  const requestedPermissionMode = optionsPermissionMode ?? envPermissionMode ?? 'bypassPermissions';

  // Keep workflow-level "plan" semantics while granting the same permissions as normal Claude runs.
  if (requestedPermissionMode === 'plan') {
    return {
      requestedPermissionMode,
      sdkPermissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    };
  }

  const sdkPermissionMode = requestedPermissionMode as PermissionMode;
  return {
    requestedPermissionMode,
    sdkPermissionMode,
    allowDangerouslySkipPermissions: sdkPermissionMode === 'bypassPermissions',
  };
}

export function getDangerousBashCommandBlockReason(
  toolName: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env[DANGEROUS_KILL_OVERRIDE_ENV] === 'true') return null;
  if (toolName.trim().toLowerCase() !== 'bash') return null;
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command.trim()) return null;

  const matched = DANGEROUS_BASH_COMMAND_PATTERNS.find((entry) => entry.pattern.test(command));
  if (!matched) return null;

  return `Blocked potentially destructive Bash command (${matched.label}). Avoid broad process-kill commands in Jeeves runs because they can terminate viewer/runner processes. Use explicit PIDs for processes you started in this shell, or run on alternate ports. Set ${DANGEROUS_KILL_OVERRIDE_ENV}=true to override.`;
}

export function mapSdkCompactEventToProviderEvent(
  msg: SDKMessage,
  timestamp: string,
): ProviderEvent | null {
  if (msg.type !== 'system') return null;

  const sysMsg = msg as { type: 'system'; subtype?: string; [key: string]: unknown };

  if (sysMsg.subtype === 'compact_boundary') {
    const compact = msg as SDKCompactBoundaryMessage;
    return {
      type: 'system',
      subtype: 'compaction',
      content: `[compact_boundary] trigger=${compact.compact_metadata.trigger} pre_tokens=${compact.compact_metadata.pre_tokens}`,
      timestamp,
      sessionId: compact.session_id,
    };
  }

  if (sysMsg.subtype === 'status') {
    const statusMsg = msg as SDKStatusMessage;
    if (statusMsg.status === 'compacting') {
      return {
        type: 'system',
        subtype: 'compaction',
        content: '[status] compacting',
        timestamp,
        sessionId: statusMsg.session_id,
      };
    }
    // status=null (compaction finished) falls through to generic handler
    return null;
  }

  return null;
}

export class ClaudeAgentProvider implements AgentProvider {
  readonly name = 'claude-agent-sdk';

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    // Get model from environment variable (set by viewer-server)
    const envModel = process.env.JEEVES_MODEL;
    validateModel(envModel);
    const resolvedModel = resolveClaudeModel(envModel);

    // Get permission mode: options > env var > default
    const envPermMode = process.env.JEEVES_PERMISSION_MODE;
    const permissionMode = resolveClaudePermissionMode(options.permissionMode, envPermMode);

    const pendingEvents: ProviderEvent[] = [];
    const toolStartMsById = new Map<string, number>();
    const canUseTool: CanUseTool = async (toolName, input, permissionOptions) => {
      const blockReason = getDangerousBashCommandBlockReason(toolName, input, process.env);
      if (blockReason) {
        return { behavior: 'deny', message: blockReason, toolUseID: permissionOptions.toolUseID };
      }
      return { behavior: 'allow', toolUseID: permissionOptions.toolUseID };
    };

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
              const response = truncateWithMeta(safeCompactString(input.tool_response));
              pendingEvents.push({
                type: 'tool_result',
                toolUseId: input.tool_use_id,
                content: response.text,
                response_text: response.text,
                response_truncated: response.truncated,
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
              const response = truncateWithMeta(input.error);
              pendingEvents.push({
                type: 'tool_result',
                toolUseId: input.tool_use_id,
                content: response.text,
                response_text: response.text,
                response_truncated: response.truncated,
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
      permissionMode: permissionMode.sdkPermissionMode,
      allowDangerouslySkipPermissions: permissionMode.allowDangerouslySkipPermissions,
      canUseTool,
      hooks: hooks as Options['hooks'],
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(options.mcpServers ? { mcpServers: options.mcpServers as Options['mcpServers'] } : {}),
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
        const usage: UsageData = {
          input_tokens: msg.usage.input_tokens,
          output_tokens: msg.usage.output_tokens,
          cache_read_input_tokens: msg.usage.cache_read_input_tokens,
          cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
          total_cost_usd: msg.total_cost_usd,
          num_turns: msg.num_turns,
        };
        yield { type: 'usage', usage, timestamp: ts };
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

      const compactEvent = mapSdkCompactEventToProviderEvent(msg, ts);
      if (compactEvent) {
        yield compactEvent;
        continue;
      }

      yield { type: 'system', content: `[sdk] ${JSON.stringify(msg)}`, timestamp: ts, sessionId: (msg as { session_id?: string }).session_id ?? null };
      while (pendingEvents.length) yield pendingEvents.shift()!;
    }

    while (pendingEvents.length) yield pendingEvents.shift()!;
  }
}
