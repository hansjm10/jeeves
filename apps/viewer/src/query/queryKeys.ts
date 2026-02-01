export const queryKeys = {
  issues: (baseUrl: string) => ['issues', baseUrl] as const,
  workflow: (baseUrl: string) => ['workflow', baseUrl] as const,
  workflows: (baseUrl: string) => ['workflows', baseUrl] as const,
  workflowByName: (baseUrl: string, name: string) => ['workflows', baseUrl, 'byName', name] as const,
  prompts: (baseUrl: string) => ['prompts', baseUrl] as const,
  prompt: (baseUrl: string, id: string) => ['prompt', baseUrl, id] as const,
};
