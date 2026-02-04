/**
 * API client functions for Sonar token management.
 *
 * These functions wrap the HTTP endpoints for token operations.
 * IMPORTANT: Token values are NEVER returned or logged.
 */

import { apiJson } from '../../api/http.js';
import type {
  SonarTokenStatusResponse,
  SonarTokenMutateResponse,
  PutSonarTokenRequest,
  ReconcileSonarTokenRequest,
} from '../../api/sonarTokenTypes.js';

/**
 * Get the current Sonar token status for the selected issue.
 */
export async function getSonarTokenStatus(baseUrl: string): Promise<SonarTokenStatusResponse> {
  return apiJson<SonarTokenStatusResponse>(baseUrl, '/api/issue/sonar-token');
}

/**
 * Save or update the Sonar token for the selected issue.
 * Token input is cleared after save - token is never displayed.
 */
export async function putSonarToken(
  baseUrl: string,
  request: PutSonarTokenRequest,
): Promise<SonarTokenMutateResponse> {
  return apiJson<SonarTokenMutateResponse>(baseUrl, '/api/issue/sonar-token', {
    method: 'PUT',
    body: JSON.stringify(request),
  });
}

/**
 * Remove the Sonar token for the selected issue.
 */
export async function deleteSonarToken(baseUrl: string): Promise<SonarTokenMutateResponse> {
  return apiJson<SonarTokenMutateResponse>(baseUrl, '/api/issue/sonar-token', {
    method: 'DELETE',
  });
}

/**
 * Trigger a reconcile operation to sync the token to the worktree.
 */
export async function reconcileSonarToken(
  baseUrl: string,
  request?: ReconcileSonarTokenRequest,
): Promise<SonarTokenMutateResponse> {
  return apiJson<SonarTokenMutateResponse>(baseUrl, '/api/issue/sonar-token/reconcile', {
    method: 'POST',
    body: request ? JSON.stringify(request) : undefined,
  });
}
