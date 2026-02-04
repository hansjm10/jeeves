/**
 * React Query hooks for Sonar token management.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  SonarTokenStatusResponse,
  SonarTokenMutateResponse,
  PutSonarTokenRequest,
  ReconcileSonarTokenRequest,
} from '../../api/sonarTokenTypes.js';
import { getSonarTokenStatus, putSonarToken, deleteSonarToken, reconcileSonarToken } from './api.js';

/**
 * Query key for Sonar token status.
 * Includes issueRef to trigger refetch when selected issue changes,
 * even when WebSocket events are unavailable.
 */
export const sonarTokenQueryKey = (baseUrl: string, issueRef: string | null = null) =>
  ['sonarToken', baseUrl, issueRef] as const;

/**
 * Hook to fetch the Sonar token status for the selected issue.
 *
 * @param baseUrl - The viewer server base URL
 * @param enabled - Whether the query should run (e.g., false when no issue is selected)
 * @param issueRef - The currently selected issue ref (included in query key to refetch on issue change)
 */
export function useSonarTokenStatus(baseUrl: string, enabled: boolean, issueRef: string | null = null) {
  return useQuery<SonarTokenStatusResponse>({
    queryKey: sonarTokenQueryKey(baseUrl, issueRef),
    queryFn: () => getSonarTokenStatus(baseUrl),
    enabled,
    // Refetch periodically to catch external changes
    refetchInterval: 30000,
    // Don't refetch on window focus since we get real-time updates via events
    refetchOnWindowFocus: false,
  });
}

/**
 * Hook to save/update the Sonar token.
 * Token input should be cleared after successful save.
 *
 * @param baseUrl - The viewer server base URL
 * @param issueRef - The currently selected issue ref (for precise query invalidation)
 */
export function usePutSonarTokenMutation(baseUrl: string, issueRef: string | null = null) {
  const queryClient = useQueryClient();
  return useMutation<SonarTokenMutateResponse, Error, PutSonarTokenRequest>({
    mutationFn: (request) => putSonarToken(baseUrl, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sonarTokenQueryKey(baseUrl, issueRef) });
    },
  });
}

/**
 * Hook to remove the Sonar token.
 *
 * @param baseUrl - The viewer server base URL
 * @param issueRef - The currently selected issue ref (for precise query invalidation)
 */
export function useDeleteSonarTokenMutation(baseUrl: string, issueRef: string | null = null) {
  const queryClient = useQueryClient();
  return useMutation<SonarTokenMutateResponse, Error, void>({
    mutationFn: () => deleteSonarToken(baseUrl),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sonarTokenQueryKey(baseUrl, issueRef) });
    },
  });
}

/**
 * Hook to trigger a reconcile operation.
 *
 * @param baseUrl - The viewer server base URL
 * @param issueRef - The currently selected issue ref (for precise query invalidation)
 */
export function useReconcileSonarTokenMutation(baseUrl: string, issueRef: string | null = null) {
  const queryClient = useQueryClient();
  return useMutation<SonarTokenMutateResponse, Error, ReconcileSonarTokenRequest | undefined>({
    mutationFn: (request) => reconcileSonarToken(baseUrl, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sonarTokenQueryKey(baseUrl, issueRef) });
    },
  });
}
