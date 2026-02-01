import type { AgentProvider, ProviderEvent, ProviderRunOptions } from '../provider.js';

// NOTE: Keep all Codex CLI integration in this file so the rest of the runner is provider-agnostic.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as readline from 'node:readline';

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(input: string, max = 2000): string {
  if (input.length <= max) return input;
  return input.slice(0, max);
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

function getString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

function getNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function getRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = obj[key];
  return isPlainObject(v) ? v : null;
}

export type CodexThreadEvent = Readonly<{ type: string; [key: string]: unknown }>;

type MapState = {
  toolStartMsById: Map<string, number>;
  emittedToolUseIds: Set<string>;
};

function isToolLikeItemType(type: string): boolean {
  return type === 'command_execution' || type === 'mcp_tool_call' || type === 'web_search' || type === 'file_change';
}

function toolNameForItem(itemType: string, item: Record<string, unknown>): string {
  if (itemType === 'command_execution') return 'command_execution';
  if (itemType === 'mcp_tool_call') {
    const server = getString(item, 'server') ?? 'unknown';
    const tool = getString(item, 'tool') ?? 'unknown';
    return `mcp:${server}/${tool}`;
  }
  if (itemType === 'web_search') return 'web_search';
  if (itemType === 'file_change') return 'file_change';
  return itemType || 'tool';
}

function toolInputForItem(itemType: string, item: Record<string, unknown>): Record<string, unknown> {
  if (itemType === 'command_execution') return { command: getString(item, 'command') ?? '' };
  if (itemType === 'mcp_tool_call') {
    return {
      server: getString(item, 'server') ?? '',
      tool: getString(item, 'tool') ?? '',
      arguments: item.arguments,
    };
  }
  if (itemType === 'web_search') return { query: getString(item, 'query') ?? '' };
  if (itemType === 'file_change') return { changes: item.changes ?? [] };
  return toRecord(item);
}

function toolResultForItem(itemType: string, item: Record<string, unknown>): { content: string; isError: boolean } {
  if (itemType === 'command_execution') {
    const aggregated = getString(item, 'aggregated_output') ?? '';
    const exitCode = getNumber(item, 'exit_code');
    const status = getString(item, 'status');
    const isError = status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0);
    const suffix = typeof exitCode === 'number' ? `\n[exit_code] ${exitCode}` : '';
    return { content: truncate(`${aggregated}${suffix}`.trim()), isError };
  }

  if (itemType === 'mcp_tool_call') {
    const status = getString(item, 'status');
    const isError = status === 'failed';
    if (isError) {
      const err = getRecord(item, 'error');
      return { content: truncate(getString(err ?? {}, 'message') ?? 'unknown error'), isError: true };
    }
    const result = getRecord(item, 'result');
    const structured = result ? result.structured_content : undefined;
    const content = truncate(safeCompactString(structured ?? result ?? ''));
    return { content, isError: false };
  }

  if (itemType === 'web_search') {
    return { content: 'web_search completed', isError: false };
  }

  if (itemType === 'file_change') {
    const status = getString(item, 'status') ?? 'completed';
    const isError = status === 'failed';
    const details = truncate(safeCompactString(item.changes));
    return { content: truncate(`file_change ${status}\n${details}`.trim()), isError };
  }

  return { content: truncate(safeCompactString(item)), isError: false };
}

function extractMessageText(item: Record<string, unknown>): string | null {
  const text = getString(item, 'text') ?? getString(item, 'content') ?? getString(item, 'message');
  if (text) return text;

  const content = item.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const obj = block as Record<string, unknown>;
      const t = getString(obj, 'text');
      if (t) parts.push(t);
    }
    if (parts.length) return parts.join('');
  }

  return null;
}

function extractMessageRole(item: Record<string, unknown>): string | null {
  const role = getString(item, 'role');
  if (!role) return null;
  return role.trim().toLowerCase();
}

function ensureToolUseEmitted(params: {
  itemType: string;
  item: Record<string, unknown>;
  state: MapState;
  events: ProviderEvent[];
  nowMs: () => number;
  nowIso: () => string;
}): void {
  const { itemType, item, state, events, nowMs, nowIso: nowIsoFn } = params;
  if (!isToolLikeItemType(itemType)) return;
  const id = getString(item, 'id');
  if (!id) return;
  if (state.emittedToolUseIds.has(id)) return;

  state.emittedToolUseIds.add(id);
  state.toolStartMsById.set(id, nowMs());

  events.push({
    type: 'tool_use',
    name: toolNameForItem(itemType, item),
    input: toolInputForItem(itemType, item),
    id,
    timestamp: nowIsoFn(),
  });
}

