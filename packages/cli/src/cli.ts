#!/usr/bin/env node

import { parseArgs } from 'node:util';

const DEFAULT_SERVER = 'http://127.0.0.1:8081';

interface RunOptions {
  server: string;
  iterations?: number;
}

function usage(): string {
  return [
    'Usage:',
    '  jeeves run [--iterations <n>] [--server <url>]',
    '',
    'Commands:',
    '  run    Start a Jeeves run via the viewer-server API',
    '',
    'Options:',
    '  --iterations <n>   Maximum iterations for the run (positive integer)',
    '  --server <url>     Viewer-server URL (default: http://127.0.0.1:8081)',
    '  --help             Show this help message',
    '',
  ].join('\n');
}

function parseIterations(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`Invalid iterations value: "${value}" is not an integer`);
  }
  if (n <= 0) {
    throw new Error(`Invalid iterations value: "${value}" must be a positive integer`);
  }
  return n;
}

async function runCommand(options: RunOptions): Promise<void> {
  const url = `${options.server}/api/run`;
  const body: Record<string, unknown> = {};

  if (options.iterations !== undefined) {
    body.max_iterations = options.iterations;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error: ${msg}`);
  }

  const data = await response.json() as { ok: boolean; error?: string; run?: unknown };
  console.log(JSON.stringify(data, null, 2));

  if (!data.ok) {
    throw new Error(`Server returned error: ${data.error ?? 'Unknown error'}`);
  }
}

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      iterations: { type: 'string' },
      server: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(usage());
    return;
  }

  const command = positionals[0] ?? '';

  if (command !== 'run') {
    if (command === '') {
      console.error('Error: No command specified\n');
    } else {
      console.error(`Error: Unknown command "${command}"\n`);
    }
    console.error(usage());
    throw new Error('Invalid command');
  }

  const options: RunOptions = {
    server: values.server ?? DEFAULT_SERVER,
  };

  if (values.iterations !== undefined) {
    options.iterations = parseIterations(values.iterations);
  }

  await runCommand(options);
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof Error && !err.message.startsWith('Network error:') && !err.message.startsWith('Server returned error:') && err.message !== 'Invalid command') {
    console.error(`Error: ${err.message}`);
  } else if (err instanceof Error && (err.message.startsWith('Network error:') || err.message.startsWith('Server returned error:'))) {
    console.error(`Error: ${err.message}`);
  }
  process.exitCode = 1;
});
