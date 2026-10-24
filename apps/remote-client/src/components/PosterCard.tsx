import type { MediaItem } from '@tvbox/shared';
import { Play, Pencil, Trash2 } from 'lucide-react';

export function PosterCard({
  item,
  onPlay,
  onEdit,
  onDelete,
}: {
  item: MediaItem;
  onPlay: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const progress = item.progress && item.duration ? Math.min(1, item.progress / item.duration) : 0;
  return (
    <div className="group relative rounded-2xl overflow-hidden bg-raised border border-line hover:border-accent/50 transition-colors">
      <div className="aspect-[2/3] relative overflow-hidden">
        {item.poster ? (
          <img src={item.poster} alt={item.title} loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-raised to-surface text-gray-600">
            <span className="text-3xl">🎬</span>
          </div>
        )}
        {progress > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
            <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
        <button
          onClick={onPlay}
          className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors"
        >
          <span className="w-12 h-12 rounded-full bg-accent text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity scale-75 group-hover:scale-100">
            <Play size={20} className="ml-0.5" />
          </span>
        </button>
        {(onEdit || onDelete) && (
          <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {onEdit && (
              <button onClick={onEdit} className="w-8 h-8 rounded-lg bg-black/70 text-white flex items-center justify-center hover:bg-black/90">
                <Pencil size={14} />
              </button>
            )}
            {onDelete && (
              <button onClick={onDelete} className="w-8 h-8 rounded-lg bg-black/70 text-red-400 flex items-center justify-center hover:bg-black/90">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )}
        {item.type === 'series' && (
          <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/70 text-[10px] uppercase tracking-wide text-gray-200">
            Series
          </span>
        )}
      </div>
      <div className="p-2.5">
        <h3 className="text-sm font-medium truncate">{item.title}</h3>
        <p className="text-[11px] text-gray-500 truncate">
          {item.releaseDate ? item.releaseDate.slice(0, 4) : ''}
          {item.rating ? ` · ★ ${item.rating.toFixed(1)}` : ''}
        </p>
      </div>
    </div>
  );
}
