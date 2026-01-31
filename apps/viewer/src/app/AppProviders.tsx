import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ViewerStreamProvider } from '../stream/ViewerStreamProvider.js';
import { ToastProvider } from '../ui/toast/ToastProvider.js';
import { UnsavedChangesProvider } from '../ui/unsaved/UnsavedChangesProvider.js';
import { ViewerServerProvider } from './ViewerServerProvider.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function AppProviders(props: { baseUrl: string; children: ReactNode }) {
  return (
    <ViewerServerProvider baseUrl={props.baseUrl}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <UnsavedChangesProvider>
            <ViewerStreamProvider baseUrl={props.baseUrl}>{props.children}</ViewerStreamProvider>
          </UnsavedChangesProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ViewerServerProvider>
  );
}
