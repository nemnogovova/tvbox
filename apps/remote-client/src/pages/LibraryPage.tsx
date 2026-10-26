import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  File as FileIcon,
  Film,
  Folder,
  FolderOpen,
  HardDrive,
  ImageIcon,
  ListPlus,
  Music,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Tv2,
  Magnet,
} from 'lucide-react';
import {
  Events,
  formatBytes,
  formatDuration,
  type FsEntry,
  type FsListResult,
  type MediaItem,
  type PlayRequest,
  type TmdbResult,
} from '@tvbox/shared';
import { act, control, isOwner, request, toast, useStore, errorText } from '../store/store';
import { Empty, Segmented, Sheet, Spinner, cx } from '../components/ui';

type Filter = 'all' | 'movies' | 'shows' | 'other' | 'files';

interface Show {
  key: string;
  title: string;
  poster?: string;
  backdrop?: string;
  overview?: string;
  rating?: number;
  year?: number;
  episodes: MediaItem[];
  addedAt: number;
}

type Card = { type: 'item'; item: MediaItem } | { type: 'show'; show: Show };

const progressOf = (m: MediaItem) => (m.position && m.duration ? Math.min(1, m.position / m.duration) : 0);
const isInProgress = (m: MediaItem) => !!m.position && !!m.duration && m.position > 30 && m.position < m.duration * 0.92;

function buildShows(items: MediaItem[]): Show[] {
  const map = new Map<string, Show>();
  for (const m of items) {
    if (m.kind !== 'episode') continue;
    const key = m.showKey || m.title;
    let s = map.get(key);
    if (!s) {
      s = { key, title: m.title, episodes: [], addedAt: 0 };
      map.set(key, s);
    }
    s.episodes.push(m);
    s.poster = s.poster || m.poster;
    s.backdrop = s.backdrop || m.backdrop;
    s.overview = s.overview || m.overview;
    s.rating = s.rating || m.rating;
    s.year = s.year || m.year;
    s.addedAt = Math.max(s.addedAt, m.addedAt);
  }
  for (const s of map.values()) {
    s.episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.path.localeCompare(b.path));
  }
  return Array.from(map.values());
}

