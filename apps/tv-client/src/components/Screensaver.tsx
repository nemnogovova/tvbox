import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { extractYouTubeId, extractYouTubeList, type IdleSettings, type MediaItem, type ScreensaverItem } from '@tvbox/shared';
import { useNow } from './Home';
import { mediaBase as base, mediaSrc } from '../media-src';

export function Screensaver({ idle, catalog }: { idle: IdleSettings; catalog: MediaItem[] }) {
  const kind = idle.screensaver;
  const covers = useMemo(
    () => Array.from(new Set(catalog.map((m) => m.backdrop).filter(Boolean) as string[])).map((src, i): ScreensaverItem => ({ id: `c${i}`, type: 'image', src })),
    [catalog],
  );
  if (kind === 'black') return <div className="h-full w-full bg-black" />;
  if (kind === 'wallpaper' && covers.length) return <Slideshow items={covers} interval={20} shuffle clock dim />;
  if (kind === 'media' && idle.screensaverMedia?.length)
    return (
      <Slideshow
        items={idle.screensaverMedia}
        interval={idle.screensaverInterval || 20}
        shuffle={idle.screensaverShuffle !== false}
        muted={idle.screensaverMuted !== false}
        clock={idle.screensaverClock !== false}
      />
    );
  return <FloatingClock />;
}


const itemUrl = (it: ScreensaverItem) => (it.type === 'image' ? mediaSrc(it.src, 'display') : mediaSrc(it.src));

// ---------------------------------------------------------------------------
// Order and position survive between screensaver runs (it goes on where it stopped)
// ---------------------------------------------------------------------------

