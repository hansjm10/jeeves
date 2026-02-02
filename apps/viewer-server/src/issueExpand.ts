import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

/**
 * Issue expansion request input validated by the endpoint
 */
export type ExpandIssueRequest = Readonly<{
  summary: string;
  issue_type?: 'feature' | 'bug' | 'refactor';
  provider?: string;
  model?: string;
}>;

/**
 * Success response from the expansion endpoint
 */
export type ExpandIssueSuccessResponse = Readonly<{
  ok: true;
  title: string;
  body: string;
  provider: string;
  model?: string;
}>;

/**
 * Error response from the expansion endpoint
 */
export type ExpandIssueErrorResponse = Readonly<{
  ok: false;
  error: string;
}>;

export type ExpandIssueResponse = ExpandIssueSuccessResponse | ExpandIssueErrorResponse;

/**
 * Options for spawning the runner subprocess
 */
export type ExpandIssueSpawnOptions = Readonly<{
  repoRoot: string;
  promptsDir: string;
  provider: string;
  model?: string;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}>;

/**
 * Runner JSON output shape (success case)
 */
type RunnerSuccess = {
  ok: true;
  title: string;
  body: string;
};

/**
 * Runner JSON output shape (error case)
 */
type RunnerError = {
  ok: false;
  error: string;
};

type RunnerOutput = RunnerSuccess | RunnerError;

/**
 * Validates the parsed runner output has the expected shape
 */
function validateRunnerOutput(parsed: unknown): RunnerOutput {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Runner output is not a valid JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.ok !== 'boolean') {
    throw new Error('Runner output missing required field: ok');
  }

  if (obj.ok === true) {
    if (typeof obj.title !== 'string' || obj.title.trim() === '') {
      throw new Error('Runner output missing required field: title');
    }
    if (typeof obj.body !== 'string' || obj.body.trim() === '') {
      throw new Error('Runner output missing required field: body');
    }
    return { ok: true, title: obj.title, body: obj.body };
  }

  if (typeof obj.error !== 'string') {
    throw new Error('Runner error output missing required field: error');
  }
  return { ok: false, error: obj.error };
}

/**
 * Spawns the runner subprocess and returns the parsed result.
 * This function never includes raw runner output in errors - only safe error messages.
 */
export async function runIssueExpand(
  input: { summary: string; issue_type?: string; repo?: string },
  options: ExpandIssueSpawnOptions,
): Promise<{ result: RunnerOutput; timedOut: boolean }> {
  const { repoRoot, promptsDir, provider, model, timeoutMs = 60000, spawnImpl = spawn } = options;

  const runnerBin = path.join(repoRoot, 'packages', 'runner', 'dist', 'bin.js');

  const args = [runnerBin, 'expand-issue', '--provider', provider, '--prompts-dir', promptsDir];

  // Build environment with optional model
  const env: Record<string, string | undefined> = { ...process.env };
  if (model) {
    env.JEEVES_MODEL = model;
  }

  return new Promise((resolve) => {
    let proc: ChildProcessWithoutNullStreams;
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    try {
      proc = spawnImpl(process.execPath, args, {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch {
      cleanup();
      resolve({
        result: { ok: false, error: 'Failed to spawn runner process' },
        timedOut: false,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    // Write input JSON to stdin and close it
    const inputJson = JSON.stringify({
      summary: input.summary,
      ...(input.issue_type ? { issue_type: input.issue_type } : {}),
      ...(input.repo ? { repo: input.repo } : {}),
    });
    proc.stdin.write(inputJson);
    proc.stdin.end();

    // Set up timeout
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGTERM');
        // Give it a moment, then force kill
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 1000);
      } catch {
        // ignore
      }
    }, timeoutMs);

    proc.once('exit', () => {
      cleanup();

      if (timedOut) {
        resolve({
          result: { ok: false, error: 'Runner subprocess timed out' },
          timedOut: true,
        });
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');

      // Try to parse runner output as JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        // Do NOT include raw stdout in error message
        resolve({
          result: { ok: false, error: 'Runner output is not valid JSON' },
          timedOut: false,
        });
        return;
      }

      // Validate the parsed output structure
      try {
        const validated = validateRunnerOutput(parsed);
        resolve({ result: validated, timedOut: false });
      } catch (err) {
        // Do NOT include raw output in error message
        resolve({
          result: {
            ok: false,
            error: err instanceof Error ? err.message : 'Runner output validation failed',
          },
          timedOut: false,
        });
      }
    });

    proc.once('error', () => {
      cleanup();
      // Do NOT include error details that might leak sensitive info
      resolve({
        result: { ok: false, error: 'Runner process error' },
        timedOut: false,
      });
    });
  });
}

/**
 * Builds the success response, conditionally including model
 */
export function buildSuccessResponse(
  title: string,
  body: string,
  provider: string,
  model?: string,
): ExpandIssueSuccessResponse {
  const response: ExpandIssueSuccessResponse = {
    ok: true,
    title,
    body,
    provider,
  };

  // Only include model if it was actually set (not undefined)
  if (model !== undefined) {
    return { ...response, model };
  }

  return response;
}
