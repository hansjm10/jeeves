import type { ExpandIssueRequest, ExpandIssueResponse } from './types.js';

/**
 * Builds the request body for expanding an issue.
 * Exported for testing purposes.
 */
export function buildExpandIssueRequestBody(input: ExpandIssueRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { summary: input.summary };
  if (input.issue_type !== undefined) {
    body.issue_type = input.issue_type;
  }
  if (input.provider !== undefined) {
    body.provider = input.provider;
  }
  if (input.model !== undefined) {
    body.model = input.model;
  }
  return body;
}

/**
 * Calls the expand issue endpoint.
 * Returns the response directly - caller handles success/error states.
 */
export async function expandIssue(baseUrl: string, input: ExpandIssueRequest): Promise<ExpandIssueResponse> {
  const url = new URL('/api/github/issues/expand', baseUrl);
  const body = buildExpandIssueRequestBody(input);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  // The endpoint always returns JSON with ok field
  if (data && typeof data === 'object' && 'ok' in data) {
    return data as ExpandIssueResponse;
  }

  // Fallback for unexpected response format
  return { ok: false, error: `Unexpected response (${res.status})` };
}
