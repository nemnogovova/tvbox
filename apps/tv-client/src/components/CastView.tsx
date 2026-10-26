import { useEffect, useRef } from 'react';
import { Music2, Radio } from 'lucide-react';
import type { CastView as CastState } from '../hooks/useCastReceiver';

export function CastView({ cast }: { cast: CastState }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (v && cast.stream && v.srcObject !== cast.stream) {
      v.srcObject = cast.stream;
      void v.play().catch(() => undefined);
    }
  }, [cast.stream]);

  return (
    <div className="relative h-full w-full bg-black">
      {cast.image ? (
        <img key={cast.image} src={cast.image} alt="" className="h-full w-full animate-fade-in object-contain" />
      ) : (
        <video ref={ref} autoPlay playsInline className={cast.hasVideo ? 'h-full w-full object-contain' : 'hidden'} />
      )}
      {!cast.image && !cast.hasVideo && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
          <div className="flex h-[28vh] w-[28vh] items-center justify-center rounded-[3rem] bg-ink-800 text-ember">
            {cast.stream ? <Music2 size={110} /> : <Radio size={110} className="animate-pulse-dot" />}
          </div>
          <div className="text-[2.2rem] font-extrabold">{cast.label}</div>
          {!cast.stream && cast.receiving === null && <div className="text-[1.4rem] text-fg-muted">Подключаемся…</div>}
        </div>
      )}
      {cast.receiving !== null && (
        <div className="absolute inset-x-[30vw] bottom-[8vh] h-2 overflow-hidden rounded-full bg-white/15">
          <div className="h-full bg-ember transition-all" style={{ width: `${Math.round(cast.receiving * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
