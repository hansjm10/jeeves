import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

const ViewerServerBaseUrlContext = createContext<string | null>(null);

export function ViewerServerProvider(props: { baseUrl: string; children: ReactNode }) {
  return <ViewerServerBaseUrlContext.Provider value={props.baseUrl}>{props.children}</ViewerServerBaseUrlContext.Provider>;
}

export function useViewerServerBaseUrl(): string {
  const value = useContext(ViewerServerBaseUrlContext);
  if (!value) throw new Error('useViewerServerBaseUrl must be used within ViewerServerProvider');
  return value;
}
