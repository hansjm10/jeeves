import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useState } from 'react';

type UnsavedChangesApi = Readonly<{
  isDirty: boolean;
  setDirty: (dirty: boolean) => void;
  confirmDiscard: (message?: string) => boolean;
}>;

const UnsavedChangesContext = createContext<UnsavedChangesApi | null>(null);

export function UnsavedChangesProvider(props: { children: ReactNode }) {
  const [isDirty, setDirty] = useState(false);

  const api = useMemo<UnsavedChangesApi>(() => {
    return {
      isDirty,
      setDirty,
      confirmDiscard: (message?: string) => {
        if (!isDirty) return true;
        return window.confirm(message ?? 'Discard unsaved changes?');
      },
    };
  }, [isDirty]);

  return <UnsavedChangesContext.Provider value={api}>{props.children}</UnsavedChangesContext.Provider>;
}

export function useUnsavedChanges(): UnsavedChangesApi {
  const value = useContext(UnsavedChangesContext);
  if (!value) throw new Error('useUnsavedChanges must be used within UnsavedChangesProvider');
  return value;
}

