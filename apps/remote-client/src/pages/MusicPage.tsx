import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Disc3,
  HardDriveDownload,
  ListMusic,
  ListPlus,
  Mic2,
  Music2,
  Play,
  Plus,
  Search,
  Settings2,
  Shuffle,
  Trash2,
  X,
} from 'lucide-react';
import {
  Events,
  formatBytes,
  formatDuration,
  type MusicAlbum,
  type MusicArtist,
  type MusicBrowseResult,
  type MusicCacheInfo,
  type MusicItemResult,
  type MusicPlaylist,
  type MusicSource,
  type MusicSourceKind,
  type MusicTrack,
  type MusicView,
} from '@tvbox/shared';
import { act, errorText, isOwner, request, toast, useStore } from '../store/store';
import { formatTotal, playTracks, queueTrack, useCover } from '../lib/music';
import { getPref, setPref } from '../lib/config';
import { Empty, Section, Segmented, Spinner, cx } from '../components/ui';

type Detail = { type: 'album' | 'artist' | 'playlist'; id: string; sourceId: string; title: string };

async function refreshSources(): Promise<void> {
  const r = await request<MusicSource[]>(Events.MUSIC_SOURCES);
  if (r.ok) useStore.setState({ musicSources: r.data || [] });
}

const VIEWS: { value: MusicView; label: string }[] = [
  { value: 'albums', label: 'Альбомы' },
  { value: 'artists', label: 'Исполнители' },
  { value: 'playlists', label: 'Плейлисты' },
  { value: 'recent', label: 'Новое' },
  { value: 'random', label: 'Случайное' },
];

