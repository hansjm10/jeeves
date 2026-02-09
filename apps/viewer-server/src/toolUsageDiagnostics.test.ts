import { describe, expect, it } from 'vitest';

import {
  computeToolUsageDiagnostics,
  computeToolUsageDiagnosticsFromSdkOutputRaw,
  mergeToolUsageDiagnosticsSummary,
} from './toolUsageDiagnostics.js';

describe('tool usage diagnostics', () => {
  it('computes duplicate and ratio metrics from tool calls', () => {
    const diagnostics = computeToolUsageDiagnostics([
      { name: 'mcp:pruner/grep', input: { pattern: 'foo', path: 'src/a.ts' } },
      { name: 'mcp:pruner/grep', input: { pattern: 'foo', path: 'src/a.ts' } },
      { name: 'mcp:pruner/grep', input: { pattern: 'bar', path: 'src/a.ts' } },
      { name: 'mcp:pruner/grep', input: { pattern: 'baz', path: 'src/a.ts' } },
      { name: 'mcp:pruner/read', input: { file_path: 'src/a.ts' } },
    ]);

    expect(diagnostics.total_tool_calls).toBe(5);
    expect(diagnostics.grep_calls).toBe(4);
    expect(diagnostics.read_calls).toBe(1);
    expect(diagnostics.duplicate_grep_calls).toBe(1);
    expect(diagnostics.duplicate_query_rate).toBe(0.25);
    expect(diagnostics.locator_to_read_ratio).toBe(4);
    expect(diagnostics.warnings.some((w) => w.includes('duplicate grep query rate'))).toBe(true);
    expect(diagnostics.warnings.some((w) => w.includes('locator-to-read ratio'))).toBe(true);
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
    expect(diagnostics.warnings.some((w) => w.includes('without read follow-up'))).toBe(true);
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

    expect(summary2.iterations_with_diagnostics).toBe(2);
    expect(summary2.iterations_with_warnings).toBeGreaterThanOrEqual(1);
    expect(summary2.max_duplicate_query_rate).toBeGreaterThan(0);
    expect(summary2.max_locator_to_read_ratio).not.toBeNull();
  });
});