export function LibraryPage() {
  const catalog = useStore((s) => s.catalog);
  const tvOnline = useStore((s) => s.presence.tvConnected);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [openItem, setOpenItem] = useState<MediaItem | null>(null);
  const [openShow, setOpenShow] = useState<string | null>(null);

  useEffect(() => {
    if (tvOnline) void request(Events.CATALOG_GET);
  }, [tvOnline]);

  const shows = useMemo(() => buildShows(catalog), [catalog]);
  const cards = useMemo<Card[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (t: string) => !q || t.toLowerCase().includes(q);
    const out: Card[] = [];
    if (filter === 'all' || filter === 'movies')
      for (const m of catalog) if (m.kind === 'movie' && match(m.title)) out.push({ type: 'item', item: m });
    if (filter === 'all' || filter === 'shows') for (const s of shows) if (match(s.title)) out.push({ type: 'show', show: s });
    if (filter === 'all' || filter === 'other')
      for (const m of catalog) if (['video', 'audio', 'photo'].includes(m.kind) && match(m.title)) out.push({ type: 'item', item: m });
    const added = (c: Card) => (c.type === 'item' ? c.item.addedAt : c.show.addedAt);
    return out.sort((a, b) => added(b) - added(a));
  }, [catalog, shows, filter, query]);

  const continueItems = useMemo(
    () => catalog.filter(isInProgress).sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0)).slice(0, 12),
    [catalog],
  );

  const currentShow = shows.find((s) => s.key === openShow) || null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="h-page mr-auto">Медиатека</h1>
        <div className="-mx-1 w-full overflow-x-auto px-1 sm:w-auto">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'Всё' },
              { value: 'movies', label: 'Фильмы' },
              { value: 'shows', label: 'Сериалы' },
              { value: 'other', label: 'Другое' },
              { value: 'files', label: 'Файлы ПК' },
            ]}
          />
        </div>
      </div>

      {filter === 'files' ? (
        <FileBrowser />
      ) : (
        <>
          <div className="relative">
            <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim" />
            <input className="field pl-11" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по медиатеке" />
          </div>

          {!query && filter === 'all' && continueItems.length > 0 && (
            <div>
              <div className="label mb-3">Продолжить просмотр</div>
              <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 lg:-mx-0 lg:px-0">
                {continueItems.map((m) => (
                  <ContinueCard key={m.id} item={m} />
                ))}
              </div>
            </div>
          )}

          {cards.length === 0 ? (
            catalog.length === 0 ? (
              <Empty
                icon={<Film size={28} />}
                title={tvOnline ? 'Медиатека пуста' : 'Телевизор не в сети'}
                text={
                  tvOnline
                    ? 'Скачайте что-нибудь во вкладке «Загрузки» или укажите папки с фильмами в настройках ТВ.'
                    : 'Каталог хранится на ТВ-компьютере и появится, когда он подключится.'
                }
              />
            ) : (
              <Empty icon={<Search size={28} />} title="Ничего не найдено" />
            )
          ) : (
            <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6">
              {cards.map((c) =>
                c.type === 'item' ? (
                  <PosterCard
                    key={c.item.id}
                    title={c.item.title}
                    poster={c.item.poster}
                    meta={[c.item.year, c.item.kind === 'movie' ? null : kindLabel(c.item.kind)].filter(Boolean).join(' · ')}
                    rating={c.item.rating}
                    progress={progressOf(c.item)}
                    kind={c.item.kind}
                    onClick={() => setOpenItem(c.item)}
                  />
                ) : (
                  <PosterCard
                    key={c.show.key}
                    title={c.show.title}
                    poster={c.show.poster}
                    meta={`${c.show.episodes.length} ${plural(c.show.episodes.length, 'серия', 'серии', 'серий')}`}
                    rating={c.show.rating}
                    badge="Сериал"
                    kind="episode"
                    progress={0}
                    onClick={() => setOpenShow(c.show.key)}
                  />
                ),
              )}
            </div>
          )}
        </>
      )}

      <MediaSheet item={openItem} onClose={() => setOpenItem(null)} />
      <ShowSheet show={currentShow} onClose={() => setOpenShow(null)} />
    </div>
  );
}

