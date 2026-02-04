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

/** Query key for Sonar token status. */
export const sonarTokenQueryKey = (baseUrl: string) => ['sonarToken', baseUrl] as const;

/**
 * Hook to fetch the Sonar token status for the selected issue.
 *
 * @param baseUrl - The viewer server base URL
 * @param enabled - Whether the query should run (e.g., false when no issue is selected)
 */
export function useSonarTokenStatus(baseUrl: string, enabled: boolean) {
  return useQuery<SonarTokenStatusResponse>({
    queryKey: sonarTokenQueryKey(baseUrl),
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
 */
export function usePutSonarTokenMutation(baseUrl: string) {
  const queryClient = useQueryClient();
  return useMutation<SonarTokenMutateResponse, Error, PutSonarTokenRequest>({
    mutationFn: (request) => putSonarToken(baseUrl, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sonarTokenQueryKey(baseUrl) });
    },
  });
}

/**
 * Hook to remove the Sonar token.
 */
export function useDeleteSonarTokenMutation(baseUrl: string) {
  const queryClient = useQueryClient();
  return useMutation<SonarTokenMutateResponse, Error, void>({
    mutationFn: () => deleteSonarToken(baseUrl),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sonarTokenQueryKey(baseUrl) });
    },
  });
}

/**
 * Hook to trigger a reconcile operation.
 */
export function useReconcileSonarTokenMutation(baseUrl: string) {
  const queryClient = useQueryClient();
  return useMutation<SonarTokenMutateResponse, Error, ReconcileSonarTokenRequest | undefined>({
    mutationFn: (request) => reconcileSonarToken(baseUrl, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sonarTokenQueryKey(baseUrl) });
    },
  });
}
