import { useEffect, useState } from 'react';
import {
  AudioLines,
  Captions,
  Check,
  ChevronUp,
  Clapperboard,
  Music2,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  Film,
  Link2,
  ListPlus,
  Maximize,
  Minus,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  RotateCw,
  SkipForward,
  Square,
  Trash2,
  Tv,
  Volume1,
  Volume2,
  VolumeX,
  Youtube,
} from 'lucide-react';
import { formatDuration, type PlayerState } from '@tvbox/shared';
import { control, effectivePlayer, livePosition, useStore } from '../store/store';
import { openLink } from '../lib/actions';
import { useCover } from '../lib/music';
import { Range, Sheet, cx } from './ui';

function useTick(active: boolean, ms = 500): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

const SOURCE_META: Record<PlayerState['source'], { label: string; icon: typeof Film }> = {
  none: { label: 'Ничего не играет', icon: Tv },
  youtube: { label: 'YouTube', icon: Youtube },
  local: { label: 'Медиатека', icon: Film },
  torrent: { label: 'Торрент · стриминг', icon: Clapperboard },
  url: { label: 'Ссылка', icon: Link2 },
  webrtc: { label: 'Трансляция', icon: Radio },
  music: { label: 'Музыка', icon: Music2 },
};

export function RemotePanel({ compact }: { compact?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <NowPlaying />
      <VolumeCard />
      <OpenLinkCard />
      <QueueCard />
      {!compact && <HotkeysHint />}
    </div>
  );
}

