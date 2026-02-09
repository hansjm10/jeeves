import fs from 'node:fs/promises';
import path from 'node:path';

import { appendRunSdkEvent, upsertRunArtifact } from '@jeeves/state-db';

import type { ProviderEvent, UsageData } from './provider.js';
import type { SdkOutputV1, SdkOutputV1Message, SdkOutputV1ToolCall } from './outputV1.js';

function nowIso(): string {
  return new Date().toISOString();
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  // Best-effort cross-platform atomic-ish write:
  // - write to temp file
  // - replace destination (Windows rename doesn't overwrite)
  await fs
    .rm(filePath, { force: true })
    .catch(() => void 0);
  await fs.rename(tmp, filePath);
}

export class SdkOutputWriterV1 {
  private readonly outputPath: string;
  private readonly dbContext: Readonly<{
    dataDir: string;
    runId: string;
    scope: string;
    taskId: string;
  }> | null;
  private readonly startedAt: string;
  private readonly messages: SdkOutputV1Message[] = [];
  private readonly toolCalls: SdkOutputV1ToolCall[] = [];
  private readonly toolCallIndexById = new Map<string, number>();
  private endedAt = '';
  private success = false;
  private error: { message: string; type: string } | null = null;
  private sessionId: string | null = null;
  private usage: UsageData | null = null;
  private lastWriteAtMs = 0;
  private completionEventEmitted = false;

