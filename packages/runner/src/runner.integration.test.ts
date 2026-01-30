import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { main } from './cli.js';
import { FakeProvider } from './providers/fake.js';
import { runWorkflowOnce } from './runner.js';

function getRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../..');
}

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
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
});
