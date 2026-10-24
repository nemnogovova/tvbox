import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/store';
import type { ControlCommand } from '@tvbox/shared';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Square,
  Youtube,
  SkipBack,
  SkipForward,
} from 'lucide-react';

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function RemotePanel() {
  const { playerState, control, connected, presence } = useStore();
  const [seekPos, setSeekPos] = useState(0);
  const [vol, setVol] = useState(1);
  const dragging = useRef(false);

  useEffect(() => {
    if (!dragging.current) setSeekPos(playerState?.position ?? 0);
  }, [playerState?.position]);
  useEffect(() => {
    setVol(playerState?.volume ?? 1);
  }, [playerState?.volume]);

  const state = playerState;
  const duration = state?.duration || 0;
  const source = state?.source || 'none';

  const onSeekInput = (v: number) => {
    dragging.current = true;
    setSeekPos(v);
  };
  const onSeekCommit = (v: number) => {
    dragging.current = false;
    control({ type: 'SEEK', position: v });
  };

  const togglePlay = () => control({ type: state?.playing ? 'PAUSE' : 'RESUME' });

  return (
    <div className="flex flex-col gap-5">
      {/* Now playing */}
      <div className="card p-5 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {source === 'youtube' && <Youtube size={14} className="text-red-400" />}
              <span className="text-[10px] uppercase tracking-wider text-gray-500">{sourceLabel(source)}</span>
            </div>
            <h2 className="font-semibold text-lg leading-tight truncate">{state?.title || 'Nothing playing'}</h2>
            {state?.subtitle && <p className="text-xs text-gray-500 truncate">{state.subtitle}</p>}
          </div>
          <button onClick={() => control({ type: 'STOP' })} className="btn-ghost !px-3 !py-2" title="Stop">
            <Square size={16} />
          </button>
        </div>

        {/* Seek */}
        <div>
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.5}
            value={Math.min(seekPos, duration || 1)}
            onChange={(e) => onSeekInput(Number(e.target.value))}
            onPointerUp={(e) => onSeekCommit(Number((e.target as HTMLInputElement).value))}
            onMouseUp={(e) => onSeekCommit(Number((e.target as HTMLInputElement).value))}
            className="w-full"
            disabled={!connected || duration === 0}
          />
          <div className="flex justify-between text-[11px] text-gray-500">
            <span>{formatTime(seekPos)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Transport */}
        <div className="flex items-center justify-center gap-6">
          <button
            onClick={() => onSeekCommit(Math.max(0, seekPos - 10))}
            className="text-gray-400 hover:text-white"
            title="Back 10s"
          >
            <SkipBack size={20} />
          </button>
          <button
            onClick={togglePlay}
            disabled={!connected}
            className="w-16 h-16 rounded-full bg-accent hover:bg-accent/90 active:scale-95 text-white flex items-center justify-center transition-all disabled:opacity-40"
          >
            {state?.playing ? <Pause size={28} /> : <Play size={28} className="ml-0.5" />}
          </button>
          <button
            onClick={() => onSeekCommit(seekPos + 10)}
            className="text-gray-400 hover:text-white"
            title="Forward 10s"
          >
            <SkipForward size={20} />
          </button>
        </div>
      </div>

      {/* Volume */}
      <div className="card p-5 flex items-center gap-3">
        <button
          onClick={() => control({ type: 'MUTE', muted: !state?.muted })}
          className="text-gray-400 hover:text-white"
        >
          {state?.muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={vol}
          onChange={(e) => {
            setVol(Number(e.target.value));
            control({ type: 'VOLUME', volume: Number(e.target.value) });
          }}
          className="flex-1"
        />
        <span className="text-xs text-gray-500 w-8 text-right">{Math.round(vol * 100)}%</span>
      </div>

      {/* YouTube quick launch */}
      <div className="card p-4">
        <p className="text-xs text-gray-500 mb-2">Play YouTube link / video ID</p>
        <YouTubeLauncher control={control} />
      </div>

      <div className="flex items-center justify-center text-xs text-gray-600 gap-1.5">
        <span className={`w-2 h-2 rounded-full ${presence.tvConnected ? 'bg-emerald-400' : 'bg-red-400'}`} />
        {presence.tvConnected ? 'Connected to TV' : 'TV offline — commands will be queued'}
      </div>
    </div>
  );
}

function sourceLabel(s: string): string {
  switch (s) {
    case 'youtube':
      return 'YouTube';
    case 'local':
      return 'Local file';
    case 'torrent':
      return 'Torrent stream';
    case 'webrtc':
      return 'Live cast';
    default:
      return 'Idle';
  }
}

function YouTubeLauncher({ control }: { control: (cmd: ControlCommand) => void }) {
  const [url, setUrl] = useState('');
  const submit = () => {
    if (!url.trim()) return;
    control({ type: 'PLAY_SOURCE', source: 'youtube', url: url.trim() });
    setUrl('');
  };
  return (
    <div className="flex gap-2">
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="https://youtube.com/watch?v=…"
        className="flex-1 bg-raised border border-line rounded-xl px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <button onClick={submit} className="btn-primary !px-3">
        <Youtube size={16} />
      </button>
    </div>
  );
}
