import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import type { McpServerConfig } from './provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type McpServersConfig = Readonly<Record<string, McpServerConfig>>;
export type McpProfile = 'default' | 'none' | 'pruner' | 'state' | 'state_with_pruner';

export type BuildMcpConfigOptions = Readonly<{
  stateDir?: string;
  profile?: string;
}>;

function resolveEntrypoint(params: {
  env: Record<string, string | undefined>;
  explicitEnvVar: string;
  packageEntrypoint: string;
  fallbackRelativeFromRunnerDist: string;
}): string | undefined {
  const { env, explicitEnvVar, packageEntrypoint, fallbackRelativeFromRunnerDist } = params;
  const explicit = env[explicitEnvVar];
  if (explicit) {
    try {
      fs.accessSync(explicit, fs.constants.R_OK);
      return explicit;
    } catch {
      console.error(
        `[mcp-config] ${explicitEnvVar}="${explicit}" is not readable; ignoring.`,
      );
      return undefined;
    }
  }

  try {
    const require = createRequire(import.meta.url);
    return require.resolve(packageEntrypoint);
  } catch {
    // Not resolvable — try workspace fallback
  }

  const fallback = path.resolve(__dirname, fallbackRelativeFromRunnerDist);
  try {
    fs.accessSync(fallback, fs.constants.R_OK);
    return fallback;
  } catch {
    return undefined;
  }
}

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
  return resolveEntrypoint({
    env,
    explicitEnvVar: 'JEEVES_MCP_PRUNER_PATH',
    packageEntrypoint: '@jeeves/mcp-pruner/dist/index.js',
    fallbackRelativeFromRunnerDist: '../../mcp-pruner/dist/index.js',
  });
}

/**
 * Resolve the mcp-state JS entrypoint path.
 *
 * Priority:
 * 1. JEEVES_MCP_STATE_PATH env var (explicit override)
 * 2. require.resolve('@jeeves/mcp-state/dist/index.js')
 * 3. Fallback: ../../mcp-state/dist/index.js relative to this file's directory
 */
function resolveStateEntrypoint(env: Record<string, string | undefined>): string | undefined {
  return resolveEntrypoint({
    env,
    explicitEnvVar: 'JEEVES_MCP_STATE_PATH',
    packageEntrypoint: '@jeeves/mcp-state/dist/index.js',
    fallbackRelativeFromRunnerDist: '../../mcp-state/dist/index.js',
  });
}

function normalizeProfile(raw: string | undefined): McpProfile {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'default';
  if (value === 'none') return 'none';
  if (value === 'pruner') return 'pruner';
  if (value === 'state') return 'state';
  if (value === 'state_with_pruner' || value === 'state+pruner' || value === 'state-pruner') {
    return 'state_with_pruner';
  }
  return 'default';
}

function shouldIncludePruner(profile: McpProfile): boolean {
  return profile === 'default' || profile === 'pruner' || profile === 'state_with_pruner';
}

function shouldRequirePruner(profile: McpProfile): boolean {
  return profile === 'pruner';
}

function shouldIncludeState(profile: McpProfile): boolean {
  return profile === 'state' || profile === 'state_with_pruner';
}

function requiredStateDir(options: BuildMcpConfigOptions): string {
  if (!options.stateDir || !options.stateDir.trim()) {
    throw new Error('MCP state profile requires a non-empty stateDir');
  }
  return path.resolve(options.stateDir);
}

/**
 * Build the mcpServers config record from runner environment variables.
 *
 * Returns undefined when profile resolution yields no enabled MCP servers.
 *
 * Environment variables:
 * - JEEVES_PRUNER_ENABLED: must be exactly "true" to enable
 * - JEEVES_PRUNER_URL: optional; forwarded as PRUNER_URL. Defaults to
 *   "http://localhost:8000/prune" when unset; empty string disables pruning.
 * - JEEVES_MCP_PRUNER_PATH: optional; explicit path to the mcp-pruner entrypoint JS file.
 * - JEEVES_MCP_STATE_PATH: optional; explicit path to the mcp-state entrypoint JS file.
 *
 * Profiles:
 * - default: existing behavior (pruner only, gated by JEEVES_PRUNER_ENABLED=true)
 * - none: no MCP servers
 * - pruner: require pruner server (ignores default profile behavior)
 * - state: require state server
 * - state_with_pruner: require state server and include pruner when enabled
 */
export function buildMcpServersConfig(
  env: Record<string, string | undefined>,
  cwd: string,
  options: BuildMcpConfigOptions = {},
): McpServersConfig | undefined {
  const profile = normalizeProfile(options.profile ?? env['JEEVES_MCP_PROFILE']);
  if (profile === 'none') {
    return undefined;
  }

  const out: Record<string, McpServerConfig> = {};

  if (shouldIncludeState(profile)) {
    const entrypoint = resolveStateEntrypoint(env);
    if (!entrypoint) {
      throw new Error('Unable to resolve mcp-state entrypoint');
    }
    const normalizedStateDir = requiredStateDir(options);
    out['state'] = {
      command: 'node',
      args: [entrypoint],
      env: {
        MCP_STATE_DIR: normalizedStateDir,
      },
    };
  }

  if (shouldIncludePruner(profile)) {
    if (env['JEEVES_PRUNER_ENABLED'] === 'true') {
      const entrypoint = resolvePrunerEntrypoint(env);
      if (entrypoint) {
        const prunerUrl =
          env['JEEVES_PRUNER_URL'] !== undefined
            ? env['JEEVES_PRUNER_URL']
            : 'http://localhost:8000/prune';
        out['pruner'] = {
          command: 'node',
          args: [entrypoint],
          env: {
            PRUNER_URL: prunerUrl,
            MCP_PRUNER_CWD: cwd,
          },
        };
      } else if (shouldRequirePruner(profile)) {
        throw new Error('Unable to resolve mcp-pruner entrypoint');
      }
    } else if (shouldRequirePruner(profile)) {
      throw new Error('MCP profile "pruner" requires JEEVES_PRUNER_ENABLED=true');
    }
  }

  if (Object.keys(out).length === 0) {
    return undefined;
  }

  return out;
}
