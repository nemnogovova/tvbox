import { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import type { TorrentInfo } from '@tvbox/shared';
import { Download, Play, Trash2, Plus } from 'lucide-react';

export function DownloadsPage() {
  const { torrents, requestTorrents, addTorrent, removeTorrent, watchTorrent } = useStore();
  const [magnet, setMagnet] = useState('');

  useEffect(() => {
    requestTorrents();
    const t = setInterval(requestTorrents, 4000);
    return () => clearInterval(t);
  }, [requestTorrents]);

  const submit = () => {
    if (!magnet.trim()) return;
    addTorrent(magnet.trim());
    setMagnet('');
  };

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold">Загрузки</h1>

      <div className="flex gap-2">
        <input
          value={magnet}
          onChange={(e) => setMagnet(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="magnet:?xt=urn:btih:… or .torrent dropped anywhere"
          className="flex-1 bg-surface border border-line rounded-xl px-3 py-2.5 text-sm outline-none focus:border-accent"
        />
        <button onClick={submit} className="btn-primary">
          <Plus size={16} /> Add
        </button>
      </div>

      {torrents.length === 0 ? (
        <div className="text-center text-gray-500 py-16">
          <Download size={40} className="mx-auto mb-3 opacity-40" />
          <p>No active downloads</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {torrents.map((t) => (
            <TorrentCard key={t.id} t={t} onRemove={() => removeTorrent(t.id)} onWatch={() => watchTorrent(t.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TorrentCard({ t, onRemove, onWatch }: { t: TorrentInfo; onRemove: () => void; onWatch: () => void }) {
  const pct = Math.round(t.progress * 100);
  const canWatch = t.files.length > 0 || t.progress > 0;
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-sm truncate">{t.name}</p>
          <p className="text-xs text-gray-500">
            {statusLabel(t.status)}
            {t.downloadSpeed > 0 && ` · ↓ ${fmtSpeed(t.downloadSpeed)}`}
            {t.uploadSpeed > 0 && ` · ↑ ${fmtSpeed(t.uploadSpeed)}`}
            {` · ${t.peers} peers`}
          </p>
        </div>
        <div className="flex gap-1 shrink-0">
          {canWatch && (
            <button onClick={onWatch} className="btn-primary !px-3 !py-1.5 !text-xs" title="Watch now">
              <Play size={14} /> Watch
            </button>
          )}
          <button onClick={onRemove} className="btn-danger !px-3 !py-1.5" title="Remove">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className="h-2 rounded-full bg-raised overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${pct >= 100 ? 'bg-emerald-400' : 'bg-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[11px] text-gray-500">
        <span>{pct}%</span>
        <span>
          {fmtSize(t.downloaded)} / {fmtSize(t.size)}
        </span>
      </div>
    </div>
  );
}

function statusLabel(s: TorrentInfo['status']): string {
  switch (s) {
    case 'downloading':
      return 'Downloading';
    case 'seeding':
      return 'Seeding';
    case 'done':
      return 'Complete';
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Error';
    default:
      return s;
  }
}

function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
