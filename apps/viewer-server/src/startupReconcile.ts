import {
  reconcilePromptsFromFiles,
  reconcileWorkflowsFromFiles,
} from './contentStore.js';
import { readIssueJson } from './issueJson.js';
import { readTasksJson } from './tasksStore.js';

export type StartupReconcileSummary = Readonly<{
  promptsSynced: number;
  workflowsSynced: number;
  issueSynced: boolean;
  tasksSynced: boolean;
}>;

export async function reconcileStartupState(params: {
  dataDir: string;
  promptsDir: string;
  workflowsDir: string;
  selectedStateDir: string | null;
}): Promise<StartupReconcileSummary> {
  const promptsSynced = await reconcilePromptsFromFiles(params.dataDir, params.promptsDir);
  const workflowsSynced = await reconcileWorkflowsFromFiles(params.dataDir, params.workflowsDir);

  let issueSynced = false;
  let tasksSynced = false;
  if (params.selectedStateDir) {
    issueSynced = (await readIssueJson(params.selectedStateDir)) !== null;
    tasksSynced = (await readTasksJson(params.selectedStateDir)) !== null;
  }

  return {
    promptsSynced,
    workflowsSynced,
    issueSynced,
    tasksSynced,
  };
}
