import { describe, expect, it } from 'vitest';

import { getToolRenderer } from './index.js';

describe('getToolRenderer', () => {
  it('resolves known tool names directly', () => {
    expect(getToolRenderer('Read')).not.toBeNull();
    expect(getToolRenderer('read')).not.toBeNull();
  });

  it('resolves MCP tool names by suffix', () => {
    const direct = getToolRenderer('read');
    const mcp = getToolRenderer('mcp:pruner/read');
    expect(mcp).toBe(direct);
  });

  it('returns null for unknown MCP tool suffixes', () => {
    expect(getToolRenderer('mcp:pruner/not-a-tool')).toBeNull();
  });
});
