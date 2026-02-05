import { useMutation, useQueryClient } from '@tanstack/react-query';

import { apiJson } from '../api/http.js';
import type { CreateIssueRequest, CreateIssueResponse, SetTaskExecutionRequest, SetTaskExecutionResponse, StartRunInput } from '../api/types.js';
import { encodePathPreservingSlashes } from '../api/paths.js';
import { queryKeys } from '../query/queryKeys.js';

export function useSelectIssueMutation(baseUrl: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (issueRef: string) =>
      apiJson(baseUrl, '/api/issues/select', { method: 'POST', body: JSON.stringify({ issue_ref: issueRef }) }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: queryKeys.issues(baseUrl) }), qc.invalidateQueries({ queryKey: queryKeys.workflow(baseUrl) })]);
    },
  });
}

export function useInitIssueMutation(baseUrl: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { repo: string; issue: number }) =>
      apiJson(baseUrl, '/api/init/issue', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: queryKeys.issues(baseUrl) }), qc.invalidateQueries({ queryKey: queryKeys.workflow(baseUrl) })]);
    },
  });
}

export function useCreateIssueMutation(baseUrl: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateIssueRequest) =>
      apiJson<CreateIssueResponse>(baseUrl, '/api/github/issues/create', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.issues(baseUrl) });
    },
  });
}

/**
 * Builds the request body for starting a run.
 * Exported for testing purposes.
 */
export function buildStartRunRequestBody(input: StartRunInput): { provider: string; max_iterations?: number } {
  const body: { provider: string; max_iterations?: number } = { provider: input.provider };
  if (input.max_iterations !== undefined) {
    body.max_iterations = input.max_iterations;
  }
  return body;
}

export function useStartRunMutation(baseUrl: string) {
  return useMutation({
    mutationFn: async (input: StartRunInput) => {
      const body = buildStartRunRequestBody(input);
      return apiJson(baseUrl, '/api/run', { method: 'POST', body: JSON.stringify(body) });
    },
  });
}

export function useStopRunMutation(baseUrl: string) {
  return useMutation({
    mutationFn: async (input: { force: boolean }) => apiJson(baseUrl, '/api/run/stop', { method: 'POST', body: JSON.stringify(input) }),
  });
}

export function useSetIssuePhaseMutation(baseUrl: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (phase: string) => apiJson(baseUrl, '/api/issue/status', { method: 'POST', body: JSON.stringify({ phase }) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.workflow(baseUrl) });
    },
  });
}

export function useSetTaskExecutionMutation(baseUrl: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetTaskExecutionRequest) =>
      apiJson<SetTaskExecutionResponse>(baseUrl, '/api/issue/task-execution', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: async () => {
      // settings are reflected in state snapshots; ensure issue list and workflow re-fetch if needed
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.issues(baseUrl) }),
        qc.invalidateQueries({ queryKey: queryKeys.workflow(baseUrl) }),
      ]);
    },
  });
}

export function useSavePromptMutation(baseUrl: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; content: string }) =>
      apiJson(baseUrl, `/api/prompts/${encodePathPreservingSlashes(input.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ content: input.content }),
      }),
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries({ queryKey: queryKeys.prompt(baseUrl, vars.id) });
    },
  });
}
