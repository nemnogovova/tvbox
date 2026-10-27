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
  const [launching, setLaunching] = useState<{ name: string; icon?: string } | null>(null);
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
      window.tvbox.onActivity(() => poke()),
      window.tvbox.onLaunching((a) => {
        setLaunching(a);
        poke();
      }),
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

  // the "Starting…" screen disappears by itself if the program never shows up
  useEffect(() => {
    if (!launching) return;
    const t = setTimeout(() => setLaunching(null), 90_000);
    return () => clearTimeout(t);
  }, [launching]);

  // local keyboard / TV remote (HDMI-CEC keys arrive as media keys).
  // The mouse pointer is hidden by the main process (it also covers YouTube on top of this page).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT') return;
      poke();
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === ' ' || k.startsWith('Arrow')) e.preventDefault();
      window.tvbox.localKey(k === 'а' ? 'f' : k === 'ь' ? 'm' : k);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
      {launching && <LaunchScreen app={launching} />}
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

/** Full-screen "Starting Jackbox…" while a program launched from the remote opens. */
function LaunchScreen({ app }: { app: { name: string; icon?: string } }) {
  return (
    <div className="absolute inset-0 z-40 flex animate-fade-in flex-col items-center justify-center bg-ink-950/95 backdrop-blur-2xl">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-1/2 h-[60vh] w-[60vh] -translate-x-1/2 -translate-y-1/2 animate-pulse-dot rounded-full bg-ember/10 blur-[120px]" />
      </div>
      <div className="relative flex h-[11rem] w-[11rem] items-center justify-center rounded-[2.5rem] border border-white/10 bg-ink-800/80 shadow-2xl">
        {app.icon ? <img src={app.icon} alt="" className="h-[6.5rem] w-[6.5rem] object-contain" /> : <span className="text-[5rem] font-extrabold text-ember">{app.name.charAt(0)}</span>}
        <div className="absolute -inset-[2.7rem] rounded-full border-[0.22rem] border-white/[0.06]" />
        <div className="absolute -inset-[2.7rem] animate-spin rounded-full border-[0.22rem] border-transparent border-t-ember" style={{ animationDuration: '1.1s' }} />
      </div>
      <p className="relative mt-[5.2rem] text-[1.1rem] font-bold uppercase tracking-[0.3em] text-fg-dim">Запускаем</p>
      <h1 className="relative mt-[0.8rem] max-w-[70vw] text-center text-[3.2rem] font-extrabold leading-tight">{app.name}</h1>
      <p className="relative mt-[1.2rem] text-[1.2rem] text-fg-muted">Откроется на весь экран · тачпад и стрелки — на пульте</p>
    </div>
  );
}