function shuffle<T>(a: T[]): T[] {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

const pos = { key: '', order: [] as ScreensaverItem[], i: 0 };

function playOrder(items: ScreensaverItem[], mix: boolean): ScreensaverItem[] {
  const key = `${mix ? 1 : 0}|${items.map((x) => `${x.id}:${x.src}`).join(',')}`;
  if (pos.key !== key) {
    pos.key = key;
    pos.order = mix ? shuffle(items) : [...items];
    pos.i = 0;
  }
  return pos.order;
}

// ---------------------------------------------------------------------------
// Pictures are fetched and decoded before they are shown
// ---------------------------------------------------------------------------

const decoded = new Map<string, HTMLImageElement>();

function preloadImage(url: string): void {
  if (decoded.has(url)) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  decoded.set(url, img);
  void img.decode().catch(() => decoded.delete(url));
  // keep a few decoded pictures, not the whole folder
  while (decoded.size > 4) decoded.delete(decoded.keys().next().value as string);
}

/**
 * Mounted while the TV is idle but before the screensaver starts: the first pictures are ready
 * the moment it kicks in.
 */
export function ScreensaverPreload({ idle }: { idle: IdleSettings }) {
  const items = idle.screensaverMedia;
  const mix = idle.screensaverShuffle !== false;
  useEffect(() => {
    if (idle.screensaver !== 'media' || !items?.length) return;
    const t = setTimeout(() => {
      const order = playOrder(items, mix);
      for (let k = 0; k < Math.min(2, order.length); k++) {
        const it = order[(pos.i + k) % order.length];
        if (it.type === 'image') preloadImage(itemUrl(it));
      }
    }, 3000);
    return () => clearTimeout(t);
  }, [idle.screensaver, items, mix]);
  return null;
}

// ---------------------------------------------------------------------------
// Slideshow: each new picture / video fades in over the previous one once it is ready
// ---------------------------------------------------------------------------

interface Layer {
  key: number;
  item: ScreensaverItem;
  ready: boolean;
}

const FADE_MS = 1600;

function Slideshow({
  items,
  interval,
  shuffle: mix,
  muted = true,
  clock,
  dim,
}: {
  items: ScreensaverItem[];
  interval: number;
  shuffle: boolean;
  muted?: boolean;
  clock?: boolean;
  dim?: boolean;
}) {
  const order = useMemo(() => playOrder(items, mix), [items, mix]);
  const n = order.length;
  const seq = useRef(0);
  const failures = useRef(0);
  const [layers, setLayers] = useState<Layer[]>(() => (n ? [{ key: ++seq.current, item: order[pos.i % n], ready: false }] : []));
  const [broken, setBroken] = useState(false);
  const top = layers[layers.length - 1];
  const shown = [...layers].reverse().find((l) => l.ready);

  const advance = useCallback(() => {
    if (n < 2) return;
    pos.i = (pos.i + 1) % n;
    const item = order[pos.i];
    setLayers((ls) => {
      // drop a picture that is still loading: the newest wish wins
      const keep = ls.filter((l) => l.ready).slice(-1);
      return [...keep, { key: ++seq.current, item, ready: false }];
    });
  }, [n, order]);

  // the settings changed while the screensaver runs: start over with the new list
  useEffect(() => {
    if (!n) return;
    setLayers((ls) => (ls.length && order.some((o) => o.id === ls[ls.length - 1].item.id) ? ls : [{ key: ++seq.current, item: order[pos.i % n], ready: false }]));
  }, [order, n]);

  const onReady = useCallback((key: number) => {
    failures.current = 0;
    setLayers((ls) => ls.map((l) => (l.key === key ? { ...l, ready: true } : l)));
    // the old layer goes away once the new one has faded in
    setTimeout(() => setLayers((ls) => {
      const i = ls.findIndex((l) => l.key === key);
      return i > 0 ? ls.slice(i) : ls;
    }), FADE_MS + 200);
  }, []);

  const onFail = useCallback(
    (key: number) => {
      failures.current++;
      setLayers((ls) => ls.filter((l) => l.key !== key));
      if (failures.current >= n) setBroken(true);
      else if (n > 1) advance();
    },
    [advance, n],
  );

  // pictures change on a timer (counted from the moment they are on screen); the next one is prepared meanwhile
  useEffect(() => {
    if (!top?.ready || n < 2) return;
    const next = order[(pos.i + 1) % n];
    if (next.type === 'image') preloadImage(itemUrl(next));
    if (top.item.type !== 'image') return;
    const t = setTimeout(advance, Math.max(5, interval) * 1000);
    return () => clearTimeout(t);
  }, [top?.key, top?.ready, top?.item.type, interval, n, order, advance]);

  if (broken || !n) return <FloatingClock />;

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {layers.map((l) => (
        <div
          key={l.key}
          className="absolute inset-0 transition-opacity ease-out"
          style={{ opacity: l.ready ? 1 : 0, transitionDuration: `${FADE_MS}ms` }}
        >
          <LayerView
            item={l.item}
            single={n < 2}
            muted={muted}
            active={l.key === (shown?.key ?? -1) || l.key === top?.key}
            onReady={() => onReady(l.key)}
            onFail={() => onFail(l.key)}
            onEnded={advance}
          />
        </div>
      ))}
      {dim && <div className="pointer-events-none absolute inset-0 bg-black/30" />}
      {clock && <CornerClock />}
    </div>
  );
}

function LayerView({
  item,
  single,
  muted,
  active,
  onReady,
  onFail,
  onEnded,
}: {
  item: ScreensaverItem;
  single: boolean;
  muted: boolean;
  active: boolean;
  onReady: () => void;
  onFail: () => void;
  onEnded: () => void;
}) {
  if (item.type === 'youtube') return <YouTubeLayer src={item.src} single={single} muted={muted} onReady={onReady} onFail={onFail} onEnded={onEnded} />;
  if (item.type === 'video')
    return (
      <ScreensaverVideo src={mediaSrc(item.src)} muted={muted} loop={single} onReady={onReady} onEnded={() => active && onEnded()} onFail={onFail} />
    );
  return <PictureLayer url={itemUrl(item)} onReady={onReady} onFail={onFail} />;
}

/** A video of the screensaver. When it goes away its connection to the media server is released at once
 * (a removed <video> keeps it until garbage collection — the browser allows only 6 at a time). */
function ScreensaverVideo({ src, muted, loop, onReady, onEnded, onFail }: { src: string; muted: boolean; loop: boolean; onReady: () => void; onEnded: () => void; onFail: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    return () => {
      if (!v) return;
      v.pause();
      v.removeAttribute('src');
      v.load();
    };
  }, []);
  return (
    <video
      ref={ref}
      src={src}
      autoPlay
      muted={muted}
      loop={loop}
      playsInline
      preload="auto"
      onPlaying={onReady}
      onEnded={onEnded}
      onError={onFail}
      className="h-full w-full object-cover"
    />
  );
}

