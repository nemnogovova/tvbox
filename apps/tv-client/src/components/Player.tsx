import { useCallback, useEffect, useRef, useState } from 'react';
import { Music2, Pause, Play } from 'lucide-react';
import { formatDuration } from '@tvbox/shared';
import type { PlayerCommand, PlayTarget, RendererReport, RendererStatus } from '../bridge';
import { YouTubePlaceholder } from './YouTubePlayer';

/**
 * Video/audio/image player. Direct files use native seeking;
 * transcoded streams (ffmpeg) restart at an offset when seeking.
 */
export function Player({ target }: { target: PlayTarget }) {
  // YouTube is rendered by the main process (a youtube.com page laid over this window)
  if (target.kind === 'youtube') return <YouTubePlaceholder target={target} />;
  if (target.kind === 'image') return <ImageView key={target.key} target={target} />;
  return <MediaPlayer key={target.key} target={target} />;
}

function ImageView({ target }: { target: PlayTarget }) {
  useEffect(() => {
    window.tvbox.report({ key: target.key, status: 'playing', position: 0, duration: 0 });
  }, [target.key]);
  return (
    <div className="flex h-full w-full items-center justify-center bg-black">
      <img src={target.url} alt="" className="max-h-full max-w-full animate-fade-in object-contain" />
    </div>
  );
}

