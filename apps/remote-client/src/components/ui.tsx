import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertTriangle, Info, X, XCircle, Loader2 } from 'lucide-react';
import { useStore } from '../store/store';
import { useBack } from '../lib/back';
import { haptic } from '../lib/haptics';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cx('animate-spin', className)} />;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[300] flex flex-col items-center gap-2 px-4"
      style={{ top: 'calc(var(--safe-top) + 12px)' }}
    >
      {toasts.map((t) => {
        const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? XCircle : t.kind === 'warning' ? AlertTriangle : Info;
        const color = t.kind === 'success' ? 'text-ok' : t.kind === 'error' ? 'text-bad' : t.kind === 'warning' ? 'text-warn' : 'text-ember';
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex w-full max-w-sm animate-rise items-start gap-3 rounded-2xl border border-white/10 bg-ink-750/95 px-4 py-3 text-sm shadow-2xl backdrop-blur-xl"
          >
            <Icon size={18} className={cx('mt-0.5 shrink-0', color)} />
            <span className="leading-snug">{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Bottom sheet on phones, centered dialog on desktop. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  // Esc / Android back / browser back close the topmost sheet only
  useBack(open, onClose);
  if (!open) return null;
  return createPortal(
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[200] flex items-end justify-center sm:items-center sm:p-6" onMouseDown={onClose}>
      <div className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm" />
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className={cx(
          'relative flex max-h-[92vh] w-full animate-sheet flex-col overflow-hidden rounded-t-[28px] border border-white/10 bg-ink-850 shadow-2xl sm:animate-pop sm:rounded-[28px]',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
        style={{ paddingBottom: 'var(--safe-bottom)' }}
      >
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-white/15 sm:hidden" />
        {title !== undefined && (
          <div className="flex items-center gap-3 px-5 pb-2 pt-3 sm:pt-5">
            <div className="min-w-0 flex-1 text-lg font-bold">{title}</div>
            <button className="icon-btn -mr-2" onClick={onClose} aria-label="Закрыть">
              <X size={20} />
            </button>
          </div>
        )}
        <div className="overflow-y-auto px-5 pb-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-ember' : 'bg-ink-600',
      )}
    >
      <span
        className={cx(
          'absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all',
          checked ? 'left-6' : 'left-1',
        )}
      />
    </button>
  );
}

export function Range({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onInput,
  onCommit,
  disabled,
  ariaLabel,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onInput?: (v: number) => void;
  onCommit?: (v: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const pct = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;
  // dragging is felt: a light detent every 10 %, a firm one at both ends
  const lastStep = useRef<number | null>(null);
  const feel = (v: number) => {
    const f = max > min ? (v - min) / (max - min) : 0;
    const stepNo = Math.round(f * 10);
    if (lastStep.current !== null && stepNo !== lastStep.current) haptic(stepNo === 0 || stepNo === 10 ? 'heavy' : 'detent');
    lastStep.current = stepNo;
  };
  return (
    <input
      type="range"
      data-haptic="off"
      className="range"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      style={{ ['--pct' as string]: `${pct}%` }}
      onChange={(e) => {
        feel(Number(e.target.value));
        onInput?.(Number(e.target.value));
      }}
      onPointerDown={() => (lastStep.current = null)}
      onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
    />
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-2xl bg-ink-800 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            'whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-semibold transition',
            value === o.value ? 'bg-ink-600 text-fg shadow' : 'text-fg-dim hover:text-fg-muted',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-ink-800 text-fg-dim">{icon}</div>
      <p className="text-base font-bold">{title}</p>
      {text && <p className="mt-1 max-w-xs text-sm text-fg-muted">{text}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Section({ title, icon, children, right }: { title: string; icon?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="panel p-5">
      <div className="mb-4 flex items-center gap-2.5">
        {icon && <span className="text-ember">{icon}</span>}
        <h2 className="flex-1 text-base font-bold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function TvStatusPill() {
  const tv = useStore((s) => s.presence.tvConnected);
  const conn = useStore((s) => s.conn);
  const label = conn !== 'online' ? 'Нет связи' : tv ? 'ТВ в сети' : 'ТВ офлайн';
  const color = conn !== 'online' ? 'bg-warn' : tv ? 'bg-ok' : 'bg-bad';
  return (
    <span className="chip bg-white/5 text-fg-muted">
      <span className={cx('h-2 w-2 rounded-full', color, conn !== 'online' && 'animate-pulse-dot')} />
      {label}
    </span>
  );
}