/** A picture: cropped to the screen, or — when its shape is far from the screen's — shown whole over a blurred copy. */
function PictureLayer({ url, onReady, onFail }: { url: string; onReady: () => void; onFail: () => void }) {
  const [fit, setFit] = useState<'cover' | 'contain'>('cover');
  const done = useRef(false);
  const ready = (img: HTMLImageElement) => {
    if (done.current) return;
    done.current = true;
    const screenRatio = window.innerWidth / Math.max(1, window.innerHeight);
    const ratio = img.naturalWidth / Math.max(1, img.naturalHeight);
    setFit(ratio / screenRatio < 0.78 || ratio / screenRatio > 1.6 ? 'contain' : 'cover');
    // wait until it is decoded: no half-drawn picture during the fade
    void img.decode().catch(() => undefined).then(onReady);
  };
  return (
    <>
      {fit === 'contain' && <img src={url} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-3xl" />}
      <img
        src={url}
        alt=""
        decoding="async"
        ref={(el) => {
          if (el && el.complete && el.naturalWidth) ready(el);
        }}
        onLoad={(e) => ready(e.currentTarget)}
        onError={onFail}
        className={fit === 'cover' ? 'absolute inset-0 h-full w-full animate-kenburns object-cover' : 'absolute inset-0 h-full w-full object-contain'}
      />
    </>
  );
}

/** YouTube video or playlist (muted by default), without YouTube's controls. */
function YouTubeLayer({
  src,
  single,
  muted,
  onReady,
  onFail,
  onEnded,
}: {
  src: string;
  single: boolean;
  muted: boolean;
  onReady: () => void;
  onFail: () => void;
  onEnded: () => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const id = extractYouTubeId(src);
  const list = extractYouTubeList(src);
  const url = useMemo(() => {
    const p = new URLSearchParams({
      autoplay: '1',
      mute: muted ? '1' : '0',
      controls: '0',
      rel: '0',
      playsinline: '1',
      iv_load_policy: '3',
      disablekb: '1',
      fs: '0',
      modestbranding: '1',
      enablejsapi: '1',
      origin: base(),
    });
    if (list) p.set('list', list);
    if (single) {
      p.set('loop', '1');
      if (id && !list) p.set('playlist', id);
    }
    return `https://www.youtube-nocookie.com/embed/${id || 'videoseries'}?${p.toString()}`;
  }, [id, list, muted, single]);

  useEffect(() => {
    if (!id && !list) {
      onFail();
      return;
    }
    let readyDone = false;
    const ready = () => {
      if (readyDone) return;
      readyDone = true;
      onReady();
    };
    const onMsg = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      let d: { event?: string; info?: unknown } | null = null;
      try {
        d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (!d) return;
      const state = d.event === 'onStateChange' ? d.info : d.event === 'infoDelivery' ? (d.info as { playerState?: number } | null)?.playerState : undefined;
      if (state === 1) ready();
      if (state === 0 && !single && !list) onEnded();
      if (d.event === 'onError') onFail();
    };
    window.addEventListener('message', onMsg);
    // shown only once it really plays: YouTube's "video unavailable" page never reaches the screen,
    // a video that doesn't start (removed, private, blocked) is skipped
    const t = setTimeout(() => {
      if (!readyDone) {
        console.warn('[screensaver] YouTube video did not start, skipped:', src);
        onFail();
      }
    }, 20000);
    return () => {
      window.removeEventListener('message', onMsg);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const listen = () => {
    // ask the embedded player to report its state (YouTube IFrame API over postMessage)
    ref.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');
  };

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-black">
      {/* slightly enlarged: YouTube's title bar and logo stay outside the screen */}
      <iframe
        ref={ref}
        title="YouTube"
        src={url}
        allow="autoplay; encrypted-media"
        onLoad={listen}
        className="absolute left-1/2 top-1/2 h-[118%] w-[118%] -translate-x-1/2 -translate-y-1/2 border-0"
      />
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
