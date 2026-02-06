/**
 * React Query hooks for Azure DevOps credential management.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  AzureDevopsStatusResponse,
  AzureMutateResponse,
  PutAzureDevopsRequest,
  PatchAzureDevopsRequest,
  ReconcileAzureDevopsRequest,
} from '../../api/azureDevopsTypes.js';
import {
  getAzureDevopsStatus,
  putAzureDevops,
  patchAzureDevops,
  deleteAzureDevops,
  reconcileAzureDevops,
} from './api.js';

/**
 * Query key for Azure DevOps status.
 * Includes issueRef to trigger refetch when selected issue changes.
 */
export const azureDevopsQueryKey = (baseUrl: string, issueRef: string | null = null) =>
  ['azureDevops', baseUrl, issueRef] as const;

/**
 * Hook to fetch the Azure DevOps status for the selected issue.
 */
export function useAzureDevopsStatus(baseUrl: string, enabled: boolean, issueRef: string | null = null) {
  return useQuery<AzureDevopsStatusResponse>({
    queryKey: azureDevopsQueryKey(baseUrl, issueRef),
    queryFn: () => getAzureDevopsStatus(baseUrl),
    enabled,
    refetchInterval: 30000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Hook to save/update Azure DevOps credentials (PUT - full replacement).
 */
export function usePutAzureDevopsMutation(baseUrl: string, issueRef: string | null = null) {
  const queryClient = useQueryClient();
  return useMutation<AzureMutateResponse, Error, PutAzureDevopsRequest>({
    mutationFn: (request) => putAzureDevops(baseUrl, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: azureDevopsQueryKey(baseUrl, issueRef) });
    },
  });
}

/**
 * Hook to partially update Azure DevOps credentials (PATCH).
 */
export function usePatchAzureDevopsMutation(baseUrl: string, issueRef: string | null = null) {
  const queryClient = useQueryClient();
  return useMutation<AzureMutateResponse, Error, PatchAzureDevopsRequest>({
    mutationFn: (request) => patchAzureDevops(baseUrl, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: azureDevopsQueryKey(baseUrl, issueRef) });
    },
  });
}

/**
 * Hook to remove Azure DevOps credentials.
 */
export function useDeleteAzureDevopsMutation(baseUrl: string, issueRef: string | null = null) {
  const queryClient = useQueryClient();
  return useMutation<AzureMutateResponse, Error, void>({
    mutationFn: () => deleteAzureDevops(baseUrl),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: azureDevopsQueryKey(baseUrl, issueRef) });
    },
  });
}

/**
 * Hook to trigger a reconcile operation.
 */
export function useReconcileAzureDevopsMutation(baseUrl: string, issueRef: string | null = null) {
  const queryClient = useQueryClient();
  return useMutation<AzureMutateResponse, Error, ReconcileAzureDevopsRequest | undefined>({
    mutationFn: (request) => reconcileAzureDevops(baseUrl, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: azureDevopsQueryKey(baseUrl, issueRef) });
    },
  });
}
