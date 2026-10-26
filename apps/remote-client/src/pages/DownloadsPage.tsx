import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Download, FileUp, Magnet, Play, Plus, Trash2, Users } from 'lucide-react';
import { Events, formatBytes, formatDuration, formatSpeed, type TorrentInfo } from '@tvbox/shared';
import { act, control, useStore } from '../store/store';
import { sendTorrentFile } from '../lib/actions';
import { Empty, Sheet, cx } from '../components/ui';

export function DownloadsPage() {
  const torrents = useStore((s) => s.torrents);
  const tvOnline = useStore((s) => s.presence.tvConnected);
  const [magnet, setMagnet] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const add = async (play: boolean) => {
    const m = magnet.trim();
    if (!m) return;
    const r = await act(Events.TORRENT_ADD, { magnet: m, play }, play ? 'Начинаем — откроется на ТВ, как только наберётся буфер' : 'Добавлено в загрузки');
    if (r.ok) setMagnet('');
  };

  const sorted = [...torrents].sort((a, b) => b.addedAt - a.addedAt);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="h-page">Загрузки</h1>

      <div className="panel p-3">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void add(false);
          }}
        >
          <div className="relative flex-1">
            <Magnet size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim" />
            <input
              className="field pl-10"
              value={magnet}
              onChange={(e) => setMagnet(e.target.value)}
              placeholder="magnet:?xt=urn:btih:…"
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-soft flex-1 sm:flex-none" disabled={!magnet.trim() || !tvOnline} onClick={() => add(true)}>
              <Play size={16} /> Смотреть
            </button>
            <button className="btn-primary flex-1 sm:flex-none" disabled={!magnet.trim() || !tvOnline}>
              <Plus size={16} /> Скачать
            </button>
          </div>
        </form>
        <button className="btn-ghost mt-1 w-full text-xs" disabled={!tvOnline} onClick={() => fileRef.current?.click()}>
          <FileUp size={15} /> Выбрать .torrent файл
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".torrent,application/x-bittorrent"
          multiple
          hidden
          onChange={(e) => {
            for (const f of Array.from(e.target.files || [])) void sendTorrentFile(f);
            e.target.value = '';
          }}
        />
      </div>

      {sorted.length === 0 ? (
        <Empty
          icon={<Download size={28} />}
          title="Загрузок нет"
          text="Вставьте magnet-ссылку, перетащите .torrent файл в окно или откройте торрент из браузера телефона."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {sorted.map((t) => (
            <TorrentCard key={t.id} t={t} />
          ))}
        </div>
      )}

      <p className="px-2 text-center text-xs leading-relaxed text-fg-dim">
        Раздача отключается сразу после завершения загрузки — канал не тратится на чужие скачивания.
      </p>
    </div>
  );
}

function TorrentCard({ t }: { t: TorrentInfo }) {
  const [pickFile, setPickFile] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const pct = Math.floor(t.progress * 1000) / 10;
  const done = t.status === 'done';
  const playable = t.files.filter((f) => f.playable);

  const watch = (fileIndex?: number) => {
    void control({ type: 'PLAY_SOURCE', request: { source: 'torrent', torrentId: t.id, fileIndex, title: t.name } });
    setPickFile(false);
  };

  return (
    <div className="panel p-4">
      <div className="flex items-start gap-3">
        <div className={cx('mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl', done ? 'bg-ok/15 text-ok' : 'bg-ember/15 text-ember')}>
          {done ? <CheckCircle2 size={20} /> : <Download size={20} />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 break-all text-sm font-bold leading-snug">{t.name || 'Получаем метаданные…'}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-dim">
            {t.status === 'metadata' && <span>Ищем пиров…</span>}
            {t.status === 'error' && <span className="text-bad">{t.error || 'Ошибка'}</span>}
            {t.status === 'downloading' && (
              <>
                <span className="flex items-center gap-1">
                  <ArrowDown size={12} /> {formatSpeed(t.downloadSpeed)}
                </span>
                {t.uploadSpeed > 1024 && (
                  <span className="flex items-center gap-1">
                    <ArrowUp size={12} /> {formatSpeed(t.uploadSpeed)}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Users size={12} /> {t.peers}
                </span>
                {t.eta !== undefined && t.eta > 0 && t.eta < 360000 && <span>≈ {formatDuration(t.eta)}</span>}
              </>
            )}
            {done && <span className="text-ok">Готово · раздача остановлена</span>}
          </div>
        </div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-ink-700">
        <div className={cx('h-full rounded-full transition-all duration-700', done ? 'bg-ok' : 'bg-ember')} style={{ width: `${Math.max(1, pct)}%` }} />
      </div>
      <div className="tabular mt-1.5 flex justify-between text-xs font-semibold text-fg-dim">
        <span>{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
        <span>
          {formatBytes(t.downloaded)} / {formatBytes(t.size)}
        </span>
      </div>

      <div className="mt-3 flex gap-2">
        {playable.length > 0 && (
          <button className="btn-primary flex-1 py-2.5" onClick={() => (playable.length > 1 ? setPickFile(true) : watch(playable[0].index))}>
            <Play size={16} fill="currentColor" /> {done ? 'Смотреть' : 'Смотреть сейчас'}
          </button>
        )}
        {!confirm ? (
          <button className="btn-soft py-2.5" onClick={() => setConfirm(true)} title="Удалить">
            <Trash2 size={16} />
          </button>
        ) : (
          <div className="flex flex-1 gap-2">
            <button className="btn-soft flex-1 py-2.5 text-xs" onClick={() => act(Events.TORRENT_REMOVE, { torrentId: t.id, deleteFiles: false })}>
              Убрать из списка
            </button>
            <button className="btn-danger flex-1 py-2.5 text-xs" onClick={() => act(Events.TORRENT_REMOVE, { torrentId: t.id, deleteFiles: true })}>
              + файлы
            </button>
          </div>
        )}
      </div>

      <Sheet open={pickFile} onClose={() => setPickFile(false)} title="Какой файл смотреть?">
        <div className="flex flex-col gap-1">
          {playable.map((f) => (
            <button key={f.index} onClick={() => watch(f.index)} className="flex items-center gap-3 rounded-2xl px-3 py-3 text-left hover:bg-white/5">
              <Play size={16} className="shrink-0 text-ember" />
              <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
              <span className="tabular shrink-0 text-xs text-fg-dim">{Math.round(f.progress * 100)}%</span>
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
