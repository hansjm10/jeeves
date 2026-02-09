export type ParsedToolResponse =
  | Readonly<{ kind: 'json'; data: unknown }>
  | Readonly<{ kind: 'text'; text: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractMcpTextBlocks(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const content = value.content;
  if (!Array.isArray(content)) return [];

  const out: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'text') continue;
    if (typeof block.text !== 'string') continue;
    out.push(block.text);
  }
  return out;
}

export function parseToolResponse(responseText: string | undefined): ParsedToolResponse | null {
  if (responseText === undefined) return null;

  try {
    const parsed = JSON.parse(responseText) as unknown;
    const mcpText = extractMcpTextBlocks(parsed);
    if (mcpText.length > 0) {
      return { kind: 'text', text: mcpText.join('\n\n') };
    }
    return { kind: 'json', data: parsed };
  } catch {
    return { kind: 'text', text: responseText };
  }
}

export function normalizeToolInputForRenderer(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!toolName.trim().toLowerCase().startsWith('mcp:')) return input;
  const args = input.arguments;
  if (isRecord(args)) return args;
  return input;
}
