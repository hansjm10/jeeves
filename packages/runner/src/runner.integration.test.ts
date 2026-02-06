import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
});