export function MusicPage() {
  const sources = useStore((s) => s.musicSources);
  const tvOnline = useStore((s) => s.presence.tvConnected);
  const owner = useStore(isOwner);
  const [sourceId, setSourceId] = useState<string>(() => getPref('music.source', ''));
  const [view, setView] = useState<MusicView>(() => getPref<MusicView>('music.view', 'albums'));
  const [detail, setDetail] = useState<Detail[]>([]);
  const [query, setQuery] = useState('');
  const [manage, setManage] = useState(false);

  const source = sources?.find((s) => s.id === sourceId) || sources?.[0];

  useEffect(() => {
    if (sources === null && tvOnline) void request<MusicSource[]>(Events.MUSIC_SOURCES).then((r) => r.ok && useStore.setState({ musicSources: r.data || [] }));
  }, [sources, tvOnline]);

  const open = useCallback((d: Detail) => {
    setDetail((x) => [...x, d]);
    document.querySelector('main')?.scrollTo({ top: 0 });
  }, []);

  if (!tvOnline && !sources) return <Empty icon={<Music2 size={28} />} title="Телевизор не в сети" text="Музыкальные сервисы подключены к ТВ-клиенту — включите его." />;
  if (sources === null)
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );

  if (!sources.length || manage) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          {manage && sources.length > 0 && (
            <button className="icon-btn -ml-2" onClick={() => setManage(false)}>
              <ArrowLeft size={20} />
            </button>
          )}
          <h1 className="h-page flex-1">Музыка</h1>
        </div>
        {!sources.length && (
          <p className="text-sm leading-relaxed text-fg-muted">
            Подключите свою аудиотеку — Jellyfin, Navidrome или любой Subsonic-сервер. Треки и плейлисты появятся здесь, играть они будут на телевизоре, а прослушанное
            сохранится в кеше на ТВ-компьютере.
          </p>
        )}
        {owner ? <SourcesManager sources={sources} /> : <Empty icon={<Music2 size={28} />} title="Музыка не подключена" text="Попросите владельца подключить Jellyfin или Navidrome в разделе «Музыка»." />}
      </div>
    );
  }

  const top = detail[detail.length - 1];
  return (
    <div className="flex flex-col gap-4">
      {top ? (
        <DetailView key={`${top.type}:${top.id}`} d={top} onBack={() => setDetail((x) => x.slice(0, -1))} onOpen={open} />
      ) : (
        <>
          <div className="-mb-2 flex items-center gap-2 lg:mb-0">
            <h1 className="h-page flex-1">Музыка</h1>
            {owner && (
              <button className="icon-btn ml-auto" title="Источники" onClick={() => setManage(true)}>
                <Settings2 size={20} />
              </button>
            )}
          </div>
          {sources.length > 1 && (
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {sources.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSourceId(s.id);
                    setPref('music.source', s.id);
                  }}
                  className={cx('chip shrink-0 px-3.5 py-2 text-sm', s.id === source?.id ? 'bg-ember/15 text-ember' : 'bg-ink-800 text-fg-muted')}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
          {source && !source.ok && source.error && (
            <p className="rounded-2xl bg-bad/10 px-4 py-3 text-sm text-bad">
              {source.name}: {errorText(source.error)}
            </p>
          )}
          <div className="relative">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim" />
            <input className="field pl-10 pr-10" placeholder="Поиск треков, альбомов, исполнителей" value={query} onChange={(e) => setQuery(e.target.value)} />
            {query && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-fg-dim" onClick={() => setQuery('')}>
                <X size={16} />
              </button>
            )}
          </div>
          {query.trim().length >= 2 ? (
            <SearchResults query={query.trim()} sourceId={sources.length > 1 ? undefined : source?.id} onOpen={open} />
          ) : (
            source && (
              <>
                <div className="-mx-1 overflow-x-auto px-1">
                  <Segmented
                    value={view}
                    onChange={(v) => {
                      setView(v);
                      setPref('music.view', v);
                    }}
                    options={VIEWS}
                  />
                </div>
                <Browse key={`${source.id}:${view}`} source={source} view={view} onOpen={open} />
              </>
            )
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

function Browse({ source, view, onOpen }: { source: MusicSource; view: MusicView; onOpen: (d: Detail) => void }) {
  const [data, setData] = useState<MusicBrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const limit = view === 'random' ? 100 : 60;

  const load = useCallback(
    async (offset: number) => {
      const r = await request<MusicBrowseResult>(Events.MUSIC_BROWSE, { sourceId: source.id, view, offset, limit }, 40000);
      if (!r.ok || !r.data) {
        setError(errorText(r.error));
        return;
      }
      setError(null);
      setData((prev) =>
        offset && prev
          ? {
              albums: [...(prev.albums || []), ...(r.data!.albums || [])],
              artists: [...(prev.artists || []), ...(r.data!.artists || [])],
              playlists: [...(prev.playlists || []), ...(r.data!.playlists || [])],
              tracks: [...(prev.tracks || []), ...(r.data!.tracks || [])],
              hasMore: r.data!.hasMore,
            }
          : r.data!,
      );
    },
    [source.id, view, limit],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  if (error && !data)
    return (
      <Empty
        icon={<Music2 size={28} />}
        title="Не удалось загрузить"
        text={error}
        action={
          <button className="btn-soft" onClick={() => void load(0)}>
            Повторить
          </button>
        }
      />
    );
  if (!data)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );

  const count = (data.albums?.length || 0) + (data.artists?.length || 0) + (data.playlists?.length || 0) + (data.tracks?.length || 0);
  const more = async () => {
    setLoadingMore(true);
    await load(count);
    setLoadingMore(false);
  };

  return (
    <div className="flex flex-col gap-4">
      {!count && <Empty icon={<Music2 size={28} />} title="Пусто" />}
      {!!data.albums?.length && <AlbumGrid albums={data.albums} onOpen={onOpen} />}
      {!!data.artists?.length && <ArtistGrid artists={data.artists} onOpen={onOpen} />}
      {!!data.playlists?.length && <PlaylistGrid playlists={data.playlists} onOpen={onOpen} />}
      {!!data.tracks?.length && (
        <>
          <PlayBar tracks={data.tracks} />
          <TrackList tracks={data.tracks} showAlbum />
        </>
      )}
      {view === 'random' ? (
        <button className="btn-soft self-center" onClick={() => void load(0)}>
          <Shuffle size={16} /> Другие треки
        </button>
      ) : (
        data.hasMore && (
          <button className="btn-soft self-center" disabled={loadingMore} onClick={more}>
            {loadingMore ? <Spinner /> : 'Показать ещё'}
          </button>
        )
      )}
    </div>
  );
}

function SearchResults({ query, sourceId, onOpen }: { query: string; sourceId?: string; onOpen: (d: Detail) => void }) {
  const [data, setData] = useState<MusicBrowseResult | null>(null);
  useEffect(() => {
    setData(null);
    const t = setTimeout(() => {
      void request<MusicBrowseResult>(Events.MUSIC_SEARCH, { query, sourceId }, 30000).then((r) => setData(r.ok && r.data ? r.data : { tracks: [] }));
    }, 350);
    return () => clearTimeout(t);
  }, [query, sourceId]);
  if (!data)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  const empty = !data.tracks?.length && !data.albums?.length && !data.artists?.length;
  if (empty) return <Empty icon={<Search size={26} />} title="Ничего не найдено" />;
  return (
    <div className="flex flex-col gap-6">
      {!!data.artists?.length && (
        <div>
          <div className="label mb-2">Исполнители</div>
          <ArtistGrid artists={data.artists} onOpen={onOpen} />
        </div>
      )}
      {!!data.albums?.length && (
        <div>
          <div className="label mb-2">Альбомы</div>
          <AlbumGrid albums={data.albums} onOpen={onOpen} />
        </div>
      )}
      {!!data.tracks?.length && (
        <div>
          <div className="label mb-2">Треки</div>
          <TrackList tracks={data.tracks} showAlbum />
        </div>
      )}
    </div>
  );
}

function Cover({ sourceId, id, round, icon }: { sourceId: string; id?: string; round?: boolean; icon?: React.ReactNode }) {
  const url = useCover(id || null, sourceId);
  return (
    <div className={cx('relative aspect-square w-full overflow-hidden bg-gradient-to-br from-ink-700 to-ink-800 text-fg-dim', round ? 'rounded-full' : 'rounded-2xl')}>
      {url ? <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <div className="absolute inset-0 flex items-center justify-center">{icon || <Disc3 size={30} />}</div>}
    </div>
  );
}

const GRID = 'grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';

function AlbumGrid({ albums, onOpen }: { albums: MusicAlbum[]; onOpen: (d: Detail) => void }) {
  return (
    <div className={GRID}>
      {albums.map((a) => (
        <button key={`${a.sourceId}:${a.id}`} className="group min-w-0 text-left" onClick={() => onOpen({ type: 'album', id: a.id, sourceId: a.sourceId, title: a.title })}>
          <div className="transition group-active:scale-[0.97]">
            <Cover sourceId={a.sourceId} id={a.cover} />
          </div>
          <div className="mt-2 truncate text-sm font-bold">{a.title}</div>
          <div className="truncate text-xs text-fg-dim">{[a.artist, a.year].filter(Boolean).join(' · ')}</div>
        </button>
      ))}
    </div>
  );
}

function ArtistGrid({ artists, onOpen }: { artists: MusicArtist[]; onOpen: (d: Detail) => void }) {
  return (
    <div className={GRID}>
      {artists.map((a) => (
        <button key={`${a.sourceId}:${a.id}`} className="group min-w-0 text-center" onClick={() => onOpen({ type: 'artist', id: a.id, sourceId: a.sourceId, title: a.name })}>
          <div className="px-2 transition group-active:scale-[0.97]">
            <Cover sourceId={a.sourceId} id={a.cover} round icon={<Mic2 size={28} />} />
          </div>
          <div className="mt-2 truncate text-sm font-bold">{a.name}</div>
          {a.albumCount ? <div className="text-xs text-fg-dim">{a.albumCount} альб.</div> : null}
        </button>
      ))}
    </div>
  );
}

function PlaylistGrid({ playlists, onOpen }: { playlists: MusicPlaylist[]; onOpen: (d: Detail) => void }) {
  return (
    <div className={GRID}>
      {playlists.map((p) => (
        <button key={`${p.sourceId}:${p.id}`} className="group min-w-0 text-left" onClick={() => onOpen({ type: 'playlist', id: p.id, sourceId: p.sourceId, title: p.title })}>
          <div className="transition group-active:scale-[0.97]">
            <Cover sourceId={p.sourceId} id={p.cover} icon={<ListMusic size={30} />} />
          </div>
          <div className="mt-2 truncate text-sm font-bold">{p.title}</div>
          <div className="truncate text-xs text-fg-dim">
            {[p.trackCount && `${p.trackCount} тр.`, p.duration && formatTotal(p.duration)].filter(Boolean).join(' · ')}
          </div>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Album / artist / playlist
// ---------------------------------------------------------------------------

function DetailView({ d, onBack, onOpen }: { d: Detail; onBack: () => void; onOpen: (d: Detail) => void }) {
  const [data, setData] = useState<MusicItemResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void request<MusicItemResult>(Events.MUSIC_ITEM, { sourceId: d.sourceId, type: d.type, id: d.id }, 40000).then((r) =>
      r.ok && r.data ? setData(r.data) : setError(errorText(r.error)),
    );
  }, [d.sourceId, d.type, d.id]);
  const total = useMemo(() => (data?.tracks || []).reduce((s, t) => s + (t.duration || 0), 0), [data]);

  return (
    <div className="flex flex-col gap-5">
      <button className="btn-ghost -ml-2 self-start px-2 py-1.5 text-sm" onClick={onBack}>
        <ArrowLeft size={18} /> Назад
      </button>
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-end">
        <div className="w-48 shrink-0 shadow-2xl sm:w-44">
          <Cover
            sourceId={d.sourceId}
            id={data?.cover}
            round={d.type === 'artist'}
            icon={d.type === 'artist' ? <Mic2 size={40} /> : d.type === 'playlist' ? <ListMusic size={40} /> : <Disc3 size={40} />}
          />
        </div>
        <div className="min-w-0 flex-1 text-center sm:text-left">
          <div className="label">{d.type === 'album' ? 'Альбом' : d.type === 'artist' ? 'Исполнитель' : 'Плейлист'}</div>
          <h1 className="mt-1 text-2xl font-extrabold leading-tight sm:text-3xl">{data?.title || d.title}</h1>
          {data && (
            <p className="mt-1 text-sm text-fg-muted">
              {[data.subtitle, data.tracks.length && `${data.tracks.length} тр.`, total && formatTotal(total)].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      </div>
      {error && <p className="rounded-2xl bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>}
      {!data && !error && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}
      {data && (
        <>
          {data.tracks.length > 0 && <PlayBar tracks={data.tracks} />}
          {!!data.albums?.length && (
            <div>
              <div className="label mb-2">Альбомы</div>
              <AlbumGrid albums={data.albums} onOpen={onOpen} />
            </div>
          )}
          {data.tracks.length > 0 && (
            <div>
              {d.type === 'artist' && <div className="label mb-2">Треки</div>}
              <TrackList tracks={data.tracks} showAlbum={d.type !== 'album'} numbered={d.type === 'album'} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PlayBar({ tracks }: { tracks: MusicTrack[] }) {
  const tvOnline = useStore((s) => s.presence.tvConnected);
  return (
    <div className="flex gap-2">
      <button className="btn-primary flex-1 sm:flex-none" disabled={!tvOnline} onClick={() => playTracks(tracks, 0)}>
        <Play size={17} fill="currentColor" /> Слушать
      </button>
      <button className="btn-soft flex-1 sm:flex-none" disabled={!tvOnline || tracks.length < 2} onClick={() => playTracks(tracks, 0, true)}>
        <Shuffle size={17} /> Вперемешку
      </button>
    </div>
  );
}

function TrackList({ tracks, showAlbum, numbered }: { tracks: MusicTrack[]; showAlbum?: boolean; numbered?: boolean }) {
  const nowId = useStore((s) => (s.player.source === 'music' ? s.player.title : null));
  const nowArtist = useStore((s) => s.player.artist);
  return (
    <div className="flex flex-col">
      {tracks.map((t, i) => {
        const playing = nowId === t.title && (!t.artist || nowArtist === t.artist);
        return (
          <div key={`${t.id}:${i}`} className="group flex items-center gap-1 rounded-2xl hover:bg-white/[0.03]">
            <button className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-2 text-left" onClick={() => playTracks(tracks, i)}>
              {numbered ? (
                <span className={cx('tabular w-6 shrink-0 text-center text-sm font-bold', playing ? 'text-ember' : 'text-fg-dim')}>{t.trackNo || i + 1}</span>
              ) : (
                <div className="w-11 shrink-0">
                  <Cover sourceId={t.sourceId} id={t.cover} />
                </div>
              )}
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate text-[15px] font-semibold', playing && 'text-ember')}>{t.title}</span>
                <span className="block truncate text-xs text-fg-dim">{[t.artist, showAlbum && t.album].filter(Boolean).join(' — ')}</span>
              </span>
              {t.cached && <HardDriveDownload size={13} className="shrink-0 text-ok/70" aria-label="В кеше ТВ" />}
              <span className="tabular w-11 shrink-0 text-right text-xs text-fg-dim">{t.duration ? formatDuration(t.duration) : ''}</span>
            </button>
            <button
              className="icon-btn h-10 w-10 shrink-0 opacity-60 hover:opacity-100"
              title="В очередь"
              onClick={async () => {
                if (await queueTrack(t)) toast(`«${t.title}» в очереди`, 'success', 1800);
              }}
            >
              <ListPlus size={18} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources (owner)
// ---------------------------------------------------------------------------

function SourcesManager({ sources }: { sources: MusicSource[] }) {
  const [adding, setAdding] = useState(!sources.length);
  const [cache, setCache] = useState<MusicCacheInfo | null>(null);
  useEffect(() => {
    void request<MusicCacheInfo>(Events.MUSIC_CACHE, {}).then((r) => r.ok && r.data && setCache(r.data));
  }, []);

  return (
    <>
      {sources.length > 0 && (
        <Section title="Подключённые источники" icon={<Music2 size={18} />}>
          <div className="flex flex-col">
            {sources.map((s) => (
              <div key={s.id} className="flex items-center gap-3 border-t border-white/5 py-3 first:border-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink-750 text-ember">
                  <Disc3 size={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold">{s.name}</div>
                  <div className={cx('truncate text-xs', s.ok === false ? 'text-bad' : 'text-fg-dim')}>
                    {s.ok === false && s.error ? errorText(s.error) : `${s.username} · ${s.url.replace(/^https?:\/\//, '')}`}
                  </div>
                </div>
                <button className="icon-btn h-9 w-9 hover:text-bad" title="Отключить" onClick={() => void act(Events.MUSIC_SOURCE_REMOVE, { sourceId: s.id }, 'Источник отключён').then(refreshSources)}>
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
          {!adding && (
            <button className="btn-soft mt-3 w-full" onClick={() => setAdding(true)}>
              <Plus size={16} /> Добавить ещё
            </button>
          )}
        </Section>
      )}
      {adding && <AddSourceForm onDone={() => setAdding(false)} canCancel={sources.length > 0} />}
      {cache && (
        <Section title="Кеш на ТВ-компьютере" icon={<HardDriveDownload size={18} />}>
          <p className="text-sm text-fg-muted">
            {cache.files} тр. · {formatBytes(cache.bytes)} из {formatBytes(cache.limitBytes)}. Прослушанные треки сохраняются и в следующий раз играют без сети; старые
            удаляются автоматически.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <select
              className="field w-auto"
              value={String(cache.limitBytes)}
              onChange={async (e) => {
                const r = await request<MusicCacheInfo>(Events.MUSIC_CACHE, { limitBytes: Number(e.target.value) });
                if (r.ok && r.data) setCache(r.data);
              }}
            >
              {[1, 2, 5, 10, 20, 50].map((g) => (
                <option key={g} value={String(g * 1024 ** 3)}>
                  Лимит {g} ГБ
                </option>
              ))}
              {![1, 2, 5, 10, 20, 50].some((g) => g * 1024 ** 3 === cache.limitBytes) && <option value={String(cache.limitBytes)}>{formatBytes(cache.limitBytes)}</option>}
            </select>
            <button
              className="btn-ghost"
              disabled={!cache.files}
              onClick={async () => {
                const r = await request<MusicCacheInfo>(Events.MUSIC_CACHE, { clear: true });
                if (r.ok && r.data) {
                  setCache(r.data);
                  toast('Кеш очищен', 'success');
                }
              }}
            >
              <Trash2 size={15} /> Очистить
            </button>
          </div>
        </Section>
      )}
      <Section title="Spotify" icon={<Music2 size={18} />}>
        <p className="text-sm leading-relaxed text-fg-muted">
          Скоро. Spotify отдаёт музыку только своим официальным плеерам (защита DRM), поэтому его поддержка появится как управление Spotify Connect — без кеширования треков.
        </p>
      </Section>
    </>
  );
}

const KINDS: { value: MusicSourceKind; label: string; hint: string; placeholder: string }[] = [
  { value: 'jellyfin', label: 'Jellyfin', hint: 'Адрес сервера Jellyfin и ваш логин/пароль.', placeholder: 'http://192.168.1.10:8096' },
  {
    value: 'subsonic',
    label: 'Navidrome / Subsonic',
    hint: 'Navidrome, Airsonic, Gonic и другие Subsonic-совместимые серверы.',
    placeholder: 'http://192.168.1.10:4533',
  },
];

function AddSourceForm({ onDone, canCancel }: { onDone: () => void; canCancel: boolean }) {
  const [kind, setKind] = useState<MusicSourceKind>('jellyfin');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = KINDS.find((k) => k.value === kind)!;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await request<MusicSource>(Events.MUSIC_SOURCE_ADD, { kind, url: url.trim(), username: username.trim(), password }, 45000);
    setBusy(false);
    if (!r.ok) return setError(errorText(r.error));
    toast(`${r.data?.name || 'Источник'} подключён`, 'success');
    await refreshSources();
    onDone();
  };

  return (
    <Section title="Подключить аудиотеку" icon={<Plus size={18} />} right={canCancel ? <button className="icon-btn -mr-2" onClick={onDone}><X size={18} /></button> : null}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Segmented value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
        <p className="text-xs leading-relaxed text-fg-dim">{meta.hint} Подключается телевизор, поэтому подойдёт и адрес в домашней сети.</p>
        <input className="field" placeholder={meta.placeholder} value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" autoCapitalize="off" autoCorrect="off" />
        <div className="grid gap-3 sm:grid-cols-2">
          <input className="field" placeholder="Логин" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="off" autoCorrect="off" autoComplete="off" />
          <input className="field" type="password" placeholder="Пароль" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        <button className="btn-primary" disabled={busy || !url.trim() || !username.trim()}>
          {busy ? <Spinner /> : 'Подключить'}
        </button>
      </form>
    </Section>
  );
}
