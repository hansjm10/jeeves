import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { getIssueStateDir, getWorktreePath } from '@jeeves/core';

import { RunManager } from './runManager.js';
import { readIssueJson } from './issueJson.js';

const execFileAsync = promisify(execFile);

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeWorkflowYaml(workflowsDir: string, name: string, yaml: string): Promise<void> {
  await fs.mkdir(workflowsDir, { recursive: true });
  await fs.writeFile(path.join(workflowsDir, `${name}.yaml`), yaml, 'utf-8');
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: 5 * 1024 * 1024 });
  return `${String(stdout ?? '')}${String(stderr ?? '')}`;
}

function makeFakeChild(exitCode = 0, delayMs = 25, signal: NodeJS.Signals | null = null) {
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
    proc.emit('exit', signal ? null : exitCode, signal);
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
  it('does not treat tool output containing the promise as completion', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');

    const workflowsDir = path.join(process.cwd(), 'workflows');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 4;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: 'fixture-trivial', branch: 'issue/4', notes: '' }, null, 2) + '\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(stateDir, 'sdk-output.json'),
      JSON.stringify(
        {
          messages: [
            {
              type: 'tool_result',
              content: "some code: content.includes('<promise>COMPLETE</promise>') // not a real completion signal",
            },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn: (() => makeFakeChild(0)) as unknown as typeof import('node:child_process').spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    const done = await (rm as unknown as { checkCompletionPromise(): Promise<boolean> }).checkCompletionPromise();
    expect(done).toBe(false);
  });

  it('treats an assistant completion promise line as completion', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');

    const workflowsDir = path.join(process.cwd(), 'workflows');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 5;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: 'fixture-trivial', branch: 'issue/5', notes: '' }, null, 2) + '\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(stateDir, 'sdk-output.json'),
      JSON.stringify(
        {
          messages: [
            {
              type: 'assistant',
              content: '\n<promise>COMPLETE</promise>\n',
            },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn: (() => makeFakeChild(0)) as unknown as typeof import('node:child_process').spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    const done = await (rm as unknown as { checkCompletionPromise(): Promise<boolean> }).checkCompletionPromise();
    expect(done).toBe(true);
  });

  it('does not treat an assistant message that merely mentions the promise as completion', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');

    const workflowsDir = path.join(process.cwd(), 'workflows');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 6;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: 'fixture-trivial', branch: 'issue/6', notes: '' }, null, 2) + '\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(stateDir, 'sdk-output.json'),
      JSON.stringify(
        {
          messages: [
            {
              type: 'assistant',
              content: 'Do not output <promise>COMPLETE</promise> unless complete.',
            },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn: (() => makeFakeChild(0)) as unknown as typeof import('node:child_process').spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    const done = await (rm as unknown as { checkCompletionPromise(): Promise<boolean> }).checkCompletionPromise();
    expect(done).toBe(false);
  });

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

  it('commits a design doc checkpoint after design_draft success', async () => {
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
      JSON.stringify(
        { repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'design_draft', workflow: 'default', branch: 'issue/1', notes: '' },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });
    await runGit(workDir, ['init']);
    await fs.mkdir(path.join(workDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(workDir, 'docs', `issue-${issueNumber}-design.md`), '# design\n', 'utf-8');

    const spawn = (() => makeFakeChild(0)) as unknown as typeof import('node:child_process').spawn;
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

    await expect(runGit(workDir, ['ls-files', '--error-unmatch', '--', `docs/issue-${issueNumber}-design.md`])).resolves.toContain(
      `docs/issue-${issueNumber}-design.md`,
    );
    const subject = (await runGit(workDir, ['log', '-1', '--pretty=%s'])).trim();
    expect(subject).toContain(`checkpoint issue #${issueNumber} design doc (design_draft)`);

    const updated = await readIssueJson(stateDir);
    expect(updated?.phase).toBe('design_review');
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

  it('records non-zero exit code when runner is terminated by signal', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = path.join(process.cwd(), 'workflows');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 222;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: 'fixture-trivial', branch: 'issue/222', notes: '' }, null, 2) +
        '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn: (() => makeFakeChild(0, 25, 'SIGKILL')) as unknown as typeof import('node:child_process').spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(rm.getStatus().returncode).toBe(137); // 128 + SIGKILL(9)
    expect(rm.getStatus().last_error).toContain('137');
  });

  it('auto-expands task filesAllowed to include test variants before implement_task', async () => {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = path.join(process.cwd(), 'workflows');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const owner = 'o';
    const repo = 'r';
    const issueNumber = 999;
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    // Start at pre_implementation_check phase (the new phase inserted between task_decomposition and implement_task)
    // with preCheckPassed: true to trigger transition to implement_task
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify(
        {
          repo: `${owner}/${repo}`,
          issue: { number: issueNumber },
          phase: 'pre_implementation_check',
          workflow: 'default',
          branch: 'issue/999',
          notes: '',
          status: { preCheckPassed: true },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    await fs.writeFile(
      path.join(stateDir, 'tasks.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          decomposedFrom: 'docs/x.md',
          tasks: [
            {
              id: 'T1',
              title: 't',
              summary: 's',
              acceptanceCriteria: ['c'],
              filesAllowed: ['packages/runner/src/issueExpand.ts'],
              dependsOn: [],
              status: 'pending',
            },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    const rm = new RunManager({
      promptsDir,
      workflowsDir,
      repoRoot,
      dataDir,
      spawn: (() => makeFakeChild(0)) as unknown as typeof import('node:child_process').spawn,
      broadcast: () => void 0,
    });

    await rm.setIssue(issueRef);
    await rm.start({ provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    const updatedIssue = await readIssueJson(stateDir);
    expect(updatedIssue?.phase).toBe('implement_task');

    const tasksRaw = await fs.readFile(path.join(stateDir, 'tasks.json'), 'utf-8');
    const tasksJson = JSON.parse(tasksRaw) as { tasks: { filesAllowed: string[] }[] };
    expect(tasksJson.tasks[0].filesAllowed).toContain('packages/runner/src/issueExpand.test.ts');
    expect(tasksJson.tasks[0].filesAllowed).toContain('packages/runner/src/__tests__/issueExpand.ts');
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
    // Isolate this test from host environment by saving and removing JEEVES_MODEL
    const savedJeevesModel = process.env.JEEVES_MODEL;
    delete process.env.JEEVES_MODEL;

    try {
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
    } finally {
      // Restore the original env value
      if (savedJeevesModel !== undefined) {
        process.env.JEEVES_MODEL = savedJeevesModel;
      }
    }
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

describe('RunManager max_iterations handling', () => {
  // Helper to create a minimal RunManager setup for testing max_iterations behavior
  async function setupTestRun(issueNumber: number) {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = path.join(process.cwd(), 'workflows');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const owner = 'o';
    const repo = 'r';
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: 'fixture-trivial', branch: `issue/${issueNumber}`, notes: '' }, null, 2) + '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    let spawnCallCount = 0;
    const spawn = (() => {
      spawnCallCount += 1;
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

    return { rm, getSpawnCallCount: () => spawnCallCount };
  }

  // Helper for testing multi-iteration scenarios (no auto-transition)
  // This workflow stays in 'hello' phase (no transitions), so the loop runs until max_iterations
  async function setupMultiIterationTestRun(issueNumber: number) {
    const dataDir = await makeTempDir('jeeves-vs-data-');
    const repoRoot = await makeTempDir('jeeves-vs-repo-');
    await fs.mkdir(path.join(repoRoot, 'packages', 'runner', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js'), '// stub\n', 'utf-8');

    const workflowsDir = await makeTempDir('jeeves-vs-workflows-');
    const promptsDir = path.join(process.cwd(), 'prompts');

    const workflowName = 'fixture-no-auto-transition';
    // This workflow has no transitions, so phase never changes and loop runs until max_iterations
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
        '    # No transitions - stays in this phase until max_iterations reached',
        '',
      ].join('\n'),
    );

    const owner = 'o';
    const repo = 'r';
    const issueRef = `${owner}/${repo}#${issueNumber}`;

    const stateDir = getIssueStateDir(owner, repo, issueNumber, dataDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify({ repo: `${owner}/${repo}`, issue: { number: issueNumber }, phase: 'hello', workflow: workflowName, branch: `issue/${issueNumber}`, notes: '' }, null, 2) + '\n',
      'utf-8',
    );

    const workDir = getWorktreePath(owner, repo, issueNumber, dataDir);
    await fs.mkdir(workDir, { recursive: true });

    let spawnCallCount = 0;
    const spawn = (() => {
      spawnCallCount += 1;
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

    return { rm, getSpawnCallCount: () => spawnCallCount };
  }

  it('defaults max_iterations to 10 when omitted', async () => {
    const { rm } = await setupTestRun(100);

    // Start run without max_iterations
    await rm.start({ provider: 'fake', inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // run status should reflect max_iterations = 10 (the default)
    expect(rm.getStatus().max_iterations).toBe(10);
  });

  it('defaults max_iterations to 10 when undefined', async () => {
    const { rm } = await setupTestRun(101);

    // Start run with explicit undefined
    await rm.start({ provider: 'fake', max_iterations: undefined, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(rm.getStatus().max_iterations).toBe(10);
  });

  it('clamps max_iterations to 1 when null (Number(null) = 0)', async () => {
    const { rm } = await setupTestRun(102);

    // Start run with explicit null - Number(null) = 0, which is finite, so Math.max(1, 0) = 1
    await rm.start({ provider: 'fake', max_iterations: null, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // null -> Number(null) = 0 -> Math.max(1, 0) = 1
    expect(rm.getStatus().max_iterations).toBe(1);
  });

  it('defaults max_iterations to 10 when NaN', async () => {
    const { rm } = await setupTestRun(103);

    // Start run with NaN
    await rm.start({ provider: 'fake', max_iterations: NaN, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(rm.getStatus().max_iterations).toBe(10);
  });

  it('clamps max_iterations to 1 when 0', async () => {
    const { rm } = await setupTestRun(104);

    await rm.start({ provider: 'fake', max_iterations: 0, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // 0 should be clamped to 1
    expect(rm.getStatus().max_iterations).toBe(1);
  });

  it('clamps max_iterations to 1 when negative', async () => {
    const { rm } = await setupTestRun(105);

    await rm.start({ provider: 'fake', max_iterations: -5, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // Negative values should be clamped to 1
    expect(rm.getStatus().max_iterations).toBe(1);
  });

  it('clamps max_iterations to 1 when -1', async () => {
    const { rm } = await setupTestRun(106);

    await rm.start({ provider: 'fake', max_iterations: -1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(rm.getStatus().max_iterations).toBe(1);
  });

  it('uses floor for float max_iterations (2.5 becomes 2 effective iterations)', async () => {
    const { rm, getSpawnCallCount } = await setupMultiIterationTestRun(107);

    // With max_iterations=2.5, the loop condition `iteration <= 2.5` allows iterations 1 and 2
    // (iteration 3 > 2.5, so it stops). The status shows the raw value passed.
    await rm.start({ provider: 'fake', max_iterations: 2.5, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // The status stores the raw value (after Math.max(1, ...))
    expect(rm.getStatus().max_iterations).toBe(2.5);
    // The loop ran 2 iterations (1 <= 2.5, 2 <= 2.5, 3 > 2.5 stops)
    // Using workflow with no transitions, so loop runs until max_iterations reached
    expect(getSpawnCallCount()).toBe(2); // floor(2.5) = 2 effective iterations
  });

  it('uses floor for float max_iterations (3.9 becomes 3 effective iterations)', async () => {
    const { rm, getSpawnCallCount } = await setupMultiIterationTestRun(108);

    await rm.start({ provider: 'fake', max_iterations: 3.9, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // The status stores the raw value
    expect(rm.getStatus().max_iterations).toBe(3.9);
    // The loop ran 3 iterations (1 <= 3.9, 2 <= 3.9, 3 <= 3.9, 4 > 3.9 stops)
    expect(getSpawnCallCount()).toBe(3); // floor(3.9) = 3 effective iterations
  });

  it('uses valid positive integer 1 as specified', async () => {
    const { rm, getSpawnCallCount } = await setupTestRun(109);

    await rm.start({ provider: 'fake', max_iterations: 1, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(rm.getStatus().max_iterations).toBe(1);
    // With max_iterations=1 and fixture-trivial, we expect exactly 1 spawn
    expect(getSpawnCallCount()).toBe(1);
  });

  it('uses valid positive integer 5 as specified', async () => {
    const { rm } = await setupTestRun(110);

    await rm.start({ provider: 'fake', max_iterations: 5, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(rm.getStatus().max_iterations).toBe(5);
  });

  it('uses valid positive integer 20 as specified', async () => {
    const { rm } = await setupTestRun(111);

    await rm.start({ provider: 'fake', max_iterations: 20, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(rm.getStatus().max_iterations).toBe(20);
  });

  it('uses valid positive integer 100 as specified', async () => {
    const { rm } = await setupTestRun(112);

    await rm.start({ provider: 'fake', max_iterations: 100, inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    expect(rm.getStatus().max_iterations).toBe(100);
  });

  it('accepts numeric string and converts to number', async () => {
    const { rm } = await setupTestRun(113);

    // Pass max_iterations as a string (API may receive this)
    await rm.start({ provider: 'fake', max_iterations: '7', inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // Number('7') = 7, so max_iterations should be 7
    expect(rm.getStatus().max_iterations).toBe(7);
  });

  it('defaults to 10 for non-numeric string', async () => {
    const { rm } = await setupTestRun(114);

    // Pass max_iterations as a non-numeric string
    await rm.start({ provider: 'fake', max_iterations: 'abc', inactivity_timeout_sec: 10, iteration_timeout_sec: 10 });
    await waitFor(() => rm.getStatus().running === false);

    // Number('abc') = NaN, which is not finite, so defaults to 10
    expect(rm.getStatus().max_iterations).toBe(10);
  });
});
