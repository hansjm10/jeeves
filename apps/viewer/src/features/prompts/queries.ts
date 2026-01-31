import { useQuery } from '@tanstack/react-query';

import { apiJson } from '../../api/http.js';
import { encodePathPreservingSlashes } from '../../api/paths.js';
import type { PromptGetResponse, PromptListResponse } from '../../api/types.js';
import { queryKeys } from '../../query/queryKeys.js';

export function usePromptListQuery(baseUrl: string) {
  return useQuery({
    queryKey: queryKeys.prompts(baseUrl),
    queryFn: async () => apiJson<PromptListResponse>(baseUrl, '/api/prompts'),
  });
}

export function usePromptQuery(baseUrl: string, id: string | null) {
  return useQuery({
    enabled: Boolean(id),
    queryKey: id ? queryKeys.prompt(baseUrl, id) : ['prompt', baseUrl, '(none)'],
    queryFn: async () => {
      if (!id) throw new Error('Missing prompt id');
      return apiJson<PromptGetResponse>(baseUrl, `/api/prompts/${encodePathPreservingSlashes(id)}`);
    },
  });
}

