export interface ToastData {
  id: string;
  message: string;
  kind: 'info' | 'success' | 'error';
}

export function Toast({ toasts }: { toasts: ToastData[] }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-2 w-[90%] max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`px-4 py-3 rounded-xl text-sm shadow-lg animate-slide-up border ${
            t.kind === 'success'
              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
              : t.kind === 'error'
                ? 'bg-red-500/15 border-red-500/30 text-red-300'
                : 'bg-surface border-line text-gray-200'
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
