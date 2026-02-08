import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AgentProvider, McpServerConfig, ProviderEvent, ProviderRunOptions } from './provider.js';
import { runSinglePhaseOnce } from './runner.js';

type JsonRpcRequest = Readonly<{
  jsonrpc: '2.0';
  method: string;
  id?: number | string | null;
  params?: Record<string, unknown>;
}>;

type JsonRpcResponse = Readonly<{
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: Readonly<{ code: number; message: string; data?: unknown }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../..');
}

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function sendRequests(
  server: McpServerConfig,
  requests: readonly JsonRpcRequest[],
  timeoutMs = 20_000,
): Promise<JsonRpcResponse[]> {
  return new Promise<JsonRpcResponse[]>((resolve, reject) => {
    const child = spawn(server.command, server.args ? [...server.args] : [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(server.env ?? {}),
      },
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
            `Timed out waiting for MCP responses (expected=${expectedResponses}, got=${responses.length}). stderr=${stderrBuffer}`,
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
            `MCP server exited before all responses were received (expected=${expectedResponses}, got=${responses.length}). stderr=${stderrBuffer}`,
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
  if (parsed['ok'] === false) {
    const message = typeof parsed['error'] === 'string' ? parsed['error'] : 'unknown error';
    throw new Error(`MCP tool ${toolName} reported failure: ${message}`);
  }
  return parsed;
}

async function callStateTool(
  stateServer: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const responses = await sendRequests(stateServer, [
    {
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'jeeves-runner-test', version: '1.0.0' },
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

class McpStateExerciseProvider implements AgentProvider {
  readonly name = 'mcp-state-exercise-provider';
  readonly calledTools: string[] = [];
  seenStateServer: McpServerConfig | null = null;

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    void prompt;
    const stateServer = options.mcpServers?.state;
    if (!stateServer) throw new Error('Expected state MCP server config');
    this.seenStateServer = stateServer;

    const issue = {
      repo: 'acme/rocket',
      issue: { number: 42, title: 'MCP integration task loop' },
      branch: 'feature/mcp-state-test',
      workflow: 'default',
      phase: 'implement_task',
      status: {
        currentTaskId: 'T1',
      },
    };
    const tasks = {
      schemaVersion: 1,
      tasks: [
        {
          id: 'T1',
          title: 'First task',
          summary: 'Implement phase loop updates.',
          status: 'pending',
          dependsOn: [],
          filesAllowed: ['packages/runner/src/*.ts'],
          acceptanceCriteria: ['state rows exist'],
        },
        {
          id: 'T2',
          title: 'Second task',
          summary: 'Follow-up task.',
          status: 'pending',
          dependsOn: ['T1'],
          filesAllowed: ['packages/mcp-state/src/*.ts'],
          acceptanceCriteria: ['task cursor advanced'],
        },
      ],
    };

    yield { type: 'system', subtype: 'init', content: 'MCP state optional integration provider' };

    yield { type: 'tool_use', id: 'tool_1', name: 'state_put_issue', input: { issue } };
    const putIssueResult = await callStateTool(stateServer, 'state_put_issue', { issue });
    this.calledTools.push('state_put_issue');
    yield { type: 'tool_result', toolUseId: 'tool_1', content: JSON.stringify(putIssueResult) };

    yield { type: 'tool_use', id: 'tool_2', name: 'state_put_tasks', input: { tasks } };
    const putTasksResult = await callStateTool(stateServer, 'state_put_tasks', { tasks });
    this.calledTools.push('state_put_tasks');
    yield { type: 'tool_result', toolUseId: 'tool_2', content: JSON.stringify(putTasksResult) };

    yield {
      type: 'tool_use',
      id: 'tool_3',
      name: 'state_set_task_status',
      input: { task_id: 'T1', status: 'passed' },
    };
    const setStatusResult = await callStateTool(stateServer, 'state_set_task_status', {
      task_id: 'T1',
      status: 'passed',
    });
    this.calledTools.push('state_set_task_status');
    yield { type: 'tool_result', toolUseId: 'tool_3', content: JSON.stringify(setStatusResult) };

    yield {
      type: 'tool_use',
      id: 'tool_4',
      name: 'state_update_issue_status',
      input: {
        fields: {
          currentTaskId: 'T2',
          taskPassed: true,
          taskFailed: false,
          hasMoreTasks: true,
          allTasksComplete: false,
        },
      },
    };
    const issueStatusResult = await callStateTool(stateServer, 'state_update_issue_status', {
      fields: {
        currentTaskId: 'T2',
        taskPassed: true,
        taskFailed: false,
        hasMoreTasks: true,
        allTasksComplete: false,
      },
    });
    this.calledTools.push('state_update_issue_status');
    yield { type: 'tool_result', toolUseId: 'tool_4', content: JSON.stringify(issueStatusResult) };

    yield {
      type: 'tool_use',
      id: 'tool_5',
      name: 'state_append_progress',
      input: { entry: '## [Integration] MCP state test\nPhase writes through tools.\n' },
    };
    const appendProgressResult = await callStateTool(stateServer, 'state_append_progress', {
      entry: '## [Integration] MCP state test\nPhase writes through tools.\n',
    });
    this.calledTools.push('state_append_progress');
    yield { type: 'tool_result', toolUseId: 'tool_5', content: JSON.stringify(appendProgressResult) };

    yield { type: 'tool_use', id: 'tool_6', name: 'state_get_issue', input: {} };
    const issueReadResult = await callStateTool(stateServer, 'state_get_issue', {});
    this.calledTools.push('state_get_issue');
    yield { type: 'tool_result', toolUseId: 'tool_6', content: JSON.stringify(issueReadResult) };

    const issuePayload = issueReadResult['issue'];
    if (!isRecord(issuePayload)) throw new Error('state_get_issue did not return an issue payload');
    const statusPayload = issuePayload['status'];
    if (!isRecord(statusPayload) || statusPayload['currentTaskId'] !== 'T2') {
      throw new Error('state_update_issue_status did not update currentTaskId');
    }

    yield { type: 'assistant', content: 'MCP state tools executed successfully.' };
    yield { type: 'result', content: 'ok' };
  }
}

const optionalDescribe = process.env.JEEVES_RUN_OPTIONAL_TESTS === 'true' ? describe : describe.skip;

optionalDescribe('runner optional MCP state integration', () => {
  it('runs a phase that calls state MCP tools and persists SQLite rows', async () => {
    const repoRoot = getRepoRoot();
    const stateEntrypoint = path.join(repoRoot, 'packages', 'mcp-state', 'dist', 'index.js');
    await expect(fs.stat(stateEntrypoint)).resolves.toBeDefined();

    const tmp = await makeTempDir('jeeves-runner-mcp-state-');
    const workflowsDir = path.join(tmp, 'workflows');
    const promptsDir = path.join(tmp, 'prompts');
    const stateDir = path.join(tmp, 'issues', 'acme', 'rocket', '42');
    const cwd = path.join(tmp, 'worktree');
    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    await fs.writeFile(
      path.join(workflowsDir, 'mcp-state-optional.yaml'),
      [
        'workflow:',
        '  name: mcp-state-optional',
        '  version: 1',
        '  start: task_phase',
        'phases:',
        '  task_phase:',
        '    type: execute',
        '    mcp_profile: state',
        '    prompt: task.phase.prompt.md',
        '    transitions: []',
      ].join('\n') + '\n',
      'utf-8',
    );
    await fs.writeFile(path.join(promptsDir, 'task.phase.prompt.md'), 'Optional MCP state integration prompt.\n', 'utf-8');

    const provider = new McpStateExerciseProvider();
    const previousStatePath = process.env.JEEVES_MCP_STATE_PATH;
    process.env.JEEVES_MCP_STATE_PATH = stateEntrypoint;
    try {
      const result = await runSinglePhaseOnce({
        provider,
        workflowName: 'mcp-state-optional',
        phaseName: 'task_phase',
        workflowsDir,
        promptsDir,
        stateDir,
        cwd,
      });

      expect(result).toEqual({ phase: 'task_phase', success: true });
      expect(provider.seenStateServer).not.toBeNull();
      expect(provider.calledTools).toEqual([
        'state_put_issue',
        'state_put_tasks',
        'state_set_task_status',
        'state_update_issue_status',
        'state_append_progress',
        'state_get_issue',
      ]);
    } finally {
      if (previousStatePath === undefined) {
        delete process.env.JEEVES_MCP_STATE_PATH;
      } else {
        process.env.JEEVES_MCP_STATE_PATH = previousStatePath;
      }
    }

    const issuePath = path.join(stateDir, 'issue.json');
    const tasksPath = path.join(stateDir, 'tasks.json');
    const progressPath = path.join(stateDir, 'progress.txt');
    const issue = JSON.parse(await fs.readFile(issuePath, 'utf-8')) as Record<string, unknown>;
    const tasks = JSON.parse(await fs.readFile(tasksPath, 'utf-8')) as Record<string, unknown>;
    const progress = await fs.readFile(progressPath, 'utf-8');
    expect((issue.status as { currentTaskId?: string }).currentTaskId).toBe('T2');
    expect(((tasks.tasks as { id: string; status: string }[])[0])?.status).toBe('passed');
    expect(progress).toContain('MCP state test');

    const logPath = path.join(stateDir, 'last-run.log');
    const log = await fs.readFile(logPath, 'utf-8');
    expect(log).toContain('[TOOL] state_put_issue');
    expect(log).toContain('[TOOL] state_update_issue_status');

    const dbPath = path.join(tmp, 'jeeves.db');
    const dbStat = await fs.stat(dbPath);
    expect(dbStat.isFile()).toBe(true);
    expect(dbStat.size).toBeGreaterThan(0);

    const stateServer = provider.seenStateServer;
    if (!stateServer) throw new Error('Missing captured state server config');
    await fs.rm(issuePath);
    await fs.rm(tasksPath);

    const issueFromDb = await callStateTool(stateServer, 'state_get_issue', {});
    const tasksFromDb = await callStateTool(stateServer, 'state_get_tasks', {});
    const restoredIssue = issueFromDb['issue'];
    const restoredTasks = tasksFromDb['tasks'];
    expect(isRecord(restoredIssue)).toBe(true);
    expect(isRecord(restoredTasks)).toBe(true);
    expect(((restoredIssue as { status?: { currentTaskId?: string } }).status?.currentTaskId)).toBe('T2');
    expect((((restoredTasks as { tasks?: { status?: string }[] }).tasks ?? [])[0])?.status).toBe('passed');
  }, 30_000);
});
