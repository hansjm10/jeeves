/**
 * React Query mutation hooks for provider-aware issue ingest.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  CreateProviderIssueRequest,
  InitFromExistingRequest,
  IngestResponse,
} from '../../api/azureDevopsTypes.js';
import { queryKeys } from '../../query/queryKeys.js';
import { createProviderIssue, initFromExisting } from './api.js';

/**
 * Hook to create a new issue via the provider-aware endpoint.
 */
export function useCreateProviderIssueMutation(baseUrl: string) {
  const queryClient = useQueryClient();
  return useMutation<IngestResponse, Error, CreateProviderIssueRequest>({
    mutationFn: (request) => createProviderIssue(baseUrl, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues(baseUrl) });
    },
  });
}

/**
 * Hook to initialize from an existing issue/work-item.
 */
export function useInitFromExistingMutation(baseUrl: string) {
  const queryClient = useQueryClient();
  return useMutation<IngestResponse, Error, InitFromExistingRequest>({
    mutationFn: (request) => initFromExisting(baseUrl, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues(baseUrl) });
    },
  });
}
