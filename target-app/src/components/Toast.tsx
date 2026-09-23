import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type ToastTone = "ok" | "bad" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  text?: string;
  leaving?: boolean;
}

interface ToastApi {
  show: (t: { tone?: ToastTone; title: string; text?: string }) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

const ICON: Record<ToastTone, ReactNode> = {
  ok: <CircleCheck size={16} aria-hidden="true" />,
  bad: <CircleAlert size={16} aria-hidden="true" />,
  info: <Info size={16} aria-hidden="true" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((all) => all.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    window.setTimeout(() => setItems((all) => all.filter((t) => t.id !== id)), 200);
  }, []);

  const show = useCallback(
    ({ tone = "ok", title, text }: { tone?: ToastTone; title: string; text?: string }) => {
      const id = ++seq.current;
      setItems((all) => [...all.slice(-3), { id, tone, title, text }]);
      window.setTimeout(() => dismiss(id), tone === "bad" ? 7000 : 4500);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`} data-leaving={t.leaving || undefined} role={t.tone === "bad" ? "alert" : "status"}>
            {ICON[t.tone]}
            <div className="toast__body">
              <div className="toast__title">{t.title}</div>
              {t.text && <div className="toast__text">{t.text}</div>}
            </div>
            <button type="button" className="toast__close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
