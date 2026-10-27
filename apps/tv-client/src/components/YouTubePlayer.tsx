import type { PlayTarget } from '../bridge';

/**
 * YouTube itself is drawn by the main process (YouTube TV in a view laid over the window).
 * The view is added only once YouTube has rendered, and this calm splash covers the moment
 * before that — instead of a white page loading and jumping into full screen.
 */
export function YouTubePlaceholder({ target }: { target: PlayTarget }) {
  return (
    <div className="relative flex h-full w-full animate-fade-in items-center justify-center overflow-hidden bg-black">
      {target.backdrop && <img src={target.backdrop} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-25 blur-2xl" />}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(255,0,51,0.12),transparent_60%)]" />
      <div className="relative flex flex-col items-center">
        <div className="relative">
          <div className="absolute inset-0 animate-pulse-dot rounded-[2.2rem] bg-[#ff0033]/40 blur-2xl" />
          <svg viewBox="0 0 90 64" className="relative h-[6.5rem] w-[9rem] drop-shadow-2xl">
            <rect width="90" height="64" rx="18" fill="#ff0033" />
            <path d="M36 19 L62 32 L36 45 Z" fill="#fff" />
          </svg>
        </div>
        <p className="mt-[2.2rem] text-[2.4rem] font-extrabold tracking-tight">YouTube</p>
        {target.videoId && target.title && target.title !== 'YouTube' && (
          <p className="mt-[0.6rem] max-w-[60vw] truncate text-[1.3rem] text-fg-muted">{target.title}</p>
        )}
        <div className="mt-[2.4rem] h-[0.3rem] w-[12rem] overflow-hidden rounded-full bg-white/10">
          <div className="h-full w-1/3 animate-[yt-load_1.1s_ease-in-out_infinite] rounded-full bg-[#ff0033]" />
        </div>
      </div>
      <style>{'@keyframes yt-load{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}'}</style>
    </div>
  );
}
