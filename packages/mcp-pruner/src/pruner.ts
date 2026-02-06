/**
 * swe-pruner HTTP client.
 *
 * Reads configuration from environment variables and provides a best-effort
 * pruneContent() function that falls back to original content on any failure.
 */

/** Pruner configuration resolved from environment variables. */
export interface PrunerConfig {
  /** Full URL of the pruner endpoint (empty string = pruning disabled). */
  url: string;
  /** Timeout in milliseconds for the outbound HTTP call. */
  timeoutMs: number;
  /** Whether pruning is enabled (url is non-empty). */
  enabled: boolean;
}

const DEFAULT_URL = "http://localhost:8000/prune";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;

/**
 * Resolve pruner configuration from process environment variables.
 *
 * - `PRUNER_URL`        – full URL; default `http://localhost:8000/prune`;
 *                         empty string disables pruning.
 * - `PRUNER_TIMEOUT_MS` – integer 100..300000; default 30000.
 */
export function getPrunerConfig(
  env: Record<string, string | undefined> = process.env,
): PrunerConfig {
  // --- URL ---
  const rawUrl = env.PRUNER_URL;
  const url = rawUrl === undefined ? DEFAULT_URL : rawUrl;

  // --- Timeout ---
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = env.PRUNER_TIMEOUT_MS;

  if (rawTimeout !== undefined && rawTimeout !== "") {
    const parsed = parseInt(rawTimeout, 10);
    if (Number.isNaN(parsed)) {
      process.stderr.write(
        `[mcp-pruner] Warning: PRUNER_TIMEOUT_MS is not a valid integer ("${rawTimeout}"), using default ${DEFAULT_TIMEOUT_MS}ms\n`,
      );
    } else if (parsed < MIN_TIMEOUT_MS) {
      timeoutMs = MIN_TIMEOUT_MS;
      process.stderr.write(
        `[mcp-pruner] Warning: PRUNER_TIMEOUT_MS (${parsed}) below minimum, clamped to ${MIN_TIMEOUT_MS}ms\n`,
      );
    } else if (parsed > MAX_TIMEOUT_MS) {
      timeoutMs = MAX_TIMEOUT_MS;
      process.stderr.write(
        `[mcp-pruner] Warning: PRUNER_TIMEOUT_MS (${parsed}) above maximum, clamped to ${MAX_TIMEOUT_MS}ms\n`,
      );
    } else {
      timeoutMs = parsed;
    }
  }

  return {
    url,
    timeoutMs,
    enabled: url !== "",
  };
}

/**
 * Attempt to prune `code` via the swe-pruner HTTP endpoint.
 *
 * On any failure (timeout, non-2xx, network error, invalid response payload),
 * returns the original `code` without throwing.
 *
 * @param code  - Raw tool output to prune.
 * @param query - The context focus question (passed verbatim).
 * @param config - Pruner configuration (from {@link getPrunerConfig}).
 * @returns The pruned text on success, or the original `code` on failure.
 */
export async function pruneContent(
  code: string,
  query: string,
  config: PrunerConfig,
): Promise<string> {
  if (!config.enabled) {
    return code;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    let response: Response;
    try {
      response = await fetch(config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, query }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      process.stderr.write(
        `[mcp-pruner] Pruner returned HTTP ${response.status}, falling back to original content\n`,
      );
      return code;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      process.stderr.write(
        `[mcp-pruner] Pruner response is not valid JSON, falling back to original content\n`,
      );
      return code;
    }

    if (body === null || typeof body !== "object") {
      process.stderr.write(
        `[mcp-pruner] Pruner response is not a JSON object, falling back to original content\n`,
      );
      return code;
    }

    const obj = body as Record<string, unknown>;

    // Accept pruned text from the first string field in priority order.
    for (const key of ["pruned_code", "content", "text"] as const) {
      if (typeof obj[key] === "string") {
        return obj[key] as string;
      }
    }

    process.stderr.write(
      `[mcp-pruner] Pruner response missing pruned_code/content/text string field, falling back to original content\n`,
    );
    return code;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[mcp-pruner] Pruner call failed (${message}), falling back to original content\n`,
    );
    return code;
  }
}
