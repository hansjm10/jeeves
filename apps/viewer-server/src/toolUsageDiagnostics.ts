function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DUPLICATE_QUERY_RATE_WARN_THRESHOLD = 0.15;
const LOCATOR_TO_READ_WARN_THRESHOLD = 3;
const MANY_GREP_WITHOUT_READ_THRESHOLD = 6;

export type ToolUsageDiagnostics = Readonly<{
  schema_version: 2;
  total_tool_calls: number;
  grep_calls: number;
  read_calls: number;
  duplicate_grep_calls: number;
  duplicate_query_rate: number;
  locator_to_read_ratio: number | null;
  truncated_tool_results_count: number;
  retrieval_handle_generated_count: number;
  retrieval_handle_resolved_count: number;
  unresolved_handle_count: number;
  raw_output_referenced_after_summary_count: number;
  duplicate_stale_context_reference_count: number;
  warnings: string[];
}>;

export type ToolUsageDiagnosticsSummary = Readonly<{
  schema_version: 2;
  iterations_with_diagnostics: number;
  iterations_with_warnings: number;
  total_warnings: number;
  warning_counts: Record<string, number>;
  max_duplicate_query_rate: number;
  max_locator_to_read_ratio: number | null;
  total_truncated_tool_results_count: number;
  total_retrieval_handle_generated_count: number;
  total_retrieval_handle_resolved_count: number;
  total_unresolved_handle_count: number;
  total_raw_output_referenced_after_summary_count: number;
  total_duplicate_stale_context_reference_count: number;
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
  const nestedArgs = isPlainRecord(input.arguments) ? input.arguments : null;
  const patternValue = input.pattern ?? nestedArgs?.pattern;
  const patternsValue = input.patterns ?? nestedArgs?.patterns;
  const pathValue = input.path ?? nestedArgs?.path;
  const contextLinesValue = input.context_lines ?? nestedArgs?.context_lines;
  const maxMatchesValue = input.max_matches ?? nestedArgs?.max_matches;

  const pattern = typeof patternValue === 'string' ? patternValue : null;
  const patterns = Array.isArray(patternsValue)
    ? patternsValue.filter((v): v is string => typeof v === 'string')
    : null;
  const searchPath = typeof pathValue === 'string' ? pathValue : '.';
  const contextLines = typeof contextLinesValue === 'number' && Number.isFinite(contextLinesValue)
    ? Math.trunc(contextLinesValue)
    : 0;
  const maxMatches = typeof maxMatchesValue === 'number' && Number.isFinite(maxMatchesValue)
    ? Math.trunc(maxMatchesValue)
    : 200;

  return JSON.stringify({
    pattern,
    patterns,
    path: searchPath,
    context_lines: contextLines,
    max_matches: maxMatches,
  });
}

function toToolCalls(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => isPlainRecord(entry));
}

function normalizeArtifactPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase();
}

function readPathFromToolInput(input: unknown): string | null {
  if (!isPlainRecord(input)) return null;
  const direct = input.file_path;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const nested = isPlainRecord(input.arguments) ? input.arguments.file_path : null;
  if (typeof nested === 'string' && nested.trim()) return nested;
  return null;
}

function parseRetrievalMeta(call: Record<string, unknown>): {
  status: 'available' | 'not_applicable' | null;
  handle: string | null;
  artifactPaths: string[];
} {
  const retrieval = call.response_retrieval;
  if (!isPlainRecord(retrieval)) {
    return { status: null, handle: null, artifactPaths: [] };
  }

  const statusRaw = retrieval.status;
  const status = statusRaw === 'available' || statusRaw === 'not_applicable' ? statusRaw : null;
  const handle = typeof retrieval.handle === 'string' && retrieval.handle.trim()
    ? retrieval.handle.trim()
    : null;
  const artifactPaths = Array.isArray(retrieval.artifact_paths)
    ? retrieval.artifact_paths
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map(normalizeArtifactPath)
    : [];

  return { status, handle, artifactPaths };
}

