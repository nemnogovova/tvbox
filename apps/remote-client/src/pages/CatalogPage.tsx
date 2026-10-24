import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/store';
import type { MediaItem } from '@tvbox/shared';
import { Play, Search, FolderOpen, Pencil, Trash2, Film, X, Check } from 'lucide-react';
import { PosterCard } from '../components/PosterCard';
import { useIsOwner } from '../store/store';

export function CatalogPage() {
  const { catalog, requestCatalog, requestFs, fsResult, control, deleteFile, updateMetadata } = useStore();
  const isOwner = useIsOwner();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'media' | 'files'>('media');
  const [series, setSeries] = useState<MediaItem | null>(null);
  const [editing, setEditing] = useState<MediaItem | null>(null);

  useEffect(() => {
    requestCatalog();
    requestFs('');
  }, [requestCatalog, requestFs]);

  const seriesEpisodes = useMemo(() => {
    if (!series) return [];
    return catalog
      .filter((m) => m.seriesId === series.id || (m.type === 'episode' && m.seriesId === series.id))
      .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
  }, [series, catalog]);

  const movies = useMemo(
    () =>
      catalog
        .filter((m) => m.type !== 'episode' && (m.type === 'movie' || m.type === 'file' || m.type === 'series'))
        .filter((m) => m.title.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)),
    [catalog, query],
  );

  const play = (m: MediaItem) => {
    control({ type: 'PLAY_SOURCE', source: 'local', mediaId: m.id, title: m.title });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Каталог</h1>
        <div className="flex gap-1 bg-raised rounded-xl p-1 ml-auto">
          <button
            onClick={() => setView('media')}
            className={`px-3 py-1.5 rounded-lg text-sm ${view === 'media' ? 'bg-accent text-white' : 'text-gray-400'}`}
          >
            Медиа
          </button>
          <button
            onClick={() => setView('files')}
            className={`px-3 py-1.5 rounded-lg text-sm ${view === 'files' ? 'bg-accent text-white' : 'text-gray-400'}`}
          >
            Файлы
          </button>
        </div>
      </div>

      {view === 'media' ? (
        <>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your library…"
              className="w-full bg-surface border border-line rounded-xl pl-10 pr-3 py-2.5 text-sm outline-none focus:border-accent"
            />
          </div>

          {movies.length === 0 ? (
            <div className="text-center text-gray-500 py-16">
              <Film size={40} className="mx-auto mb-3 opacity-40" />
              <p>Your library is empty</p>
              <p className="text-xs mt-1">Add torrents or browse files to populate it</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {movies.map((m) => (
                <PosterCard
                  key={m.id}
                  item={m}
                  onPlay={() => (m.type === 'series' ? setSeries(m) : play(m))}
                  onEdit={isOwner ? () => setEditing(m) : undefined}
                  onDelete={isOwner ? () => deleteFile(m.id, m.fileId) : undefined}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <FileBrowser fsResult={fsResult} requestFs={requestFs} />
      )}

      {series && (
        <SeriesModal
          series={series}
          episodes={seriesEpisodes}
          onClose={() => setSeries(null)}
          onPlay={play}
        />
      )}

      {editing && (
        <EditModal
          item={editing}
          onClose={() => setEditing(null)}
          onSave={(payload) => {
            updateMetadata({ mediaId: editing.id, ...payload });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function FileBrowser({
  fsResult,
  requestFs,
}: {
  fsResult: { path: string; entries: { name: string; path: string; kind: string; size?: number }[] } | null;
  requestFs: (p?: string) => void;
}) {
  const { control } = useStore();
  if (!fsResult) return <p className="text-gray-500">Loading filesystem…</p>;
  const parent = fsResult.path.split(/[\\/]/).slice(0, -1).join('/') || '/';

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3 text-sm">
        <FolderOpen size={16} className="text-accent" />
        <span className="truncate text-gray-300">{fsResult.path || '/'}</span>
        <button onClick={() => requestFs(parent)} className="ml-auto text-xs btn-ghost !py-1 !px-2">
          Up
        </button>
      </div>
      <div className="flex flex-col divide-y divide-line">
        {fsResult.entries.map((e) => (
          <button
            key={e.path}
            onClick={() => {
              if (e.kind === 'dir') requestFs(e.path);
              else if (e.kind === 'video' || e.kind === 'audio' || e.kind === 'image') {
                control({ type: 'PLAY_SOURCE', source: 'local', url: e.path, title: e.name });
              }
            }}
            className="flex items-center gap-3 py-2.5 text-left hover:bg-raised/50 rounded-lg px-2"
          >
            <span className="text-gray-400">{e.kind === 'dir' ? '📁' : '📄'}</span>
            <span className="truncate text-sm flex-1">{e.name}</span>
            {e.size !== undefined && <span className="text-xs text-gray-500">{fmtSize(e.size)}</span>}
          </button>
        ))}
        {fsResult.entries.length === 0 && <p className="text-gray-600 text-sm py-4 text-center">Empty</p>}
      </div>
    </div>
  );
}

function SeriesModal({
  series,
  episodes,
  onClose,
  onPlay,
}: {
  series: MediaItem;
  episodes: MediaItem[];
  onClose: () => void;
  onPlay: (m: MediaItem) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="bg-surface border border-line rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto p-5 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-lg">{series.title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={20} />
          </button>
        </div>
        {episodes.length === 0 ? (
          <p className="text-gray-500 text-sm">No episodes found</p>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {episodes.map((e) => (
              <button
                key={e.id}
                onClick={() => onPlay(e)}
                className="flex items-center gap-3 p-3 rounded-xl bg-raised hover:bg-raised/70 text-left"
              >
                <Play size={16} className="text-accent shrink-0" />
                <span className="text-sm flex-1 truncate">
                  {e.season !== undefined && e.episode !== undefined
                    ? `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`
                    : ''}{' '}
                  {e.title}
                </span>
                {e.progress !== undefined && e.duration ? (
                  <span className="text-xs text-gray-500">{Math.round((e.progress / e.duration) * 100)}%</span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EditModal({
  item,
  onClose,
  onSave,
}: {
  item: MediaItem;
  onClose: () => void;
  onSave: (p: { title?: string; overview?: string; poster?: string }) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [overview, setOverview] = useState(item.overview || '');
  const [poster, setPoster] = useState(item.poster || '');
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-surface border border-line rounded-2xl w-full max-w-md p-5 animate-slide-up flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Edit metadata</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={20} />
          </button>
        </div>
        <label className="text-xs text-gray-500">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full mt-1 bg-raised border border-line rounded-xl px-3 py-2 text-sm outline-none focus:border-accent" />
        </label>
        <label className="text-xs text-gray-500">
          Overview
          <textarea value={overview} onChange={(e) => setOverview(e.target.value)} rows={3} className="w-full mt-1 bg-raised border border-line rounded-xl px-3 py-2 text-sm outline-none focus:border-accent resize-none" />
        </label>
        <label className="text-xs text-gray-500">
          Poster URL
          <input value={poster} onChange={(e) => setPoster(e.target.value)} className="w-full mt-1 bg-raised border border-line rounded-xl px-3 py-2 text-sm outline-none focus:border-accent" />
        </label>
        <div className="flex gap-2 justify-end mt-2">
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button
            onClick={() => onSave({ title, overview, poster })}
            className="btn-primary"
          >
            <Check size={16} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export { fmtSize };
