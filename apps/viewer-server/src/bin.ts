import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

function stripInlineComment(value: string): string {
  // Keep it simple: treat " #" as a comment delimiter, but ignore when quoted.
  // This matches common .env usage for unquoted values (URLs, booleans, numbers).
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return value;
  const idx = value.indexOf(' #');
  return idx >= 0 ? value.slice(0, idx) : value;
}

function parseDotenvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed;
  const eq = withoutExport.indexOf('=');
  if (eq <= 0) return null;

  const key = withoutExport.slice(0, eq).trim();
  let rawValue = withoutExport.slice(eq + 1);
  rawValue = stripInlineComment(rawValue).trim();

  // Remove surrounding quotes when present.
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2)
  ) {
    rawValue = rawValue.slice(1, -1);
  }

  if (!key) return null;
  return { key, value: rawValue };
}

function loadDotenvFromCwd(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }

  for (const line of content.split(/\r?\n/)) {
    const parsed = parseDotenvLine(line);
    if (!parsed) continue;
    if (process.env[parsed.key] !== undefined) continue;
    process.env[parsed.key] = parsed.value;
  }
}

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
  // Load .env before importing server code so env is available during module init
  // (and before any long-running processes start).
  loadDotenvFromCwd();

  const { startServer } = await import('./server.js');

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
