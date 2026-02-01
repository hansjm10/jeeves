import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiJson } from './http.js';
import type {
  IssueWorkflowSelectRequest,
  IssueWorkflowSelectResponse,
  WorkflowCreateRequest,
  WorkflowGetResponse,
  WorkflowListResponse,
} from './types.js';
import { queryKeys } from '../query/queryKeys.js';

function encodeWorkflowName(name: string): string {
  return encodeURIComponent(name);
}

export async function listWorkflows(baseUrl: string): Promise<WorkflowListResponse> {
  return apiJson<WorkflowListResponse>(baseUrl, '/api/workflows');
}

export async function getWorkflow(baseUrl: string, name: string): Promise<WorkflowGetResponse> {
  return apiJson<WorkflowGetResponse>(baseUrl, `/api/workflows/${encodeWorkflowName(name)}`);
}

export async function saveWorkflow(baseUrl: string, name: string, workflow: unknown): Promise<WorkflowGetResponse> {
  return apiJson<WorkflowGetResponse>(baseUrl, `/api/workflows/${encodeWorkflowName(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ workflow }),
  });
}

export async function createWorkflow(baseUrl: string, input: WorkflowCreateRequest): Promise<WorkflowGetResponse> {
  return apiJson<WorkflowGetResponse>(baseUrl, '/api/workflows', { method: 'POST', body: JSON.stringify(input) });
}

export async function selectIssueWorkflow(
  baseUrl: string,
  input: IssueWorkflowSelectRequest,
): Promise<IssueWorkflowSelectResponse> {
  return apiJson<IssueWorkflowSelectResponse>(baseUrl, '/api/issue/workflow', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function useWorkflowsQuery(baseUrl: string) {
  return useQuery({
    queryKey: queryKeys.workflows(baseUrl),
    queryFn: async () => listWorkflows(baseUrl),
  });
}

export function useWorkflowByNameQuery(baseUrl: string, name: string | null) {
  return useQuery({
    enabled: Boolean(name),
    queryKey: name ? queryKeys.workflowByName(baseUrl, name) : ['workflows', baseUrl, 'byName', '(none)'],
    queryFn: async () => {
      if (!name) throw new Error('Missing workflow name');
      return getWorkflow(baseUrl, name);
    },
  });
}

export function useSaveWorkflowMutation(baseUrl: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; workflow: unknown }) => saveWorkflow(baseUrl, input.name, input.workflow),
    onSuccess: async (_data, vars) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.workflows(baseUrl) }),
        qc.invalidateQueries({ queryKey: queryKeys.workflowByName(baseUrl, vars.name) }),
      ]);
    },
  });
}

export function useCreateWorkflowMutation(baseUrl: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: WorkflowCreateRequest) => createWorkflow(baseUrl, input),
    onSuccess: async (_data, vars) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.workflows(baseUrl) }),
        qc.invalidateQueries({ queryKey: queryKeys.workflowByName(baseUrl, vars.name) }),
      ]);
    },
  });
}

export function useSelectIssueWorkflowMutation(baseUrl: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: IssueWorkflowSelectRequest) => selectIssueWorkflow(baseUrl, input),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.workflow(baseUrl) });
    },
  });
}

