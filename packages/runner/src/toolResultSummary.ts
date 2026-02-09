import type { ToolResponseCompression, ToolResponseStructuredSummary } from './toolResultMetadata.js';

const DEFAULT_MAX_SUMMARY_CHARS = 2000;
const MAX_HIGHLIGHT_LINES = 24;
const MAX_STRUCTURED_PATHS = 12;
const MAX_STRUCTURED_LINE_NUMBERS = 12;
const NOISY_OUTPUT_LINE_THRESHOLD = 20;

const ERROR_LINE_PATTERN = /(error|exception|failed|fatal|traceback|assert|cannot|unable to|not found)/i;
const FILE_WITH_LINE_PATTERN = /(?:^|[\s("'`])([A-Za-z0-9_./\\-]+\.[A-Za-z0-9_]+):([0-9]{1,7})(?::[0-9]{1,7})?/g;
const FILE_PATH_PATTERN = /(?:^|[\s("'`])([A-Za-z0-9_./\\-]+\.[A-Za-z0-9_]+)(?=$|[\s)"'`:,\]])/g;
const LINE_NUMBER_PATTERN = /\bline\s+([0-9]{1,7})\b/gi;

function normalizeLine(line: string): string {
  return line.trim();
}

function uniqueLimited(values: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueNumberLimited(values: readonly number[], limit: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function splitNonEmptyLines(rawText: string): string[] {
  return rawText
    .split(/\r?\n/g)
    .map(normalizeLine)
    .filter(Boolean);
}

function truncateText(input: string, maxChars: number): { text: string; truncated: boolean } {
  if (input.length <= maxChars) return { text: input, truncated: false };
  return { text: input.slice(0, maxChars), truncated: true };
}

function parsePossibleLineNumber(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function collectStructuredSummary(params: {
  rawText: string;
  command?: string;
  exitCode?: number | null;
}): ToolResponseStructuredSummary {
  const lines = splitNonEmptyLines(params.rawText);
  const errorSignature = lines.find((line) => ERROR_LINE_PATTERN.test(line)) ?? null;

  const pathCandidates: string[] = [];
  const lineCandidates: number[] = [];

  for (const line of lines) {
    let withLineMatch: RegExpExecArray | null;
    while ((withLineMatch = FILE_WITH_LINE_PATTERN.exec(line)) !== null) {
      const filePath = withLineMatch[1]?.trim();
      const lineNumberRaw = withLineMatch[2];
      if (filePath) pathCandidates.push(filePath);
      const parsedLine = lineNumberRaw ? parsePossibleLineNumber(lineNumberRaw) : null;
      if (parsedLine !== null) lineCandidates.push(parsedLine);
    }
    FILE_WITH_LINE_PATTERN.lastIndex = 0;

    let pathMatch: RegExpExecArray | null;
    while ((pathMatch = FILE_PATH_PATTERN.exec(line)) !== null) {
      const filePath = pathMatch[1]?.trim();
      if (filePath) pathCandidates.push(filePath);
    }
    FILE_PATH_PATTERN.lastIndex = 0;

    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = LINE_NUMBER_PATTERN.exec(line)) !== null) {
      const parsedLine = lineMatch[1] ? parsePossibleLineNumber(lineMatch[1]) : null;
      if (parsedLine !== null) lineCandidates.push(parsedLine);
    }
    LINE_NUMBER_PATTERN.lastIndex = 0;
  }

  const filePaths = uniqueLimited(pathCandidates, MAX_STRUCTURED_PATHS);
  const lineNumbers = uniqueNumberLimited(lineCandidates, MAX_STRUCTURED_LINE_NUMBERS);

  const structured: ToolResponseStructuredSummary = {
    ...(params.command ? { command: params.command } : {}),
    ...(errorSignature ? { error_signature: errorSignature } : {}),
    ...(filePaths.length > 0 ? { file_paths: filePaths } : {}),
    ...(lineNumbers.length > 0 ? { line_numbers: lineNumbers } : {}),
    ...(params.exitCode !== undefined ? { exit_code: params.exitCode } : {}),
  };
  return structured;
}

function collectHighlights(rawText: string): string[] {
  const lines = splitNonEmptyLines(rawText);
  if (lines.length === 0) return [];

  const important: string[] = [];
  for (const line of lines) {
    if (ERROR_LINE_PATTERN.test(line) || FILE_WITH_LINE_PATTERN.test(line) || FILE_PATH_PATTERN.test(line)) {
      important.push(line);
    }
    FILE_WITH_LINE_PATTERN.lastIndex = 0;
    FILE_PATH_PATTERN.lastIndex = 0;
  }
  if (important.length === 0) {
    important.push(...lines.slice(0, MAX_HIGHLIGHT_LINES));
  } else if (important.length < MAX_HIGHLIGHT_LINES) {
    const firstLine = lines[0];
    if (firstLine) important.unshift(firstLine);
  }
  return uniqueLimited(important, MAX_HIGHLIGHT_LINES);
}

function buildExtractiveSummaryText(params: {
  structured: ToolResponseStructuredSummary;
  highlights: readonly string[];
}): string {
  const lines: string[] = [];
  if (params.structured.command) lines.push(`command: ${params.structured.command}`);
  if (params.structured.exit_code !== undefined) lines.push(`exit_code: ${String(params.structured.exit_code)}`);
  if (params.structured.error_signature) lines.push(`error_signature: ${params.structured.error_signature}`);
  if (params.structured.file_paths && params.structured.file_paths.length > 0) {
    lines.push(`file_paths: ${params.structured.file_paths.join(', ')}`);
  }
  if (params.structured.line_numbers && params.structured.line_numbers.length > 0) {
    lines.push(`line_numbers: ${params.structured.line_numbers.join(', ')}`);
  }

  if (params.highlights.length > 0) {
    lines.push('');
    lines.push('highlights:');
    for (const line of params.highlights) {
      lines.push(`- ${line}`);
    }
  }

  return lines.join('\n').trim();
}

function hasStructuredDetails(structured: ToolResponseStructuredSummary): boolean {
  return Boolean(
    structured.command ||
      structured.error_signature ||
      (structured.file_paths && structured.file_paths.length > 0) ||
      (structured.line_numbers && structured.line_numbers.length > 0) ||
      structured.exit_code !== undefined,
  );
}

export type ToolSummaryOptions = Readonly<{
  rawText: string;
  command?: string;
  exitCode?: number | null;
  maxChars?: number;
  forceStructuredSummary?: boolean;
}>;

export type ToolSummaryResult = Readonly<{
  summaryText: string;
  responseTruncated: boolean;
  compression: ToolResponseCompression;
}>;

export function summarizeToolResponse(options: ToolSummaryOptions): ToolSummaryResult {
  const maxChars = options.maxChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const rawText = options.rawText ?? '';
  const command = typeof options.command === 'string' && options.command.trim().length > 0
    ? options.command.trim()
    : undefined;
  const exitCode = typeof options.exitCode === 'number' && Number.isFinite(options.exitCode)
    ? Math.trunc(options.exitCode)
    : options.exitCode === null
      ? null
      : undefined;

  const lines = splitNonEmptyLines(rawText);
  const isNoisy = rawText.length > maxChars || lines.length > NOISY_OUTPUT_LINE_THRESHOLD;
  const shouldExtract = options.forceStructuredSummary || isNoisy;
  const structuredSummary = collectStructuredSummary({ rawText, command, exitCode });

  if (!shouldExtract) {
    const truncated = truncateText(rawText, maxChars);
    const mode = truncated.truncated ? 'truncated_preview' : 'none';
    return {
      summaryText: truncated.text,
      responseTruncated: truncated.truncated,
      compression: {
        mode,
        raw_char_count: rawText.length,
        summary_char_count: truncated.text.length,
        ...(truncated.truncated ? { truncation_reason: 'max_chars' as const } : {}),
        ...(hasStructuredDetails(structuredSummary)
          ? { structured_summary: structuredSummary }
          : {}),
      },
    };
  }

  const extractive = buildExtractiveSummaryText({
    structured: structuredSummary,
    highlights: collectHighlights(rawText),
  });
  const candidateSummary = extractive || rawText;
  const truncated = truncateText(candidateSummary, maxChars);
  const responseTruncated = truncated.truncated || truncated.text !== rawText;

  return {
    summaryText: truncated.text,
    responseTruncated,
    compression: {
      mode: 'extractive_summary',
      raw_char_count: rawText.length,
      summary_char_count: truncated.text.length,
      ...(truncated.truncated ? { truncation_reason: 'max_chars' as const } : {}),
      ...(hasStructuredDetails(structuredSummary)
        ? { structured_summary: structuredSummary }
        : {}),
    },
  };
}
