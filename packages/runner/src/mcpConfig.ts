import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import type { McpServerConfig } from './provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type McpServersConfig = Readonly<Record<string, McpServerConfig>>;

/**
 * Resolve the mcp-pruner JS entrypoint path.
 *
 * Priority:
 * 1. JEEVES_MCP_PRUNER_PATH env var (explicit override)
 * 2. require.resolve('@jeeves/mcp-pruner/dist/index.js')
 * 3. Fallback: ../../mcp-pruner/dist/index.js relative to this file's directory
 *    (works for workspace dist layout where this file is at packages/runner/dist/*)
 *
 * Returns undefined if no readable path is found.
 */
function resolvePrunerEntrypoint(env: Record<string, string | undefined>): string | undefined {
  const explicit = env['JEEVES_MCP_PRUNER_PATH'];
  if (explicit) {
    return explicit;
  }

  // Try require.resolve (works when @jeeves/mcp-pruner is resolvable)
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('@jeeves/mcp-pruner/dist/index.js');
    return resolved;
  } catch {
    // Not resolvable — try workspace fallback
  }

  // Fallback: workspace dist layout (relative to packages/runner/dist/*)
  const fallback = path.resolve(__dirname, '../../mcp-pruner/dist/index.js');
  try {
    fs.accessSync(fallback, fs.constants.R_OK);
    return fallback;
  } catch {
    return undefined;
  }
}

/**
 * Build the mcpServers config record from runner environment variables.
 *
 * Returns undefined when the pruner is disabled or the entrypoint cannot be resolved.
 *
 * Environment variables:
 * - JEEVES_PRUNER_ENABLED: must be exactly "true" to enable
 * - JEEVES_PRUNER_URL: optional; forwarded as PRUNER_URL. Defaults to
 *   "http://localhost:8000/prune" when unset; empty string disables pruning.
 * - JEEVES_MCP_PRUNER_PATH: optional; explicit path to the mcp-pruner entrypoint JS file.
 */
export function buildMcpServersConfig(
  env: Record<string, string | undefined>,
  cwd: string,
): McpServersConfig | undefined {
  if (env['JEEVES_PRUNER_ENABLED'] !== 'true') {
    return undefined;
  }

  const entrypoint = resolvePrunerEntrypoint(env);
  if (!entrypoint) {
    return undefined;
  }

  // PRUNER_URL: default http://localhost:8000/prune when JEEVES_PRUNER_URL is unset;
  // empty string is passed through (disables pruning in the server).
  const prunerUrl =
    env['JEEVES_PRUNER_URL'] !== undefined
      ? env['JEEVES_PRUNER_URL']
      : 'http://localhost:8000/prune';

  return {
    pruner: {
      command: 'node',
      args: [entrypoint],
      env: {
        PRUNER_URL: prunerUrl,
        MCP_PRUNER_CWD: cwd,
      },
    },
  };
}
