import type { PlayTarget } from '../bridge';

/**
 * YouTube videos are played by the main process in a youtube.com watch page laid over
 * the window (works for videos with embedding disabled and with a signed-in account).
 * This only shows the thumbnail while the page loads underneath it.
 */
export function YouTubePlaceholder({ target }: { target: PlayTarget }) {
  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black">
      {target.backdrop && <img src={target.backdrop} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />}
      <div className="relative h-16 w-16 animate-spin rounded-full border-4 border-white/20 border-t-ember" />
    </div>
  );
}
