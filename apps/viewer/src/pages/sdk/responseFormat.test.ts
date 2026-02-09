import { describe, expect, it } from 'vitest';

import { normalizeToolInputForRenderer, parseToolResponse } from './responseFormat.js';

describe('parseToolResponse', () => {
  it('returns null for undefined responses', () => {
    expect(parseToolResponse(undefined)).toBeNull();
  });

  it('returns text for non-JSON responses', () => {
    expect(parseToolResponse('plain output')).toEqual({
      kind: 'text',
      text: 'plain output',
    });
  });

  it('returns formatted JSON for JSON responses', () => {
    expect(parseToolResponse('{"ok":true}')).toEqual({
      kind: 'json',
      data: { ok: true },
    });
  });

  it('extracts text blocks from MCP content payloads', () => {
    const response = JSON.stringify({
      content: [{ type: 'text', text: '1: line one\n2: line two' }],
      structured_content: null,
    });

    expect(parseToolResponse(response)).toEqual({
      kind: 'text',
      text: '1: line one\n2: line two',
    });
  });
});

describe('normalizeToolInputForRenderer', () => {
  it('returns MCP arguments when present', () => {
    expect(
      normalizeToolInputForRenderer('mcp:pruner/read', {
        server: 'pruner',
        tool: 'read',
        arguments: { file_path: 'x.ts', start_line: 1 },
      }),
    ).toEqual({ file_path: 'x.ts', start_line: 1 });
  });

  it('returns original input for non-MCP tools', () => {
    const input = { file_path: 'x.ts' };
    expect(normalizeToolInputForRenderer('Read', input)).toBe(input);
  });
});
