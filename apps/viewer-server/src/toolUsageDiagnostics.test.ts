import { describe, expect, it } from 'vitest';

import {
  computeToolUsageDiagnostics,
  computeToolUsageDiagnosticsFromSdkOutputRaw,
  mergeToolUsageDiagnosticsSummary,
} from './toolUsageDiagnostics.js';

describe('tool usage diagnostics', () => {
  it('computes hygiene + retrieval metrics from tool calls', () => {
    const diagnostics = computeToolUsageDiagnostics([
      {
        name: 'mcp:pruner/grep',
        input: { arguments: { pattern: 'foo', path: 'src/a.ts' } },
      },
      {
        name: 'mcp:pruner/grep',
        input: { arguments: { pattern: 'foo', path: 'src/a.ts' } },
      },
      {
        name: 'mcp:pruner/read',
        input: { arguments: { file_path: 'src/a.ts' } },
      },
      {
        name: 'command_execution',
        input: { command: 'pnpm test' },
        response_truncated: true,
        response_retrieval: {
          status: 'available',
          handle: 'tool-output://abc',
          artifact_paths: ['tool-raw/abc.part-001.txt'],
        },
      },
      {
        name: 'read',
        input: { file_path: 'tool-raw/abc.part-001.txt' },
      },
      {
        name: 'read',
        input: { file_path: 'tool-raw/abc.part-001.txt' },
      },
    ]);

    expect(diagnostics.schema_version).toBe(2);
    expect(diagnostics.total_tool_calls).toBe(6);
    expect(diagnostics.grep_calls).toBe(2);
    expect(diagnostics.read_calls).toBe(3);
    expect(diagnostics.duplicate_grep_calls).toBe(1);
    expect(diagnostics.duplicate_query_rate).toBe(0.5);
    expect(diagnostics.truncated_tool_results_count).toBe(1);
    expect(diagnostics.retrieval_handle_generated_count).toBe(1);
    expect(diagnostics.retrieval_handle_resolved_count).toBe(1);
    expect(diagnostics.unresolved_handle_count).toBe(0);
    expect(diagnostics.raw_output_referenced_after_summary_count).toBe(2);
    expect(diagnostics.duplicate_stale_context_reference_count).toBe(1);
    expect(diagnostics.warnings.some((warning) => warning.includes('duplicate grep query rate'))).toBe(true);
    expect(diagnostics.warnings.some((warning) => warning.includes('Repeated raw artifact reads'))).toBe(true);
  });

  it('warns when many grep calls happen without any read calls', () => {
    const diagnostics = computeToolUsageDiagnostics([
      { name: 'mcp:pruner/grep', input: { pattern: 'a' } },
      { name: 'mcp:pruner/grep', input: { pattern: 'b' } },
      { name: 'mcp:pruner/grep', input: { pattern: 'c' } },
      { name: 'mcp:pruner/grep', input: { pattern: 'd' } },
      { name: 'mcp:pruner/grep', input: { pattern: 'e' } },
      { name: 'mcp:pruner/grep', input: { pattern: 'f' } },
    ]);

    expect(diagnostics.read_calls).toBe(0);
    expect(diagnostics.warnings.some((warning) => warning.includes('without read follow-up'))).toBe(true);
  });

  it('tracks unresolved retrieval handles when raw artifacts are missing', () => {
    const diagnostics = computeToolUsageDiagnostics([
      {
        name: 'command_execution',
        input: { command: 'pnpm lint' },
        response_truncated: true,
        response_retrieval: {
          status: 'available',
          handle: 'tool-output://lint',
          artifact_paths: ['tool-raw/lint.part-001.txt'],
        },
      },
      {
        name: 'read',
        input: { file_path: 'tool-raw/unknown.part-001.txt' },
      },
    ]);

    expect(diagnostics.retrieval_handle_generated_count).toBe(1);
    expect(diagnostics.retrieval_handle_resolved_count).toBe(0);
    expect(diagnostics.unresolved_handle_count).toBe(2);
    expect(diagnostics.warnings.some((warning) => warning.includes('Unresolved retrieval handles'))).toBe(true);
  });

  it('parses diagnostics from sdk-output JSON payload', () => {
    const raw = JSON.stringify({
      schema: 'jeeves.sdk.v1',
      tool_calls: [
        { name: 'grep', input: { pattern: 'x' } },
        { name: 'read', input: { file_path: 'x.ts' } },
      ],
    });
    const diagnostics = computeToolUsageDiagnosticsFromSdkOutputRaw(raw);
    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.grep_calls).toBe(1);
    expect(diagnostics?.read_calls).toBe(1);
  });

  it('returns null when sdk-output is invalid JSON', () => {
    expect(computeToolUsageDiagnosticsFromSdkOutputRaw('{not-json')).toBeNull();
  });

  it('merges diagnostic summaries across iterations', () => {
    const first = computeToolUsageDiagnostics([
      { name: 'grep', input: { pattern: 'foo' } },
      { name: 'grep', input: { pattern: 'foo' } },
      { name: 'read', input: { file_path: 'a.ts' } },
      {
        name: 'bash',
        input: { command: 'pnpm test' },
        response_truncated: true,
        response_retrieval: {
          status: 'available',
          handle: 'tool-output://test',
          artifact_paths: ['tool-raw/test.part-001.txt'],
        },
      },
      {
        name: 'read',
        input: { file_path: 'tool-raw/test.part-001.txt' },
      },
    ]);
    const second = computeToolUsageDiagnostics([
      { name: 'grep', input: { pattern: 'bar' } },
      { name: 'grep', input: { pattern: 'baz' } },
      { name: 'grep', input: { pattern: 'qux' } },
      { name: 'grep', input: { pattern: 'quux' } },
      { name: 'read', input: { file_path: 'b.ts' } },
    ]);

    const summary1 = mergeToolUsageDiagnosticsSummary(null, first);
    const summary2 = mergeToolUsageDiagnosticsSummary(summary1, second);

    expect(summary2.schema_version).toBe(2);
    expect(summary2.iterations_with_diagnostics).toBe(2);
    expect(summary2.iterations_with_warnings).toBeGreaterThanOrEqual(1);
    expect(summary2.max_duplicate_query_rate).toBeGreaterThan(0);
    expect(summary2.max_locator_to_read_ratio).not.toBeNull();
    expect(summary2.total_truncated_tool_results_count).toBe(first.truncated_tool_results_count + second.truncated_tool_results_count);
    expect(summary2.total_retrieval_handle_generated_count).toBe(first.retrieval_handle_generated_count + second.retrieval_handle_generated_count);
  });
});
