import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { PlayerState } from '@tvbox/shared';
import type { PlayTarget } from '../types';

export interface PlayerApi {
  play: () => void;
  pause: () => void;
  resume: () => void;
  seek: (pos: number) => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setFullscreen: (f: boolean) => void;
  stop: () => void;
}

interface Props {
  target: PlayTarget;
  onState: (s: PlayerState) => void;
  onEnded: () => void;
}

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement, opts: Record<string, unknown>) => YtPlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YtPlayer {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (s: number, allowSeekAhead: boolean) => void;
  setVolume: (v: number) => void;
  mute: () => void;
  unMute: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getVolume: () => number;
  isMuted: () => boolean;
  stopVideo: () => void;
  destroy: () => void;
}

const isYouTube = (t: PlayTarget) => t.kind === 'youtube';

export const PlayerOverlay = forwardRef<PlayerApi, Props>(function PlayerOverlay({ target, onState, onEnded }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const ytContainerRef = useRef<HTMLDivElement>(null);
  const ytRef = useRef<YtPlayer | null>(null);
  const [ytReady, setYtReady] = useState(false);
  const playingRef = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;

  const emitState = useCallback(() => {
    if (targetRef.current.kind === 'youtube') {
      const yt = ytRef.current;
      onState({
        source: 'youtube',
        playing: playingRef.current,
        paused: !playingRef.current,
        title: targetRef.current.title || '',
        duration: yt?.getDuration?.() || 0,
        position: yt?.getCurrentTime?.() || 0,
        volume: (yt?.getVolume?.() || 0) / 100,
        muted: yt?.isMuted?.() || false,
        fullscreen: false,
      });
    } else {
      const v = videoRef.current;
      if (v) {
        onState({
          source: targetRef.current.kind === 'torrent' ? 'torrent' : 'local',
          playing: !v.paused,
          paused: v.paused,
          title: targetRef.current.title || '',
          duration: v.duration || 0,
          position: v.currentTime || 0,
          volume: v.volume,
          muted: v.muted,
          fullscreen: document.fullscreenElement != null,
        });
      }
    }
  }, [onState, ytReady]);

  // ---- YouTube ----
  useEffect(() => {
    if (!isYouTube(target)) return;
    let disposed = false;

    const init = () => {
      if (disposed || !ytContainerRef.current || !window.YT) return;
      ytRef.current?.destroy();
      ytRef.current = new window.YT.Player(ytContainerRef.current, {
        width: '100%',
        height: '100%',
        videoId: target.videoId,
        playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => setYtReady(true),
          onStateChange: (e: { data: number }) => {
            playingRef.current = e.data === 1;
            if (e.data === 0) onEnded();
            emitState();
          },
        },
      });
    };

    if (window.YT?.Player) init();
    else {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        init();
        prev?.();
      };
      if (!document.getElementById('yt-iframe-api')) {
        const s = document.createElement('script');
        s.id = 'yt-iframe-api';
        s.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(s);
      }
    }

    return () => {
      disposed = true;
      setYtReady(false);
      try {
        ytRef.current?.destroy();
      } catch {
        // noop
      }
      ytRef.current = null;
    };
  }, [target, onEnded, emitState]);

  // Reset on target change
  useEffect(() => {
    setYtReady(false);
  }, [target]);

  useImperativeHandle(ref, () => ({
    play: () => {
      if (isYouTube(targetRef.current)) ytRef.current?.playVideo();
      else void videoRef.current?.play();
    },
    pause: () => {
      if (isYouTube(targetRef.current)) ytRef.current?.pauseVideo();
      else videoRef.current?.pause();
    },
    resume: () => {
      if (isYouTube(targetRef.current)) ytRef.current?.playVideo();
      else void videoRef.current?.play();
    },
    seek: (pos) => {
      if (isYouTube(targetRef.current)) ytRef.current?.seekTo(pos, true);
      else if (videoRef.current) videoRef.current.currentTime = pos;
    },
    setVolume: (v) => {
      if (isYouTube(targetRef.current)) ytRef.current?.setVolume(Math.round(v * 100));
      else if (videoRef.current) videoRef.current.volume = v;
    },
    setMuted: (m) => {
      if (isYouTube(targetRef.current)) {
        if (m) ytRef.current?.mute();
        else ytRef.current?.unMute();
      } else if (videoRef.current) videoRef.current.muted = m;
    },
    setFullscreen: (f) => {
      const el = document.getElementById('player-root');
      if (f) void el?.requestFullscreen?.();
      else if (document.fullscreenElement) void document.exitFullscreen?.();
    },
    stop: () => {
      if (isYouTube(targetRef.current)) ytRef.current?.stopVideo?.();
      else videoRef.current?.pause();
    },
  }));

  if (isYouTube(target)) {
    return <div ref={ytContainerRef} className="w-full h-full" />;
  }

  return (
    <video
      ref={videoRef}
      src={target.url}
      autoPlay
      controls={false}
      className="w-full h-full object-contain bg-black"
      onTimeUpdate={emitState}
      onLoadedMetadata={emitState}
      onPlay={emitState}
      onPause={emitState}
      onEnded={onEnded}
      onVolumeChange={emitState}
    />
  );
});
