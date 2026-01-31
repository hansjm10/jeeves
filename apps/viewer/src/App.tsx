import { useMemo } from 'react';
import { RouterProvider } from 'react-router-dom';

import { AppProviders } from './app/AppProviders.js';
import { makeRouter } from './app/router.js';

const router = makeRouter();

export function App() {
  const baseUrl = useMemo(() => {
    const raw = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_VIEWER_SERVER_URL;
    return (raw ?? window.location.origin).trim();
  }, []);

  return (
    <AppProviders baseUrl={baseUrl}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}

