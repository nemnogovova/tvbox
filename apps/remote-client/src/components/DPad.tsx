import { useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, ExternalLink, Home, LogIn, MousePointer2, Search, ShieldCheck, Undo2, X, Youtube } from 'lucide-react';
import { Events, type NavKey } from '@tvbox/shared';
import { act, control, errorText, isOwner, request, toast, useStore, youtubeOpen } from '../store/store';
import { Touchpad } from './Touchpad';
import { cx } from './ui';
import { openExternal } from '../lib/native';

const buzz = () => {
  try {
    navigator.vibrate?.(10);
  } catch {
    // ignore
  }
};

export const nav = (key: NavKey) => {
  buzz();
  void control({ type: 'NAV', key });
};

/** Round D-pad with OK in the middle — like a TV remote. */
export function DPad({ className }: { className?: string }) {
  const arrow = 'absolute flex items-center justify-center text-fg-muted transition active:scale-90 active:text-ember';
  // hold an arrow to repeat (scrolling through long rows on YouTube)
  const repeat = (key: NavKey) => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let delay: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      if (delay) clearTimeout(delay);
      timer = delay = null;
    };
    return {
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault();
        nav(key);
        delay = setTimeout(() => (timer = setInterval(() => nav(key), 140)), 420);
      },
      onPointerUp: stop,
      onPointerLeave: stop,
      onPointerCancel: stop,
    };
  };
  return (
    <div className={cx('relative mx-auto aspect-square w-[min(66vw,240px)] select-none rounded-full bg-gradient-to-b from-ink-700 to-ink-800 shadow-card ring-1 ring-white/[0.06]', className)}>
      <button aria-label="Вверх" className={cx(arrow, 'inset-x-[30%] top-0 h-[30%]')} {...repeat('up')}>
        <ChevronUp size={30} />
      </button>
      <button aria-label="Вниз" className={cx(arrow, 'inset-x-[30%] bottom-0 h-[30%]')} {...repeat('down')}>
        <ChevronDown size={30} />
      </button>
      <button aria-label="Влево" className={cx(arrow, 'inset-y-[30%] left-0 w-[30%]')} {...repeat('left')}>
        <ChevronLeft size={30} />
      </button>
      <button aria-label="Вправо" className={cx(arrow, 'inset-y-[30%] right-0 w-[30%]')} {...repeat('right')}>
        <ChevronRight size={30} />
      </button>
      <button
        aria-label="OK"
        onClick={() => nav('enter')}
        className="absolute inset-[30%] flex items-center justify-center rounded-full bg-ink-600 text-sm font-extrabold tracking-wider text-fg shadow-lg ring-1 ring-white/10 transition active:scale-95 active:bg-ember active:text-ink-950"
      >
        OK
      </button>
    </div>
  );
}

/** Remote for YouTube TV: D-pad, search, home / back, account linking by code. */
export function YouTubeCard() {
  const yt = useStore((s) => s.youtube);
  const open = useStore(youtubeOpen);
  const owner = useStore(isOwner);
  const [q, setQ] = useState('');
  const [touchpad, setTouchpad] = useState(false);

  if (!open) return null;
  const search = () => {
    if (!q.trim()) return nav('search');
    void control({ type: 'TEXT', text: q.trim() });
    setQ('');
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-white/5 px-4 py-3">
        <Youtube size={20} className="text-[#ff3d3d]" />
        <span className="flex-1 text-sm font-bold">YouTube на ТВ</span>
        {!!yt?.adsBlocked && (
          <span className="chip bg-ok/10 py-1 text-[11px] text-ok" title="Реклама вырезана">
            <ShieldCheck size={13} /> {yt.adsBlocked}
          </span>
        )}
        {owner && (
          <button className="icon-btn h-9 w-9" onClick={() => setTouchpad(true)} title="Тачпад">
            <MousePointer2 size={17} />
          </button>
        )}
        <button className="icon-btn h-9 w-9" onClick={() => control({ type: 'STOP' })} title="Закрыть YouTube">
          <X size={18} />
        </button>
      </div>

      {yt?.code && <ActivationCode code={yt.code} />}

      {!yt?.code && yt && !yt.signedIn && owner && (
        <button
          onClick={() => act(Events.YOUTUBE_LOGIN, {})}
          className="flex w-full items-center gap-3 border-b border-white/5 bg-[#ff3d3d]/[0.06] px-4 py-3 text-left transition hover:bg-[#ff3d3d]/10"
        >
          <LogIn size={18} className="shrink-0 text-[#ff6b6b]" />
          <span className="flex-1 text-[13px] leading-snug text-fg-muted">
            <b className="text-fg">Подключите свой аккаунт</b> — рекомендации, подписки, плейлисты и история. Вход кодом с телефона.
          </span>
        </button>
      )}

      <form
        className="flex gap-2 px-4 pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <div className="relative flex-1">
          <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim" />
          <input className="field h-11 pl-10" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск на YouTube" enterKeyHint="search" />
        </div>
        {q.trim() && (
          <button className="btn-primary h-11 px-4" aria-label="Найти">
            <Search size={17} />
          </button>
        )}
      </form>

      <div className="px-4 py-5">
        <DPad />
        <div className="mt-5 grid grid-cols-3 gap-2">
          <button className="btn-soft h-12 flex-col gap-0.5 py-1 text-[11px]" onClick={() => nav('back')}>
            <Undo2 size={18} /> Назад
          </button>
          <button className="btn-soft h-12 flex-col gap-0.5 py-1 text-[11px]" onClick={() => nav('home')}>
            <Home size={18} /> Главная
          </button>
          <button className="btn-soft h-12 flex-col gap-0.5 py-1 text-[11px]" onClick={search}>
            <Search size={18} /> Поиск
          </button>
        </div>
      </div>
      <Touchpad open={touchpad} onClose={() => setTouchpad(false)} />
    </div>
  );
}

export function ActivationCode({ code }: { code: string }) {
  const url = 'https://yt.be/activate';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code.replace(/-/g, ''));
      toast('Код скопирован', 'success');
    } catch {
      // clipboard blocked
    }
  };
  return (
    <div className="border-b border-white/5 bg-gradient-to-b from-[#ff3d3d]/10 to-transparent px-4 py-4">
      <p className="text-[13px] leading-snug text-fg-muted">
        Откройте <b className="text-fg">yt.be/activate</b> на телефоне (там, где вы уже вошли в Google), введите код и подтвердите:
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button onClick={copy} className="tabular flex-1 rounded-2xl bg-ink-900/70 py-3 text-center font-mono text-2xl font-extrabold tracking-[0.18em] text-fg ring-1 ring-white/10">
          {code}
        </button>
        <button onClick={copy} className="icon-btn h-12 w-12 bg-ink-750" aria-label="Скопировать код">
          <Copy size={18} />
        </button>
      </div>
      <button
        onClick={() => {
          void copy();
          void openExternal(url);
        }}
        className="btn-primary mt-3 w-full bg-[#ff3d3d] text-white hover:bg-[#ff5757]"
      >
        <ExternalLink size={16} /> Открыть yt.be/activate
      </button>
      <p className="mt-2 text-center text-[11px] text-fg-dim">Код уже скопирован при нажатии — просто вставьте его</p>
    </div>
  );
}

/** "Open YouTube" tile shown on the remote when nothing is playing. */
export async function openYoutube(search?: string): Promise<void> {
  const r = await request(Events.YOUTUBE_OPEN, search ? { search } : {});
  if (!r.ok) toast(`YouTube не открылся: ${errorText(r.error)}`, 'error');
}