  constructor(params: {
    outputPath: string;
    dbContext?: Readonly<{
      dataDir: string;
      runId: string;
      scope: string;
      taskId?: string;
    }> | null;
  }) {
    this.outputPath = params.outputPath;
    this.startedAt = nowIso();
    const db = params.dbContext;
    this.dbContext = db
      ? {
          dataDir: db.dataDir,
          runId: db.runId,
          scope: db.scope,
          taskId: db.taskId ?? '',
        }
      : null;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  private emitSdkEvent(event: string, data: Record<string, unknown>, ts: string): void {
    if (!this.dbContext) return;
    appendRunSdkEvent({
      dataDir: this.dbContext.dataDir,
      runId: this.dbContext.runId,
      scope: this.dbContext.scope,
      taskId: this.dbContext.taskId,
      ts,
      event: { event, data },
    });
  }

  private emitMessageEvent(message: SdkOutputV1Message, ts: string): void {
    this.emitSdkEvent(
      'sdk-message',
      {
        message,
        index: this.messages.length - 1,
        total: this.messages.length,
      },
      ts,
    );
  }

  addProviderEvent(event: ProviderEvent): void {
    const timestamp = event.timestamp ?? nowIso();

    if (event.type === 'usage') {
      this.usage = event.usage;
      return;
    }

    if (event.type === 'tool_use') {
      const idx = this.toolCalls.length;
      this.toolCalls.push({
        name: event.name,
        input: event.input,
        tool_use_id: event.id,
        timestamp,
      });
      this.toolCallIndexById.set(event.id, idx);
      this.emitSdkEvent(
        'sdk-tool-start',
        {
          tool_use_id: event.id,
          name: event.name,
          input: event.input,
        },
        timestamp,
      );
      return;
    }

    if (event.type === 'tool_result') {
      const message: SdkOutputV1Message = {
        type: 'tool_result',
        timestamp,
        tool_use_id: event.toolUseId,
        content: event.content,
        ...(event.isError ? { is_error: true } : {}),
      };
      this.messages.push(message);
      this.emitMessageEvent(message, timestamp);

      const idx = this.toolCallIndexById.get(event.toolUseId);
      const toolName = idx !== undefined ? this.toolCalls[idx]?.name : undefined;
      if (idx !== undefined) {
        const prev = this.toolCalls[idx];
        this.toolCalls[idx] = {
          ...prev,
          ...(event.durationMs !== undefined ? { duration_ms: event.durationMs } : {}),
          ...(event.isError ? { is_error: true } : {}),
        };
      }
      this.emitSdkEvent(
        'sdk-tool-complete',
        {
          tool_use_id: event.toolUseId,
          name: toolName,
          duration_ms: event.durationMs ?? 0,
          is_error: event.isError ?? false,
        },
        timestamp,
      );
      return;
    }

    if (event.type === 'system') {
      const message: SdkOutputV1Message = {
        type: 'system',
        timestamp,
        subtype: event.subtype ?? null,
        content: event.content,
        session_id: event.sessionId ?? this.sessionId,
      };
      this.messages.push(message);
      this.emitMessageEvent(message, timestamp);
      if (event.sessionId) {
        this.emitSdkEvent(
          'sdk-init',
          {
            session_id: event.sessionId,
            started_at: this.startedAt,
            status: 'running',
          },
          timestamp,
        );
      }
      return;
    }

    const message: SdkOutputV1Message = {
      type: event.type,
      timestamp,
      content: event.content,
    };
    this.messages.push(message);
    this.emitMessageEvent(message, timestamp);
  }

  setError(err: unknown): void {
    if (err instanceof Error) {
      this.error = { message: err.message, type: err.name };
    } else {
      this.error = { message: String(err), type: 'Error' };
    }
  }

  finalize(success: boolean): void {
    this.success = success;
    this.endedAt = nowIso();
    if (!this.completionEventEmitted) {
      const snapshot = this.snapshot();
      this.emitSdkEvent(
        'sdk-complete',
        {
          status: success ? 'success' : 'error',
          summary: snapshot.stats,
        },
        this.endedAt,
      );
      this.completionEventEmitted = true;
    }
  }

  snapshot(): SdkOutputV1 {
    const endedAt = this.endedAt || nowIso();
    const durationSeconds = Math.max(
      0,
      (Date.parse(endedAt) - Date.parse(this.startedAt)) / 1000,
    );

    const output: SdkOutputV1 = {
      schema: 'jeeves.sdk.v1',
      session_id: this.sessionId,
      started_at: this.startedAt,
      ended_at: endedAt,
      success: this.success,
      messages: [...this.messages],
      tool_calls: [...this.toolCalls],
      stats: {
        message_count: this.messages.length,
        tool_call_count: this.toolCalls.length,
        duration_seconds: durationSeconds,
        ...(this.usage
          ? {
              input_tokens: this.usage.input_tokens,
              output_tokens: this.usage.output_tokens,
              ...(this.usage.cache_read_input_tokens !== undefined
                ? { cache_read_input_tokens: this.usage.cache_read_input_tokens }
                : {}),
              ...(this.usage.cache_creation_input_tokens !== undefined
                ? { cache_creation_input_tokens: this.usage.cache_creation_input_tokens }
                : {}),
              ...(this.usage.total_cost_usd !== undefined
                ? { total_cost_usd: this.usage.total_cost_usd }
                : {}),
              ...(this.usage.num_turns !== undefined
                ? { num_turns: this.usage.num_turns }
                : {}),
            }
          : {}),
      },
      ...(this.error
        ? { error: this.error.message, error_type: this.error.type }
        : {}),
    };
    return output;
  }

  async writeIncremental(options?: { force?: boolean; minIntervalMs?: number }): Promise<void> {
    const minIntervalMs = options?.minIntervalMs ?? 750;
    const force = options?.force ?? false;
    const nowMs = Date.now();
    if (!force && nowMs - this.lastWriteAtMs < minIntervalMs) return;
    const snapshot = this.snapshot();
    await writeJsonAtomic(this.outputPath, snapshot);
    if (this.dbContext) {
      const content = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
      upsertRunArtifact({
        dataDir: this.dbContext.dataDir,
        runId: this.dbContext.runId,
        scope: this.dbContext.scope,
        taskId: this.dbContext.taskId,
        name: 'sdk-output.json',
        mime: 'application/json',
        content,
      });
    }
    this.lastWriteAtMs = nowMs;
  }
}
