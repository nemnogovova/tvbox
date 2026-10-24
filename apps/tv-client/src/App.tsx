import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlCommand, IdleSettings, MediaItem, PlayerState, WidgetConfig } from '@tvbox/shared';
import type { PlayTarget, TvInfo } from './types';
import { IdleScreen } from './components/IdleScreen';
import { PlayerOverlay, type PlayerApi } from './components/PlayerOverlay';
import { SetupScreen } from './components/SetupScreen';
import { useWebrtcReceiver } from './hooks/useWebrtcReceiver';
import { Settings } from 'lucide-react';

const DEFAULT_STATE: PlayerState = {
  source: 'none',
  playing: false,
  paused: true,
  title: '',
  duration: 0,
  position: 0,
  volume: 1,
  muted: false,
  fullscreen: false,
};

const DEFAULT_IDLE: IdleSettings = {
  showClock: true,
  showWeather: true,
  showQr: true,
  screensaver: 'black',
  screensaverDelayMs: 5 * 60 * 1000,
  widgets: [],
};

export default function App() {
  const [mode, setMode] = useState<'idle' | 'player'>('idle');
  const [target, setTarget] = useState<PlayTarget | null>(null);
  const [state, setState] = useState<PlayerState>(DEFAULT_STATE);
  const [idle, setIdle] = useState<IdleSettings>(DEFAULT_IDLE);
  const [widgets, setWidgets] = useState<WidgetConfig[]>([]);
  const [catalog, setCatalog] = useState<MediaItem[]>([]);
  const [backendUrl, setBackendUrl] = useState('http://localhost:3000');
  const [screensaver, setScreensaver] = useState(false);
  const [info, setInfo] = useState<TvInfo | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  const playerRef = useRef<PlayerApi>(null);
  const mediaIdRef = useRef<string | undefined>(undefined);
  const stateRef = useRef(state);
  stateRef.current = state;
  const webrtc = useWebrtcReceiver();

  const handleControl = useCallback((cmd: ControlCommand) => {
    switch (cmd.type) {
      case 'PLAY':
        playerRef.current?.play();
        setState((s) => ({ ...s, playing: true, paused: false }));
        break;
      case 'RESUME':
        playerRef.current?.resume();
        setState((s) => ({ ...s, playing: true, paused: false }));
        break;
      case 'PAUSE':
        playerRef.current?.pause();
        setState((s) => ({ ...s, playing: false, paused: true }));
        break;
      case 'SEEK':
        playerRef.current?.seek(cmd.position);
        setState((s) => ({ ...s, position: cmd.position }));
        break;
      case 'VOLUME':
        playerRef.current?.setVolume(cmd.volume);
        setState((s) => ({ ...s, volume: cmd.volume }));
        break;
      case 'MUTE':
        playerRef.current?.setMuted(cmd.muted);
        setState((s) => ({ ...s, muted: cmd.muted }));
        break;
      case 'FULLSCREEN':
        playerRef.current?.setFullscreen(cmd.fullscreen);
        setState((s) => ({ ...s, fullscreen: cmd.fullscreen }));
        break;
      case 'STOP':
        playerRef.current?.stop();
        setTarget(null);
        setMode('idle');
        break;
      default:
        break;
    }
  }, []);

  useEffect(() => {
    void window.tvbox.getInfo().then((i) => {
      setInfo(i);
      setBackendUrl(i.backendUrl);
      if (!i.configured) setShowSetup(true);
    });
    void window.tvbox.getCatalog().then(setCatalog);
    window.tvbox.requestWidgets();

    const offPlay = window.tvbox.onPlay((t) => {
      setTarget(t);
      mediaIdRef.current = t.mediaId;
      setScreensaver(false);
      setMode('player');
    });
    const offControl = window.tvbox.onControl((cmd) => handleControl(cmd as ControlCommand));
    const offWidgets = window.tvbox.onWidgets(({ widgets, settings }) => {
      setWidgets(widgets);
      setIdle(settings);
    });
    const refresh = setInterval(() => void window.tvbox.getCatalog().then(setCatalog), 30000);
    return () => {
      offPlay();
      offControl();
      offWidgets();
      clearInterval(refresh);
    };
  }, [handleControl]);

  useEffect(() => {
    if (webrtc.active) setMode('player');
  }, [webrtc.active]);

  useEffect(() => {
    if (mode !== 'player') return;
    const t = setInterval(() => {
      const s = stateRef.current;
      if (mediaIdRef.current && s.duration > 0) {
        window.tvbox.sendProgress({ mediaId: mediaIdRef.current, position: s.position, duration: s.duration });
      }
    }, 5000);
    return () => clearInterval(t);
  }, [mode]);

  const onPlayerState = useCallback((s: PlayerState) => setState(s), []);

  useEffect(() => {
    window.tvbox.sendPlayerState(state);
  }, [state]);

  // cursor auto-hide
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const show = () => {
      document.body.classList.remove('idle-cursor');
      clearTimeout(timer);
      timer = setTimeout(() => document.body.classList.add('idle-cursor'), 3000);
    };
    window.addEventListener('mousemove', show);
    show();
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousemove', show);
    };
  }, []);

  // screensaver
  useEffect(() => {
    if (mode === 'player' || idle.screensaver === 'off') return;
    let timer = setTimeout(() => setScreensaver(true), idle.screensaverDelayMs);
    const reset = () => {
      setScreensaver(false);
      clearTimeout(timer);
      timer = setTimeout(() => setScreensaver(true), idle.screensaverDelayMs);
    };
    window.addEventListener('mousemove', reset);
    window.addEventListener('keydown', reset);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousemove', reset);
      window.removeEventListener('keydown', reset);
    };
  }, [mode, idle.screensaver, idle.screensaverDelayMs]);

  if (showSetup) {
    return (
      <SetupScreen
        initial={info}
        onDone={() => {
          setShowSetup(false);
          void window.tvbox.getInfo().then((i) => {
            setInfo(i);
            setBackendUrl(i.backendUrl);
          });
          void window.tvbox.getCatalog().then(setCatalog);
          setMode('idle');
        }}
      />
    );
  }

  if (mode === 'player') {
    if (webrtc.active && webrtc.stream) {
      return (
        <div className="w-full h-full bg-black">
          <video ref={(el) => el && (el.srcObject = webrtc.stream)} autoPlay playsInline className="w-full h-full object-contain" />
        </div>
      );
    }
    if (target) {
      return (
        <div id="player-root" className="w-full h-full bg-black">
          <PlayerOverlay
            ref={playerRef}
            target={target}
            onState={onPlayerState}
            onEnded={() => {
              setTarget(null);
              setMode('idle');
            }}
          />
        </div>
      );
    }
  }

  if (screensaver && idle.screensaver !== 'off') {
    return <Screensaver kind={idle.screensaver} />;
  }

  return (
    <div className="w-full h-full relative">
      <IdleScreen settings={{ ...idle, widgets }} catalog={catalog} backendUrl={backendUrl} />
      <button
        onClick={() => setShowSetup(true)}
        className="absolute bottom-5 right-5 w-11 h-11 rounded-full bg-surface/80 border border-line text-gray-400 hover:text-white flex items-center justify-center"
        title="Настройки"
      >
        <Settings size={20} />
      </button>
    </div>
  );
}

function Screensaver({ kind }: { kind: 'black' | 'clock' | 'wallpaper' }) {
  if (kind === 'black') return <div className="w-full h-full bg-black" />;
  if (kind === 'wallpaper') {
    return <div className="w-full h-full bg-gradient-to-br from-[#0b0b1a] via-[#141428] to-[#1a0b24]" />;
  }
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <div className="w-full h-full bg-black flex items-center justify-center">
      <div className="text-9xl font-extralight text-white/40 tabular-nums">{time}</div>
    </div>
  );
}
