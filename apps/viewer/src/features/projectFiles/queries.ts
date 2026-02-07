import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  ProjectFilesStatusResponse,
  ProjectFilesMutateResponse,
  PutProjectFileRequest,
  ReconcileProjectFilesRequest,
} from '../../api/projectFilesTypes.js';
import {
  getProjectFilesStatus,
  putProjectFile,
  deleteProjectFileById,
  reconcileProjectFiles,
} from './api.js';

export const projectFilesQueryKey = (baseUrl: string, issueRef: string | null = null) =>
  ['projectFiles', baseUrl, issueRef] as const;

export function useProjectFilesStatus(baseUrl: string, enabled: boolean, issueRef: string | null = null) {
  return useQuery<ProjectFilesStatusResponse>({
    queryKey: projectFilesQueryKey(baseUrl, issueRef),
    queryFn: () => getProjectFilesStatus(baseUrl),
    enabled,
    refetchInterval: 30000,
    refetchOnWindowFocus: false,
  });
}

export function usePutProjectFileMutation(baseUrl: string, issueRef: string | null = null) {
  const queryClient = useQueryClient();
  return useMutation<ProjectFilesMutateResponse, Error, PutProjectFileRequest>({
    mutationFn: (request) => putProjectFile(baseUrl, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectFilesQueryKey(baseUrl, issueRef) });
    },
  });
}

export function useDeleteProjectFileMutation(baseUrl: string, issueRef: string | null = null) {
  const queryClient = useQueryClient();
  return useMutation<ProjectFilesMutateResponse, Error, string>({
    mutationFn: (id) => deleteProjectFileById(baseUrl, id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectFilesQueryKey(baseUrl, issueRef) });
    },
  });
}

export function useReconcileProjectFilesMutation(baseUrl: string, issueRef: string | null = null) {
  const queryClient = useQueryClient();
  return useMutation<ProjectFilesMutateResponse, Error, ReconcileProjectFilesRequest | undefined>({
    mutationFn: (request) => reconcileProjectFiles(baseUrl, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectFilesQueryKey(baseUrl, issueRef) });
    },
  });
}
