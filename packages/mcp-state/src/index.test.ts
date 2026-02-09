import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SERVER_ENTRY = path.resolve(import.meta.dirname ?? __dirname, '../dist/index.js');

type JsonRpcResponse = Readonly<{
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: Readonly<{ code: number; message: string; data?: unknown }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function makeStateDir(prefix: string): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(dataDir, 'issues', 'acme', 'rocket', '112');
  await fs.mkdir(stateDir, { recursive: true });
  return stateDir;
}

function sendRequests(
  stateDir: string,
  requests: readonly Record<string, unknown>[],
  timeoutMs = 15_000,
): Promise<JsonRpcResponse[]> {
  return new Promise<JsonRpcResponse[]>((resolve, reject) => {
    const child = spawn('node', [SERVER_ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_STATE_DIR: stateDir },
    });

    const expectedResponses = requests.reduce((count, request) => {
      return request.id === undefined ? count : count + 1;
    }, 0);

    const responses: JsonRpcResponse[] = [];
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        reject(
          new Error(
            `Timed out waiting for MCP state responses (expected=${expectedResponses}, got=${responses.length}). stderr=${stderrBuffer}`,
          ),
        );
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      let newlineIdx = stdoutBuffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as unknown;
            if (isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'id')) {
              responses.push(parsed as JsonRpcResponse);
            }
          } catch {
            // Ignore non-JSON lines.
          }
        }
        if (responses.length >= expectedResponses) {
          settle(() => resolve(responses));
          return;
        }
        newlineIdx = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.on('error', (err) => {
      settle(() => reject(err));
    });

    child.on('exit', () => {
      if (responses.length >= expectedResponses) {
        settle(() => resolve(responses));
        return;
      }
      settle(() => {
        reject(
          new Error(
            `MCP state server exited early (expected=${expectedResponses}, got=${responses.length}). stderr=${stderrBuffer}`,
          ),
        );
      });
    });

    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
    child.stdin.end();
  });
}

function parseToolPayload(response: JsonRpcResponse, toolName: string): Record<string, unknown> {
  if (response.error) {
    throw new Error(`MCP tool ${toolName} failed: ${response.error.code} ${response.error.message}`);
  }
  const result = response.result;
  if (!isRecord(result)) {
    throw new Error(`MCP tool ${toolName} returned no result payload`);
  }
  const content = result['content'];
  if (!Array.isArray(content)) {
    throw new Error(`MCP tool ${toolName} returned malformed content`);
  }
  const firstTextBlock = content.find(
    (item) => isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string',
  ) as { text: string } | undefined;
  if (!firstTextBlock) {
    throw new Error(`MCP tool ${toolName} returned no text block`);
  }
  const parsed = JSON.parse(firstTextBlock.text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`MCP tool ${toolName} returned non-object JSON`);
  }
  return parsed;
}

async function callTool(
  stateDir: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const responses = await sendRequests(stateDir, [
    {
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'jeeves-mcp-state-test', version: '1.0.0' },
        capabilities: {},
      },
    },
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 2,
      params: {
        name: toolName,
        arguments: args,
      },
    },
  ]);
  const toolResponse = responses.find((item) => item.id === 2);
  if (!toolResponse) throw new Error(`Missing tools/call response for ${toolName}`);
  return parseToolPayload(toolResponse, toolName);
}

describe('mcp-state server memory tools', () => {
  it('supports get/upsert/mark-stale/delete flows', async () => {
    const stateDir = await makeStateDir('jeeves-mcp-state-tools-memory-');

    const upsertResult = await callTool(stateDir, 'state_upsert_memory', {
      scope: 'decisions',
      key: 'schema-choice',
      value: { version: 1, owner: 'platform' },
      source_iteration: 5,
    });
    expect(upsertResult['ok']).toBe(true);

    const visibleResult = await callTool(stateDir, 'state_get_memory', {
      scope: 'decisions',
    });
    expect(visibleResult['ok']).toBe(true);
    const visibleEntries = visibleResult['entries'];
    expect(Array.isArray(visibleEntries)).toBe(true);
    expect(visibleEntries).toHaveLength(1);

    const staleResult = await callTool(stateDir, 'state_mark_memory_stale', {
      scope: 'decisions',
      key: 'schema-choice',
    });
    expect(staleResult['ok']).toBe(true);
    expect(staleResult['updated']).toBe(true);

    const hiddenResult = await callTool(stateDir, 'state_get_memory', {
      scope: 'decisions',
    });
    const hiddenEntries = hiddenResult['entries'];
    expect(Array.isArray(hiddenEntries)).toBe(true);
    expect(hiddenEntries).toHaveLength(0);

    const staleVisibleResult = await callTool(stateDir, 'state_get_memory', {
      scope: 'decisions',
      include_stale: true,
    });
    const staleEntries = staleVisibleResult['entries'];
    expect(Array.isArray(staleEntries)).toBe(true);
    expect(staleEntries).toHaveLength(1);
    const firstStale = (staleEntries as unknown[])[0];
    expect(isRecord(firstStale)).toBe(true);
    expect((firstStale as Record<string, unknown>)['stale']).toBe(true);

    const deleteResult = await callTool(stateDir, 'state_delete_memory', {
      scope: 'decisions',
      key: 'schema-choice',
    });
    expect(deleteResult['ok']).toBe(true);
    expect(deleteResult['deleted']).toBe(true);

    const afterDeleteResult = await callTool(stateDir, 'state_get_memory', {
      scope: 'decisions',
      include_stale: true,
    });
    const afterDeleteEntries = afterDeleteResult['entries'];
    expect(Array.isArray(afterDeleteEntries)).toBe(true);
    expect(afterDeleteEntries).toHaveLength(0);
  }, 30_000);
});
