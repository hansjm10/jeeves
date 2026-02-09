#!/usr/bin/env node
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  appendProgress,
  getProgress,
  deleteMemory,
  getIssue,
  getMemory,
  getTasks,
  putIssue,
  upsertMemory,
  putTasks,
  markMemoryStale,
  setTaskStatus,
  updateIssueControlFields,
  updateIssueStatusFields,
} from './stateStore.js';

type JsonRecord = Record<string, unknown>;

function jsonTextResult(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function resolveStateDir(env: NodeJS.ProcessEnv): string {
  const raw = env['MCP_STATE_DIR'];
  if (!raw || !raw.trim()) {
    throw new Error('MCP_STATE_DIR is required');
  }
  return path.resolve(raw.trim());
}

const server = new McpServer({
  name: 'mcp-state',
  version: '1.0.0',
});

const emptySchema = {};
const issueSchema = {
  issue: z.record(z.string(), z.unknown()).describe('Full issue state JSON object'),
};
const tasksSchema = {
  tasks: z.record(z.string(), z.unknown()).describe('Full tasks JSON object'),
};
const taskStatusSchema = {
  task_id: z.string().min(1).describe('Task ID to update'),
  status: z.string().min(1).describe('New task status string'),
};
const fieldPatchSchema = {
  fields: z.record(z.string(), z.unknown()).describe('Fields to merge into status/control'),
};
const progressSchema = {
  entry: z.string().describe('Raw text to append to the canonical progress event log'),
};
const getProgressSchema = {
  max_events: z.number().int().positive().max(20000).optional().describe('Optional max number of progress events to render'),
};
const memoryScopeSchema = z
  .enum(['session', 'working_set', 'decisions', 'cross_run'])
  .describe('Memory scope');
const getMemorySchema = {
  scope: memoryScopeSchema.optional(),
  key: z.string().min(1).optional().describe('Optional exact key filter'),
  include_stale: z.boolean().optional().describe('Include stale entries when true'),
  limit: z.number().int().positive().max(2000).optional().describe('Maximum entries to return'),
};
const upsertMemorySchema = {
  scope: memoryScopeSchema,
  key: z.string().min(1).describe('Stable memory key'),
  value: z.record(z.string(), z.unknown()).describe('Structured JSON value payload'),
  source_iteration: z.number().int().nonnegative().optional().describe('Optional source iteration'),
  stale: z.boolean().optional().describe('Optional stale flag (defaults to false)'),
};
const markMemoryStaleSchema = {
  scope: memoryScopeSchema,
  key: z.string().min(1).describe('Stable memory key'),
  stale: z.boolean().optional().describe('Set false to reactivate entry'),
};
const deleteMemorySchema = {
  scope: memoryScopeSchema,
  key: z.string().min(1).describe('Stable memory key'),
};

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function main(): Promise<void> {
  const stateDir = resolveStateDir(process.env);

  server.tool(
    'state_get_issue',
    'Load current issue state JSON from normalized storage.',
    emptySchema,
    async () => {
      try {
        const issue = await getIssue(stateDir);
        return jsonTextResult({ ok: true, state_dir: stateDir, issue });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  server.tool(
    'state_put_issue',
    'Replace current issue state JSON and sync normalized DB columns.',
    issueSchema,
    async (args) => {
      try {
        if (!isJsonRecord(args.issue)) {
          return jsonTextResult({ ok: false, error: 'issue must be an object' });
        }
        await putIssue(stateDir, args.issue);
        return jsonTextResult({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  server.tool(
    'state_get_tasks',
    'Load current tasks JSON from normalized storage.',
    emptySchema,
    async () => {
      try {
        const tasks = await getTasks(stateDir);
        return jsonTextResult({ ok: true, state_dir: stateDir, tasks });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  server.tool(
    'state_put_tasks',
    'Replace full tasks JSON and sync normalized task tables.',
    tasksSchema,
    async (args) => {
      try {
        if (!isJsonRecord(args.tasks)) {
          return jsonTextResult({ ok: false, error: 'tasks must be an object' });
        }
        await putTasks(stateDir, args.tasks);
        return jsonTextResult({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  server.tool(
    'state_set_task_status',
    'Set status for one task by task_id.',
    taskStatusSchema,
    async (args) => {
      try {
        const updated = await setTaskStatus(stateDir, args.task_id, args.status);
        return jsonTextResult({ ok: true, updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  server.tool(
    'state_update_issue_status',
    'Merge fields into issue.status and persist.',
    fieldPatchSchema,
    async (args) => {
      try {
        if (!isJsonRecord(args.fields)) {
          return jsonTextResult({ ok: false, error: 'fields must be an object' });
        }
        const updated = await updateIssueStatusFields(stateDir, args.fields);
        return jsonTextResult({ ok: true, updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  server.tool(
    'state_update_issue_control',
    'Merge fields into issue.control and persist.',
    fieldPatchSchema,
    async (args) => {
      try {
        if (!isJsonRecord(args.fields)) {
          return jsonTextResult({ ok: false, error: 'fields must be an object' });
        }
        const updated = await updateIssueControlFields(stateDir, args.fields);
        return jsonTextResult({ ok: true, updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  server.tool(
    'state_append_progress',
    'Append a plain-text entry to the canonical progress event log.',
    progressSchema,
    async (args) => {
      try {
        await appendProgress(stateDir, args.entry);
        return jsonTextResult({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  server.tool(
    'state_get_progress',
    'Render the canonical progress event log as plain text.',
    getProgressSchema,
    async (args) => {
      try {
        const text = await getProgress(stateDir, args.max_events);
        return jsonTextResult({ ok: true, state_dir: stateDir, progress: text });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  server.tool(
    'state_get_memory',
    'List structured memory entries by scope/key.',
    getMemorySchema,
    async (args) => {
      try {
        const entries = await getMemory(stateDir, {
          scope: args.scope,
          key: args.key,
          includeStale: args.include_stale,
          limit: args.limit,
        });
        return jsonTextResult({ ok: true, state_dir: stateDir, count: entries.length, entries });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  server.tool(
    'state_upsert_memory',
    'Insert or update one structured memory entry.',
    upsertMemorySchema,
    async (args) => {
      try {
        if (!isJsonRecord(args.value)) {
          return jsonTextResult({ ok: false, error: 'value must be an object' });
        }
        const entry = await upsertMemory(stateDir, {
          scope: args.scope,
          key: args.key,
          value: args.value,
          sourceIteration: args.source_iteration,
          stale: args.stale,
        });
        return jsonTextResult({ ok: true, entry });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  server.tool(
    'state_mark_memory_stale',
    'Mark a memory entry stale (or reactivate it with stale=false).',
    markMemoryStaleSchema,
    async (args) => {
      try {
        const stale = args.stale ?? true;
        const updated = await markMemoryStale(stateDir, args.scope, args.key, stale);
        return jsonTextResult({ ok: true, updated, stale });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  server.tool(
    'state_delete_memory',
    'Delete one structured memory entry by scope/key.',
    deleteMemorySchema,
    async (args) => {
      try {
        const deleted = await deleteMemory(stateDir, args.scope, args.key);
        return jsonTextResult({ ok: true, deleted });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonTextResult({ ok: false, error: message });
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
