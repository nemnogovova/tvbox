import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Info, AlertTriangle, XCircle } from 'lucide-react';
import { DEFAULT_IDLE_SETTINGS, type IdleSettings, type MediaItem } from '@tvbox/shared';
import type { PlayTarget, TvStatus } from './bridge';
import { Home } from './components/Home';
import { Pairing } from './components/Pairing';
import { Player } from './components/Player';
import { CastView } from './components/CastView';
import { Screensaver } from './components/Screensaver';
import { useCastReceiver } from './hooks/useCastReceiver';

const INITIAL_STATUS: TvStatus = { conn: 'connecting', serverUrl: '', publicUrl: '', tvName: '', pairing: null, paired: true };

interface Toast {
  id: number;
  message: string;
  kind?: string;
}

export default function App() {
  const [status, setStatus] = useState<TvStatus>(INITIAL_STATUS);
  const [target, setTarget] = useState<PlayTarget | null>(null);
  const [catalog, setCatalog] = useState<MediaItem[]>([]);
  const [idle, setIdle] = useState<IdleSettings>(DEFAULT_IDLE_SETTINGS);
  const [saver, setSaver] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const cast = useCastReceiver();
  const activity = useRef(Date.now());

  const poke = () => {
    activity.current = Date.now();
    setSaver(false);
  };

  useEffect(() => {
    void window.tvbox.getStatus().then(setStatus);
    void window.tvbox.getCatalog().then(setCatalog);
    void window.tvbox.getIdle().then(setIdle);
    let seq = 1;
    const offs = [
      window.tvbox.onStatus(setStatus),
      window.tvbox.onCatalog(setCatalog),
      window.tvbox.onIdle((s) => {
        setIdle(s);
        poke();
      }),
      window.tvbox.onLoad((t) => {
        setTarget(t);
        poke();
      }),
      window.tvbox.onCommand(() => poke()),
      window.tvbox.onToast((t) => {
        const id = seq++;
        setToasts((x) => [...x.slice(-2), { id, ...t }]);
        setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 5000);
      }),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  useEffect(() => {
    if (cast.active) poke();
  }, [cast.active, cast.label]);

  // screensaver
  useEffect(() => {
    const t = setInterval(() => {
      if (idle.screensaver === 'off' || target || cast.active) return;
      if (Date.now() - activity.current > idle.screensaverMinutes * 60 * 1000) setSaver(true);
    }, 5000);
    return () => clearInterval(t);
  }, [idle.screensaver, idle.screensaverMinutes, target, cast.active]);

  // local keyboard / TV remote (HDMI-CEC keys arrive as media keys) + auto-hidden cursor
  useEffect(() => {
    let cursorTimer: ReturnType<typeof setTimeout>;
    const onMove = () => {
      document.body.classList.remove('hide-cursor');
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 2500);
      poke();
    };
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT') return;
      poke();
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === ' ' || k.startsWith('Arrow')) e.preventDefault();
      window.tvbox.localKey(k === 'а' ? 'f' : k === 'ь' ? 'm' : k);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('keydown', onKey);
    onMove();
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKey);
      clearTimeout(cursorTimer);
    };
  }, []);

  let screen;
  if (cast.active) screen = <CastView cast={cast} />;
  else if (target) screen = <Player target={target} />;
  else if (status.conn === 'pairing' || (!status.paired && status.conn !== 'online')) screen = <Pairing status={status} />;
  else if (saver && idle.screensaver !== 'off') screen = <Screensaver idle={idle} catalog={catalog} />;
  else screen = <Home idle={idle} catalog={catalog} status={status} />;

  return (
    <div className="relative h-full w-full">
      {screen}
      <div className="pointer-events-none absolute right-[2.5vw] top-[3vh] z-50 flex w-[30vw] flex-col gap-3">
        {toasts.map((t) => {
          const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? XCircle : t.kind === 'warning' ? AlertTriangle : Info;
          const color = t.kind === 'success' ? 'text-ok' : t.kind === 'error' ? 'text-bad' : t.kind === 'warning' ? 'text-warn' : 'text-ember';
          return (
            <div key={t.id} className="flex animate-rise items-center gap-4 rounded-3xl border border-white/10 bg-ink-800/90 px-6 py-4 text-[1.3rem] shadow-2xl backdrop-blur-xl">
              <Icon size={28} className={`shrink-0 ${color}`} />
              <span>{t.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
