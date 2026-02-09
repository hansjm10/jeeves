import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { markMemoryEntryStaleInDb, upsertMemoryEntryInDb } from '@jeeves/state-db';
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
    const childEvents = child as unknown as {
      on(event: 'error', listener: (err: unknown) => void): void;
      on(event: 'exit', listener: () => void): void;
    };

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

    childEvents.on('error', (err: unknown) => {
      settle(() => reject(err));
    });

    childEvents.on('exit', () => {
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

function getMemoryEntries(payload: Record<string, unknown>): Record<string, unknown>[] {
  const rawEntries = payload['entries'];
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries.filter(isRecord);
}

class McpStateExerciseProvider implements AgentProvider {
  readonly name = 'mcp-state-exercise-provider';
  readonly mode: 'writer' | 'reader';
  readonly calledTools: string[] = [];
  seenStateServer: McpServerConfig | null = null;
  seenPrompt: string | null = null;

  constructor(mode: 'writer' | 'reader') {
    this.mode = mode;
  }

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    this.seenPrompt = prompt;
    const stateServer = options.mcpServers?.state;
    if (!stateServer) throw new Error('Expected state MCP server config');
    this.seenStateServer = stateServer;

    if (this.mode === 'reader') {
      if (!prompt.includes('key=current-task')) {
        throw new Error('memory prompt missing working_set key=current-task');
      }
      if (!prompt.includes('key=schema-choice')) {
        throw new Error('memory prompt missing decisions key=schema-choice');
      }
      if (!prompt.includes('key=task_phase:focus')) {
        throw new Error('memory prompt missing session key=task_phase:focus');
      }
      if (!prompt.includes('key=task_phase:lint-reminder')) {
        throw new Error('memory prompt missing cross_run key=task_phase:lint-reminder');
      }
      if (prompt.includes('key=deprecated-choice')) {
        throw new Error('memory prompt includes stale/deleted key=deprecated-choice');
      }

      yield { type: 'system', subtype: 'init', content: 'MCP state optional integration provider (reader mode)' };

      yield { type: 'tool_use', id: 'tool_r1', name: 'state_get_memory', input: { scope: 'decisions' } };
      const decisions = await callStateTool(stateServer, 'state_get_memory', { scope: 'decisions' });
      this.calledTools.push('state_get_memory');
      yield { type: 'tool_result', toolUseId: 'tool_r1', content: JSON.stringify(decisions) };

      const decisionEntries = getMemoryEntries(decisions);
      const decisionEntry = decisionEntries.find((entry) => entry['key'] === 'schema-choice');
      if (!decisionEntry) throw new Error('expected persisted decision key=schema-choice');
      const decisionValue = decisionEntry['value'];
      if (!isRecord(decisionValue) || decisionValue['version'] !== 'v2') {
        throw new Error('expected persisted decision schema-choice version=v2');
      }

      yield { type: 'tool_use', id: 'tool_r2', name: 'state_get_memory', input: { scope: 'cross_run' } };
      const crossRun = await callStateTool(stateServer, 'state_get_memory', { scope: 'cross_run' });
      this.calledTools.push('state_get_memory');
      yield { type: 'tool_result', toolUseId: 'tool_r2', content: JSON.stringify(crossRun) };

      const crossRunEntries = getMemoryEntries(crossRun);
      if (!crossRunEntries.some((entry) => entry['key'] === 'task_phase:lint-reminder')) {
        throw new Error('expected persisted cross_run key=task_phase:lint-reminder');
      }

      yield { type: 'tool_use', id: 'tool_r3', name: 'state_get_issue', input: {} };
      const issueReadResult = await callStateTool(stateServer, 'state_get_issue', {});
      this.calledTools.push('state_get_issue');
      yield { type: 'tool_result', toolUseId: 'tool_r3', content: JSON.stringify(issueReadResult) };

      const issuePayload = issueReadResult['issue'];
      if (!isRecord(issuePayload)) throw new Error('state_get_issue did not return an issue payload');
      const statusPayload = issuePayload['status'];
      if (!isRecord(statusPayload) || statusPayload['currentTaskId'] !== 'T2') {
        throw new Error('expected currentTaskId=T2 in reader mode');
      }

      yield { type: 'assistant', content: 'MCP state tools executed successfully (reader).' };
      yield { type: 'result', content: 'ok' };
      return;
    }

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
      id: 'tool_5a',
      name: 'state_upsert_memory',
      input: {
        scope: 'working_set',
        key: 'current-task',
        value: { taskId: 'T2', summary: 'Follow-up task' },
        source_iteration: 1,
      },
    };
    const workingSetMemory = await callStateTool(stateServer, 'state_upsert_memory', {
      scope: 'working_set',
      key: 'current-task',
      value: { taskId: 'T2', summary: 'Follow-up task' },
      source_iteration: 1,
    });
    this.calledTools.push('state_upsert_memory');
    yield { type: 'tool_result', toolUseId: 'tool_5a', content: JSON.stringify(workingSetMemory) };

    yield {
      type: 'tool_use',
      id: 'tool_5b',
      name: 'state_upsert_memory',
      input: {
        scope: 'session',
        key: 'task_phase:focus',
        value: { phase: 'task_phase', focus: 'memory hierarchy verification' },
        source_iteration: 1,
      },
    };
    const sessionMemory = await callStateTool(stateServer, 'state_upsert_memory', {
      scope: 'session',
      key: 'task_phase:focus',
      value: { phase: 'task_phase', focus: 'memory hierarchy verification' },
      source_iteration: 1,
    });
    this.calledTools.push('state_upsert_memory');
    yield { type: 'tool_result', toolUseId: 'tool_5b', content: JSON.stringify(sessionMemory) };

    yield {
      type: 'tool_use',
      id: 'tool_5c',
      name: 'state_upsert_memory',
      input: {
        scope: 'decisions',
        key: 'schema-choice',
        value: { version: 'v1', reason: 'initial decision' },
        source_iteration: 1,
      },
    };
    const decisionMemoryV1 = await callStateTool(stateServer, 'state_upsert_memory', {
      scope: 'decisions',
      key: 'schema-choice',
      value: { version: 'v1', reason: 'initial decision' },
      source_iteration: 1,
    });
    this.calledTools.push('state_upsert_memory');
    yield { type: 'tool_result', toolUseId: 'tool_5c', content: JSON.stringify(decisionMemoryV1) };

    yield {
      type: 'tool_use',
      id: 'tool_5d',
      name: 'state_mark_memory_stale',
      input: { scope: 'decisions', key: 'schema-choice' },
    };
    const staleDecision = await callStateTool(stateServer, 'state_mark_memory_stale', {
      scope: 'decisions',
      key: 'schema-choice',
    });
    this.calledTools.push('state_mark_memory_stale');
    yield { type: 'tool_result', toolUseId: 'tool_5d', content: JSON.stringify(staleDecision) };

    yield {
      type: 'tool_use',
      id: 'tool_5e',
      name: 'state_upsert_memory',
      input: {
        scope: 'decisions',
        key: 'schema-choice',
        value: { version: 'v2', reason: 'replacement decision' },
        source_iteration: 1,
      },
    };
    const decisionMemoryV2 = await callStateTool(stateServer, 'state_upsert_memory', {
      scope: 'decisions',
      key: 'schema-choice',
      value: { version: 'v2', reason: 'replacement decision' },
      source_iteration: 1,
    });
    this.calledTools.push('state_upsert_memory');
    yield { type: 'tool_result', toolUseId: 'tool_5e', content: JSON.stringify(decisionMemoryV2) };

    yield {
      type: 'tool_use',
      id: 'tool_5f',
      name: 'state_upsert_memory',
      input: {
        scope: 'decisions',
        key: 'deprecated-choice',
        value: { version: 'legacy' },
        source_iteration: 1,
      },
    };
    const deprecatedDecision = await callStateTool(stateServer, 'state_upsert_memory', {
      scope: 'decisions',
      key: 'deprecated-choice',
      value: { version: 'legacy' },
      source_iteration: 1,
    });
    this.calledTools.push('state_upsert_memory');
    yield { type: 'tool_result', toolUseId: 'tool_5f', content: JSON.stringify(deprecatedDecision) };

    yield {
      type: 'tool_use',
      id: 'tool_5g',
      name: 'state_mark_memory_stale',
      input: { scope: 'decisions', key: 'deprecated-choice' },
    };
    const staleDeprecated = await callStateTool(stateServer, 'state_mark_memory_stale', {
      scope: 'decisions',
      key: 'deprecated-choice',
    });
    this.calledTools.push('state_mark_memory_stale');
    yield { type: 'tool_result', toolUseId: 'tool_5g', content: JSON.stringify(staleDeprecated) };

    yield {
      type: 'tool_use',
      id: 'tool_5h',
      name: 'state_delete_memory',
      input: { scope: 'decisions', key: 'deprecated-choice' },
    };
    const deleteDeprecated = await callStateTool(stateServer, 'state_delete_memory', {
      scope: 'decisions',
      key: 'deprecated-choice',
    });
    this.calledTools.push('state_delete_memory');
    yield { type: 'tool_result', toolUseId: 'tool_5h', content: JSON.stringify(deleteDeprecated) };

    yield {
      type: 'tool_use',
      id: 'tool_5i',
      name: 'state_upsert_memory',
      input: {
        scope: 'cross_run',
        key: 'task_phase:lint-reminder',
        value: { relevantPhases: ['task_phase'], reminder: 'run lint before test' },
        source_iteration: 1,
      },
    };
    const crossRunMemory = await callStateTool(stateServer, 'state_upsert_memory', {
      scope: 'cross_run',
      key: 'task_phase:lint-reminder',
      value: { relevantPhases: ['task_phase'], reminder: 'run lint before test' },
      source_iteration: 1,
    });
    this.calledTools.push('state_upsert_memory');
    yield { type: 'tool_result', toolUseId: 'tool_5i', content: JSON.stringify(crossRunMemory) };

    yield {
      type: 'tool_use',
      id: 'tool_5j',
      name: 'state_get_memory',
      input: { scope: 'decisions' },
    };
    const visibleDecisions = await callStateTool(stateServer, 'state_get_memory', {
      scope: 'decisions',
    });
    this.calledTools.push('state_get_memory');
    yield { type: 'tool_result', toolUseId: 'tool_5j', content: JSON.stringify(visibleDecisions) };

    const visibleDecisionEntries = getMemoryEntries(visibleDecisions);
    if (!visibleDecisionEntries.some((entry) => entry['key'] === 'schema-choice')) {
      throw new Error('state_get_memory(decisions) missing schema-choice entry');
    }
    if (visibleDecisionEntries.some((entry) => entry['key'] === 'deprecated-choice')) {
      throw new Error('state_get_memory(decisions) should not include deleted stale entry');
    }

    yield {
      type: 'tool_use',
      id: 'tool_5k',
      name: 'state_get_memory',
      input: { scope: 'decisions', include_stale: true },
    };
    const allDecisions = await callStateTool(stateServer, 'state_get_memory', {
      scope: 'decisions',
      include_stale: true,
    });
    this.calledTools.push('state_get_memory');
    yield { type: 'tool_result', toolUseId: 'tool_5k', content: JSON.stringify(allDecisions) };

    const allDecisionEntries = getMemoryEntries(allDecisions);
    if (!allDecisionEntries.some((entry) => entry['key'] === 'schema-choice')) {
      throw new Error('state_get_memory(include_stale=true) missing schema-choice entry');
    }

    yield {
      type: 'tool_use',
      id: 'tool_6',
      name: 'state_append_progress',
      input: { entry: '## [Integration] MCP state test\nPhase writes through tools.\n' },
    };
    const appendProgressResult = await callStateTool(stateServer, 'state_append_progress', {
      entry: '## [Integration] MCP state test\nPhase writes through tools.\n',
    });
    this.calledTools.push('state_append_progress');
    yield { type: 'tool_result', toolUseId: 'tool_6', content: JSON.stringify(appendProgressResult) };

    yield { type: 'tool_use', id: 'tool_7', name: 'state_get_issue', input: {} };
    const issueReadResult = await callStateTool(stateServer, 'state_get_issue', {});
    this.calledTools.push('state_get_issue');
    yield { type: 'tool_result', toolUseId: 'tool_7', content: JSON.stringify(issueReadResult) };

    const issuePayload = issueReadResult['issue'];
    if (!isRecord(issuePayload)) throw new Error('state_get_issue did not return an issue payload');
    const statusPayload = issuePayload['status'];
    if (!isRecord(statusPayload) || statusPayload['currentTaskId'] !== 'T2') {
      throw new Error('state_update_issue_status did not update currentTaskId');
    }

    yield { type: 'assistant', content: 'MCP state tools executed successfully (writer).' };
    yield { type: 'result', content: 'ok' };
  }
}

