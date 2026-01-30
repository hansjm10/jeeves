import { parseArgs } from 'node:util';

import { startServer } from './server.js';

function usage(): string {
  return [
    'Usage:',
    '  jeeves-viewer-server [--host 127.0.0.1] [--port 8080] [--issue owner/repo#N] [--allow-remote-run]',
    '',
    'Notes:',
    '  - By default, the server binds to 127.0.0.1 and mutating endpoints are restricted to localhost.',
    '  - Set JEEVES_VIEWER_ALLOW_REMOTE_RUN=1 or pass --allow-remote-run to allow run control from non-local clients.',
  ].join('\n');
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      issue: { type: 'string' },
      'allow-remote-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(usage());
    return;
  }

  const host = String(values.host ?? '127.0.0.1');
  const port = Number(values.port ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid port: ${values.port}`);

  await startServer({
    host,
    port,
    allowRemoteRun: Boolean(values['allow-remote-run'] ?? false),
    initialIssue: typeof values.issue === 'string' ? values.issue : undefined,
  });
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});

