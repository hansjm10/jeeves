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
});
