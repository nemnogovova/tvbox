import { useEffect, useMemo, useState } from 'react';
import type { IdleSettings, MediaItem, ScreensaverItem } from '@tvbox/shared';
import { useNow } from './Home';

export function Screensaver({ idle, catalog }: { idle: IdleSettings; catalog: MediaItem[] }) {
  const kind = idle.screensaver;
  if (kind === 'black') return <div className="h-full w-full bg-black" />;
  if (kind === 'wallpaper') return <Wallpapers catalog={catalog} />;
  if (kind === 'media' && idle.screensaverMedia?.length) return <MediaSlideshow idle={idle} />;
  return <FloatingClock />;
}

/** tvbox-file:<name> → file uploaded to the TV, served by the local media server */
export const mediaSrc = (src: string) =>
  src.startsWith('tvbox-file:') ? `${location.origin.startsWith('http') ? location.origin : 'http://127.0.0.1:8765'}/screensaver-file?n=${encodeURIComponent(src.slice(11))}` : src;

function shuffle<T>(a: T[]): T[] {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

function MediaSlideshow({ idle }: { idle: IdleSettings }) {
  const items = useMemo(
    () => (idle.screensaverShuffle !== false ? shuffle(idle.screensaverMedia || []) : idle.screensaverMedia || []),
    [idle.screensaverMedia, idle.screensaverShuffle],
  );
  const [i, setI] = useState(0);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const interval = Math.max(5, idle.screensaverInterval || 20) * 1000;
  const cur: ScreensaverItem | undefined = items[i % Math.max(1, items.length)];
  const next = () => setI((x) => (x + 1) % Math.max(1, items.length));

  // pictures advance on a timer; videos advance when they end (or loop when alone)
  useEffect(() => {
    if (!cur || cur.type === 'video' || items.length < 2) return;
    const t = setTimeout(next, interval);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, cur?.id, interval, items.length]);

  useEffect(() => {
    if (cur && failed.has(cur.id) && failed.size < items.length) next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id, failed]);

  const onError = () => cur && setFailed((f) => new Set(f).add(cur.id));
  const showClock = idle.screensaverClock !== false;

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {cur &&
        (cur.type === 'video' ? (
          <video
            key={cur.id}
            src={mediaSrc(cur.src)}
            autoPlay
            muted={idle.screensaverMuted !== false}
            loop={items.length < 2}
            playsInline
            onEnded={next}
            onError={onError}
            className="absolute inset-0 h-full w-full animate-xfade object-cover"
          />
        ) : (
          <img key={cur.id} src={mediaSrc(cur.src)} alt="" onError={onError} className="absolute inset-0 h-full w-full animate-kenburns object-cover" />
        ))}
      {showClock && <CornerClock />}
    </div>
  );
}

function CornerClock() {
  const now = useNow(15000);
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[30vh] bg-gradient-to-t from-black/70 to-transparent" />
      <div className="absolute bottom-[6vh] right-[5vw] text-right">
        <div className="tabular text-[5rem] font-extralight leading-none text-white/80">{now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>
        <div className="mt-2 text-[1.4rem] text-white/50">{now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      </div>
    </>
  );
}

function FloatingClock() {
  const now = useNow();
  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {/* moves slowly so no pixel burns in */}
      <div className="absolute left-[20vw] top-[20vh] animate-float text-center">
        <div className="tabular text-[10rem] font-extralight leading-none text-white/55">
          {now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        </div>
        <div className="mt-2 text-[1.6rem] text-white/30">{now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      </div>
    </div>
  );
}

function Wallpapers({ catalog }: { catalog: MediaItem[] }) {
  const images = useMemo(() => Array.from(new Set(catalog.map((m) => m.backdrop).filter(Boolean) as string[])), [catalog]);
  const [i, setI] = useState(0);
  const now = useNow(30000);
  useEffect(() => {
    if (images.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % images.length), 20000);
    return () => clearInterval(t);
  }, [images.length]);
  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {images.length ? (
        <img key={images[i]} src={images[i]} alt="" className="absolute inset-0 h-full w-full animate-drift object-cover opacity-70" />
      ) : (
        <div className="absolute inset-0 animate-drift bg-gradient-to-br from-[#1b1030] via-[#0b0c10] to-[#2a1408]" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
      <div className="tabular absolute bottom-[6vh] right-[5vw] text-[5rem] font-extralight text-white/70">
        {now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  );
}
