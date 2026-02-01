import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { getIssueStateDir, getWorktreePath } from '@jeeves/core';

import { RunManager } from './runManager.js';
import { readIssueJson } from './issueJson.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeWorkflowYaml(workflowsDir: string, name: string, yaml: string): Promise<void> {
  await fs.mkdir(workflowsDir, { recursive: true });
  await fs.writeFile(path.join(workflowsDir, `${name}.yaml`), yaml, 'utf-8');
}

function makeFakeChild(exitCode = 0, delayMs = 25) {
  class FakeChild extends EventEmitter {
    pid = 12345;
    exitCode: number | null = null;
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    kill(_signal?: NodeJS.Signals | number): boolean {
      void _signal;
      return true;
    }
  }

  const proc = new FakeChild() as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
  setTimeout(() => {
    (proc as unknown as FakeChild).exitCode = exitCode;
    proc.emit('exit', exitCode, null);
  }, delayMs);
  return proc;
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('RunManager', () => {
  it('runs a single iteration and advances phase via workflow transitions', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = path.join(process.cwd(), 'workflows');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 1;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: 'fixture-trivial', branch: 'issue/1', notes: '' }, null, 2) + '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    const spawn = (() => makeFakeChild(0)) as unknown as typeof import('node:child_process').spawn;
    const broadcastEvents: string[] = [];
    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn,
      broadcast: (event) => broadcastEvents.push(event),
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });

    await waitFor(() => rm.getStatus().running === false);
    expect(rm.getStatus().completed_via_state).toBe(true);

    const updated = await readIssueJson(stateDir);
    expect(updated?.phase).toBe('complete');
    expect(broadcastEvents.includes('run')).toBe(true);
  });

  it('propagates dataDir to runner via JEEVES_DATA_DIR', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = path.join(process.cwd(), 'workflows');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 2;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: 'fixture-trivial', branch: 'issue/2', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    let observedEnv: NodeJS.ProcessEnv | undefined;
    const spawn = ((cmd: unknown, args: unknown, options: unknown) => {
      void cmd;
      void args;
      const o = options as { env?: NodeJS.ProcessEnv } | undefined;
      observedEnv = o?.env;
      return makeFakeChild(0);
    }) as unknown as typeof import('node:child_process').spawn;

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(observedEnv?.JEEVES_DATA_DIR).toBe(dataDir);
  });

  it('does not spawn runner when issue phase is terminal', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');

    const workflowsDir = path.join(process.cwd(), 'workflows');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 3;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'complete', workflow: 'fixture-trivial', branch: 'issue/3', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    let spawnCalls = 0;
    const spawn = (() => {
      spawnCalls += 1;
      return makeFakeChild(0);
    }) as unknown as typeof import('node:child_process').spawn;

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'fake', max_iterations: 5, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(spawnCalls).toBe(0);
    expect(rm.getStatus().completed_via_state).toBe(true);
    expect(rm.getStatus().completion_reason).toContain('already in terminal phase: complete');
    const updated = await readIssueJson(stateDir);
    expect(updated?.phase).toBe('complete');
  });

  it('uses phase.provider over workflow.defaultProvider over run-start provider', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = await makeTempDir('jeeves-vs-workflows-');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const workflowName = 'fixture-provider';
    await writeWorkflowYaml(
      workflowsDir,
      workflowName,
      [
        'workflow:',
        `  name: ${workflowName}`,
        '  version: 2',
        '  start: hello',
        '  default_provider: fake',
        '',
        'phases:',
        '  hello:',
        '    type: execute',
        '    provider: codex',
        '    prompt: fixtures/trivial.md',
        '    transitions:',
        '      - to: complete',
        '        auto: true',
        '',
        '  complete:',
        '    type: terminal',
        '',
      ].join('\n'),
    );

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 4;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: workflowName, branch: 'issue/4', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    let observedProvider: string | undefined;
    const spawn = ((cmd: unknown, args: unknown) => {
      void cmd;
      const a = Array.isArray(args) ? (args as string[]) : [];
      const idx = a.indexOf('--provider');
      observedProvider = idx >= 0 ? a[idx + 1] : undefined;
      return makeFakeChild(0);
    }) as unknown as typeof import('node:child_process').spawn;

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'claude', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(observedProvider).toBe('codex');
  });

  it('uses workflow.defaultProvider when phase.provider is unset', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = await makeTempDir('jeeves-vs-workflows-');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const workflowName = 'fixture-provider';
    await writeWorkflowYaml(
      workflowsDir,
      workflowName,
      [
        'workflow:',
        `  name: ${workflowName}`,
        '  version: 2',
        '  start: hello',
        '  default_provider: codex',
        '',
        'phases:',
        '  hello:',
        '    type: execute',
        '    prompt: fixtures/trivial.md',
        '    transitions:',
        '      - to: complete',
        '        auto: true',
        '',
        '  complete:',
        '    type: terminal',
        '',
      ].join('\n'),
    );

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 5;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: workflowName, branch: 'issue/5', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    let observedProvider: string | undefined;
    const spawn = ((cmd: unknown, args: unknown) => {
      void cmd;
      const a = Array.isArray(args) ? (args as string[]) : [];
      const idx = a.indexOf('--provider');
      observedProvider = idx >= 0 ? a[idx + 1] : undefined;
      return makeFakeChild(0);
    }) as unknown as typeof import('node:child_process').spawn;

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(observedProvider).toBe('codex');
  });

  it('falls back to the run-start provider when phase and workflow providers are unset', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = await makeTempDir('jeeves-vs-workflows-');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const workflowName = 'fixture-provider';
    await writeWorkflowYaml(
      workflowsDir,
      workflowName,
      [
        'workflow:',
        `  name: ${workflowName}`,
        '  version: 2',
        '  start: hello',
        '',
        'phases:',
        '  hello:',
        '    type: execute',
        '    prompt: fixtures/trivial.md',
        '    transitions:',
        '      - to: complete',
        '        auto: true',
        '',
        '  complete:',
        '    type: terminal',
        '',
      ].join('\n'),
    );

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 6;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: workflowName, branch: 'issue/6', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    let observedProvider: string | undefined;
    const spawn = ((cmd: unknown, args: unknown) => {
      void cmd;
      const a = Array.isArray(args) ? (args as string[]) : [];
      const idx = a.indexOf('--provider');
      observedProvider = idx >= 0 ? a[idx + 1] : undefined;
      return makeFakeChild(0);
    }) as unknown as typeof import('node:child_process').spawn;

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(observedProvider).toBe('fake');
  });

  it('uses phase.model over workflow.defaultModel via JEEVES_MODEL env', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = await makeTempDir('jeeves-vs-workflows-');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const workflowName = 'fixture-model';
    await writeWorkflowYaml(
      workflowsDir,
      workflowName,
      [
        'workflow:',
        `  name: ${workflowName}`,
        '  version: 2',
        '  start: hello',
        '  default_model: haiku',
        '',
        'phases:',
        '  hello:',
        '    type: execute',
        '    model: opus',
        '    prompt: fixtures/trivial.md',
        '    transitions:',
        '      - to: complete',
        '        auto: true',
        '',
        '  complete:',
        '    type: terminal',
        '',
      ].join('\n'),
    );

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 7;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: workflowName, branch: 'issue/7', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    let observedModel: string | undefined;
    const spawn = ((cmd: unknown, args: unknown, options: unknown) => {
      void cmd;
      void args;
      const o = options as { env?: Record<string, string> } | undefined;
      observedModel = o?.env?.JEEVES_MODEL;
      return makeFakeChild(0);
    }) as unknown as typeof import('node:child_process').spawn;

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // phase.model = 'opus' takes precedence over workflow.default_model = 'haiku'
    expect(observedModel).toBe('opus');
  });

  it('uses workflow.defaultModel when phase.model is unset', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = await makeTempDir('jeeves-vs-workflows-');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const workflowName = 'fixture-model';
    await writeWorkflowYaml(
      workflowsDir,
      workflowName,
      [
        'workflow:',
        `  name: ${workflowName}`,
        '  version: 2',
        '  start: hello',
        '  default_model: sonnet',
        '',
        'phases:',
        '  hello:',
        '    type: execute',
        '    prompt: fixtures/trivial.md',
        '    transitions:',
        '      - to: complete',
        '        auto: true',
        '',
        '  complete:',
        '    type: terminal',
        '',
      ].join('\n'),
    );

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 8;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: workflowName, branch: 'issue/8', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    let observedModel: string | undefined;
    const spawn = ((cmd: unknown, args: unknown, options: unknown) => {
      void cmd;
      void args;
      const o = options as { env?: Record<string, string> } | undefined;
      observedModel = o?.env?.JEEVES_MODEL;
      return makeFakeChild(0);
    }) as unknown as typeof import('node:child_process').spawn;

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // workflow.default_model = 'sonnet' is used when phase.model is unset
    expect(observedModel).toBe('sonnet');
  });

  it('does not set JEEVES_MODEL when no model is specified (provider default)', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = await makeTempDir('jeeves-vs-workflows-');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const workflowName = 'fixture-model';
    await writeWorkflowYaml(
      workflowsDir,
      workflowName,
      [
        'workflow:',
        `  name: ${workflowName}`,
        '  version: 2',
        '  start: hello',
        '',
        'phases:',
        '  hello:',
        '    type: execute',
        '    prompt: fixtures/trivial.md',
        '    transitions:',
        '      - to: complete',
        '        auto: true',
        '',
        '  complete:',
        '    type: terminal',
        '',
      ].join('\n'),
    );

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 9;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: workflowName, branch: 'issue/9', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    let observedModel: string | undefined;
    const spawn = ((cmd: unknown, args: unknown, options: unknown) => {
      void cmd;
      void args;
      const o = options as { env?: Record<string, string> } | undefined;
      observedModel = o?.env?.JEEVES_MODEL;
      return makeFakeChild(0);
    }) as unknown as typeof import('node:child_process').spawn;

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // No model specified, so JEEVES_MODEL should be undefined (provider uses its default)
    expect(observedModel).toBeUndefined();
  });

  it('fails loudly with invalid provider (no silent fallback)', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = await makeTempDir('jeeves-vs-workflows-');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const workflowName = 'fixture-provider-invalid';
    await writeWorkflowYaml(
      workflowsDir,
      workflowName,
      [
        'workflow:',
        `  name: ${workflowName}`,
        '  version: 2',
        '  start: hello',
        '',
        'phases:',
        '  hello:',
        '    type: execute',
        '    provider: unknown-provider-xyz',
        '    prompt: fixtures/trivial.md',
        '    transitions:',
        '      - to: complete',
        '        auto: true',
        '',
        '  complete:',
        '    type: terminal',
        '',
      ].join('\n'),
    );

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 11;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: workflowName, branch: 'issue/11', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    let spawnCalls = 0;
    const spawn = (() => {
      spawnCalls += 1;
      return makeFakeChild(0);
    }) as unknown as typeof import('node:child_process').spawn;

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // Runner should NOT be spawned because provider validation should fail first
    expect(spawnCalls).toBe(0);
    // An error should be recorded
    expect(rm.getStatus().last_error).toContain('Invalid provider');
    expect(rm.getStatus().last_error).toContain('unknown-provider-xyz');
  });

  it('fails loudly with invalid model (no silent fallback)', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = await makeTempDir('jeeves-vs-workflows-');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const workflowName = 'fixture-model-invalid';
    await writeWorkflowYaml(
      workflowsDir,
      workflowName,
      [
        'workflow:',
        `  name: ${workflowName}`,
        '  version: 2',
        '  start: hello',
        '',
        'phases:',
        '  hello:',
        '    type: execute',
        '    model: invalid-model-xyz',
        '    prompt: fixtures/trivial.md',
        '    transitions:',
        '      - to: complete',
        '        auto: true',
        '',
        '  complete:',
        '    type: terminal',
        '',
      ].join('\n'),
    );

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 10;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: workflowName, branch: 'issue/10', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    let spawnCalls = 0;
    const spawn = (() => {
      spawnCalls += 1;
      return makeFakeChild(0);
    }) as unknown as typeof import('node:child_process').spawn;

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // Runner should NOT be spawned because validation should fail first
    expect(spawnCalls).toBe(0);
    // An error should be recorded - core validates model at parse time
    expect(rm.getStatus().last_error).toContain('invalid model');
    expect(rm.getStatus().last_error).toContain('invalid-model-xyz');
  });
});
