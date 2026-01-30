import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseIssueRef, getIssueStateDir, getWorktreePath } from '@jeeves/core';

import { ClaudeAgentProvider } from './providers/claudeAgentSdk.js';
import { FakeProvider } from './providers/fake.js';
import { runSinglePhaseOnce, runWorkflowOnce } from './runner.js';

function usage(): string {
  return [
    'Usage:',
    '  jeeves-runner run-workflow --workflow <name> [--provider claude|fake] [--workflows-dir <dir>] [--prompts-dir <dir>] [--state-dir <dir>] [--work-dir <dir>] [--issue <owner/repo#N>]',
    '  jeeves-runner run-phase --workflow <name> --phase <phaseName> [--provider claude|fake] [--workflows-dir <dir>] [--prompts-dir <dir>] [--state-dir <dir>] [--work-dir <dir>] [--issue <owner/repo#N>]',
    '  jeeves-runner run-fixture [--state-dir <dir>]',
    '',
    'Notes:',
    '  - run-fixture defaults to workflow=fixture-trivial and provider=fake so it runs without credentials.',
    '  - If --issue is provided, state/work dirs default to the XDG layout (override with JEEVES_DATA_DIR).',
  ].join('\n');
}

function resolveProvider(name: string): { providerName: string; provider: FakeProvider | ClaudeAgentProvider } {
  if (name === 'fake') return { providerName: 'fake', provider: new FakeProvider() };
  if (name === 'claude') return { providerName: 'claude', provider: new ClaudeAgentProvider() };
  throw new Error(`Unknown provider: ${name}`);
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const cmd = command ?? 'run-workflow';

  const { values } = parseArgs({
    args: rest,
    options: {
      workflow: { type: 'string' },
      phase: { type: 'string' },
      provider: { type: 'string' },
      'workflows-dir': { type: 'string' },
      'prompts-dir': { type: 'string' },
      'state-dir': { type: 'string' },
      'work-dir': { type: 'string' },
      issue: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(usage());
    return;
  }

  if (cmd === 'run-fixture') {
    const { provider } = resolveProvider(String(values.provider ?? 'fake'));
    const workflowsDir = path.resolve(String(values['workflows-dir'] ?? path.join(process.cwd(), 'workflows')));
    const promptsDir = path.resolve(String(values['prompts-dir'] ?? path.join(process.cwd(), 'prompts')));
    const stateDir = path.resolve(String(values['state-dir'] ?? path.join(process.cwd(), '.jeeves-fixture')));
    const cwd = path.resolve(String(values['work-dir'] ?? process.cwd()));

    await runWorkflowOnce({
      provider,
      workflowName: String(values.workflow ?? 'fixture-trivial'),
      workflowsDir,
      promptsDir,
      stateDir,
      cwd,
    });
    return;
  }

  if (cmd !== 'run-workflow' && cmd !== 'run-phase') {
    throw new Error(`Unknown command: ${cmd}\n\n${usage()}`);
  }

  const issue = values.issue ? parseIssueRef(String(values.issue)) : null;
  const workflowsDir = path.resolve(String(values['workflows-dir'] ?? path.join(process.cwd(), 'workflows')));
  const promptsDir = path.resolve(String(values['prompts-dir'] ?? path.join(process.cwd(), 'prompts')));

  const stateDir = issue
    ? getIssueStateDir(issue.owner, issue.repo, issue.issueNumber)
    : path.resolve(String(values['state-dir'] ?? path.join(process.cwd(), '.jeeves')));
  const cwd = issue
    ? getWorktreePath(issue.owner, issue.repo, issue.issueNumber)
    : path.resolve(String(values['work-dir'] ?? process.cwd()));

  const { provider } = resolveProvider(String(values.provider ?? 'claude'));
  const workflowName = String(values.workflow ?? 'default');

  if (cmd === 'run-phase') {
    const phaseName = String(values.phase ?? '').trim();
    if (!phaseName) throw new Error(`--phase is required for run-phase\n\n${usage()}`);

    await runSinglePhaseOnce({
      provider,
      workflowName,
      phaseName,
      workflowsDir,
      promptsDir,
      stateDir,
      cwd,
    });
    return;
  }

  await runWorkflowOnce({ provider, workflowName, workflowsDir, promptsDir, stateDir, cwd });
}

// Intentionally no side-effectful entrypoint here; see `src/bin.ts`.
