import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { upsertMemoryEntriesInDb, upsertMemoryEntryInDb } from '@jeeves/state-db';
import { describe, expect, it } from 'vitest';

import { main } from './cli.js';
import type { AgentProvider, ProviderEvent, ProviderRunOptions } from './provider.js';
import { FakeProvider } from './providers/fake.js';
import { runSinglePhaseOnce, runWorkflowOnce } from './runner.js';

function getRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../..');
}

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

describe('runner integration', () => {
  it('runWorkflowOnce runs fixture workflow and writes artifacts', async () => {
    const repoRoot = getRepoRoot();
    const workflowsDir = path.join(repoRoot, 'workflows');
    const promptsDir = path.join(repoRoot, 'prompts');

    const tmp = await makeTempDir('jeeves-runner-');
    const stateDir = path.join(tmp, 'state');
    const cwd = path.join(tmp, 'work');
    await fs.mkdir(cwd, { recursive: true });

    const result = await runWorkflowOnce({
      provider: new FakeProvider(),
      workflowName: 'fixture-trivial',
      workflowsDir,
      promptsDir,
      stateDir,
      cwd,
    });

    expect(result.success).toBe(true);

    const outputPath = path.join(stateDir, 'sdk-output.json');
    const logPath = path.join(stateDir, 'last-run.log');
    const progressPath = path.join(stateDir, 'progress.txt');

    const output = JSON.parse(await fs.readFile(outputPath, 'utf-8')) as Record<string, unknown>;
    expect(output.schema).toBe('jeeves.sdk.v1');
    expect(typeof output.started_at).toBe('string');
    expect(typeof output.ended_at).toBe('string');
    expect(output.success).toBe(true);
    expect(Array.isArray(output.messages)).toBe(true);
    expect(Array.isArray(output.tool_calls)).toBe(true);
    expect(output.stats && typeof output.stats === 'object').toBe(true);

    const log = await fs.readFile(logPath, 'utf-8');
    expect(log).toContain('[RUNNER]');
    expect(log).toContain('[ASSISTANT]');

    const progress = await fs.readFile(progressPath, 'utf-8');
    expect(progress).toContain('Started:');
    expect(progress).toContain('Phase: hello');
    expect(progress).toContain('Ended:');
  });

  it('CLI run-fixture runs without credentials (fake provider)', async () => {
    const repoRoot = getRepoRoot();
    const workflowsDir = path.join(repoRoot, 'workflows');
    const promptsDir = path.join(repoRoot, 'prompts');

    const tmp = await makeTempDir('jeeves-runner-cli-');
    const stateDir = path.join(tmp, 'state');
    const cwd = path.join(tmp, 'work');
    await fs.mkdir(cwd, { recursive: true });

    await main([
      'run-fixture',
      '--provider',
      'fake',
      '--workflow',
      'fixture-trivial',
      '--workflows-dir',
      workflowsDir,
      '--prompts-dir',
      promptsDir,
      '--state-dir',
      stateDir,
      '--work-dir',
      cwd,
    ]);

    const outputPath = path.join(stateDir, 'sdk-output.json');
    const logPath = path.join(stateDir, 'last-run.log');
    await expect(fs.stat(outputPath)).resolves.toBeTruthy();
    await expect(fs.stat(logPath)).resolves.toBeTruthy();
  });

  it('CLI run-phase runs a single phase and writes artifacts', async () => {
    const repoRoot = getRepoRoot();
    const workflowsDir = path.join(repoRoot, 'workflows');
    const promptsDir = path.join(repoRoot, 'prompts');

    const tmp = await makeTempDir('jeeves-runner-cli-phase-');
    const stateDir = path.join(tmp, 'state');
    const cwd = path.join(tmp, 'work');
    await fs.mkdir(cwd, { recursive: true });

    await main([
      'run-phase',
      '--provider',
      'fake',
      '--workflow',
      'fixture-trivial',
      '--phase',
      'hello',
      '--workflows-dir',
      workflowsDir,
      '--prompts-dir',
      promptsDir,
      '--state-dir',
      stateDir,
      '--work-dir',
      cwd,
    ]);

    const outputPath = path.join(stateDir, 'sdk-output.json');
    const logPath = path.join(stateDir, 'last-run.log');
    const progressPath = path.join(stateDir, 'progress.txt');

    const output = JSON.parse(await fs.readFile(outputPath, 'utf-8')) as Record<string, unknown>;
    expect(output.schema).toBe('jeeves.sdk.v1');
    expect(output.success).toBe(true);

    const log = await fs.readFile(logPath, 'utf-8');
    expect(log).toContain('[RUNNER]');
    expect(log).toContain('phase=hello');

    const progress = await fs.readFile(progressPath, 'utf-8');
    expect(progress).toContain('Phase: hello');
  });

  it('prepends AGENTS.md and CLAUDE.md to phase prompts when present in cwd', async () => {
    const tmp = await makeTempDir('jeeves-runner-prompt-prepend-');
    const workflowsDir = path.join(tmp, 'workflows');
    const promptsDir = path.join(tmp, 'prompts');
    const stateDir = path.join(tmp, 'state');
    const cwd = path.join(tmp, 'work');

    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'AGENTS SENTINEL\nUse the pruner MCP server.', 'utf-8');
    await fs.writeFile(path.join(cwd, 'CLAUDE.md'), 'CLAUDE SENTINEL\nPurpose: focused tool usage.', 'utf-8');

    await fs.writeFile(
      path.join(workflowsDir, 'prepend-fixture.yaml'),
      [
        'workflow:',
        '  name: prepend-fixture',
        '  version: 1',
        '  start: only_phase',
        'phases:',
        '  only_phase:',
        '    type: execute',
        '    prompt: only.prompt.md',
        '    transitions: []',
      ].join('\n') + '\n',
      'utf-8',
    );
    await fs.writeFile(path.join(promptsDir, 'only.prompt.md'), 'PHASE PROMPT SENTINEL', 'utf-8');

    const provider = new PromptCaptureProvider();
    const result = await runSinglePhaseOnce({
      provider,
      workflowName: 'prepend-fixture',
      phaseName: 'only_phase',
      workflowsDir,
      promptsDir,
      stateDir,
      cwd,
    });

    expect(result).toEqual({ phase: 'only_phase', success: true });
    const prompt = provider.seenPrompt ?? '';
    expect(prompt).toContain('AGENTS SENTINEL');
    expect(prompt).toContain('CLAUDE SENTINEL');
    expect(prompt).toContain('PHASE PROMPT SENTINEL');
    expect(prompt.indexOf('AGENTS SENTINEL')).toBeLessThan(prompt.indexOf('CLAUDE SENTINEL'));
    expect(prompt.indexOf('CLAUDE SENTINEL')).toBeLessThan(prompt.indexOf('PHASE PROMPT SENTINEL'));
  });

  it('skips memory preload when state DB is unavailable', async () => {
    const tmp = await makeTempDir('jeeves-runner-memory-skip-');
    const workflowsDir = path.join(tmp, 'workflows');
    const promptsDir = path.join(tmp, 'prompts');
    const stateDir = path.join(tmp, '.jeeves');
    const cwd = path.join(tmp, 'work');

    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    await fs.writeFile(
      path.join(workflowsDir, 'memory-skip-fixture.yaml'),
      [
        'workflow:',
        '  name: memory-skip-fixture',
        '  version: 1',
        '  start: phase_one',
        'phases:',
        '  phase_one:',
        '    type: execute',
        '    prompt: phase.prompt.md',
        '    transitions: []',
      ].join('\n') + '\n',
      'utf-8',
    );
    await fs.writeFile(path.join(promptsDir, 'phase.prompt.md'), 'MEMORY SKIP SENTINEL', 'utf-8');

    const provider = new PromptCaptureProvider();
    const result = await runSinglePhaseOnce({
      provider,
      workflowName: 'memory-skip-fixture',
      phaseName: 'phase_one',
      workflowsDir,
      promptsDir,
      stateDir,
      cwd,
    });

    expect(result).toEqual({ phase: 'phase_one', success: true });
    const prompt = provider.seenPrompt ?? '';
    expect(prompt).toContain('MEMORY SKIP SENTINEL');
    expect(prompt).not.toContain('<memory_context>');

    const log = await fs.readFile(path.join(stateDir, 'last-run.log'), 'utf-8');
    expect(log).toContain('[RUNNER] memory_context=disabled');
    expect(log).toContain('state_db_unavailable');
  });

  it('injects scoped memory into phase prompts with deterministic ordering and relevance filtering', async () => {
    const tmp = await makeTempDir('jeeves-runner-memory-prompt-');
    const workflowsDir = path.join(tmp, 'workflows');
    const promptsDir = path.join(tmp, 'prompts');
    const stateDir = path.join(tmp, 'state');
    const cwd = path.join(tmp, 'work');

    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    await fs.writeFile(
      path.join(workflowsDir, 'memory-fixture.yaml'),
      [
        'workflow:',
        '  name: memory-fixture',
        '  version: 1',
        '  start: implement_task',
        'phases:',
        '  implement_task:',
        '    type: execute',
        '    prompt: memory.prompt.md',
        '    transitions: []',
      ].join('\n') + '\n',
      'utf-8',
    );
    await fs.writeFile(path.join(promptsDir, 'memory.prompt.md'), 'MEMORY PROMPT SENTINEL', 'utf-8');

    upsertMemoryEntryInDb({
      stateDir,
      scope: 'working_set',
      key: 'current-task',
      value: { taskId: 'T42' },
      sourceIteration: 2,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'decisions',
      key: 'db-choice',
      value: { choice: 'sqlite' },
      sourceIteration: 3,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'decisions',
      key: 'obsolete-choice',
      value: { choice: 'xml' },
      sourceIteration: 1,
      stale: true,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'session',
      key: 'implement_task:focus',
      value: { phase: 'implement_task', focus: 'wire memory tools' },
      sourceIteration: 3,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'session',
      key: 'design_plan:focus',
      value: { phase: 'design_plan', focus: 'skip in implement phase' },
      sourceIteration: 2,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'session',
      key: 'implement_task:legacy-note',
      value: { focus: 'legacy phase tag in key only' },
      sourceIteration: 4,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'session',
      key: 'design_plan:legacy-note',
      value: { focus: 'skip legacy key from other phase' },
      sourceIteration: 4,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'session',
      key: 'untagged-note',
      value: { focus: 'legacy session note without phase hints' },
      sourceIteration: 4,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'cross_run',
      key: 'implement_task:carry-forward',
      value: { relevantPhases: ['implement_task'], reminder: 'keep prompt deterministic' },
      sourceIteration: 1,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'cross_run',
      key: 'design_review:carry-forward',
      value: { relevantPhases: ['design_review'], reminder: 'not relevant now' },
      sourceIteration: 1,
    });

    const provider = new PromptCaptureProvider();
    const result = await runSinglePhaseOnce({
      provider,
      workflowName: 'memory-fixture',
      phaseName: 'implement_task',
      workflowsDir,
      promptsDir,
      stateDir,
      cwd,
    });

    expect(result).toEqual({ phase: 'implement_task', success: true });
    const prompt = provider.seenPrompt ?? '';
    expect(prompt).toContain('<memory_context>');
    expect(prompt).toContain('### Working Set (active)');
    expect(prompt).toContain('### Decisions (active)');
    expect(prompt).toContain('### Session Context (phase=implement_task)');
    expect(prompt).toContain('### Cross-Run Memory (relevant)');
    expect(prompt.indexOf('### Working Set (active)')).toBeLessThan(prompt.indexOf('### Decisions (active)'));
    expect(prompt.indexOf('### Decisions (active)')).toBeLessThan(
      prompt.indexOf('### Session Context (phase=implement_task)'),
    );
    expect(prompt.indexOf('### Session Context (phase=implement_task)')).toBeLessThan(
      prompt.indexOf('### Cross-Run Memory (relevant)'),
    );

    expect(prompt).toContain('key=current-task');
    expect(prompt).toContain('key=db-choice');
    expect(prompt).toContain('key=implement_task:focus');
    expect(prompt).toContain('key=implement_task:legacy-note');
    expect(prompt).toContain('key=implement_task:carry-forward');
    expect(prompt).not.toContain('key=obsolete-choice');
    expect(prompt).not.toContain('key=design_plan:focus');
    expect(prompt).not.toContain('key=design_plan:legacy-note');
    expect(prompt).not.toContain('key=untagged-note');
    expect(prompt).not.toContain('key=design_review:carry-forward');
    expect(prompt).toContain('MEMORY PROMPT SENTINEL');
  });

  it('loads canonical issue memory when running from a worker sandbox state dir', async () => {
    const tmp = await makeTempDir('jeeves-runner-memory-worker-');
    const workflowsDir = path.join(tmp, 'workflows');
    const promptsDir = path.join(tmp, 'prompts');
    const canonicalStateDir = path.join(tmp, 'issues', 'acme', 'rocket', '42');
    const workerStateDir = path.join(canonicalStateDir, '.runs', 'run-123', 'workers', 'T1');
    const cwd = path.join(tmp, 'work');

    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.mkdir(canonicalStateDir, { recursive: true });
    await fs.mkdir(workerStateDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    await fs.writeFile(
      path.join(workflowsDir, 'memory-worker-fixture.yaml'),
      [
        'workflow:',
        '  name: memory-worker-fixture',
        '  version: 1',
        '  start: implement_task',
        'phases:',
        '  implement_task:',
        '    type: execute',
        '    prompt: memory.prompt.md',
        '    transitions: []',
      ].join('\n') + '\n',
      'utf-8',
    );
    await fs.writeFile(path.join(promptsDir, 'memory.prompt.md'), 'WORKER MEMORY PROMPT SENTINEL', 'utf-8');

    upsertMemoryEntryInDb({
      stateDir: canonicalStateDir,
      scope: 'working_set',
      key: 'current-task',
      value: { taskId: 'T42' },
      sourceIteration: 1,
    });
    upsertMemoryEntryInDb({
      stateDir: canonicalStateDir,
      scope: 'session',
      key: 'implement_task:focus',
      value: { phase: 'implement_task', focus: 'canonical memory is visible' },
      sourceIteration: 1,
    });
    upsertMemoryEntryInDb({
      stateDir: canonicalStateDir,
      scope: 'cross_run',
      key: 'implement_task:carry-forward',
      value: { relevantPhases: ['implement_task'], reminder: 'canonical cross-run memory is visible' },
      sourceIteration: 1,
    });

    const provider = new PromptCaptureProvider();
    const result = await runSinglePhaseOnce({
      provider,
      workflowName: 'memory-worker-fixture',
      phaseName: 'implement_task',
      workflowsDir,
      promptsDir,
      stateDir: workerStateDir,
      cwd,
    });

    expect(result).toEqual({ phase: 'implement_task', success: true });
    const prompt = provider.seenPrompt ?? '';
    expect(prompt).toContain('<memory_context>');
    expect(prompt).toContain('key=current-task');
    expect(prompt).toContain('key=implement_task:focus');
    expect(prompt).toContain('key=implement_task:carry-forward');
    expect(prompt).toContain('WORKER MEMORY PROMPT SENTINEL');
  });

  it('applies memory cap after relevance filtering so relevant context is retained', async () => {
    const tmp = await makeTempDir('jeeves-runner-memory-limit-');
    const workflowsDir = path.join(tmp, 'workflows');
    const promptsDir = path.join(tmp, 'prompts');
    const stateDir = path.join(tmp, 'state');
    const cwd = path.join(tmp, 'work');

    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    await fs.writeFile(
      path.join(workflowsDir, 'memory-limit-fixture.yaml'),
      [
        'workflow:',
        '  name: memory-limit-fixture',
        '  version: 1',
        '  start: implement_task',
        'phases:',
        '  implement_task:',
        '    type: execute',
        '    prompt: memory.prompt.md',
        '    transitions: []',
      ].join('\n') + '\n',
      'utf-8',
    );
    await fs.writeFile(path.join(promptsDir, 'memory.prompt.md'), 'MEMORY LIMIT PROMPT SENTINEL', 'utf-8');

    upsertMemoryEntryInDb({
      stateDir,
      scope: 'session',
      key: 'implement_task:focus',
      value: { phase: 'implement_task', focus: 'must survive relevance filtering' },
      sourceIteration: 2,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'cross_run',
      key: 'implement_task:carry-forward',
      value: { relevantPhases: ['implement_task'], reminder: 'must survive relevance filtering' },
      sourceIteration: 2,
    });
    upsertMemoryEntriesInDb({
      stateDir,
      entries: Array.from({ length: 510 }, (_, i) => ({
        scope: 'session' as const,
        key: `design_plan:noise-${String(i).padStart(3, '0')}`,
        value: { phase: 'design_plan', i },
        sourceIteration: 1,
      })),
    });

    const provider = new PromptCaptureProvider();
    const result = await runSinglePhaseOnce({
      provider,
      workflowName: 'memory-limit-fixture',
      phaseName: 'implement_task',
      workflowsDir,
      promptsDir,
      stateDir,
      cwd,
    });

    expect(result).toEqual({ phase: 'implement_task', success: true });
    const prompt = provider.seenPrompt ?? '';
    expect(prompt).toContain('<memory_context>');
    expect(prompt).toContain('key=implement_task:focus');
    expect(prompt).toContain('key=implement_task:carry-forward');
    expect(prompt).not.toContain('key=design_plan:noise-000');
    expect(prompt).toContain('MEMORY LIMIT PROMPT SENTINEL');
  }, 60_000);

  it('fails fast when required MCP servers are missing for strict enforcement', async () => {
    const tmp = await makeTempDir('jeeves-runner-mcp-strict-');
    const workflowsDir = path.join(tmp, 'workflows');
    const promptsDir = path.join(tmp, 'prompts');
    const stateDir = path.join(tmp, 'state');
    const cwd = path.join(tmp, 'work');

    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    await fs.writeFile(
      path.join(workflowsDir, 'mcp-strict-fixture.yaml'),
      [
        'workflow:',
        '  name: mcp-strict-fixture',
        '  version: 1',
        '  start: phase_one',
        'phases:',
        '  phase_one:',
        '    type: execute',
        '    mcp_profile: state_with_pruner',
        '    prompt: phase.prompt.md',
        '    transitions: []',
      ].join('\n') + '\n',
      'utf-8',
    );
    await fs.writeFile(path.join(promptsDir, 'phase.prompt.md'), 'strict mcp prompt', 'utf-8');

    const result = await runSinglePhaseOnce({
      provider: new FakeProvider(),
      workflowName: 'mcp-strict-fixture',
      phaseName: 'phase_one',
      workflowsDir,
      promptsDir,
      stateDir,
      cwd,
    });

    expect(result).toEqual({ phase: 'phase_one', success: false });

    const log = await fs.readFile(path.join(stateDir, 'last-run.log'), 'utf-8');
    expect(log).toContain('[MCP] FAIL_FAST');
    expect(log).toContain('Missing required MCP servers');
  });

  it('allows explicit degraded mode when mcp_enforcement=allow_degraded', async () => {
    const tmp = await makeTempDir('jeeves-runner-mcp-degraded-');
    const workflowsDir = path.join(tmp, 'workflows');
    const promptsDir = path.join(tmp, 'prompts');
    const stateDir = path.join(tmp, 'state');
    const cwd = path.join(tmp, 'work');

    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    await fs.writeFile(
      path.join(workflowsDir, 'mcp-degraded-fixture.yaml'),
      [
        'workflow:',
        '  name: mcp-degraded-fixture',
        '  version: 1',
        '  start: phase_one',
        'phases:',
        '  phase_one:',
        '    type: execute',
        '    mcp_profile: state_with_pruner',
        '    mcp_enforcement: allow_degraded',
        '    prompt: phase.prompt.md',
        '    transitions: []',
      ].join('\n') + '\n',
      'utf-8',
    );
    await fs.writeFile(path.join(promptsDir, 'phase.prompt.md'), 'degraded mcp prompt', 'utf-8');

    const result = await runSinglePhaseOnce({
      provider: new FakeProvider(),
      workflowName: 'mcp-degraded-fixture',
      phaseName: 'phase_one',
      workflowsDir,
      promptsDir,
      stateDir,
      cwd,
      mcpServers: {
        state: {
          command: 'node',
          args: ['/tmp/fake-mcp-state.js'],
        },
      },
    });

    expect(result).toEqual({ phase: 'phase_one', success: true });
    const log = await fs.readFile(path.join(stateDir, 'last-run.log'), 'utf-8');
    expect(log).toContain('[MCP] DEGRADED_MODE');
  });
});
