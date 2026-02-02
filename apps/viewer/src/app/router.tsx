import { createBrowserRouter, Navigate } from 'react-router-dom';

import { AppShell } from '../layout/AppShell.js';
import { CreateIssuePage } from '../pages/CreateIssuePage.js';
import { PromptsPage } from '../pages/PromptsPage.js';
import { WatchPage } from '../pages/WatchPage.js';
import { WorkflowsPage } from '../pages/WorkflowsPage.js';

export function makeRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter([
    {
      path: '/',
      element: <AppShell />,
      children: [
        { index: true, element: <Navigate to="/watch" replace /> },
        { path: 'watch', element: <WatchPage /> },
        // Legacy routes redirect to Watch with explicit view mapping
        { path: 'sdk', element: <Navigate to="/watch?view=sdk" replace /> },
        { path: 'logs', element: <Navigate to="/watch?view=logs" replace /> },
        { path: 'viewer-logs', element: <Navigate to="/watch?view=viewer-logs" replace /> },
        { path: 'workflows', element: <WorkflowsPage /> },
        { path: 'create-issue', element: <CreateIssuePage /> },
        { path: 'prompts/*', element: <PromptsPage /> },
        { path: '*', element: <Navigate to="/watch" replace /> },
      ],
    },
  ]);
}
