import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentProvider, ProviderEvent } from './provider.js';

export type ExpandIssueInput = Readonly<{
  summary: string;
  issue_type?: 'feature' | 'bug' | 'refactor';
  repo?: string;
}>;

export type ExpandIssueSuccess = Readonly<{
  ok: true;
  title: string;
  body: string;
}>;

export type ExpandIssueError = Readonly<{
  ok: false;
  error: string;
}>;

export type ExpandIssueResult = ExpandIssueSuccess | ExpandIssueError;

export type ExpandIssueOptions = Readonly<{
  provider: AgentProvider;
  promptsDir: string;
  promptId?: string;
}>;

/**
 * Reads and parses stdin as JSON
 */
async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(raw);
}

/**
 * Validates the input and returns typed input or throws
 */
function validateInput(raw: unknown): ExpandIssueInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Input must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.summary !== 'string' || obj.summary.trim() === '') {
    throw new Error('Missing or empty required field: summary');
  }

  const result: {
    summary: string;
    issue_type?: 'feature' | 'bug' | 'refactor';
    repo?: string;
  } = {
    summary: obj.summary,
  };

  if (obj.issue_type !== undefined) {
    if (typeof obj.issue_type !== 'string') {
      throw new Error('issue_type must be a string');
    }
    const validTypes = ['feature', 'bug', 'refactor'] as const;
    if (!validTypes.includes(obj.issue_type as typeof validTypes[number])) {
      throw new Error(`issue_type must be one of: ${validTypes.join(', ')}`);
    }
    result.issue_type = obj.issue_type as typeof validTypes[number];
  }

  if (obj.repo !== undefined) {
    if (typeof obj.repo !== 'string') {
      throw new Error('repo must be a string');
    }
    result.repo = obj.repo;
  }

  return result;
}

/**
 * Builds the prompt with context block
 */
function buildPrompt(template: string, input: ExpandIssueInput): string {
  const contextBlock = JSON.stringify(
    {
      summary: input.summary,
      issue_type: input.issue_type ?? 'feature',
      ...(input.repo ? { repo: input.repo } : {}),
    },
    null,
    2,
  );

  return `${template}\n\n<context>\n${contextBlock}\n</context>`;
}

/**
 * Extracts the final text content from provider events
 */
function extractProviderOutput(events: ProviderEvent[]): string {
  // Collect all assistant messages
  const assistantMessages: string[] = [];
  for (const evt of events) {
    if (evt.type === 'assistant') {
      assistantMessages.push(evt.content);
    }
  }

  // The last assistant message should contain the JSON output
  if (assistantMessages.length === 0) {
    throw new Error('Provider returned no output');
  }

  return assistantMessages[assistantMessages.length - 1];
}

/**
 * Parses and validates the provider output as the expected JSON format
 */
function parseProviderOutput(raw: string): { title: string; body: string } {
  // Try to parse as JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error('Provider output is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Provider output must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.title !== 'string' || obj.title.trim() === '') {
    throw new Error('Provider output missing required field: title');
  }

  if (typeof obj.body !== 'string' || obj.body.trim() === '') {
    throw new Error('Provider output missing required field: body');
  }

  return {
    title: obj.title,
    body: obj.body,
  };
}

/**
 * Main expand-issue implementation.
 * Returns a result object; caller is responsible for output and exit code.
 */
export async function expandIssue(options: ExpandIssueOptions): Promise<ExpandIssueResult> {
  const { provider, promptsDir, promptId = 'issue.expand.md' } = options;

  // Read and validate input
  let input: ExpandIssueInput;
  try {
    const rawInput = await readStdinJson();
    input = validateInput(rawInput);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Load prompt template
  const promptPath = path.join(promptsDir, promptId);
  let template: string;
  try {
    template = await fs.readFile(promptPath, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      error: `Failed to load prompt template: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Build full prompt with context
  const prompt = buildPrompt(template, input);

  // Run provider and collect events
  const events: ProviderEvent[] = [];
  try {
    for await (const evt of provider.run(prompt, { cwd: process.cwd() })) {
      events.push(evt);
    }
  } catch (err) {
    return {
      ok: false,
      error: `Provider execution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Extract and parse provider output
  let output: { title: string; body: string };
  try {
    const rawOutput = extractProviderOutput(events);
    output = parseProviderOutput(rawOutput);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ok: true,
    title: output.title,
    body: output.body,
  };
}

/**
 * CLI runner for expand-issue command.
 * Handles stdin/stdout and exit code.
 * All output goes to stdout as JSON only.
 */
export async function runExpandIssue(options: ExpandIssueOptions): Promise<void> {
  const result = await expandIssue(options);

  // Output only JSON to stdout
  console.log(JSON.stringify(result));

  // Exit non-zero on failure
  if (!result.ok) {
    process.exitCode = 1;
  }
}
