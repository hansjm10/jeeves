import { createBrowserRouter, Navigate } from 'react-router-dom';

import { AppShell } from '../layout/AppShell.js';
import { CreateIssuePage } from '../pages/CreateIssuePage.js';
import { LogsPage } from '../pages/LogsPage.js';
import { PromptsPage } from '../pages/PromptsPage.js';
import { SdkPage } from '../pages/SdkPage.js';
import { ViewerLogsPage } from '../pages/ViewerLogsPage.js';

export function makeRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter([
    {
      path: '/',
      element: <AppShell />,
      children: [
        { index: true, element: <Navigate to="/sdk" replace /> },
        { path: 'sdk', element: <SdkPage /> },
        { path: 'create-issue', element: <CreateIssuePage /> },
        { path: 'logs', element: <LogsPage /> },
        { path: 'viewer-logs', element: <ViewerLogsPage /> },
        { path: 'prompts/*', element: <PromptsPage /> },
        { path: '*', element: <Navigate to="/sdk" replace /> },
      ],
    },
  ]);
}
