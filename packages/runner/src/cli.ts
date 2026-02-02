import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseIssueRef, getIssueStateDir, getWorktreePath } from '@jeeves/core';

import { runExpandIssue } from './issueExpand.js';
import { ClaudeAgentProvider } from './providers/claudeAgentSdk.js';
import { CodexSdkProvider } from './providers/codexSdk.js';
import { FakeProvider } from './providers/fake.js';
import { runSinglePhaseOnce, runWorkflowOnce } from './runner.js';

function usage(): string {
  return [
    'Usage:',
    '  jeeves-runner run-workflow --workflow <name> [--provider claude|codex|fake] [--workflows-dir <dir>] [--prompts-dir <dir>] [--state-dir <dir>] [--work-dir <dir>] [--issue <owner/repo#N>]',
    '  jeeves-runner run-phase --workflow <name> --phase <phaseName> [--provider claude|codex|fake] [--workflows-dir <dir>] [--prompts-dir <dir>] [--state-dir <dir>] [--work-dir <dir>] [--issue <owner/repo#N>]',
    '  jeeves-runner run-fixture [--state-dir <dir>]',
    '  jeeves-runner expand-issue [--provider claude|codex|fake] [--prompts-dir <dir>]',
    '',
    'Notes:',
    '  - run-fixture defaults to workflow=fixture-trivial and provider=fake so it runs without credentials.',
    '  - If --issue is provided, state/work dirs default to the XDG layout (override with JEEVES_DATA_DIR).',
    '  - expand-issue reads JSON from stdin with { summary, issue_type?, repo? } and outputs JSON to stdout.',
  ].join('\n');
}

function resolveProvider(
  name: string,
): { providerName: string; provider: FakeProvider | ClaudeAgentProvider | CodexSdkProvider } {
  const n = name.trim().toLowerCase();
  if (n === 'fake') return { providerName: 'fake', provider: new FakeProvider() };
  if (n === 'claude') return { providerName: 'claude', provider: new ClaudeAgentProvider() };
  if (n === 'codex' || n === 'codex-sdk' || n === 'codex_sdk') return { providerName: 'codex', provider: new CodexSdkProvider() };
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

    const result = await runWorkflowOnce({
      provider,
      workflowName: String(values.workflow ?? 'fixture-trivial'),
      workflowsDir,
      promptsDir,
      stateDir,
      cwd,
    });
    if (!result.success) {
      throw new Error(`run-fixture failed (finalPhase=${result.finalPhase})`);
    }
    return;
  }

  if (cmd === 'expand-issue') {
    const { provider } = resolveProvider(String(values.provider ?? 'claude'));
    const promptsDir = path.resolve(String(values['prompts-dir'] ?? path.join(process.cwd(), 'prompts')));

    await runExpandIssue({
      provider,
      promptsDir,
      promptId: 'issue.expand.md',
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

    const result = await runSinglePhaseOnce({
      provider,
      workflowName,
      phaseName,
      workflowsDir,
      promptsDir,
      stateDir,
      cwd,
    });
    if (!result.success) {
      throw new Error(`run-phase failed (phase=${result.phase})`);
    }
    return;
  }

  const result = await runWorkflowOnce({ provider, workflowName, workflowsDir, promptsDir, stateDir, cwd });
  if (!result.success) {
    throw new Error(`run-workflow failed (finalPhase=${result.finalPhase})`);
  }
}

// Intentionally no side-effectful entrypoint here; see `src/bin.ts`.
