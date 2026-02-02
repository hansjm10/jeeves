import { apiJson } from "./http.js";
import type {
  ExpandIssueRequest,
  ExpandIssueResponse,
  WorkflowGetResponse,
} from "./types.js";

/**
 * Workflow defaults (provider and optional model) extracted from a workflow config.
 */
export type WorkflowDefaults = Readonly<{
  provider: string;
  model?: string;
}>;

/**
 * Fetches the default workflow configuration and extracts provider/model defaults.
 * Falls back to 'claude' as the default provider if the workflow cannot be loaded.
 *
 * Exported for testing purposes.
 */
export async function getWorkflowDefaults(
  baseUrl: string,
): Promise<WorkflowDefaults> {
  try {
    const response = await apiJson<WorkflowGetResponse>(
      baseUrl,
      "/api/workflows/default",
    );
    const workflow = response.workflow;

    // Extract default_provider and default_model from workflow config
    const provider =
      typeof workflow.default_provider === "string" && workflow.default_provider
        ? workflow.default_provider
        : "claude";
    const model =
      typeof workflow.default_model === "string" && workflow.default_model
        ? workflow.default_model
        : undefined;

    return { provider, model };
  } catch {
    // If default workflow doesn't exist or request fails, use fallback
    return { provider: "claude" };
  }
}

/**
 * Builds the request body for expanding an issue.
 * Exported for testing purposes.
 */
export function buildExpandIssueRequestBody(
  input: ExpandIssueRequest,
): Record<string, unknown> {
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
export async function expandIssue(
  baseUrl: string,
  input: ExpandIssueRequest,
): Promise<ExpandIssueResponse> {
  const url = new URL("/api/github/issues/expand", baseUrl);
  const body = buildExpandIssueRequestBody(input);

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  // The endpoint always returns JSON with ok field
  if (data && typeof data === "object" && "ok" in data) {
    return data as ExpandIssueResponse;
  }

  // Fallback for unexpected response format
  return { ok: false, error: `Unexpected response (${res.status})` };
}