function kindLabel(k: MediaItem['kind']): string {
  return { movie: 'Фильм', episode: 'Серия', video: 'Видео', audio: 'Аудио', photo: 'Фото' }[k];
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function KindIcon({ kind, size = 28 }: { kind: MediaItem['kind']; size?: number }) {
  if (kind === 'audio') return <Music size={size} />;
  if (kind === 'photo') return <ImageIcon size={size} />;
  if (kind === 'episode') return <Tv2 size={size} />;
  return <Film size={size} />;
}

function PosterCard({
  title,
  poster,
  meta,
  rating,
  progress,
  badge,
  kind,
  onClick,
}: {
  title: string;
  poster?: string;
  meta?: string;
  rating?: number;
  progress: number;
  badge?: string;
  kind: MediaItem['kind'];
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="group flex min-w-0 flex-col text-left">
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-2xl bg-ink-800 ring-1 ring-white/5 transition duration-300 group-hover:ring-ember/50 group-active:scale-[0.98]">
        {poster ? (
          <img src={poster} alt="" loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-ink-750 to-ink-850 p-3 text-center text-fg-dim">
            <KindIcon kind={kind} />
            <span className="line-clamp-3 text-xs font-semibold text-fg-muted">{title}</span>
          </div>
        )}
        {badge && <span className="chip absolute left-2 top-2 bg-black/60 px-2 py-1 text-[10px] uppercase tracking-wider text-fg backdrop-blur">{badge}</span>}
        {rating ? (
          <span className="chip absolute right-2 top-2 bg-black/60 px-2 py-1 text-[11px] text-warn backdrop-blur">
            <Star size={10} fill="currentColor" /> {rating.toFixed(1)}
          </span>
        ) : null}
        {progress > 0 && (
          <div className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-black/60">
            <div className="h-full rounded-full bg-ember" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
      </div>
      <div className="mt-2 line-clamp-2 text-[13px] font-bold leading-tight">{title}</div>
      {meta && <div className="mt-0.5 truncate text-xs text-fg-dim">{meta}</div>}
    </button>
  );
}

function ContinueCard({ item }: { item: MediaItem }) {
  const p = progressOf(item);
  const sub = item.kind === 'episode' ? episodeLabel(item) : formatDuration((item.duration || 0) - (item.position || 0)) + ' осталось';
  return (
    <button
      onClick={() => playMedia(item)}
      className="group relative aspect-video w-64 shrink-0 snap-start overflow-hidden rounded-2xl bg-ink-800 text-left ring-1 ring-white/5 active:scale-[0.98]"
    >
      {(item.backdrop || item.poster) && <img src={item.backdrop || item.poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-70" />}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
      <div className="absolute left-3 top-3 flex h-10 w-10 items-center justify-center rounded-full bg-ember text-ink-950 opacity-90 shadow-glow">
        <Play size={16} fill="currentColor" className="ml-0.5" />
      </div>
      <div className="absolute inset-x-3 bottom-3">
        <div className="truncate text-sm font-bold">{item.title}</div>
        <div className="truncate text-xs text-fg-muted">{sub}</div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/20">
          <div className="h-full bg-ember" style={{ width: `${p * 100}%` }} />
        </div>
      </div>
    </button>
  );
}

function episodeLabel(m: MediaItem): string {
  const se = m.season !== undefined || m.episode !== undefined ? `S${String(m.season ?? 1).padStart(2, '0')}E${String(m.episode ?? 0).padStart(2, '0')}` : '';
  return [se, m.episodeTitle].filter(Boolean).join(' · ') || m.path.split(/[\\/]/).pop() || '';
}

export function playMedia(m: MediaItem, fromStart = false): void {
  const req: PlayRequest = { source: 'local', mediaId: m.id, title: m.title, ...(fromStart ? { startAt: 0 } : {}) };
  void control({ type: 'PLAY_SOURCE', request: req });
}

function queueMedia(m: MediaItem): void {
  void control({ type: 'QUEUE_ADD', request: { source: 'local', mediaId: m.id, title: m.title } }).then(
    (ok) => ok && toast('Добавлено в очередь', 'success'),
  );
}

// ---------------------------------------------------------------------------

function MediaSheet({ item, onClose }: { item: MediaItem | null; onClose: () => void }) {
  const owner = useStore(isOwner);
  const [editing, setEditing] = useState(false);
  if (!item) return null;
  const inProgress = isInProgress(item);
  return (
    <>
      <Sheet open={!!item && !editing} onClose={onClose} wide>
        <div className="-mx-5 -mt-1">
          <div className="relative h-48 overflow-hidden sm:h-60">
            {item.backdrop || item.poster ? (
              <img src={item.backdrop || item.poster} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full bg-gradient-to-br from-ink-700 to-ink-850" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-ink-850 via-ink-850/30 to-transparent" />
          </div>
        </div>
        <div className="-mt-16 relative flex gap-4">
          {item.poster && <img src={item.poster} alt="" className="hidden h-36 w-24 shrink-0 rounded-xl object-cover shadow-2xl ring-1 ring-white/10 sm:block" />}
          <div className="min-w-0 flex-1 self-end">
            <h2 className="text-2xl font-extrabold leading-tight">{item.title}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-fg-muted">
              {item.year && <span>{item.year}</span>}
              {item.rating ? (
                <span className="flex items-center gap-1 text-warn">
                  <Star size={13} fill="currentColor" /> {item.rating.toFixed(1)}
                </span>
              ) : null}
              {item.genres?.length ? <span>{item.genres.slice(0, 3).join(', ')}</span> : null}
              {item.duration ? <span>{formatDuration(item.duration)}</span> : null}
              {item.size ? <span>{formatBytes(item.size)}</span> : null}
            </div>
          </div>
        </div>
        {item.overview && <p className="mt-4 text-sm leading-relaxed text-fg-muted">{item.overview}</p>}
        <p className="mt-3 break-all text-xs text-fg-dim">{item.path}</p>
        {inProgress && (
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full bg-ember" style={{ width: `${progressOf(item) * 100}%` }} />
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            className="btn-primary flex-1 py-3.5"
            onClick={() => {
              playMedia(item);
              onClose();
            }}
          >
            <Play size={18} fill="currentColor" /> {inProgress ? `Продолжить с ${formatDuration(item.position || 0)}` : 'Смотреть на ТВ'}
          </button>
          {inProgress && (
            <button
              className="btn-soft"
              onClick={() => {
                playMedia(item, true);
                onClose();
              }}
            >
              С начала
            </button>
          )}
          <button className="btn-soft" onClick={() => queueMedia(item)} title="В очередь">
            <ListPlus size={18} />
          </button>
          {owner && (
            <button className="btn-soft" onClick={() => setEditing(true)} title="Изменить">
              <Pencil size={18} />
            </button>
          )}
        </div>
      </Sheet>
      {editing && (
        <EditSheet
          item={item}
          onClose={() => {
            setEditing(false);
            onClose();
          }}
        />
      )}
    </>
  );
}

function ShowSheet({ show, onClose }: { show: Show | null; onClose: () => void }) {
  const owner = useStore(isOwner);
  const seasons = useMemo(() => Array.from(new Set((show?.episodes || []).map((e) => e.season ?? 1))).sort((a, b) => a - b), [show]);
  const [season, setSeason] = useState<number | null>(null);
  const [editing, setEditing] = useState<MediaItem | null>(null);
  useEffect(() => {
    if (!show) return;
    const next = show.episodes.find(isInProgress) || show.episodes.find((e) => !e.position);
    setSeason(next?.season ?? seasons[0] ?? 1);
  }, [show?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!show) return null;
  const eps = show.episodes.filter((e) => (e.season ?? 1) === season);
  const nextUp = show.episodes.find(isInProgress) || show.episodes.find((e) => !e.position || progressOf(e) < 0.92);

  return (
    <>
      <Sheet open={!editing} onClose={onClose} wide>
        <div className="-mx-5 -mt-1">
          <div className="relative h-44 overflow-hidden sm:h-56">
            {show.backdrop || show.poster ? (
              <img src={show.backdrop || show.poster} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full bg-gradient-to-br from-ink-700 to-ink-850" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-ink-850 via-ink-850/30 to-transparent" />
          </div>
        </div>
        <div className="-mt-10 relative">
          <h2 className="text-2xl font-extrabold">{show.title}</h2>
          <div className="mt-1 text-sm text-fg-muted">
            {[show.year, `${show.episodes.length} ${plural(show.episodes.length, 'серия', 'серии', 'серий')}`].filter(Boolean).join(' · ')}
          </div>
        </div>
        {show.overview && <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-fg-muted">{show.overview}</p>}
        {nextUp && (
          <button
            className="btn-primary mt-4 w-full py-3.5"
            onClick={() => {
              playMedia(nextUp);
              onClose();
            }}
          >
            <Play size={18} fill="currentColor" /> {isInProgress(nextUp) ? 'Продолжить' : 'Смотреть'} {episodeLabel(nextUp)}
          </button>
        )}
        {seasons.length > 1 && (
          <div className="-mx-5 mt-5 flex gap-2 overflow-x-auto px-5">
            {seasons.map((s) => (
              <button
                key={s}
                onClick={() => setSeason(s)}
                className={cx('chip shrink-0 px-4 py-2 text-sm', season === s ? 'bg-ember text-ink-950' : 'bg-ink-750 text-fg-muted')}
              >
                Сезон {s}
              </button>
            ))}
          </div>
        )}
        <div className="mt-4 flex flex-col gap-1">
          {eps.map((e) => {
            const p = progressOf(e);
            return (
              <div key={e.id} className="group flex items-center gap-3 rounded-2xl px-2 py-2.5 hover:bg-white/[0.03]">
                <button
                  onClick={() => {
                    playMedia(e);
                    onClose();
                  }}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-ink-750 text-fg transition group-hover:bg-ember group-hover:text-ink-950"
                >
                  <Play size={16} fill="currentColor" className="ml-0.5" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold">{episodeLabel(e)}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1 w-20 overflow-hidden rounded-full bg-ink-700">
                      <div className={cx('h-full', p >= 0.92 ? 'bg-ok' : 'bg-ember')} style={{ width: `${p * 100}%` }} />
                    </div>
                    <span className="text-[11px] text-fg-dim">{p >= 0.92 ? 'просмотрено' : e.duration ? formatDuration(e.duration) : formatBytes(e.size || 0)}</span>
                  </div>
                </div>
                <button className="icon-btn h-9 w-9" onClick={() => queueMedia(e)} title="В очередь">
                  <ListPlus size={17} />
                </button>
                {owner && (
                  <button className="icon-btn h-9 w-9" onClick={() => setEditing(e)} title="Изменить">
                    <Pencil size={15} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </Sheet>
      {editing && <EditSheet item={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function EditSheet({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [poster, setPoster] = useState(item.poster || '');
  const [year, setYear] = useState(item.year ? String(item.year) : '');
  const [season, setSeason] = useState(item.season !== undefined ? String(item.season) : '');
  const [episode, setEpisode] = useState(item.episode !== undefined ? String(item.episode) : '');
  const [q, setQ] = useState(item.title);
  const [type, setType] = useState<'movie' | 'tv'>(item.kind === 'episode' ? 'tv' : 'movie');
  const [results, setResults] = useState<TmdbResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isEp = item.kind === 'episode';

  const save = async () => {
    const r = await act(
      Events.MEDIA_UPDATE,
      {
        mediaId: item.id,
        patch: {
          title: title.trim() || item.title,
          poster: poster.trim() || undefined,
          year: year ? Number(year) : undefined,
          ...(isEp ? { season: season ? Number(season) : undefined, episode: episode ? Number(episode) : undefined } : {}),
        },
      },
      'Сохранено',
    );
    if (r.ok) onClose();
  };

  const search = async () => {
    setSearching(true);
    const r = await request<TmdbResult[]>(Events.TMDB_SEARCH, { query: q, type });
    setSearching(false);
    if (!r.ok) {
      toast(r.error === 'no_tmdb_key' ? 'Укажите ключ TMDb в настройках ТВ' : errorText(r.error), 'error');
      return;
    }
    setResults(r.data || []);
  };

  const apply = async (res: TmdbResult) => {
    const r = await act(Events.MEDIA_APPLY_TMDB, { mediaId: item.id, tmdbId: res.id, type: res.type, wholeShow: isEp }, 'Обложка и описание обновлены');
    if (r.ok) onClose();
  };

  const remove = async () => {
    const r = await act(Events.MEDIA_DELETE, { mediaId: item.id }, 'Файл удалён с диска ТВ');
    if (r.ok) onClose();
  };

  return (
    <Sheet open onClose={onClose} title="Изменить" wide>
      <div className="flex flex-col gap-3">
        <label className="label">Название</label>
        <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="label">Год</label>
            <input className="field mt-2" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} />
          </div>
          {isEp && (
            <>
              <div>
                <label className="label">Сезон</label>
                <input className="field mt-2" inputMode="numeric" value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, ''))} />
              </div>
              <div>
                <label className="label">Серия</label>
                <input className="field mt-2" inputMode="numeric" value={episode} onChange={(e) => setEpisode(e.target.value.replace(/\D/g, ''))} />
              </div>
            </>
          )}
        </div>
        <label className="label">Ссылка на обложку</label>
        <input className="field" value={poster} onChange={(e) => setPoster(e.target.value)} placeholder="https://…" />
        <button className="btn-primary mt-1" onClick={save}>
          Сохранить
        </button>

        <div className="mt-4 border-t border-white/5 pt-4">
          <div className="label mb-2">Найти в TMDb</div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <input className="field" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="field w-28" value={type} onChange={(e) => setType(e.target.value as 'movie' | 'tv')}>
              <option value="movie">Фильм</option>
              <option value="tv">Сериал</option>
            </select>
            <button className="btn-soft">{searching ? <Spinner /> : <Search size={18} />}</button>
          </form>
          {results && (
            <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-5">
              {results.length === 0 && <p className="col-span-full text-sm text-fg-muted">Ничего не нашлось</p>}
              {results.map((r) => (
                <button key={`${r.type}-${r.id}`} onClick={() => apply(r)} className="group text-left">
                  <div className="aspect-[2/3] overflow-hidden rounded-xl bg-ink-750 ring-1 ring-white/5 group-hover:ring-ember">
                    {r.poster && <img src={r.poster} alt="" className="h-full w-full object-cover" />}
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs font-bold">{r.title}</div>
                  <div className="text-[11px] text-fg-dim">{r.year}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 border-t border-white/5 pt-4">
          {!confirmDelete ? (
            <button className="btn-danger w-full" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={16} /> Удалить файл с диска ТВ
            </button>
          ) : (
            <div className="flex gap-2">
              <button className="btn-soft flex-1" onClick={() => setConfirmDelete(false)}>
                Отмена
              </button>
              <button className="btn-danger flex-1 bg-bad text-white hover:bg-bad/90" onClick={remove}>
                Удалить навсегда
              </button>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

function FileBrowser() {
  const [result, setResult] = useState<FsListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const owner = useStore(isOwner);
  const tvOnline = useStore((s) => s.presence.tvConnected);

  const open = async (path?: string) => {
    setLoading(true);
    const r = await request<FsListResult>(Events.FS_LIST, { path });
    setLoading(false);
    if (r.ok && r.data) setResult(r.data);
    else toast(errorText(r.error), 'error');
  };

  useEffect(() => {
    if (tvOnline) void open(undefined);
  }, [tvOnline]);

  if (!tvOnline) return <Empty icon={<HardDrive size={28} />} title="Телевизор не в сети" />;
  if (!result) return <div className="flex justify-center py-16">{<Spinner />}</div>;

  const playEntry = (e: FsEntry, mode: 'play' | 'queue') => {
    const req: PlayRequest = { source: 'local', path: e.path, title: e.name.replace(/\.[^.]+$/, '') };
    void control(mode === 'play' ? { type: 'PLAY_SOURCE', request: req } : { type: 'QUEUE_ADD', request: req }).then(
      (ok) => ok && mode === 'queue' && toast('Добавлено в очередь', 'success'),
    );
  };

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2.5">
        <button className="icon-btn" disabled={result.parent === null} onClick={() => open(result.parent ?? undefined)}>
          <ChevronLeft size={20} />
        </button>
        <FolderOpen size={18} className="shrink-0 text-ember" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" dir="rtl">
          {result.path || 'Этот компьютер'}
        </span>
        {loading ? <Spinner size={16} className="mr-2" /> : (
          <button className="icon-btn" onClick={() => open(result.path || undefined)}>
            <RefreshCw size={16} />
          </button>
        )}
      </div>
      {result.error && <p className="px-5 py-3 text-sm text-bad">{result.error}</p>}
      <div className="max-h-[65vh] overflow-y-auto py-1">
        {result.entries.length === 0 && !result.error && <p className="py-10 text-center text-sm text-fg-dim">Папка пуста</p>}
        {result.entries.map((e) => {
          const playable = e.kind === 'video' || e.kind === 'audio' || e.kind === 'image';
          const Icon = e.kind === 'dir' ? (result.path ? Folder : HardDrive) : e.kind === 'video' ? Film : e.kind === 'audio' ? Music : e.kind === 'image' ? ImageIcon : e.kind === 'torrent' ? Magnet : FileIcon;
          return (
            <div key={e.path} className="group flex items-center gap-1 px-2">
              <button
                className={cx('flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/[0.04]', !playable && e.kind !== 'dir' && e.kind !== 'torrent' && 'opacity-50')}
                onClick={() => {
                  if (e.kind === 'dir') void open(e.path);
                  else if (playable) playEntry(e, 'play');
                  else if (e.kind === 'torrent') void act(Events.TORRENT_ADD, { torrentPath: e.path }, 'Торрент добавлен в загрузки');
                }}
              >
                <Icon size={18} className={cx('shrink-0', e.kind === 'dir' ? 'text-ember' : 'text-fg-muted')} />
                <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
                {e.size !== undefined && <span className="shrink-0 text-xs text-fg-dim">{formatBytes(e.size)}</span>}
              </button>
              {playable && (
                <button className="icon-btn h-9 w-9 opacity-0 group-hover:opacity-100 max-sm:opacity-60" onClick={() => playEntry(e, 'queue')} title="В очередь">
                  <ListPlus size={16} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {owner && result.path && (
        <div className="border-t border-white/5 px-4 py-3 text-xs text-fg-dim">
          Совет: добавьте эту папку в «Настройки → Папки с медиа», чтобы файлы появились в медиатеке.
        </div>
      )}
    </div>
  );
}
