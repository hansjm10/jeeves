import fs from 'node:fs';
import path from 'node:path';

function stripInlineComment(value: string): string {
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

loadDotenvFromCwd();

(async () => {
  const { main } = await import('./cli.js');
  await main(process.argv.slice(2));
})().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
