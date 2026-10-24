import { useRef, useState } from 'react';
import { useStore } from '../store/store';
import { castFile, castScreen, castWebcam, type ActiveCast } from '../lib/webrtc';
import { MonitorUp, Camera, FileVideo, Square } from 'lucide-react';

export function CastPage() {
  const { socket, presence } = useStore();
  const [active, setActive] = useState<ActiveCast | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const canCast = !!socket && presence.tvConnected;

  const start = async (fn: () => Promise<ActiveCast>) => {
    if (active) active.close();
    try {
      const cast = await fn();
      setActive(cast);
    } catch (e) {
      console.error(e);
    }
  };

  const stop = () => {
    active?.close();
    setActive(null);
  };

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold">Кастинг</h1>
      <p className="text-sm text-gray-500 -mt-3">
        Stream your screen, camera or a media file directly to the TV over WebRTC (P2P, no server storage).
      </p>

      <input
        ref={fileInput}
        type="file"
        accept="video/*,audio/*,image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) start(() => castFile(socket!, f));
          e.target.value = '';
        }}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button
          onClick={() => fileInput.current?.click()}
          disabled={!canCast}
          className="card p-6 flex flex-col items-center gap-3 hover:border-accent/50 transition-colors disabled:opacity-40"
        >
          <FileVideo size={28} className="text-accent" />
          <span className="font-medium">Cast a file</span>
          <span className="text-xs text-gray-500">Video / audio / photo</span>
        </button>
        <button
          onClick={() => start(() => castScreen(socket!))}
          disabled={!canCast}
          className="card p-6 flex flex-col items-center gap-3 hover:border-accent/50 transition-colors disabled:opacity-40"
        >
          <MonitorUp size={28} className="text-accent2" />
          <span className="font-medium">Share screen</span>
          <span className="text-xs text-gray-500">Mirror your desktop</span>
        </button>
        <button
          onClick={() => start(() => castWebcam(socket!))}
          disabled={!canCast}
          className="card p-6 flex flex-col items-center gap-3 hover:border-accent/50 transition-colors disabled:opacity-40"
        >
          <Camera size={28} className="text-emerald-400" />
          <span className="font-medium">Camera</span>
          <span className="text-xs text-gray-500">Live webcam feed</span>
        </button>
      </div>

      {active && (
        <div className="card p-4 flex items-center justify-between">
          <div>
            <p className="font-medium text-sm">Casting: {active.label}</p>
            <p className="text-xs text-gray-500">{active.kind}</p>
          </div>
          <button onClick={stop} className="btn-danger">
            <Square size={16} /> Stop
          </button>
        </div>
      )}

      {!canCast && (
        <p className="text-sm text-amber-400">TV is offline — cannot cast right now.</p>
      )}
    </div>
  );
}
