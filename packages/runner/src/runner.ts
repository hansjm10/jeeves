import fs from 'node:fs/promises';
import path from 'node:path';

import { loadWorkflowByName, resolvePromptPath, WorkflowEngine } from '@jeeves/core';

import type { AgentProvider } from './provider.js';
import { appendProgress, ensureProgressFile, markEnded, markPhase, markStarted } from './progress.js';
import { SdkOutputWriterV1 } from './outputWriter.js';

export type RunPhaseParams = Readonly<{
  provider: AgentProvider;
  promptPath: string;
  outputPath: string;
  logPath: string;
  progressPath: string;
  cwd: string;
  phaseName: string;
}>;

export async function runPhaseOnce(params: RunPhaseParams): Promise<{ success: boolean }> {
  await fs.mkdir(path.dirname(params.outputPath), { recursive: true });
  await fs.mkdir(path.dirname(params.logPath), { recursive: true });
  await ensureProgressFile(params.progressPath);

  await markStarted(params.progressPath);
  await markPhase(params.progressPath, params.phaseName);

  const prompt = await fs.readFile(params.promptPath, 'utf-8');

  await fs.writeFile(params.logPath, '', 'utf-8');
  const logStream = await fs.open(params.logPath, 'a');

  const writer = new SdkOutputWriterV1({ outputPath: params.outputPath });
  const logLine = async (line: string): Promise<void> => {
    await logStream.appendFile(`${line}\n`, 'utf-8');
  };

  try {
    await logLine(`[RUNNER] provider=${params.provider.name}`);
    await logLine(`[RUNNER] phase=${params.phaseName}`);
    await logLine(`[RUNNER] prompt=${params.promptPath}`);

    for await (const evt of params.provider.run(prompt, { cwd: params.cwd })) {
      writer.addProviderEvent(evt);

      if (evt.type === 'assistant' || evt.type === 'user' || evt.type === 'result') {
        await logLine(`[${evt.type.toUpperCase()}] ${evt.content}`);
      } else if (evt.type === 'system') {
        await logLine(`[SYSTEM${evt.subtype ? `:${evt.subtype}` : ''}] ${evt.content}`);
        if (evt.sessionId !== undefined) writer.setSessionId(evt.sessionId);
      } else if (evt.type === 'tool_use') {
        await logLine(`[TOOL] ${evt.name} ${JSON.stringify(evt.input)}`);
      } else if (evt.type === 'tool_result') {
        await logLine(`[TOOL_RESULT] ${evt.toolUseId} ${evt.content}`);
      }

      await writer.writeIncremental();
    }

    writer.finalize(true);
    await writer.writeIncremental({ force: true });
    await markEnded(params.progressPath, true);
    await appendProgress(params.progressPath, '');
    return { success: true };
  } catch (err) {
    writer.setError(err);
    writer.finalize(false);
    await writer.writeIncremental({ force: true });
    await logLine(`[ERROR] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    await markEnded(params.progressPath, false);
    return { success: false };
  } finally {
    await logStream.close();
  }
}

export type RunWorkflowParams = Readonly<{
  provider: AgentProvider;
  workflowName: string;
  workflowsDir: string;
  promptsDir: string;
  stateDir: string;
  cwd: string;
}>;

export async function runWorkflowOnce(params: RunWorkflowParams): Promise<{ finalPhase: string; success: boolean }> {
  const workflow = await loadWorkflowByName(params.workflowName, { workflowsDir: params.workflowsDir });
  const engine = new WorkflowEngine(workflow);

  let current = workflow.start;
  while (!engine.isTerminal(current)) {
    const promptPath = await resolvePromptPath(current, params.promptsDir, engine);
    const outputPath = path.join(params.stateDir, 'sdk-output.json');
    const logPath = path.join(params.stateDir, 'last-run.log');
    const progressPath = path.join(params.stateDir, 'progress.txt');

    const phaseResult = await runPhaseOnce({
      provider: params.provider,
      promptPath,
      outputPath,
      logPath,
      progressPath,
      cwd: params.cwd,
      phaseName: current,
    });

    if (!phaseResult.success) {
      return { finalPhase: current, success: false };
    }

    // Minimal workflow support: advance only via auto transitions unless the
    // caller supplies richer status/context in the future.
    const next = engine.evaluateTransitions(current, { status: {} });
    if (!next) return { finalPhase: current, success: true };
    current = next;
  }

  return { finalPhase: current, success: true };
}