function MediaPlayer({ target }: { target: PlayTarget }) {
  const ref = useRef<HTMLVideoElement>(null);
  const transcoded = !!target.transcode && !target.url;
  // Video copied by ffmpeg can only start at a keyframe: ask the media server where they are and start there.
  const copyMode = transcoded && /[?&]copy=1/.test(target.transcode!.base);
  const initial = transcoded ? target.startAt || 0 : 0;
  // offset = source time of the stream's 0 (the keyframe); streamStart = what ffmpeg is asked for
  const [offset, setOffset] = useState<number | null>(copyMode && initial > 0.5 ? null : initial);
  const [streamStart, setStreamStart] = useState(initial);
  const wanted = useRef(initial);
  const offsetRef = useRef<number>(initial);
  const seekTo = useCallback(
    (pos: number) => {
      const from = offsetRef.current + (ref.current?.currentTime || 0);
      wanted.current = pos;
      if (!copyMode || pos <= 0.5) {
        offsetRef.current = pos;
        setStreamStart(pos);
        return setOffset(pos);
      }
      setOffset(null);
      const url = `${target.transcode!.base.replace('/transcode?', '/seekpoint?')}&start=${pos.toFixed(3)}`;
      void fetch(url)
        .then((r) => r.json() as Promise<{ keyframes?: { pts: number; dts: number }[] }>)
        .then((r) => r.keyframes || [])
        .catch(() => [] as { pts: number; dts: number }[])
        .then((kfs) => {
          if (wanted.current !== pos) return;
          // A copied video can only start at a keyframe; audio starts there too (perfect sync).
          let pick = [...kfs].reverse().find((k) => k.pts <= pos + 0.05) || kfs[0];
          const next = kfs.find((k) => k.pts > pos + 0.05);
          const forward = pos > from + 1;
          if (pick && next && ((forward && pick.pts <= from + 0.5) || (pos - pick.pts > 5 && next.pts - pos < 2.5))) pick = next;
          const start = pick ? pick.pts + 0.01 : pos;
          const origin = pick ? pick.dts : pos;
          offsetRef.current = origin;
          setStreamStart(start);
          setOffset(origin);
        });
    },
    [copyMode, target.transcode],
  );
  useEffect(() => {
    if (offset === null) seekTo(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [subId, setSubId] = useState<string | null>(null);
  const [osd, setOsd] = useState(true);
  const [status, setStatus] = useState<RendererStatus>('loading');
  const [, force] = useState(0);
  const lastReport = useRef(0);
  const osdTimer = useRef<ReturnType<typeof setTimeout>>();

  const src = !transcoded ? target.url! : offset === null ? undefined : `${target.transcode!.base}${streamStart > 0 ? `&start=${streamStart.toFixed(3)}` : ''}`;

  const position = () => (offset === null || !ref.current ? wanted.current : offset + (ref.current.currentTime || 0));

  const duration = () => {
    const v = ref.current;
    if (transcoded) return target.duration || 0;
    return v && Number.isFinite(v.duration) ? v.duration : target.duration || 0;
  };

  const report = useCallback(
    (extra: Partial<RendererReport> = {}, force = false) => {
      const now = Date.now();
      if (!force && now - lastReport.current < 900) return;
      lastReport.current = now;
      const v = ref.current;
      const st: RendererStatus = extra.status ?? (!v ? 'loading' : v.ended ? 'ended' : v.paused ? 'paused' : v.readyState < 3 ? 'loading' : 'playing');
      window.tvbox.report({ key: target.key, status: st, position: position(), duration: duration(), subtitleId: subId, ...extra });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target.key, offset, subId],
  );

  const flashOsd = (ms = 3500) => {
    setOsd(true);
    clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(false), ms);
  };

  // initial seek for direct files
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const onMeta = () => {
      if (!transcoded && target.startAt && target.startAt > 0) v.currentTime = target.startAt;
      void v.play().catch(() => undefined);
      // a video file that decodes no picture → ask for transcoding
      if (target.kind === 'video') {
        setTimeout(() => {
          if (ref.current && ref.current.videoWidth === 0 && !ref.current.paused) report({ needFallback: true }, true);
        }, 2500);
      }
    };
    v.addEventListener('loadedmetadata', onMeta, { once: true });
    flashOsd(5000);
    return () => v.removeEventListener('loadedmetadata', onMeta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // commands from the remote
  useEffect(() => {
    return window.tvbox.onCommand((c: PlayerCommand) => {
      const v = ref.current;
      if (!v) return;
      switch (c.type) {
        case 'toggle':
          if (v.paused) void v.play();
          else v.pause();
          flashOsd();
          break;
        case 'play':
          void v.play();
          flashOsd();
          break;
        case 'pause':
          v.pause();
          flashOsd();
          break;
        case 'stop':
          v.pause();
          break;
        case 'seek': {
          const dur = duration();
          const pos = Math.max(0, dur ? Math.min(dur - 0.5, c.position) : c.position);
          if (transcoded) seekTo(pos);
          else v.currentTime = pos;
          flashOsd();
          setTimeout(() => report({}, true), 50);
          break;
        }
        case 'subtitles':
          setSubId(c.id);
          break;
        case 'audio': {
          const tracks = (v as unknown as { audioTracks?: { length: number; [i: number]: { enabled: boolean } } }).audioTracks;
          if (!transcoded && tracks && tracks.length > c.index) {
            for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === c.index;
          } else {
            report({ needAudio: c.index }, true);
          }
          break;
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcoded, offset, report]);

  // subtitles: one <track> element at a time
  const sub = target.subtitles?.find((s) => s.id === subId);
  const subSrc = sub && offset !== null ? `${sub.url}${transcoded && offset > 0 ? `&start=${offset.toFixed(3)}` : ''}` : null;
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const apply = () => {
      for (let i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = subSrc ? 'showing' : 'disabled';
    };
    apply();
    const t = setTimeout(apply, 300);
    report({}, true);
    return () => clearTimeout(t);
  }, [subSrc, report]);

  // periodic report even when no events fire
  useEffect(() => {
    const t = setInterval(() => {
      report();
      force((n) => n + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [report]);

  const onStatus = (s: RendererStatus) => {
    setStatus(s);
    report({ status: s }, true);
  };

  const pos = position();
  const dur = duration();
  const art = target.backdrop || target.poster;

  return (
    <div className="relative h-full w-full bg-black">
      {target.source === 'music' && <MusicScreen target={target} pos={pos} dur={dur} status={status} />}
      {target.kind === 'audio' && target.source !== 'music' && (
        <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
          {art && <img src={art} alt="" className="absolute inset-0 h-full w-full animate-drift object-cover opacity-30 blur-3xl" />}
          <div className="relative flex flex-col items-center gap-8">
            {target.poster ? (
              <img src={target.poster} alt="" className="h-[40vh] rounded-3xl shadow-2xl" />
            ) : (
              <div className="flex h-[30vh] w-[30vh] items-center justify-center rounded-[3rem] bg-ink-800 text-ember">
                <Music2 size={120} />
              </div>
            )}
          </div>
        </div>
      )}
      <video
        ref={ref}
        src={src}
        autoPlay
        playsInline
        preload="auto"
        className={target.kind === 'audio' ? 'hidden' : 'h-full w-full object-contain'}
        onPlaying={() => onStatus('playing')}
        onPause={() => onStatus('paused')}
        onWaiting={() => onStatus('loading')}
        onSeeked={() => report({}, true)}
        onEnded={() => onStatus('ended')}
        onTimeUpdate={() => report()}
        onError={() => {
          const err = ref.current?.error;
          console.warn('[player] media error', err?.code, err?.message);
          if (err?.code === 4 || err?.code === 3) report({ needFallback: true, error: 'Формат не поддерживается' }, true);
          else report({ status: 'error', error: 'Не удалось открыть файл' }, true);
        }}
      >
        {subSrc && <track key={subSrc} kind="subtitles" src={subSrc} default label={sub?.label} />}
      </video>

      {/* OSD */}
      {target.source !== 'music' && <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-[5vw] pb-[5vh] pt-[16vh] transition-opacity duration-700 ${
          osd || status !== 'playing' || target.kind === 'audio' ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="flex items-end gap-6">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-white/10 backdrop-blur">
            {status === 'loading' ? (
              <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-white/20 border-t-ember" />
            ) : status === 'playing' ? (
              <Play size={30} fill="currentColor" />
            ) : (
              <Pause size={30} fill="currentColor" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            {target.subtitle && <div className="mb-1 text-[1.4rem] font-semibold text-ember">{target.subtitle}</div>}
            <div className="truncate text-[2.6rem] font-extrabold leading-tight">{target.title}</div>
          </div>
        </div>
        {dur > 0 && (
          <div className="mt-6 flex items-center gap-5">
            <span className="tabular w-28 text-[1.3rem] font-semibold text-fg-muted">{formatDuration(pos)}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/15">
              <div className="h-full rounded-full bg-ember transition-[width] duration-1000 ease-linear" style={{ width: `${Math.min(100, (pos / dur) * 100)}%` }} />
            </div>
            <span className="tabular w-28 text-right text-[1.3rem] font-semibold text-fg-muted">{formatDuration(dur)}</span>
          </div>
        )}
      </div>}
    </div>
  );
}

function MusicScreen({ target, pos, dur, status }: { target: PlayTarget; pos: number; dur: number; status: RendererStatus }) {
  return (
    <div className="absolute inset-0 overflow-hidden">
      {target.backdrop && <img src={target.backdrop} alt="" className="absolute inset-0 h-full w-full scale-125 animate-drift object-cover opacity-40 blur-[80px]" />}
      <div className="absolute inset-0 bg-gradient-to-br from-black/30 via-black/50 to-black/80" />
      <div className="relative flex h-full items-center gap-[5vw] px-[8vw]">
        <div className="relative aspect-square h-[56vh] shrink-0 overflow-hidden rounded-[2.5rem] bg-ink-800 shadow-[0_40px_120px_-20px_rgba(0,0,0,0.9)]">
          {target.poster ? (
            <img src={target.poster} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-ember">
              <Music2 size={140} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-4 flex items-center gap-3 text-[1.3rem] font-semibold uppercase tracking-[0.2em] text-ember">
            {status === 'loading' ? (
              <div className="h-6 w-6 animate-spin rounded-full border-[3px] border-white/20 border-t-ember" />
            ) : status === 'playing' ? (
              <Equalizer />
            ) : (
              <Pause size={22} fill="currentColor" />
            )}
            {status === 'paused' ? 'Пауза' : 'Сейчас играет'}
          </div>
          <div className="line-clamp-2 text-[4.2rem] font-extrabold leading-[1.05]">{target.title}</div>
          {target.artist && <div className="mt-4 truncate text-[2.2rem] font-semibold text-white/80">{target.artist}</div>}
          {target.album && <div className="mt-1 truncate text-[1.6rem] text-white/50">{target.album}</div>}
          <div className="mt-[6vh] flex items-center gap-5">
            <span className="tabular w-24 text-[1.3rem] font-semibold text-white/60">{formatDuration(pos)}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/15">
              <div className="h-full rounded-full bg-ember transition-[width] duration-1000 ease-linear" style={{ width: `${dur ? Math.min(100, (pos / dur) * 100) : 0}%` }} />
            </div>
            <span className="tabular w-24 text-right text-[1.3rem] font-semibold text-white/60">{dur ? formatDuration(dur) : '--:--'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Equalizer() {
  return (
    <span className="flex h-6 items-end gap-[3px]">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="w-[4px] animate-eq rounded-full bg-ember" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  );
}