export function mapCodexEventToProviderEvents(
  raw: unknown,
  state: MapState,
  nowMs: () => number,
  nowIsoFn: () => string,
): ProviderEvent[] {
  const events: ProviderEvent[] = [];

  if (!isPlainObject(raw)) {
    events.push({ type: 'system', content: `[codex] ${safeCompactString(raw)}`, timestamp: nowIsoFn() });
    return events;
  }

  const type = getString(raw, 'type');
  if (!type) {
    events.push({ type: 'system', content: `[codex] ${safeCompactString(raw)}`, timestamp: nowIsoFn() });
    return events;
  }

  if (type === 'thread.started') {
    const threadId = getString(raw, 'thread_id');
    events.push({
      type: 'system',
      subtype: 'init',
      content: 'Codex thread started',
      timestamp: nowIsoFn(),
      ...(threadId ? { sessionId: threadId } : {}),
    });
    return events;
  }

  if (type === 'turn.started') {
    events.push({ type: 'system', content: 'Codex turn started', timestamp: nowIsoFn() });
    return events;
  }

  if (type === 'turn.completed') {
    const usage = getRecord(raw, 'usage');
    const inTok = usage ? getNumber(usage, 'input_tokens') : null;
    const cachedTok = usage ? getNumber(usage, 'cached_input_tokens') : null;
    const outTok = usage ? getNumber(usage, 'output_tokens') : null;
    const usageText = `usage: in=${inTok ?? '?'} cached=${cachedTok ?? '?'} out=${outTok ?? '?'}`;
    events.push({ type: 'system', content: `Codex turn completed (${usageText})`, timestamp: nowIsoFn() });
    return events;
  }

  if (type === 'turn.failed') {
    const err = getRecord(raw, 'error');
    const msg = getString(err ?? {}, 'message') ?? 'unknown error';
    events.push({ type: 'system', subtype: 'error', content: `Codex turn failed: ${msg}`, timestamp: nowIsoFn() });
    return events;
  }

  if (type === 'error') {
    const msg = getString(raw, 'message') ?? 'unknown error';
    events.push({ type: 'system', subtype: 'error', content: `Codex stream error: ${msg}`, timestamp: nowIsoFn() });
    return events;
  }

  if (type !== 'item.started' && type !== 'item.updated' && type !== 'item.completed') {
    events.push({ type: 'system', content: `[codex] ${safeCompactString(raw)}`, timestamp: nowIsoFn() });
    return events;
  }

  const item = getRecord(raw, 'item');
  if (!item) {
    events.push({ type: 'system', content: `[codex] ${safeCompactString(raw)}`, timestamp: nowIsoFn() });
    return events;
  }

  const itemType = getString(item, 'type') ?? 'unknown';
  const itemId = getString(item, 'id');

  if (type === 'item.started' || type === 'item.updated') {
    ensureToolUseEmitted({ itemType, item, state, events, nowMs, nowIso: nowIsoFn });
    return events;
  }

  // item.completed
  if (itemType === 'agent_message') {
    events.push({ type: 'assistant', content: getString(item, 'text') ?? '', timestamp: nowIsoFn() });
    return events;
  }

  if (itemType === 'user_message' || itemType === 'human_message') {
    events.push({ type: 'user', content: extractMessageText(item) ?? '', timestamp: nowIsoFn() });
    return events;
  }

  if (itemType === 'message' || itemType === 'chat_message') {
    const role = extractMessageRole(item);
    const content = extractMessageText(item) ?? '';
    if (role === 'user') {
      events.push({ type: 'user', content, timestamp: nowIsoFn() });
      return events;
    }
    if (role === 'assistant' || role === 'agent') {
      events.push({ type: 'assistant', content, timestamp: nowIsoFn() });
      return events;
    }
  }

  if (itemType === 'reasoning') {
    events.push({ type: 'system', content: `[reasoning] ${truncate(getString(item, 'text') ?? '')}`, timestamp: nowIsoFn() });
    return events;
  }

  if (itemType === 'todo_list') {
    events.push({ type: 'system', content: `[todo_list] ${truncate(safeCompactString(item.items))}`, timestamp: nowIsoFn() });
    return events;
  }

  if (itemType === 'error') {
    events.push({
      type: 'system',
      subtype: 'error',
      content: `[item.error] ${truncate(getString(item, 'message') ?? '')}`,
      timestamp: nowIsoFn(),
    });
    return events;
  }

  if (isToolLikeItemType(itemType)) {
    ensureToolUseEmitted({ itemType, item, state, events, nowMs, nowIso: nowIsoFn });

    const startedMs = itemId ? state.toolStartMsById.get(itemId) : undefined;
    const durationMs = startedMs ? nowMs() - startedMs : null;

    const result = toolResultForItem(itemType, item);
    if (itemId) {
      events.push({
        type: 'tool_result',
        toolUseId: itemId,
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
        durationMs,
        timestamp: nowIsoFn(),
      });
      return events;
    }
  }

  events.push({ type: 'system', content: `[item] ${safeCompactString(item)}`, timestamp: nowIsoFn() });
  return events;
}