export function computeToolUsageDiagnostics(toolCallsRaw: unknown): ToolUsageDiagnostics {
  const toolCalls = toToolCalls(toolCallsRaw);
  let grepCalls = 0;
  let readCalls = 0;
  let duplicateGrepCalls = 0;
  let truncatedToolResultsCount = 0;
  const seenGrepQueries = new Map<string, number>();

  const generatedHandles = new Map<string, Set<string>>();
  const handlesRequiringFollowup = new Set<string>();
  const artifactPathToHandle = new Map<string, string>();

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

    if (call.response_truncated === true) truncatedToolResultsCount += 1;

    const retrieval = parseRetrievalMeta(call);
    if (retrieval.status !== 'available' || !retrieval.handle) continue;
    if (call.response_truncated === true) {
      handlesRequiringFollowup.add(retrieval.handle);
    }
    const existingPaths = generatedHandles.get(retrieval.handle) ?? new Set<string>();
    for (const artifactPath of retrieval.artifactPaths) {
      existingPaths.add(artifactPath);
      artifactPathToHandle.set(artifactPath, retrieval.handle);
    }
    generatedHandles.set(retrieval.handle, existingPaths);
  }

  const resolvedHandles = new Set<string>();
  let unresolvedHandleReferences = 0;
  let rawOutputReferencedAfterSummaryCount = 0;
  let duplicateStaleContextReferenceCount = 0;
  const readCountByArtifactPath = new Map<string, number>();

  for (const call of toolCalls) {
    if (classifyToolName(call.name) !== 'read') continue;
    const filePath = readPathFromToolInput(call.input);
    if (!filePath) continue;
    const normalizedPath = normalizeArtifactPath(filePath);
    const handle = artifactPathToHandle.get(normalizedPath);

    if (handle) {
      rawOutputReferencedAfterSummaryCount += 1;
      resolvedHandles.add(handle);
      const seen = readCountByArtifactPath.get(normalizedPath) ?? 0;
      if (seen > 0) duplicateStaleContextReferenceCount += 1;
      readCountByArtifactPath.set(normalizedPath, seen + 1);
      continue;
    }

    if (normalizedPath.includes('tool-raw/')) {
      unresolvedHandleReferences += 1;
    }
  }

  const duplicateQueryRate = grepCalls > 0 ? duplicateGrepCalls / grepCalls : 0;
  const locatorToReadRatio = readCalls > 0 ? grepCalls / readCalls : null;
  const retrievalHandleGeneratedCount = generatedHandles.size;
  const retrievalHandleResolvedCount = resolvedHandles.size;
  let resolvedHandlesRequiringFollowupCount = 0;
  for (const handle of resolvedHandles) {
    if (handlesRequiringFollowup.has(handle)) resolvedHandlesRequiringFollowupCount += 1;
  }
  const unresolvedGeneratedHandles = Math.max(
    0,
    handlesRequiringFollowup.size - resolvedHandlesRequiringFollowupCount,
  );
  const unresolvedHandleCount = unresolvedGeneratedHandles + unresolvedHandleReferences;
  const warnings: string[] = [];

  if (grepCalls >= MANY_GREP_WITHOUT_READ_THRESHOLD && readCalls === 0) {
    warnings.push(
      `Many grep locator calls without read follow-up (${grepCalls} grep, 0 read). Read exact files before concluding.`,
    );
  }
  if (duplicateQueryRate > DUPLICATE_QUERY_RATE_WARN_THRESHOLD) {
    warnings.push(
      `High duplicate grep query rate (${(duplicateQueryRate * 100).toFixed(1)}%). Refine search terms to avoid repeated scans.`,
    );
  }
  if (locatorToReadRatio !== null && locatorToReadRatio > LOCATOR_TO_READ_WARN_THRESHOLD) {
    warnings.push(
      `High locator-to-read ratio (${locatorToReadRatio.toFixed(2)}). Promote concrete file reads after locating hits.`,
    );
  }
  if (truncatedToolResultsCount > 0 && retrievalHandleGeneratedCount === 0) {
    warnings.push(
      `Truncated tool results detected (${truncatedToolResultsCount}) without retrieval handles. Persist raw output artifacts for recovery.`,
    );
  }
  if (unresolvedHandleCount > 0) {
    warnings.push(
      `Unresolved retrieval handles detected (${unresolvedHandleCount}). Use response_retrieval.artifact_paths to reopen raw outputs.`,
    );
  }
  if (truncatedToolResultsCount > 0 && rawOutputReferencedAfterSummaryCount === 0) {
    warnings.push(
      'Truncated summaries were not followed by raw artifact reads. Re-open raw outputs for brittle failures.',
    );
  }
  if (duplicateStaleContextReferenceCount > 0) {
    warnings.push(
      `Repeated raw artifact reads detected (${duplicateStaleContextReferenceCount}). Summarize once and reuse the extracted facts.`,
    );
  }

  return {
    schema_version: 2,
    total_tool_calls: toolCalls.length,
    grep_calls: grepCalls,
    read_calls: readCalls,
    duplicate_grep_calls: duplicateGrepCalls,
    duplicate_query_rate: duplicateQueryRate,
    locator_to_read_ratio: locatorToReadRatio,
    truncated_tool_results_count: truncatedToolResultsCount,
    retrieval_handle_generated_count: retrievalHandleGeneratedCount,
    retrieval_handle_resolved_count: retrievalHandleResolvedCount,
    unresolved_handle_count: unresolvedHandleCount,
    raw_output_referenced_after_summary_count: rawOutputReferencedAfterSummaryCount,
    duplicate_stale_context_reference_count: duplicateStaleContextReferenceCount,
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
    schema_version: 2,
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
    total_truncated_tool_results_count:
      (current?.total_truncated_tool_results_count ?? 0) +
      diagnostics.truncated_tool_results_count,
    total_retrieval_handle_generated_count:
      (current?.total_retrieval_handle_generated_count ?? 0) +
      diagnostics.retrieval_handle_generated_count,
    total_retrieval_handle_resolved_count:
      (current?.total_retrieval_handle_resolved_count ?? 0) +
      diagnostics.retrieval_handle_resolved_count,
    total_unresolved_handle_count:
      (current?.total_unresolved_handle_count ?? 0) +
      diagnostics.unresolved_handle_count,
    total_raw_output_referenced_after_summary_count:
      (current?.total_raw_output_referenced_after_summary_count ?? 0) +
      diagnostics.raw_output_referenced_after_summary_count,
    total_duplicate_stale_context_reference_count:
      (current?.total_duplicate_stale_context_reference_count ?? 0) +
      diagnostics.duplicate_stale_context_reference_count,
  };
}
