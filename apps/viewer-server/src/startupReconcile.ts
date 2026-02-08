import {
  reconcilePromptsFromFiles,
  reconcileWorkflowsFromFiles,
} from './contentStore.js';
import {
  readIssueFromDb,
  readTasksFromDb,
} from './sqliteStorage.js';

export type StartupReconcileSummary = Readonly<{
  promptsSynced: number;
  workflowsSynced: number;
  issueSynced: boolean;
  tasksSynced: boolean;
  bootstrapRan: boolean;
  bootstrapIssuesImported: number;
  bootstrapTasksImported: number;
  bootstrapActiveIssueImported: boolean;
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
    issueSynced = readIssueFromDb(params.selectedStateDir) !== null;
    tasksSynced = readTasksFromDb(params.selectedStateDir) !== null;
  }

  return {
    promptsSynced,
    workflowsSynced,
    issueSynced,
    tasksSynced,
    bootstrapRan: false,
    bootstrapIssuesImported: 0,
    bootstrapTasksImported: 0,
    bootstrapActiveIssueImported: false,
  };
}