// Codex supports passing model directly; no alias mapping needed.
// JEEVES_MODEL takes precedence, then existing env vars.
function getCodexModel(): string | undefined {
  const jeevesModel = process.env.JEEVES_MODEL;
  if (jeevesModel) return jeevesModel;
  return process.env.CODEX_MODEL ?? process.env.OPENAI_MODEL ?? undefined;
}

export class CodexSdkProvider implements AgentProvider {
  readonly name = 'codex';

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    const model = getCodexModel();

    const state: MapState = {
      toolStartMsById: new Map<string, number>(),
      emittedToolUseIds: new Set<string>(),
    };

    const modelInfo = model ? ` (model=${model})` : '';
    yield { type: 'system', subtype: 'init', content: `Starting Codex session${modelInfo}`, timestamp: nowIso() };

    const require = createRequire(import.meta.url);
    const codexEntry = require.resolve('@openai/codex/bin/codex.js');

    const args: string[] = ['exec', '--experimental-json'];
    if (model) args.push('--model', model);
    args.push('--sandbox', 'danger-full-access');
    args.push('--cd', options.cwd);
    args.push('--skip-git-repo-check');
    args.push('--config', 'approval_policy="never"');

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value;
    }
    if (!env.CODEX_API_KEY && env.OPENAI_API_KEY) env.CODEX_API_KEY = env.OPENAI_API_KEY;
    if (!env.OPENAI_BASE_URL && env.CODEX_BASE_URL) env.OPENAI_BASE_URL = env.CODEX_BASE_URL;

    let spawnError: unknown | null = null;
    let rl: readline.Interface | null = null;
    const stderrChunks: Buffer[] = [];
    const child = spawn(process.execPath, [codexEntry, ...args], { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const completion = new Promise<number>((resolve) => {
      let settled = false;
      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      child.once('exit', (code) => settle(code ?? 0));
      child.once('close', (code) => settle(code ?? 0));
      child.once('error', (err) => {
        spawnError = err;
        try {
          rl?.close();
        } catch {
          // ignore
        }
        try {
          child.stdout.destroy();
        } catch {
          // ignore
        }
        try {
          child.stderr.destroy();
        } catch {
          // ignore
        }
        settle(1);
      });
    });

    child.stderr.on('data', (d) => stderrChunks.push(Buffer.from(d)));

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const message = `Codex exec stdin write failed: ${msg}`;
      yield { type: 'system', subtype: 'error', content: message, timestamp: nowIso() };
      throw new Error(message);
    }

    rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const activeRl = rl;

    try {
      for await (const line of activeRl) {
        if (!line || !line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          yield {
            type: 'system',
            subtype: 'error',
            content: `Failed to parse Codex event: ${line}`,
            timestamp: nowIso(),
          };
          continue;
        }

        const mapped = mapCodexEventToProviderEvents(parsed, state, () => Date.now(), () => nowIso());
        for (const out of mapped) yield out;
      }

      const exitCode = await completion;

      if (spawnError) {
        const msg = spawnError instanceof Error ? spawnError.message : String(spawnError);
        const message = `Codex exec spawn failed: ${msg}`;
        yield { type: 'system', subtype: 'error', content: message, timestamp: nowIso() };
        throw new Error(message);
      }

      if (exitCode !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        const message = `Codex exec exited with code ${exitCode}: ${stderr}`.trim();
        yield { type: 'system', subtype: 'error', content: message, timestamp: nowIso() };
        throw new Error(message);
      }
    } finally {
      try {
        rl?.close();
      } catch {
        // ignore
      }
      child.removeAllListeners();
      try {
        if (!child.killed) child.kill();
      } catch {
        // ignore
      }
    }
  }
}
