/**
 * API client functions for Azure DevOps credential management.
 *
 * These functions wrap the HTTP endpoints for Azure DevOps credential operations.
 * IMPORTANT: PAT values are NEVER returned or logged.
 */

import type {
  AzureDevopsStatusResponse,
  AzureMutateResponse,
  AzureDevopsErrorResponse,
  PutAzureDevopsRequest,
  PatchAzureDevopsRequest,
  ReconcileAzureDevopsRequest,
} from '../../api/azureDevopsTypes.js';

/**
 * Custom error class that preserves field-level validation errors from 400 responses.
 * Used by components to display inline per-field error messages.
 */
export class ApiValidationError extends Error {
  readonly fieldErrors: Record<string, string>;
  readonly code: string;

  constructor(message: string, code: string, fieldErrors: Record<string, string>) {
    super(message);
    this.name = 'ApiValidationError';
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

/**
 * Make an API request that may return field_errors on 400 validation_failed responses.
 * Unlike the generic apiJson, this preserves field_errors for inline error display.
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
 * Get the current Azure DevOps status for the selected issue.
 */
export async function getAzureDevopsStatus(baseUrl: string): Promise<AzureDevopsStatusResponse> {
  return apiJsonWithFieldErrors<AzureDevopsStatusResponse>(baseUrl, '/api/issue/azure-devops');
}

/**
 * Save or update Azure DevOps credentials for the selected issue.
 * PAT input is cleared after save - PAT is never displayed.
 */
export async function putAzureDevops(
  baseUrl: string,
  request: PutAzureDevopsRequest,
): Promise<AzureMutateResponse> {
  return apiJsonWithFieldErrors<AzureMutateResponse>(baseUrl, '/api/issue/azure-devops', {
    method: 'PUT',
    body: JSON.stringify(request),
  });
}

/**
 * Partially update Azure DevOps credentials for the selected issue.
 */
export async function patchAzureDevops(
  baseUrl: string,
  request: PatchAzureDevopsRequest,
): Promise<AzureMutateResponse> {
  return apiJsonWithFieldErrors<AzureMutateResponse>(baseUrl, '/api/issue/azure-devops', {
    method: 'PATCH',
    body: JSON.stringify(request),
  });
}

/**
 * Remove Azure DevOps credentials for the selected issue.
 */
export async function deleteAzureDevops(baseUrl: string): Promise<AzureMutateResponse> {
  return apiJsonWithFieldErrors<AzureMutateResponse>(baseUrl, '/api/issue/azure-devops', {
    method: 'DELETE',
  });
}

/**
 * Trigger a reconcile operation to sync Azure DevOps credentials to the worktree.
 */
export async function reconcileAzureDevops(
  baseUrl: string,
  request?: ReconcileAzureDevopsRequest,
): Promise<AzureMutateResponse> {
  return apiJsonWithFieldErrors<AzureMutateResponse>(baseUrl, '/api/issue/azure-devops/reconcile', {
    method: 'POST',
    body: request ? JSON.stringify(request) : undefined,
  });
}
