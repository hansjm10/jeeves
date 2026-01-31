import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useState } from 'react';

type ToastApi = Readonly<{ pushToast: (message: string) => void }>;

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider(props: { children: ReactNode }) {
  const [toast, setToast] = useState<string | null>(null);

  const api = useMemo<ToastApi>(() => {
    return {
      pushToast: (message: string) => {
        setToast(message);
        window.setTimeout(() => setToast(null), 3500);
      },
    };
  }, []);

  return <ToastContext.Provider value={api}>{props.children}{toast ? <div className="toast">{toast}</div> : null}</ToastContext.Provider>;
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used within ToastProvider');
  return value;
}
