import { useQuery } from '@tanstack/react-query';

import { apiJson } from '../../api/http.js';
import type { IssueListResponse } from '../../api/types.js';
import { queryKeys } from '../../query/queryKeys.js';

export function useIssuesQuery(baseUrl: string) {
  return useQuery({
    queryKey: queryKeys.issues(baseUrl),
    queryFn: async () => apiJson<IssueListResponse>(baseUrl, '/api/issues'),
  });
}

