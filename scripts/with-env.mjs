#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const eqIdx = withoutExport.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = withoutExport.slice(0, eqIdx).trim();
    let value = withoutExport.slice(eqIdx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replaceAll('\\\\', '\\')
          .replaceAll('\\n', '\n')
          .replaceAll('\\r', '\r')
          .replaceAll('\\t', '\t')
          .replaceAll('\\"', '"');
      }
    }

    if (key) out[key] = value;
  }
  return out;
}

async function loadEnvFileIfExists(envFilePath, env) {
  const abs = path.resolve(envFilePath);
  try {
    const txt = await fs.readFile(abs, 'utf-8');
    const parsed = parseEnvFile(txt);
    for (const [k, v] of Object.entries(parsed)) {
      if (env[k] === undefined) env[k] = v;
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }
}

function usage() {
  console.error('Usage: node scripts/with-env.mjs [--env-file <path>] -- <command> [args...]');
}

async function main() {
  const argv = process.argv.slice(2);
  let envFilePath = '.env';

  while (argv.length) {
    if (argv[0] === '--env-file') {
      argv.shift();
      const next = argv.shift();
      if (!next) {
        usage();
        process.exit(2);
      }
      envFilePath = next;
      continue;
    }
    break;
  }

  if (argv[0] === '--') argv.shift();
  const command = argv.shift();
  if (!command) {
    usage();
    process.exit(2);
  }

  const env = { ...process.env };
  await loadEnvFileIfExists(envFilePath, env);

  const child = spawn(command, argv, { stdio: 'inherit', env });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

