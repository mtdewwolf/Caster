import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastAction {
  label: string;
  onSelect: () => void;
}

export interface ToastInput {
  title: string;
  /** Optional detail. Keep it to what the person can act on. */
  description?: string;
  tone?: ToastTone;
  action?: ToastAction;
  /** Milliseconds before auto-dismiss. Errors persist until dismissed. */
  durationMs?: number;
}

interface Toast extends ToastInput {
  id: number;
  tone: ToastTone;
}

interface ToastContextValue {
  notify: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 6000;

const TONE_STYLES: Record<ToastTone, { border: string; icon: string; Icon: typeof Info }> = {
  info: { border: 'border-white/10', icon: 'text-blue-400', Icon: Info },
  success: { border: 'border-emerald-500/30', icon: 'text-emerald-400', Icon: CheckCircle2 },
  error: { border: 'border-rose-500/40', icon: 'text-rose-400', Icon: AlertTriangle }
};

/**
 * Turns a thrown value into something worth showing a person. API errors carry
 * a server-authored message; anything else falls back to the caller's wording
 * rather than leaking an internal stack or object shape.
 */
export function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    const tone = input.tone ?? 'info';
    setToasts((current) => [...current, { ...input, id, tone }]);

    // An error the person may need to act on should not vanish on its own.
    const duration = input.durationMs ?? (tone === 'error' ? 0 : DEFAULT_DURATION_MS);
    if (duration > 0) {
      timers.current.set(id, setTimeout(() => dismiss(id), duration));
    }
    return id;
  }, [dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo(() => ({ notify, dismiss }), [notify, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => {
          const { border, icon, Icon } = TONE_STYLES[toast.tone];
          return (
            <div
              key={toast.id}
              role={toast.tone === 'error' ? 'alert' : 'status'}
              aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
              className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border ${border} bg-slate-900/95 p-3 shadow-xl shadow-black/40 backdrop-blur`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${icon}`} aria-hidden="true" />
              <div className="flex-1 space-y-1">
                <p className="text-sm font-semibold text-white">{toast.title}</p>
                {toast.description && (
                  <p className="text-xs leading-relaxed text-slate-400">{toast.description}</p>
                )}
                {toast.action && (
                  <button
                    type="button"
                    onClick={() => {
                      dismiss(toast.id);
                      toast.action?.onSelect();
                    }}
                    className="mt-1 text-xs font-semibold text-blue-400 underline underline-offset-2 transition-colors hover:text-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                  >
                    {toast.action.label}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label={`Dismiss: ${toast.title}`}
                className="rounded p-0.5 text-slate-500 transition-colors hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside a ToastProvider');
  }
  return context;
}