function NowPlaying() {
  const state = useStore((s) => s);
  const p = effectivePlayer(state);
  const tvOnline = state.presence.tvConnected;
  const playing = p.status === 'playing';
  useTick(playing);
  const pos = livePosition(state);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? pos;
  const meta = SOURCE_META[p.source] || SOURCE_META.none;
  const Icon = meta.icon;
  const idle = p.source === 'none' || p.status === 'idle';
  const poster = useCover(p.poster);
  const art = useCover(p.backdrop) || poster;
  const canSeek = !idle && p.duration > 0 && p.source !== 'webrtc';
  const music = p.source === 'music';
  const repeat = p.repeat || 'off';
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat;

  return (
    <div className="panel relative overflow-hidden">
      {art && (
        <div className="absolute inset-0">
          <img src={art} alt="" className="h-full w-full scale-110 object-cover opacity-30 blur-2xl" />
          <div className="absolute inset-0 bg-gradient-to-b from-ink-850/40 via-ink-850/80 to-ink-850" />
        </div>
      )}
      <div className="relative p-5">
        <div className="flex items-start gap-4">
          <div
            className={cx(
              'relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-ink-750 text-fg-dim',
              music || p.source === 'youtube' ? 'h-20 w-20' : 'h-20 w-14',
            )}
          >
            {poster ? <img src={poster} alt="" className="h-full w-full object-cover" /> : <Icon size={24} />}
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="label flex items-center gap-1.5">
              {playing && <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-ember" />}
              {!tvOnline ? 'Телевизор не в сети' : p.status === 'loading' ? 'Загрузка…' : meta.label}
            </div>
            <h2 className="mt-1 line-clamp-2 text-lg font-extrabold leading-snug">
              {idle ? (tvOnline ? 'Выберите, что посмотреть' : 'Включите ТВ-клиент') : p.title || 'Без названия'}
            </h2>
            {!idle && (p.artist || p.subtitle) && <p className="mt-0.5 truncate text-sm text-fg-muted">{music ? [p.artist, p.album].filter(Boolean).join(' — ') : p.subtitle}</p>}
            {p.status === 'error' && p.error && <p className="mt-1 text-sm text-bad">{p.error}</p>}
          </div>
        </div>

        <div className="mt-5">
          <Range
            ariaLabel="Перемотка"
            value={canSeek ? shown : 0}
            min={0}
            max={canSeek ? p.duration : 1}
            step={1}
            disabled={!canSeek}
            onInput={setDrag}
            onCommit={(v) => {
              setDrag(null);
              void control({ type: 'SEEK', position: v });
            }}
          />
          <div className="tabular -mt-0.5 flex justify-between text-xs font-semibold text-fg-dim">
            <span>{canSeek ? formatDuration(shown) : '—:—'}</span>
            <span>{canSeek ? `-${formatDuration(Math.max(0, p.duration - shown))}` : '—:—'}</span>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between">
          {music ? (
            <button
              className={cx('icon-btn h-11 w-11', repeat !== 'off' && 'text-ember')}
              disabled={idle}
              onClick={() => control({ type: 'REPEAT', mode: repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off' })}
              aria-label="Повтор"
            >
              <RepeatIcon size={20} />
            </button>
          ) : (
            <button className="icon-btn h-11 w-11" disabled={idle || (!p.hasPrevious && !canSeek)} onClick={() => control({ type: 'PREVIOUS' })} aria-label="Предыдущее">
              <SkipBack size={20} />
            </button>
          )}
          <button
            className="icon-btn h-14 w-14"
            disabled={music ? idle : !canSeek}
            onClick={() => control(music ? { type: 'PREVIOUS' } : { type: 'SEEK_RELATIVE', delta: -10 })}
            aria-label={music ? 'Предыдущий трек' : 'Назад 10 секунд'}
          >
            {music ? <SkipBack size={26} fill="currentColor" /> : <RotateCcw size={24} />}
          </button>
          <button
            onClick={() => control({ type: 'PLAY_PAUSE' })}
            disabled={!tvOnline || idle || p.source === 'webrtc'}
            aria-label={playing ? 'Пауза' : 'Играть'}
            className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-ember text-ink-950 shadow-glow transition active:scale-95 disabled:bg-ink-700 disabled:text-fg-dim disabled:shadow-none"
          >
            {playing ? <Pause size={32} fill="currentColor" /> : <Play size={32} fill="currentColor" className="ml-1" />}
          </button>
          <button
            className="icon-btn h-14 w-14"
            disabled={music ? !p.queue.length && repeat !== 'all' : !canSeek}
            onClick={() => control(music ? { type: 'NEXT' } : { type: 'SEEK_RELATIVE', delta: 10 })}
            aria-label={music ? 'Следующий трек' : 'Вперёд 10 секунд'}
          >
            {music ? <SkipForward size={26} fill="currentColor" /> : <RotateCw size={24} />}
          </button>
          {music ? (
            <button className="icon-btn h-11 w-11" disabled={p.queue.length < 2} onClick={() => control({ type: 'QUEUE_SHUFFLE' })} aria-label="Перемешать очередь">
              <Shuffle size={20} />
            </button>
          ) : (
            <button className="icon-btn h-11 w-11" disabled={!p.queue.length} onClick={() => control({ type: 'NEXT' })} aria-label="Следующее">
              <SkipForward size={20} />
            </button>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-1">
          <button className="btn-ghost px-3 py-2 text-xs" disabled={idle} onClick={() => control({ type: 'STOP' })}>
            <Square size={14} /> Стоп
          </button>
          <TrackPicker
            icon={<Captions size={14} />}
            label="Субтитры"
            active={!!p.subtitleId}
            options={(p.subtitles || []).length ? [{ key: 'off', label: 'Выключить', selected: !p.subtitleId, pick: () => control({ type: 'SUBTITLES', id: null }) }, ...(p.subtitles || []).map((s) => ({ key: s.id, label: s.label, selected: p.subtitleId === s.id, pick: () => control({ type: 'SUBTITLES', id: s.id }) }))] : []}
          />
          <TrackPicker
            icon={<AudioLines size={14} />}
            label="Озвучка"
            minOptions={2}
            options={(p.audioTracks || []).map((t) => ({ key: String(t.index), label: t.label, selected: (p.audioIndex ?? 0) === t.index, pick: () => control({ type: 'AUDIO_TRACK', index: t.index }) }))}
          />
          {!music && (
            <button className="btn-ghost px-3 py-2 text-xs" disabled={!tvOnline} onClick={() => control({ type: 'FULLSCREEN' })}>
              <Maximize size={14} /> Экран
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface PickOption {
  key: string;
  label: string;
  selected: boolean;
  pick: () => unknown;
}

/** Subtitles / dubs: a scrollable sheet, so long lists of tracks always fit on screen. */
function TrackPicker({ icon, label, options, active, minOptions = 1 }: { icon: React.ReactNode; label: string; options: PickOption[]; active?: boolean; minOptions?: number }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  if (options.length < minOptions || !options.length) return null;
  const current = options.find((o) => o.selected);
  const shown = filter ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase())) : options;
  return (
    <>
      <button className={cx('btn-ghost max-w-[11rem] px-3 py-2 text-xs', active && 'text-ember')} onClick={() => setOpen(true)} title={current?.label}>
        {icon} <span className="truncate">{label}</span>
      </button>
      <Sheet
        open={open}
        onClose={() => {
          setOpen(false);
          setFilter('');
        }}
        title={`${label} · ${options.length}`}
      >
        {options.length > 8 && <input className="field mb-3" placeholder="Поиск…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <div className="flex flex-col gap-1">
          {shown.map((o) => (
            <button
              key={o.key}
              onClick={() => {
                setOpen(false);
                setFilter('');
                void o.pick();
              }}
              className={cx(
                'flex w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left text-[15px] transition hover:bg-white/5',
                o.selected ? 'bg-ember/10 font-bold text-ember' : 'text-fg',
              )}
            >
              <span className="min-w-0 flex-1 break-words">{o.label}</span>
              {o.selected && <Check size={18} className="shrink-0" />}
            </button>
          ))}
          {!shown.length && <p className="py-6 text-center text-sm text-fg-dim">Ничего не найдено</p>}
        </div>
      </Sheet>
    </>
  );
}

function VolumeCard() {
  const state = useStore((s) => s);
  const p = effectivePlayer(state);
  const [drag, setDrag] = useState<number | null>(null);
  const vol = drag ?? p.volume;
  const tvOnline = state.presence.tvConnected;
  const VolIcon = p.muted || vol === 0 ? VolumeX : vol < 0.5 ? Volume1 : Volume2;

  // Throttled live updates while dragging (optimistic, feels instant)
  useEffect(() => {
    if (drag === null) return;
    const t = setTimeout(() => void control({ type: 'VOLUME', volume: drag }), 60);
    return () => clearTimeout(t);
  }, [drag]);

  return (
    <div className="panel flex items-center gap-2 px-3 py-3">
      <button
        className={cx('icon-btn', p.muted && 'text-ember')}
        disabled={!tvOnline}
        onClick={() => control({ type: 'MUTE' })}
        aria-label="Без звука"
      >
        <VolIcon size={22} />
      </button>
      <button className="icon-btn h-10 w-10 sm:hidden" disabled={!tvOnline} onClick={() => control({ type: 'VOLUME_STEP', delta: -0.05 })}>
        <Minus size={18} />
      </button>
      <div className="flex-1 px-1">
        <Range
          ariaLabel="Громкость"
          value={p.muted ? 0 : vol}
          disabled={!tvOnline}
          onInput={setDrag}
          onCommit={(v) => {
            setDrag(null);
            void control({ type: 'VOLUME', volume: v });
          }}
        />
      </div>
      <button className="icon-btn h-10 w-10 sm:hidden" disabled={!tvOnline} onClick={() => control({ type: 'VOLUME_STEP', delta: 0.05 })}>
        <Plus size={18} />
      </button>
      <span className="tabular w-11 text-right text-sm font-bold text-fg-muted">{Math.round((p.muted ? 0 : vol) * 100)}</span>
    </div>
  );
}

function OpenLinkCard() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (mode: 'play' | 'queue') => {
    if (!text.trim()) return;
    setBusy(true);
    const ok = await openLink(text, mode);
    setBusy(false);
    if (ok) setText('');
  };
  return (
    <form
      className="panel p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run('play');
      }}
    >
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Link2 size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim" />
          <input
            className="field pl-10"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ссылка YouTube или magnet"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <button type="button" className="icon-btn h-12 w-12 bg-ink-750" disabled={busy || !text.trim()} onClick={() => run('queue')} title="В очередь">
          <ListPlus size={20} />
        </button>
        <button className="btn-primary h-12 px-4" disabled={busy || !text.trim()}>
          <Play size={16} fill="currentColor" />
        </button>
      </div>
    </form>
  );
}

function QueueCard() {
  const queue = useStore((s) => s.player.queue);
  const [expanded, setExpanded] = useState(false);
  if (!queue?.length) return null;
  return (
    <div className="panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="label">Очередь · {queue.length}</span>
        <button className="text-xs font-semibold text-fg-dim hover:text-fg" onClick={() => control({ type: 'QUEUE_CLEAR' })}>
          Очистить
        </button>
      </div>
      <div className="flex flex-col">
        {queue.slice(0, expanded ? queue.length : 8).map((q, i) => (
          <div key={q.id} className="group flex items-center gap-1 rounded-xl">
            <button className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-2 text-left hover:bg-white/[0.03]" onClick={() => control({ type: 'QUEUE_JUMP', id: q.id })} title="Играть сейчас">
              <span className="tabular w-5 text-center text-xs font-bold text-fg-dim">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{q.title}</span>
            </button>
            {i > 0 && (
              <button className="icon-btn h-8 w-8 opacity-60 hover:opacity-100" onClick={() => control({ type: 'QUEUE_MOVE', id: q.id, to: 0 })} title="Играть следующим">
                <ChevronUp size={16} />
              </button>
            )}
            <button className="icon-btn h-8 w-8 opacity-60 hover:opacity-100" onClick={() => control({ type: 'QUEUE_REMOVE', id: q.id })} title="Убрать">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {queue.length > 8 && (
          <button className="mt-1 text-xs font-semibold text-fg-dim hover:text-fg" onClick={() => setExpanded((e) => !e)}>
            {expanded ? 'Свернуть' : `Ещё ${queue.length - 8}`}
          </button>
        )}
      </div>
    </div>
  );
}

function HotkeysHint() {
  const keys: [string, string][] = [
    ['Пробел', 'пауза'],
    ['← →', '±10 с'],
    ['↑ ↓', 'громкость'],
    ['M', 'без звука'],
    ['N / P', 'след. / пред.'],
    ['F', 'экран'],
  ];
  return (
    <div className="hidden flex-wrap justify-center gap-x-4 gap-y-1.5 px-2 text-[11px] text-fg-dim lg:flex">
      {keys.map(([k, v]) => (
        <span key={k}>
          <kbd className="rounded-md bg-ink-750 px-1.5 py-0.5 font-sans font-bold text-fg-muted">{k}</kbd> {v}
        </span>
      ))}
    </div>
  );
}