class PromptCaptureProvider implements AgentProvider {
  readonly name = 'prompt-capture-provider';
  seenPrompt: string | null = null;

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    void options;
    this.seenPrompt = prompt;
    yield { type: 'result', content: 'ok' };
  }
}

const optionalDescribe = process.env.JEEVES_RUN_OPTIONAL_TESTS === 'true' ? describe : describe.skip;

optionalDescribe('runner optional MCP state integration', () => {
  it('runs two phases with MCP state tools and preserves structured memory across iterations', async () => {
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

    const writerProvider = new McpStateExerciseProvider('writer');
    const previousStatePath = process.env.JEEVES_MCP_STATE_PATH;
    process.env.JEEVES_MCP_STATE_PATH = stateEntrypoint;
    try {
      const writerResult = await runSinglePhaseOnce({
        provider: writerProvider,
        workflowName: 'mcp-state-optional',
        phaseName: 'task_phase',
        workflowsDir,
        promptsDir,
        stateDir,
        cwd,
      });

      expect(writerResult).toEqual({ phase: 'task_phase', success: true });
      expect(writerProvider.seenStateServer).not.toBeNull();
      expect(writerProvider.calledTools).toEqual(
        expect.arrayContaining([
          'state_put_issue',
          'state_put_tasks',
          'state_set_task_status',
          'state_update_issue_status',
          'state_upsert_memory',
          'state_mark_memory_stale',
          'state_delete_memory',
          'state_get_memory',
          'state_append_progress',
          'state_get_issue',
        ]),
      );

      const readerProvider = new McpStateExerciseProvider('reader');
      const readerResult = await runSinglePhaseOnce({
        provider: readerProvider,
        workflowName: 'mcp-state-optional',
        phaseName: 'task_phase',
        workflowsDir,
        promptsDir,
        stateDir,
        cwd,
      });
      expect(readerResult).toEqual({ phase: 'task_phase', success: true });
      expect(readerProvider.calledTools).toEqual(
        expect.arrayContaining(['state_get_memory', 'state_get_issue']),
      );
    } finally {
      if (previousStatePath === undefined) {
        delete process.env.JEEVES_MCP_STATE_PATH;
      } else {
        process.env.JEEVES_MCP_STATE_PATH = previousStatePath;
      }
    }

    const progressPath = path.join(stateDir, 'progress.txt');
    const progress = await fs.readFile(progressPath, 'utf-8');
    expect(progress).toContain('MCP state test');

    const logPath = path.join(stateDir, 'last-run.log');
    const log = await fs.readFile(logPath, 'utf-8');
    expect(log).toContain('[RUNNER] memory_context=enabled');
    expect(log).toContain('[TOOL] state_get_memory');

    const dbPath = path.join(tmp, 'jeeves.db');
    const dbStat = await fs.stat(dbPath);
    expect(dbStat.isFile()).toBe(true);
    expect(dbStat.size).toBeGreaterThan(0);

    const stateServer = writerProvider.seenStateServer;
    if (!stateServer) throw new Error('Missing captured state server config');

    const issueFromDb = await callStateTool(stateServer, 'state_get_issue', {});
    const tasksFromDb = await callStateTool(stateServer, 'state_get_tasks', {});
    const memoryFromDb = await callStateTool(stateServer, 'state_get_memory', { include_stale: true });
    const restoredIssue = issueFromDb['issue'];
    const restoredTasks = tasksFromDb['tasks'];
    const restoredMemoryEntries = getMemoryEntries(memoryFromDb);
    expect(isRecord(restoredIssue)).toBe(true);
    expect(isRecord(restoredTasks)).toBe(true);
    expect(((restoredIssue as { status?: { currentTaskId?: string } }).status?.currentTaskId)).toBe('T2');
    expect((((restoredTasks as { tasks?: { status?: string }[] }).tasks ?? [])[0])?.status).toBe('passed');
    expect(restoredMemoryEntries.some((entry) => entry['key'] === 'current-task')).toBe(true);
    expect(restoredMemoryEntries.some((entry) => entry['key'] === 'schema-choice')).toBe(true);
    expect(restoredMemoryEntries.some((entry) => entry['key'] === 'task_phase:focus')).toBe(true);
    expect(restoredMemoryEntries.some((entry) => entry['key'] === 'task_phase:lint-reminder')).toBe(true);
    expect(restoredMemoryEntries.some((entry) => entry['key'] === 'deprecated-choice')).toBe(false);
  }, 90_000);

  it('maintains deterministic memory prompt ordering across repeated fresh iterations', async () => {
    const tmp = await makeTempDir('jeeves-runner-memory-soak-');
    const workflowsDir = path.join(tmp, 'workflows');
    const promptsDir = path.join(tmp, 'prompts');
    const stateDir = path.join(tmp, 'issues', 'acme', 'rocket', '42');
    const cwd = path.join(tmp, 'worktree');
    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    await fs.writeFile(
      path.join(workflowsDir, 'memory-soak.yaml'),
      [
        'workflow:',
        '  name: memory-soak',
        '  version: 1',
        '  start: task_phase',
        'phases:',
        '  task_phase:',
        '    type: execute',
        '    prompt: task.phase.prompt.md',
        '    transitions: []',
      ].join('\n') + '\n',
      'utf-8',
    );
    await fs.writeFile(path.join(promptsDir, 'task.phase.prompt.md'), 'Optional memory soak prompt.\n', 'utf-8');

    for (let iteration = 1; iteration <= 20; iteration += 1) {
      upsertMemoryEntryInDb({
        stateDir,
        scope: 'working_set',
        key: 'current-task',
        value: { taskId: `T${iteration}`, iteration },
        sourceIteration: iteration,
      });
      upsertMemoryEntryInDb({
        stateDir,
        scope: 'decisions',
        key: 'schema-choice',
        value: { version: 'v2', iteration },
        sourceIteration: iteration,
      });
      upsertMemoryEntryInDb({
        stateDir,
        scope: 'session',
        key: 'task_phase:focus',
        value: { phase: 'task_phase', iteration },
        sourceIteration: iteration,
      });
      upsertMemoryEntryInDb({
        stateDir,
        scope: 'cross_run',
        key: 'task_phase:carry-forward',
        value: { relevantPhases: ['task_phase'], iteration },
        sourceIteration: iteration,
      });
      upsertMemoryEntryInDb({
        stateDir,
        scope: 'decisions',
        key: 'stale-marker',
        value: { iteration },
        sourceIteration: iteration,
      });
      markMemoryEntryStaleInDb({
        stateDir,
        scope: 'decisions',
        key: 'stale-marker',
      });

      const provider = new PromptCaptureProvider();
      const result = await runSinglePhaseOnce({
        provider,
        workflowName: 'memory-soak',
        phaseName: 'task_phase',
        workflowsDir,
        promptsDir,
        stateDir,
        cwd,
      });
      expect(result).toEqual({ phase: 'task_phase', success: true });

      const prompt = provider.seenPrompt ?? '';
      expect(prompt).toContain('<memory_context>');
      expect(prompt).toContain('key=current-task');
      expect(prompt).toContain('key=schema-choice');
      expect(prompt).toContain('key=task_phase:focus');
      expect(prompt).toContain('key=task_phase:carry-forward');
      expect(prompt).not.toContain('key=stale-marker');

      const workingIdx = prompt.indexOf('### Working Set (active)');
      const decisionsIdx = prompt.indexOf('### Decisions (active)');
      const sessionIdx = prompt.indexOf('### Session Context (phase=task_phase)');
      const crossRunIdx = prompt.indexOf('### Cross-Run Memory (relevant)');
      expect(workingIdx).toBeGreaterThanOrEqual(0);
      expect(decisionsIdx).toBeGreaterThan(workingIdx);
      expect(sessionIdx).toBeGreaterThan(decisionsIdx);
      expect(crossRunIdx).toBeGreaterThan(sessionIdx);
    }
  }, 60_000);
});
