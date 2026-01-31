import { useQuery } from '@tanstack/react-query';

import { apiJson } from '../../api/http.js';
import type { WorkflowResponse } from '../../api/types.js';
import { queryKeys } from '../../query/queryKeys.js';

export function useWorkflowQuery(baseUrl: string) {
  return useQuery({
    queryKey: queryKeys.workflow(baseUrl),
    queryFn: async () => apiJson<WorkflowResponse>(baseUrl, '/api/workflow'),
  });
}

