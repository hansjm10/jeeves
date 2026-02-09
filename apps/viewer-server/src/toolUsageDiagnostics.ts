function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DUPLICATE_QUERY_RATE_WARN_THRESHOLD = 0.15;
const LOCATOR_TO_READ_WARN_THRESHOLD = 3;
const MANY_GREP_WITHOUT_READ_THRESHOLD = 6;

export type ToolUsageDiagnostics = Readonly<{
  schema_version: 1;
  total_tool_calls: number;
  grep_calls: number;
  read_calls: number;
  duplicate_grep_calls: number;
  duplicate_query_rate: number;
  locator_to_read_ratio: number | null;
  warnings: string[];
}>;

export type ToolUsageDiagnosticsSummary = Readonly<{
  schema_version: 1;
  iterations_with_diagnostics: number;
  iterations_with_warnings: number;
  total_warnings: number;
  warning_counts: Record<string, number>;
  max_duplicate_query_rate: number;
  max_locator_to_read_ratio: number | null;
}>;

function classifyToolName(name: unknown): 'grep' | 'read' | 'other' {
  if (typeof name !== 'string') return 'other';
  const normalized = name.trim().toLowerCase();
  if (
    normalized === 'grep' ||
    normalized.endsWith('/grep') ||
    normalized.endsWith(':grep') ||
    normalized.endsWith('.grep')
  ) {
    return 'grep';
  }
  if (
    normalized === 'read' ||
    normalized.endsWith('/read') ||
    normalized.endsWith(':read') ||
    normalized.endsWith('.read')
  ) {
    return 'read';
  }
  return 'other';
}

function normalizeGrepQueryKey(input: unknown): string {
  if (!isPlainRecord(input)) return '{"invalid":true}';
  const pattern = typeof input.pattern === 'string' ? input.pattern : null;
  const patterns = Array.isArray(input.patterns)
    ? input.patterns.filter((v): v is string => typeof v === 'string')
    : null;
  const path = typeof input.path === 'string' ? input.path : '.';
  const contextLines = typeof input.context_lines === 'number' && Number.isFinite(input.context_lines)
    ? Math.trunc(input.context_lines)
    : 0;
  const maxMatches = typeof input.max_matches === 'number' && Number.isFinite(input.max_matches)
    ? Math.trunc(input.max_matches)
    : 200;

  return JSON.stringify({
    pattern,
    patterns,
    path,
    context_lines: contextLines,
    max_matches: maxMatches,
  });
}

function toToolCalls(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => isPlainRecord(entry));
}

export function computeToolUsageDiagnostics(toolCallsRaw: unknown): ToolUsageDiagnostics {
  const toolCalls = toToolCalls(toolCallsRaw);
  let grepCalls = 0;
  let readCalls = 0;
  let duplicateGrepCalls = 0;
  const seenGrepQueries = new Map<string, number>();

  for (const call of toolCalls) {
    const toolClass = classifyToolName(call.name);
    if (toolClass === 'grep') {
      grepCalls += 1;
      const key = normalizeGrepQueryKey(call.input);
      const seenCount = seenGrepQueries.get(key) ?? 0;
      if (seenCount > 0) duplicateGrepCalls += 1;
      seenGrepQueries.set(key, seenCount + 1);
    } else if (toolClass === 'read') {
      readCalls += 1;
    }
  }

  const duplicateQueryRate = grepCalls > 0 ? duplicateGrepCalls / grepCalls : 0;
  const locatorToReadRatio = readCalls > 0 ? grepCalls / readCalls : null;
  const warnings: string[] = [];

  if (grepCalls >= MANY_GREP_WITHOUT_READ_THRESHOLD && readCalls === 0) {
    warnings.push(
      `Many grep locator calls without read follow-up (${grepCalls} grep, 0 read).`,
    );
  }
  if (duplicateQueryRate > DUPLICATE_QUERY_RATE_WARN_THRESHOLD) {
    warnings.push(
      `High duplicate grep query rate (${(duplicateQueryRate * 100).toFixed(1)}%).`,
    );
  }
  if (locatorToReadRatio !== null && locatorToReadRatio > LOCATOR_TO_READ_WARN_THRESHOLD) {
    warnings.push(
      `High locator-to-read ratio (${locatorToReadRatio.toFixed(2)}).`,
    );
  }

  return {
    schema_version: 1,
    total_tool_calls: toolCalls.length,
    grep_calls: grepCalls,
    read_calls: readCalls,
    duplicate_grep_calls: duplicateGrepCalls,
    duplicate_query_rate: duplicateQueryRate,
    locator_to_read_ratio: locatorToReadRatio,
    warnings,
  };
}

export function computeToolUsageDiagnosticsFromSdkOutputRaw(
  raw: string,
): ToolUsageDiagnostics | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  return computeToolUsageDiagnostics(parsed.tool_calls);
}

export function mergeToolUsageDiagnosticsSummary(
  current: ToolUsageDiagnosticsSummary | null,
  diagnostics: ToolUsageDiagnostics,
): ToolUsageDiagnosticsSummary {
  const warningCounts: Record<string, number> = {
    ...(current?.warning_counts ?? {}),
  };
  for (const warning of diagnostics.warnings) {
    warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
  }

  let maxLocatorToReadRatio = current?.max_locator_to_read_ratio ?? null;
  if (diagnostics.locator_to_read_ratio !== null) {
    if (
      maxLocatorToReadRatio === null ||
      diagnostics.locator_to_read_ratio > maxLocatorToReadRatio
    ) {
      maxLocatorToReadRatio = diagnostics.locator_to_read_ratio;
    }
  }

  return {
    schema_version: 1,
    iterations_with_diagnostics: (current?.iterations_with_diagnostics ?? 0) + 1,
    iterations_with_warnings:
      (current?.iterations_with_warnings ?? 0) +
      (diagnostics.warnings.length > 0 ? 1 : 0),
    total_warnings: (current?.total_warnings ?? 0) + diagnostics.warnings.length,
    warning_counts: warningCounts,
    max_duplicate_query_rate: Math.max(
      current?.max_duplicate_query_rate ?? 0,
      diagnostics.duplicate_query_rate,
    ),
    max_locator_to_read_ratio: maxLocatorToReadRatio,
  };
}
