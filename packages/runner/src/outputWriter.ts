import fs from 'node:fs/promises';
import path from 'node:path';

import type { ProviderEvent } from './provider.js';
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
  private readonly startedAt: string;
  private readonly messages: SdkOutputV1Message[] = [];
  private readonly toolCalls: SdkOutputV1ToolCall[] = [];
  private endedAt = '';
  private success = false;
  private error: { message: string; type: string } | null = null;
  private sessionId: string | null = null;
  private lastWriteAtMs = 0;

  constructor(params: { outputPath: string }) {
    this.outputPath = params.outputPath;
    this.startedAt = nowIso();
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  addProviderEvent(event: ProviderEvent): void {
    const timestamp = event.timestamp ?? nowIso();

    if (event.type === 'tool_use') {
      this.toolCalls.push({
        name: event.name,
        input: event.input,
        tool_use_id: event.id,
        timestamp,
      });
      return;
    }

    if (event.type === 'tool_result') {
      this.messages.push({
        type: 'tool_result',
        timestamp,
        tool_use_id: event.toolUseId,
        content: event.content,
        ...(event.isError ? { is_error: true } : {}),
      });
      return;
    }

    if (event.type === 'system') {
      this.messages.push({
        type: 'system',
        timestamp,
        subtype: event.subtype ?? null,
        content: event.content,
        session_id: event.sessionId ?? this.sessionId,
      });
      return;
    }

    this.messages.push({
      type: event.type,
      timestamp,
      content: event.content,
    });
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
    await writeJsonAtomic(this.outputPath, this.snapshot());
    this.lastWriteAtMs = nowMs;
  }
}
