/**
 * API client functions for provider-aware issue create/init-from-existing.
 *
 * These endpoints replace the legacy /api/github/issues/create with
 * provider-aware /api/issues/create and /api/issues/init-from-existing.
 */

import type {
  CreateProviderIssueRequest,
  InitFromExistingRequest,
  IngestResponse,
  AzureDevopsErrorResponse,
} from '../../api/azureDevopsTypes.js';
import { ApiValidationError } from '../azureDevops/api.js';

/**
 * Make a provider-aware API request that may return field_errors on 400 responses.
 */
async function apiJsonWithFieldErrors<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = new URL(path, baseUrl);
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.method && init.method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const errorData = data as AzureDevopsErrorResponse | null;
    const msg = errorData?.error ?? `Request failed (${res.status})`;
    const code = errorData?.code ?? 'unknown';
    const fieldErrors = errorData?.field_errors;
    if (fieldErrors && Object.keys(fieldErrors).length > 0) {
      throw new ApiValidationError(msg, code, fieldErrors);
    }
    throw new Error(msg);
  }
  return data as T;
}

/**
 * Create a new issue via the provider-aware endpoint.
 * POST /api/issues/create
 */
export async function createProviderIssue(
  baseUrl: string,
  request: CreateProviderIssueRequest,
): Promise<IngestResponse> {
  return apiJsonWithFieldErrors<IngestResponse>(baseUrl, '/api/issues/create', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

/**
 * Initialize from an existing issue/work-item via the provider-aware endpoint.
 * POST /api/issues/init-from-existing
 */
export async function initFromExisting(
  baseUrl: string,
  request: InitFromExistingRequest,
): Promise<IngestResponse> {
  return apiJsonWithFieldErrors<IngestResponse>(baseUrl, '/api/issues/init-from-existing', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}
