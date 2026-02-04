import { parseArgs } from 'node:util';

const DEFAULT_SERVER = 'http://127.0.0.1:8081';
const VERSION = '0.0.0';

interface RunOptions {
  server: string;
  iterations?: number;
  quick?: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  jeeves run [--iterations <n>] [--server <url>] [--quick]',
    '',
    'Commands:',
    '  run    Start a Jeeves run via the viewer-server API',
    '',
    'Options:',
    '  --iterations <n>   Maximum iterations for the run (positive integer)',
    '  --server <url>     Viewer-server URL (default: http://127.0.0.1:8081)',
    '  --quick            Route to the quick-fix workflow when possible',
    '  --help             Show this help message',
    '  --version, -v      Show version number',
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
  if (options.quick === true) {
    body.quick = true;
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
      quick: { type: 'boolean' },
      help: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
  });

  if (values.version) {
    console.log(`jeeves ${VERSION}`);
    return;
  }

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
  if (values.quick !== undefined) {
    options.quick = Boolean(values.quick);
  }

  await runCommand(options);
}
