import fs from 'node:fs/promises';

type SdkOutputV1 = {
  schema?: string;
  session_id?: string | null;
  started_at?: string;
  ended_at?: string;
  success?: boolean;
  messages?: unknown[];
  tool_calls?: Record<string, unknown>[];
  stats?: unknown;
};

export class LogTailer {
  private filePath: string | null = null;
  private offset = 0;
  private leftover = '';

  reset(filePath: string): void {
    this.filePath = filePath;
    this.offset = 0;
    this.leftover = '';
  }

  async getAllLines(maxLines: number): Promise<string[]> {
    if (!this.filePath) return [];
    const raw = await fs
      .readFile(this.filePath, 'utf-8')
      .catch(() => '');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.slice(Math.max(0, lines.length - maxLines));
  }

  async getNewLines(): Promise<{ lines: string[]; changed: boolean }> {
    if (!this.filePath) return { lines: [], changed: false };
    const stat = await fs
      .stat(this.filePath)
      .catch(() => null);
    if (!stat || !stat.isFile()) return { lines: [], changed: false };

    if (stat.size < this.offset) {
      this.offset = 0;
      this.leftover = '';
    }
    const toRead = stat.size - this.offset;
    if (toRead <= 0) return { lines: [], changed: false };

    const fh = await fs.open(this.filePath, 'r');
    try {
      const buf = Buffer.alloc(toRead);
      const { bytesRead } = await fh.read(buf, 0, toRead, this.offset);
      this.offset += bytesRead;
      const text = this.leftover + buf.subarray(0, bytesRead).toString('utf-8');
      const parts = text.split(/\r?\n/);
      const endsWithNewline = /\r?\n$/.test(text);
      if (!endsWithNewline) {
        this.leftover = parts.pop() ?? '';
      } else {
        this.leftover = '';
        // drop final empty segment
        if (parts.length && parts[parts.length - 1] === '') parts.pop();
      }
      const lines = parts.filter(Boolean);
      return { lines, changed: lines.length > 0 };
    } finally {
      await fh.close();
    }
  }
}

export class SdkOutputTailer {
  private filePath: string | null = null;
  private lastSessionId: string | null = null;
  private lastMessageCount = 0;
  private toolSeen = new Set<string>();
  private toolCompleted = new Set<string>();
  private ended = false;

  reset(filePath: string): void {
    this.filePath = filePath;
    this.lastSessionId = null;
    this.lastMessageCount = 0;
    this.toolSeen = new Set();
    this.toolCompleted = new Set();
    this.ended = false;
  }

  async readSnapshot(): Promise<SdkOutputV1 | null> {
    if (!this.filePath) return null;
    const raw = await fs
      .readFile(this.filePath, 'utf-8')
      .catch(() => null);
    if (!raw || !raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw) as SdkOutputV1;
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  consumeAndDiff(snapshot: SdkOutputV1): {
    sessionChanged: boolean;
    sessionId: string | null;
    startedAt: string | undefined;
    endedAt: string | undefined;
    success: boolean | undefined;
    newMessages: { message: unknown; index: number; total: number }[];
    toolStarts: { tool_use_id: string; name?: unknown; input?: unknown }[];
    toolCompletes: { tool_use_id: string; name?: unknown; duration_ms?: unknown; is_error?: unknown }[];
    justEnded: boolean;
    stats: unknown;
  } {
    const sessionId = typeof snapshot.session_id === 'string' ? snapshot.session_id : snapshot.session_id ?? null;
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const toolCalls = Array.isArray(snapshot.tool_calls) ? snapshot.tool_calls : [];

    const sessionChanged = sessionId !== this.lastSessionId && sessionId !== null;
    if (sessionChanged) {
      this.lastSessionId = sessionId;
      this.lastMessageCount = 0;
      this.toolSeen.clear();
      this.toolCompleted.clear();
      this.ended = false;
    }

    const newMessages: { message: unknown; index: number; total: number }[] = [];
    for (let i = this.lastMessageCount; i < messages.length; i += 1) {
      newMessages.push({ message: messages[i], index: i, total: messages.length });
    }
    this.lastMessageCount = messages.length;

    const toolStarts: { tool_use_id: string; name?: unknown; input?: unknown }[] = [];
    const toolCompletes: { tool_use_id: string; name?: unknown; duration_ms?: unknown; is_error?: unknown }[] = [];

    for (const tc of toolCalls) {
      const toolUseId = typeof tc.tool_use_id === 'string' ? tc.tool_use_id : '';
      if (!toolUseId) continue;

      if (!this.toolSeen.has(toolUseId)) {
        this.toolSeen.add(toolUseId);
        toolStarts.push({ tool_use_id: toolUseId, name: tc.name, input: tc.input });
      }

      const hasCompletionData = tc.duration_ms !== undefined || tc.is_error !== undefined;
      if (hasCompletionData && !this.toolCompleted.has(toolUseId)) {
        this.toolCompleted.add(toolUseId);
        toolCompletes.push({
          tool_use_id: toolUseId,
          name: tc.name,
          duration_ms: tc.duration_ms,
          is_error: tc.is_error,
        });
      }
    }

    const endedAt = typeof snapshot.ended_at === 'string' ? snapshot.ended_at : undefined;
    const justEnded = Boolean(endedAt) && !this.ended;
    if (justEnded) this.ended = true;

    return {
      sessionChanged,
      sessionId,
      startedAt: typeof snapshot.started_at === 'string' ? snapshot.started_at : undefined,
      endedAt,
      success: typeof snapshot.success === 'boolean' ? snapshot.success : undefined,
      newMessages,
      toolStarts,
      toolCompletes,
      justEnded,
      stats: snapshot.stats,
    };
  }
}
