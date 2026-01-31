import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

type ToastApi = Readonly<{ pushToast: (message: string) => void }>;

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider(props: { children: ReactNode }) {
  const [toast, setToast] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const api = useMemo<ToastApi>(() => {
    return {
      pushToast: (message: string) => {
        setToast(message);
        if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => {
          timeoutRef.current = null;
          setToast(null);
        }, 3500);
      },
    };
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
  }, []);

  return <ToastContext.Provider value={api}>{props.children}{toast ? <div className="toast">{toast}</div> : null}</ToastContext.Provider>;
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used within ToastProvider');
  return value;
}
