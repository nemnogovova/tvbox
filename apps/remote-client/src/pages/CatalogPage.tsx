import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Calendar,
  Check,
  ChevronRight,
  Clapperboard,
  Clock,
  Download,
  ExternalLink,
  Film,
  Flame,
  Library,
  Loader2,
  Play,
  Search,
  Sparkles,
  Star,
  Tv,
  Users,
  X,
  Youtube,
} from 'lucide-react';
import {
  Events,
  formatBytes,
  type CatalogBrowsePayload,
  type CatalogDetails,
  type CatalogHome,
  type CatalogItem,
  type CatalogKind,
  type CatalogPage as CatalogPageData,
  type CatalogSort,
  type TorrentResult,
  type TorrentSearchResult,
  type IndexerStatus,
} from '@tvbox/shared';
import { act, control, errorText, isOwner, request, toast, useStore } from '../store/store';
import { Empty, Segmented, Spinner, cx } from '../components/ui';
import { openExternal } from '../lib/native';

type Open = { id: number; type: CatalogKind };

let homeCache: { at: number; data: CatalogHome } | null = null;

export function CatalogPage({ onWatch, onOpenSettings }: { onWatch?: () => void; onOpenSettings?: () => void }) {
  const tvOnline = useStore((s) => s.presence.tvConnected);
  const owner = useStore(isOwner);
  const [home, setHome] = useState<CatalogHome | null>(homeCache?.data || null);
  const [error, setError] = useState<string | null>(null);
  const [browse, setBrowse] = useState<(CatalogBrowsePayload & { title?: string }) | null>(null);
  const [query, setQuery] = useState('');
  const [stack, setStack] = useState<Open[]>([]);

  const load = useCallback(async (force = false) => {
    if (!force && homeCache && Date.now() - homeCache.at < 20 * 60 * 1000) return setHome(homeCache.data);
    const r = await request<CatalogHome>(Events.CATALOG_HOME, {}, 45000);
    if (r.ok && r.data) {
      homeCache = { at: Date.now(), data: r.data };
      setHome(r.data);
      setError(null);
    } else setError(r.error || 'error');
  }, []);

  useEffect(() => {
    if (tvOnline) void load();
  }, [tvOnline, load]);

  const open = (it: Pick<CatalogItem, 'id' | 'type'>) => setStack((s) => [...s, { id: it.id, type: it.type }]);
  const closeTop = () => setStack((s) => s.slice(0, -1));
  const searching = query.trim().length >= 2;

  let body: ReactNode;
  if (error && !home)
    body =
      error === 'no_tmdb_key' ? (
        <Empty
          icon={<Film size={28} />}
          title="Каталогу нужен ключ TMDb"
          text="Бесплатный ключ с themoviedb.org даёт обложки, описания, трейлеры и подборки. Вставьте его в настройках ТВ."
          action={onOpenSettings && <button className="btn-primary" onClick={onOpenSettings}>Открыть настройки</button>}
        />
      ) : (
        <Empty icon={<Film size={28} />} title="Каталог не загрузился" text={errorText(error)} action={<button className="btn-soft" onClick={() => load(true)}>Повторить</button>} />
      );
  else if (searching) body = <Grid payload={{ kind: 'movie', query: query.trim() }} onOpen={open} key={`q:${query.trim()}`} />;
  else if (browse) body = <BrowseView initial={browse} genres={home?.genres} onOpen={open} onBack={() => setBrowse(null)} />;
  else if (!home)
    body = (
      <div className="flex flex-col gap-6">
        <div className="aspect-[16/9] w-full animate-pulse rounded-[28px] bg-ink-800 sm:aspect-[21/9]" />
        {[0, 1].map((i) => (
          <div key={i}>
            <div className="mb-3 h-4 w-40 animate-pulse rounded bg-ink-800" />
            <div className="flex gap-3 overflow-hidden">
              {Array.from({ length: 6 }, (_, j) => (
                <div key={j} className="aspect-[2/3] w-[118px] shrink-0 animate-pulse rounded-2xl bg-ink-800 sm:w-[140px]" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  else
    body = (
      <div className="flex flex-col gap-7">
        {home.indexer?.mode === 'none' && <IndexerSetup owner={owner} onOpenSettings={onOpenSettings} onReady={() => load(true)} />}
        <Hero items={home.hero} onOpen={open} />
        <GenreChips home={home} onPick={(b) => setBrowse(b)} />
        {home.sections.map((sec) => (
          <Shelf
            key={sec.id}
            title={sec.title}
            icon={sec.id === 'for-you' ? <Sparkles size={16} className="text-ember" /> : sec.id.startsWith('trending') ? <Flame size={16} className="text-ember" /> : undefined}
            items={sec.items}
            onOpen={open}
            onAll={sec.browse ? () => setBrowse({ ...sec.browse!, title: sec.title }) : undefined}
          />
        ))}
        <p className="pb-2 text-center text-[11px] text-fg-dim">Описания, постеры и рейтинги — The Movie Database (TMDb)</p>
      </div>
    );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <h1 className="h-page mr-auto">Каталог</h1>
        <div className="relative flex-1 lg:w-80 lg:flex-none">
          <Search size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim" />
          <input className="field h-11 pl-10 pr-10" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Фильмы, сериалы, мультфильмы…" enterKeyHint="search" />
          {query && (
            <button className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-fg-dim hover:text-fg" onClick={() => setQuery('')} aria-label="Очистить">
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      {body}
      {stack.map((o, i) => (
        <DetailsView
          key={`${o.type}:${o.id}:${i}`}
          open={o}
          top={i === stack.length - 1}
          onClose={closeTop}
          onOpen={open}
          onWatch={() => {
            setStack([]);
            onWatch?.();
          }}
          onOpenSettings={onOpenSettings}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home building blocks
// ---------------------------------------------------------------------------

function Rating({ value, className }: { value?: number; className?: string }) {
  if (!value) return null;
  const color = value >= 7.5 ? 'bg-ok/90 text-ink-950' : value >= 6 ? 'bg-warn/90 text-ink-950' : 'bg-ink-600/90 text-fg';
  return <span className={cx('tabular rounded-lg px-1.5 py-0.5 text-[11px] font-extrabold shadow', color, className)}>{value.toFixed(1)}</span>;
}

export function PosterCard({ item, onOpen, className }: { item: CatalogItem; onOpen: (i: CatalogItem) => void; className?: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <button onClick={() => onOpen(item)} className={cx('group flex shrink-0 flex-col gap-2 text-left', className)}>
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-2xl bg-ink-800 shadow-card ring-1 ring-white/[0.05] transition duration-300 group-hover:ring-ember/50 group-active:scale-[0.97]">
        {item.poster && (
          <img
            src={item.poster}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
            className={cx('h-full w-full object-cover transition duration-500 group-hover:scale-105', loaded ? 'opacity-100' : 'opacity-0')}
          />
        )}
        <Rating value={item.rating} className="absolute left-1.5 top-1.5" />
        {item.inLibrary && (
          <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-ember text-ink-950 shadow" title="Есть в медиатеке">
            <Check size={14} strokeWidth={3} />
          </span>
        )}
        {item.type === 'tv' && <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-fg-muted backdrop-blur">Сериал</span>}
      </div>
      <div className="min-w-0 px-0.5">
        <div className="line-clamp-2 text-[13px] font-bold leading-tight">{item.title}</div>
        {item.year && <div className="mt-0.5 text-[11px] text-fg-dim">{item.year}</div>}
      </div>
    </button>
  );
}

function Hero({ items, onOpen }: { items: CatalogItem[]; onOpen: (i: CatalogItem) => void }) {
  const [idx, setIdx] = useState(0);
  const strip = useRef<HTMLDivElement | null>(null);
  const userTouched = useRef(0);

  useEffect(() => {
    if (items.length < 2) return;
    const t = setInterval(() => {
      if (Date.now() - userTouched.current < 12000) return;
      const el = strip.current;
      if (!el) return;
      const next = (Math.round(el.scrollLeft / el.clientWidth) + 1) % items.length;
      el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' });
    }, 7000);
    return () => clearInterval(t);
  }, [items.length]);

  if (!items.length) return null;
  return (
    <div className="relative -mx-4 sm:mx-0">
      <div
        ref={strip}
        onScroll={(e) => setIdx(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}
        onPointerDown={() => (userTouched.current = Date.now())}
        className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] sm:rounded-[28px] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((it) => (
          <button key={`${it.type}:${it.id}`} onClick={() => onOpen(it)} className="relative aspect-[4/3] w-full shrink-0 snap-center overflow-hidden text-left sm:aspect-[21/9]">
            <img src={it.backdrop} alt="" className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-ink-900 via-ink-900/40 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r from-ink-900/70 via-transparent to-transparent" />
            <div className="absolute inset-x-0 bottom-0 p-5 pb-9 sm:max-w-[60%] sm:p-8 sm:pb-10">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ember">
                <Flame size={13} /> Сегодня в тренде · {it.type === 'tv' ? 'сериал' : 'фильм'}
              </div>
              <h2 className="text-2xl font-extrabold leading-tight drop-shadow-lg sm:text-4xl">{it.title}</h2>
              <div className="mt-2 flex items-center gap-2 text-sm text-fg-muted">
                <Rating value={it.rating} />
                {it.year && <span>{it.year}</span>}
              </div>
              <p className="mt-2 line-clamp-2 text-[13px] leading-snug text-fg-muted sm:line-clamp-3 sm:text-sm">{it.overview}</p>
            </div>
          </button>
        ))}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
        {items.map((_, i) => (
          <span key={i} className={cx('h-1.5 rounded-full transition-all duration-300', i === idx ? 'w-5 bg-ember' : 'w-1.5 bg-white/30')} />
        ))}
      </div>
    </div>
  );
}

function Shelf({ title, icon, items, onOpen, onAll }: { title: string; icon?: ReactNode; items: CatalogItem[]; onOpen: (i: CatalogItem) => void; onAll?: () => void }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h3 className="flex-1 text-[17px] font-extrabold tracking-tight">{title}</h3>
        {onAll && (
          <button className="flex items-center gap-0.5 text-xs font-bold text-fg-dim transition hover:text-ember" onClick={onAll}>
            Все <ChevronRight size={15} />
          </button>
        )}
      </div>
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
        {items.map((it) => (
          <PosterCard key={`${it.type}:${it.id}`} item={it} onOpen={onOpen} className="w-[118px] sm:w-[140px]" />
        ))}
      </div>
    </section>
  );
}

const SPECIALS: { label: string; payload: CatalogBrowsePayload }[] = [
  { label: '🎨 Мультфильмы', payload: { kind: 'movie', special: 'animation' } },
  { label: '⛩️ Аниме', payload: { kind: 'tv', special: 'anime' } },
  { label: '👨‍👩‍👧 Детям', payload: { kind: 'movie', special: 'kids' } },
  { label: '🇷🇺 Российское', payload: { kind: 'movie', special: 'russian' } },
  { label: '⭐ Топ фильмов', payload: { kind: 'movie', sort: 'rating' } },
  { label: '🏆 Топ сериалов', payload: { kind: 'tv', sort: 'rating' } },
  { label: '🆕 Новинки', payload: { kind: 'movie', sort: 'new' } },
];

function GenreChips({ home, onPick }: { home: CatalogHome; onPick: (b: CatalogBrowsePayload & { title?: string }) => void }) {
  const [kind, setKind] = useState<CatalogKind>('movie');
  const genres = home.genres[kind] || [];
  return (
    <section className="flex flex-col gap-3">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden">
        {SPECIALS.map((s) => (
          <button key={s.label} onClick={() => onPick({ ...s.payload, title: s.label.replace(/^\S+\s/, '') })} className="chip shrink-0 bg-ink-800 px-3.5 py-2 text-[13px] text-fg-muted ring-1 ring-white/5 transition hover:text-fg active:scale-95">
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span className="label">Жанры</span>
        <Segmented<CatalogKind> value={kind} onChange={setKind} options={[{ value: 'movie', label: 'Фильмы' }, { value: 'tv', label: 'Сериалы' }]} />
      </div>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden">
        {genres.map((g) => (
          <button
            key={g.id}
            onClick={() => onPick({ kind, genre: g.id, title: g.name })}
            className="shrink-0 rounded-2xl bg-gradient-to-br from-ink-750 to-ink-800 px-4 py-2.5 text-[13px] font-bold text-fg-muted ring-1 ring-white/5 transition hover:text-fg active:scale-95"
          >
            {g.name}
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Browse with filters / search grid
// ---------------------------------------------------------------------------

const DECADES: { label: string; from?: number; to?: number }[] = [
  { label: 'Все годы' },
  { label: `${new Date().getFullYear()}`, from: new Date().getFullYear(), to: new Date().getFullYear() },
  { label: '2020-е', from: 2020, to: 2029 },
  { label: '2010-е', from: 2010, to: 2019 },
  { label: '2000-е', from: 2000, to: 2009 },
  { label: '90-е', from: 1990, to: 1999 },
  { label: 'Классика', to: 1989 },
];

function BrowseView({
  initial,
  genres,
  onOpen,
  onBack,
}: {
  initial: CatalogBrowsePayload & { title?: string };
  genres?: CatalogHome['genres'];
  onOpen: (i: CatalogItem) => void;
  onBack: () => void;
}) {
  const [p, setP] = useState<CatalogBrowsePayload>(() => ({ sort: 'popular', ...initial }));
  const [minRating, setMinRating] = useState<number | undefined>(initial.minRating);
  const decade = DECADES.findIndex((d) => d.from === p.yearFrom && d.to === p.yearTo);
  const genreList = genres?.[p.kind] || [];
  const title = initial.title || (p.kind === 'tv' ? 'Сериалы' : 'Фильмы');
  const payload = { ...p, minRating };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <button className="icon-btn -ml-2" onClick={onBack} aria-label="Назад">
          <ArrowLeft size={20} />
        </button>
        <h2 className="flex-1 truncate text-xl font-extrabold">{title}</h2>
      </div>
      <div className="flex flex-col gap-2.5">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
          {!p.special && (
            <Segmented<CatalogKind>
              value={p.kind}
              onChange={(kind) => setP((x) => ({ ...x, kind, genre: undefined }))}
              options={[
                { value: 'movie', label: 'Фильмы' },
                { value: 'tv', label: 'Сериалы' },
              ]}
            />
          )}
          <Segmented<CatalogSort>
            value={p.sort || 'popular'}
            onChange={(sort) => setP((x) => ({ ...x, sort }))}
            options={[
              { value: 'popular', label: 'Популярное' },
              { value: 'rating', label: 'Рейтинг' },
              { value: 'new', label: 'Новое' },
            ]}
          />
        </div>
        {!!genreList.length && (
          <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden">
            <FilterChip active={!p.genre} onClick={() => setP((x) => ({ ...x, genre: undefined }))}>
              Все жанры
            </FilterChip>
            {genreList.map((g) => (
              <FilterChip key={g.id} active={p.genre === g.id} onClick={() => setP((x) => ({ ...x, genre: x.genre === g.id ? undefined : g.id }))}>
                {g.name}
              </FilterChip>
            ))}
          </div>
        )}
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden">
          {DECADES.map((d, i) => (
            <FilterChip key={d.label} active={decade === i || (i === 0 && decade < 0 && !p.yearFrom && !p.yearTo)} onClick={() => setP((x) => ({ ...x, yearFrom: d.from, yearTo: d.to }))}>
              {d.label}
            </FilterChip>
          ))}
          <span className="mx-1 w-px shrink-0 bg-white/10" />
          {[7, 8].map((r) => (
            <FilterChip key={r} active={minRating === r} onClick={() => setMinRating((m) => (m === r ? undefined : r))}>
              <Star size={12} fill="currentColor" /> {r}+
            </FilterChip>
          ))}
        </div>
      </div>
      <Grid payload={payload} onOpen={onOpen} key={JSON.stringify(payload)} />
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex shrink-0 items-center gap-1 rounded-full px-3.5 py-2 text-[13px] font-semibold transition active:scale-95',
        active ? 'bg-ember text-ink-950' : 'bg-ink-800 text-fg-muted ring-1 ring-white/5 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function Grid({ payload, onOpen }: { payload: CatalogBrowsePayload; onOpen: (i: CatalogItem) => void }) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const busy = useRef(false);

  const more = useCallback(async () => {
    if (busy.current || page >= total) return;
    busy.current = true;
    setLoading(true);
    const r = await request<CatalogPageData>(Events.CATALOG_BROWSE, { ...payload, page: page + 1 }, 30000);
    busy.current = false;
    setLoading(false);
    if (!r.ok || !r.data) return setError(r.error || 'error');
    const data = r.data;
    setItems((list) => {
      const seen = new Set(list.map((x) => `${x.type}:${x.id}`));
      return [...list, ...data.items.filter((x) => !seen.has(`${x.type}:${x.id}`))];
    });
    setPage(data.page);
    setTotal(data.totalPages);
  }, [payload, page, total]);

  // debounce the first load (search as you type)
  useEffect(() => {
    const t = setTimeout(() => void more(), payload.query ? 350 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = sentinel.current;
    // infinite scroll starts after the first page (the first one is debounced while typing)
    if (!el || page === 0) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && void more(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more, page]);

  if (error && !items.length) return <Empty icon={<Search size={26} />} title="Не получилось" text={errorText(error)} />;
  if (!loading && page > 0 && !items.length) return <Empty icon={<Search size={26} />} title="Ничего не нашлось" text="Попробуйте другое название или фильтры" />;
  return (
    <>
      <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6">
        {items.map((it) => (
          <PosterCard key={`${it.type}:${it.id}`} item={it} onOpen={onOpen} />
        ))}
        {loading &&
          Array.from({ length: items.length ? 3 : 12 }, (_, i) => <div key={`s${i}`} className="aspect-[2/3] animate-pulse rounded-2xl bg-ink-800" />)}
      </div>
      <div ref={sentinel} className="h-4" />
    </>
  );
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

function DetailsView({
  open,
  top,
  onClose,
  onOpen,
  onWatch,
  onOpenSettings,
}: {
  open: Open;
  top: boolean;
  onClose: () => void;
  onOpen: (i: CatalogItem) => void;
  onWatch: () => void;
  onOpenSettings?: () => void;
}) {
  const [d, setD] = useState<CatalogDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState<number | undefined>(undefined);
  const [releases, setReleases] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const catalog = useStore((s) => s.catalog);

  useEffect(() => {
    let alive = true;
    void request<CatalogDetails>(Events.CATALOG_DETAILS, open, 30000).then((r) => {
      if (!alive) return;
      if (r.ok && r.data) {
        setD(r.data);
        const seasons = r.data.seasons || [];
        setSeason(seasons.length ? seasons[seasons.length - 1].number : undefined);
      } else setError(r.error || 'error');
    });
    return () => {
      alive = false;
    };
  }, [open.id, open.type]);

  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (releases ? setReleases(false) : onClose());
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [top, releases, onClose]);

  // library items of this title (to play right away)
  const inLibrary = useMemo(() => {
    if (!d) return [];
    return catalog.filter((m) => m.tmdbId === d.id && m.tmdbType === d.type).sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
  }, [catalog, d]);

  const playTrailer = async () => {
    const t = d?.trailers[0];
    if (!t) return;
    const ok = await control({ type: 'PLAY_SOURCE', request: { source: 'youtube', url: `https://www.youtube.com/watch?v=${t.key}`, title: `${d.title} — трейлер` } });
    if (ok) toast('Трейлер на экране ТВ', 'success');
  };
  const playLibrary = async () => {
    const m = inLibrary.find((x) => x.position && x.duration && x.position < x.duration * 0.92) || inLibrary[0];
    if (!m) return;
    if (await control({ type: 'PLAY_SOURCE', request: { source: 'local', mediaId: m.id } })) onWatch();
  };

  return createPortal(
    <div className={cx('fixed inset-0 z-[150] flex justify-center bg-black/70 backdrop-blur-sm', top ? 'animate-fade-in' : 'pointer-events-none opacity-0')} onMouseDown={onClose}>
      <div
        ref={scroller}
        onMouseDown={(e) => e.stopPropagation()}
        className="relative h-full w-full max-w-4xl animate-rise overflow-y-auto bg-ink-900 sm:my-6 sm:h-[calc(100%-3rem)] sm:rounded-[28px] sm:border sm:border-white/10 sm:shadow-2xl"
      >
        <button
          onClick={onClose}
          className="fixed right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-fg backdrop-blur-md transition hover:bg-black/70 sm:absolute"
          style={{ top: 'calc(var(--safe-top) + 12px)' }}
          aria-label="Закрыть"
        >
          <X size={20} />
        </button>
        {!d && !error && (
          <div className="flex h-full items-center justify-center">
            <Spinner size={28} className="text-fg-dim" />
          </div>
        )}
        {error && <Empty icon={<Film size={26} />} title="Не удалось открыть" text={errorText(error)} />}
        {d && (
          <>
            <div className="relative">
              <div className="relative aspect-[16/10] w-full overflow-hidden sm:aspect-[21/9]">
                {d.backdrop ? <img src={d.backdrop} alt="" className="h-full w-full animate-fade-in object-cover" /> : <div className="h-full w-full bg-ink-800" />}
                <div className="absolute inset-0 bg-gradient-to-t from-ink-900 via-ink-900/50 to-ink-900/10" />
              </div>
              <div className="relative z-10 -mt-28 flex gap-4 px-5 sm:-mt-40 sm:gap-6 sm:px-8">
                {d.poster && <img src={d.poster} alt="" className="hidden w-36 shrink-0 self-end rounded-2xl shadow-2xl ring-1 ring-white/10 sm:block sm:w-44" />}
                <div className="min-w-0 flex-1 self-end">
                  <h2 className="text-[26px] font-extrabold leading-[1.1] tracking-tight drop-shadow-lg sm:text-4xl">{d.title}</h2>
                  {d.originalTitle && d.originalTitle !== d.title && <p className="mt-1 text-sm text-fg-muted">{d.originalTitle}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-fg-muted">
                    {d.rating ? (
                      <span className="flex items-center gap-1 font-bold text-fg">
                        <Star size={14} className="text-warn" fill="currentColor" /> {d.rating.toFixed(1)}
                        {d.voteCount ? <span className="font-normal text-fg-dim">· {d.voteCount > 999 ? `${Math.round(d.voteCount / 1000)}K` : d.voteCount}</span> : null}
                      </span>
                    ) : null}
                    {d.year && (
                      <span className="flex items-center gap-1">
                        <Calendar size={13} /> {d.year}
                      </span>
                    )}
                    {d.runtime && (
                      <span className="flex items-center gap-1">
                        <Clock size={13} /> {d.type === 'tv' ? `~${d.runtime} мин серия` : `${Math.floor(d.runtime / 60) ? `${Math.floor(d.runtime / 60)} ч ` : ''}${d.runtime % 60} мин`}
                      </span>
                    )}
                    {d.certification && <span className="rounded-md border border-white/20 px-1.5 text-[11px] font-bold">{d.certification}</span>}
                    {d.type === 'tv' && d.seasons && <span>{d.seasons.length} сез.</span>}
                  </div>
                </div>
              </div>
            </div>

            <div className="relative z-10 flex flex-col gap-6 px-5 pb-10 pt-5 sm:px-8" style={{ paddingBottom: 'calc(var(--safe-bottom) + 40px)' }}>
              <div className="flex flex-wrap gap-2">
                <button className="btn-primary h-12 flex-1 px-6 text-[15px] sm:flex-none" onClick={() => setReleases(true)}>
                  <Play size={18} fill="currentColor" /> Смотреть
                </button>
                {inLibrary.length > 0 && (
                  <button className="btn-soft h-12 flex-1 sm:flex-none" onClick={playLibrary}>
                    <Library size={17} /> Из медиатеки
                  </button>
                )}
                {d.trailers.length > 0 && (
                  <button className="btn-soft h-12 flex-1 sm:flex-none" onClick={playTrailer}>
                    <Youtube size={18} className="text-[#ff4d4d]" /> Трейлер
                  </button>
                )}
              </div>

              {!!d.genres.length && (
                <div className="flex flex-wrap gap-1.5">
                  {d.genres.map((g) => (
                    <span key={g} className="chip bg-white/5 text-fg-muted">
                      {g}
                    </span>
                  ))}
                </div>
              )}
              {d.tagline && <p className="text-[15px] italic text-fg-muted">«{d.tagline}»</p>}
              {d.overview && <p className="text-[15px] leading-relaxed text-fg/90">{d.overview}</p>}

              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                {!!d.directors?.length && (
                  <>
                    <dt className="text-fg-dim">{d.type === 'tv' ? 'Создатели' : 'Режиссёр'}</dt>
                    <dd>{d.directors.join(', ')}</dd>
                  </>
                )}
                {!!d.countries?.length && (
                  <>
                    <dt className="text-fg-dim">Страна</dt>
                    <dd>{d.countries.join(', ')}</dd>
                  </>
                )}
                {d.imdbId && (
                  <>
                    <dt className="text-fg-dim">IMDb</dt>
                    <dd>
                      <button className="inline-flex items-center gap-1 text-ember" onClick={() => void openExternal(`https://www.imdb.com/title/${d.imdbId}/`)}>
                        {d.imdbId} <ExternalLink size={12} />
                      </button>
                    </dd>
                  </>
                )}
              </dl>

              {!!d.seasons?.length && (
                <section>
                  <div className="label mb-3">Сезоны</div>
                  <div className="-mx-5 flex gap-3 overflow-x-auto px-5 [scrollbar-width:none] sm:-mx-8 sm:px-8 [&::-webkit-scrollbar]:hidden">
                    {d.seasons.map((s) => (
                      <button
                        key={s.number}
                        onClick={() => {
                          setSeason(s.number);
                          setReleases(true);
                        }}
                        className="group w-[96px] shrink-0 text-left"
                      >
                        <div className="aspect-[2/3] overflow-hidden rounded-xl bg-ink-800 ring-1 ring-white/5 transition group-hover:ring-ember/50 group-active:scale-95">
                          {s.poster ? <img src={s.poster} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-2xl font-extrabold text-fg-dim">{s.number}</div>}
                        </div>
                        <div className="mt-1.5 text-[12px] font-bold">Сезон {s.number}</div>
                        <div className="text-[11px] text-fg-dim">
                          {s.episodes} эп.{s.year ? ` · ${s.year}` : ''}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {!!d.cast.length && (
                <section>
                  <div className="label mb-3 flex items-center gap-1.5">
                    <Users size={13} /> В ролях
                  </div>
                  <div className="-mx-5 flex gap-3 overflow-x-auto px-5 [scrollbar-width:none] sm:-mx-8 sm:px-8 [&::-webkit-scrollbar]:hidden">
                    {d.cast.map((c) => (
                      <div key={c.name + (c.character || '')} className="w-[76px] shrink-0 text-center">
                        <div className="mx-auto h-[76px] w-[76px] overflow-hidden rounded-full bg-ink-800 ring-1 ring-white/5">
                          {c.photo ? (
                            <img src={c.photo} alt="" loading="lazy" className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full items-center justify-center text-lg font-bold text-fg-dim">{c.name.charAt(0)}</div>
                          )}
                        </div>
                        <div className="mt-1.5 line-clamp-2 text-[11px] font-bold leading-tight">{c.name}</div>
                        {c.character && <div className="line-clamp-1 text-[10px] text-fg-dim">{c.character}</div>}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {!!d.recommendations.length && <Shelf title="Похожее" items={d.recommendations} onOpen={onOpen} />}
            </div>

            {releases && (
              <ReleasesPanel
                details={d}
                season={season}
                onSeason={setSeason}
                onClose={() => setReleases(false)}
                onStarted={onWatch}
                onOpenSettings={onOpenSettings}
              />
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Releases (torrent search)
// ---------------------------------------------------------------------------

type QualityFilter = 'all' | '2160p' | '1080p' | '720p';

function ReleasesPanel({
  details,
  season,
  onSeason,
  onClose,
  onStarted,
  onOpenSettings,
}: {
  details: CatalogDetails;
  season?: number;
  onSeason: (n: number) => void;
  onClose: () => void;
  onStarted: () => void;
  onOpenSettings?: () => void;
}) {
  const owner = useStore(isOwner);
  const [res, setRes] = useState<TorrentSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityFilter>('all');
  const [ruOnly, setRuOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [picked, setPicked] = useState<TorrentResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    setRes(null);
    setError(null);
    setPicked(null);
    void request<TorrentSearchResult>(Events.TORRENT_SEARCH, { tmdbId: details.id, type: details.type, season: details.type === 'tv' ? season : undefined }, 90000).then((r) => {
      if (!alive) return;
      if (r.ok && r.data) setRes(r.data);
      else setError(r.error || 'error');
    });
    return () => {
      alive = false;
    };
  }, [details.id, details.type, season, retry]);

  const list = useMemo(() => {
    let l = res?.results || [];
    if (quality !== 'all') l = l.filter((r) => r.quality === quality);
    if (ruOnly) l = l.filter((r) => r.tags.some((t) => ['Дубляж', 'Многоголосый', 'Авторский'].includes(t)));
    return l;
  }, [res, quality, ruOnly]);
  const matched = list.filter((r) => r.matched);
  const others = list.filter((r) => !r.matched);
  const best = matched[0];

  const start = async (r: TorrentResult, play: boolean) => {
    setBusy(`${r.id}:${play}`);
    const ack = await act(Events.TORRENT_ADD, {
      magnet: r.magnet,
      link: r.magnet ? undefined : r.link,
      name: r.title,
      play,
      meta: { tmdbId: details.id, type: details.type, title: details.title, year: details.year, poster: details.poster, backdrop: details.backdrop },
    });
    setBusy(null);
    if (!ack.ok) return;
    toast(play ? `«${details.title}» скоро начнётся на ТВ` : `«${details.title}» скачивается — появится в медиатеке`, 'success', 4500);
    if (play) onStarted();
    else onClose();
  };

  return (
    <div className="fixed inset-0 z-[160] flex animate-fade-in items-end justify-center bg-black/60 sm:items-center sm:p-6" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-full max-w-2xl animate-sheet flex-col overflow-hidden rounded-t-[28px] border border-white/10 bg-ink-850 shadow-2xl sm:animate-pop sm:rounded-[28px]"
        style={{ paddingBottom: 'var(--safe-bottom)' }}
      >
        <div className="flex items-center gap-3 border-b border-white/5 px-5 py-4">
          <Clapperboard size={19} className="text-ember" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-bold">{details.title}</div>
            <div className="text-xs text-fg-dim">
              {res ? `Найдено раздач: ${res.results.length}` : error === 'no_indexer' ? 'Поиск раздач ещё не настроен' : error ? 'Поиск не удался' : 'Ищем раздачи на трекерах…'}
            </div>
          </div>
          <button className="icon-btn -mr-2" onClick={onClose} aria-label="Закрыть">
            <X size={20} />
          </button>
        </div>

        {!!details.seasons?.length && (
          <div className="flex gap-1.5 overflow-x-auto border-b border-white/5 px-5 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {details.seasons.map((s) => (
              <FilterChip key={s.number} active={season === s.number} onClick={() => onSeason(s.number)}>
                Сезон {s.number}
              </FilterChip>
            ))}
          </div>
        )}
        {res && !!res.results.length && (
          <div className="flex items-center gap-1.5 overflow-x-auto border-b border-white/5 px-5 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {(['all', '2160p', '1080p', '720p'] as QualityFilter[]).map((q) => (
              <FilterChip key={q} active={quality === q} onClick={() => setQuality(q)}>
                {q === 'all' ? 'Любое' : q === '2160p' ? '4K' : q}
              </FilterChip>
            ))}
            <span className="mx-1 w-px shrink-0 self-stretch bg-white/10" />
            <FilterChip active={ruOnly} onClick={() => setRuOnly((v) => !v)}>
              🇷🇺 Озвучка
            </FilterChip>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {!res && !error && (
            <div className="flex flex-col items-center gap-4 py-14 text-center">
              <div className="relative h-14 w-14">
                <Loader2 size={56} className="animate-spin text-ember/80" strokeWidth={1.5} />
              </div>
              <p className="max-w-xs text-sm text-fg-muted">Опрашиваем трекеры и подбираем лучшие раздачи: качество, озвучка, сиды…</p>
            </div>
          )}
          {error === 'no_indexer' && (
            <div className="px-2 py-2">
              <IndexerSetup owner={owner} onOpenSettings={onOpenSettings} onReady={() => setRetry((n) => n + 1)} compact />
            </div>
          )}
          {error && error !== 'no_indexer' && (
            <Empty icon={<Search size={26} />} title="Поиск не удался" text={errorText(error)} action={owner && onOpenSettings && <button className="btn-soft" onClick={onOpenSettings}>Настройки поиска</button>} />
          )}
          {res && !list.length && <Empty icon={<Search size={26} />} title="Раздач не нашлось" text={quality !== 'all' || ruOnly ? 'Попробуйте снять фильтры' : 'Трекеры ничего не вернули по этому названию'} />}
          {best && (
            <div className="mb-2 rounded-3xl bg-gradient-to-br from-ember/15 to-ember/[0.03] p-1 ring-1 ring-ember/30">
              <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-ember">
                <Sparkles size={13} /> Лучший вариант
              </div>
              <ReleaseRow r={best} picked={picked?.id === best.id} onPick={() => setPicked((p) => (p?.id === best.id ? null : best))} onStart={start} busy={busy} />
            </div>
          )}
          {matched.slice(1, showAll ? undefined : 25).map((r) => (
            <ReleaseRow key={r.id} r={r} picked={picked?.id === r.id} onPick={() => setPicked((p) => (p?.id === r.id ? null : r))} onStart={start} busy={busy} />
          ))}
          {!!others.length && (
            <>
              <div className="label mb-1 mt-4 px-3">Возможно, не то: другое название или сезон</div>
              {others.slice(0, showAll ? undefined : 8).map((r) => (
                <ReleaseRow key={r.id} r={r} dim picked={picked?.id === r.id} onPick={() => setPicked((p) => (p?.id === r.id ? null : r))} onStart={start} busy={busy} />
              ))}
            </>
          )}
          {!showAll && (matched.length > 25 || others.length > 8) && (
            <button className="btn-ghost mt-2 w-full text-xs" onClick={() => setShowAll(true)}>
              Показать все
            </button>
          )}
          {!!res?.errors?.length && <p className="mt-3 px-3 text-center text-[11px] text-fg-dim">Не ответили: {res.errors.join(', ')}</p>}
        </div>
      </div>
    </div>
  );
}

const ago = (t?: number) => {
  if (!t) return '';
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d < 1) return 'сегодня';
  if (d < 31) return `${d} дн. назад`;
  if (d < 365) return `${Math.floor(d / 30)} мес. назад`;
  return `${Math.floor(d / 365)} г. назад`;
};

function ReleaseRow({
  r,
  picked,
  dim,
  onPick,
  onStart,
  busy,
}: {
  r: TorrentResult;
  picked: boolean;
  dim?: boolean;
  onPick: () => void;
  onStart: (r: TorrentResult, play: boolean) => void;
  busy: string | null;
}) {
  const q = r.quality === '2160p' ? '4K' : r.quality || '—';
  const qColor = r.quality === '2160p' ? 'bg-[#b48cff]/20 text-[#cdb3ff]' : r.quality === '1080p' ? 'bg-ember/15 text-ember' : 'bg-white/5 text-fg-muted';
  return (
    <div className={cx('rounded-2xl transition', picked ? 'bg-ink-750' : 'hover:bg-white/[0.03]', dim && !picked && 'opacity-60')}>
      <button onClick={onPick} className="flex w-full items-start gap-3 px-3 py-3 text-left">
        <span className={cx('mt-0.5 w-12 shrink-0 rounded-lg py-1 text-center text-[12px] font-extrabold', qColor)}>{q}</span>
        <span className="min-w-0 flex-1">
          <span className={cx('block text-[13px] leading-snug', picked ? '' : 'line-clamp-2')}>{r.title}</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-dim">
            {r.tags.map((t) => (
              <span key={t} className={cx('rounded-md px-1.5 py-0.5 font-bold', t === 'Дубляж' || t === 'Многоголосый' ? 'bg-ok/10 text-ok' : /HDR|Dolby/.test(t) ? 'bg-warn/10 text-warn' : 'bg-white/5 text-fg-muted')}>
                {t}
              </span>
            ))}
            <span>{formatBytes(r.size)}</span>
            <span>·</span>
            <span>{r.tracker}</span>
            {r.publishedAt && <span>· {ago(r.publishedAt)}</span>}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end text-[12px] font-bold">
          <span className={cx(r.seeders >= 20 ? 'text-ok' : r.seeders >= 3 ? 'text-warn' : 'text-bad')}>▲ {r.seeders}</span>
          <span className="text-fg-dim">▼ {r.leechers}</span>
        </span>
      </button>
      {picked && (
        <div className="grid grid-cols-2 gap-2 px-3 pb-3">
          <button className="btn-primary h-11 whitespace-nowrap px-2 text-[13px]" disabled={!!busy} onClick={() => onStart(r, true)}>
            {busy === `${r.id}:true` ? <Spinner size={16} /> : <Play size={15} fill="currentColor" />} Смотреть сейчас
          </button>
          <button className="btn h-11 whitespace-nowrap bg-ink-600 px-2 text-[13px] text-fg hover:bg-ink-500" disabled={!!busy} onClick={() => onStart(r, false)}>
            {busy === `${r.id}:false` ? <Spinner size={16} /> : <Download size={16} />} Скачать
          </button>
          {r.seeders < 3 && <p className="col-span-2 text-center text-[11px] text-warn">Мало сидов — загрузка может идти медленно</p>}
        </div>
      )}
    </div>
  );
}

/** Step-by-step setup of torrent search (Jackett on the TV PC) with a "check" button. */
export function IndexerSetup({ owner, onOpenSettings, onReady, compact }: { owner: boolean; onOpenSettings?: () => void; onReady?: () => void; compact?: boolean }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<IndexerStatus | null>(null);
  const check = async () => {
    setChecking(true);
    const r = await request<IndexerStatus>(Events.INDEXER_TEST, {}, 45000);
    setChecking(false);
    if (!r.ok || !r.data) return toast(errorText(r.error), 'error');
    setResult(r.data);
    if (r.data.mode !== 'none' && !r.data.error && (r.data.trackers ?? 0) > 0) {
      toast(`Поиск раздач подключён: трекеров — ${r.data.trackers}`, 'success');
      onReady?.();
    }
  };
  const steps: ReactNode[] = [
    <>
      Скачайте и установите <b className="text-fg">Jackett</b> на ПК, где работает TVBox — это бесплатная программа-поисковик по трекерам.
    </>,
    <>
      После установки Jackett откроется в браузере ПК (адрес <span className="font-mono text-fg">127.0.0.1:9117</span>).
    </>,
    <>
      Нажмите <b className="text-fg">«+ Add indexer»</b> и добавьте трекеры, которыми пользуетесь: открытые — сразу, закрытые — со своим логином.
    </>,
    <>Нажмите «Проверить» — TVBox найдёт Jackett сам, вводить ничего не нужно.</>,
  ];
  return (
    <div className={cx('rounded-3xl border border-ember/25 bg-gradient-to-br from-ember/[0.08] to-transparent', compact ? 'p-4' : 'p-5')}>
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-ember/15 text-ember">
          <Clapperboard size={22} />
        </span>
        <div>
          <div className="text-[15px] font-extrabold">Подключите поиск раздач</div>
          <div className="text-xs text-fg-dim">Один раз — и «Смотреть» работает для любого фильма</div>
        </div>
      </div>
      <ol className="mt-4 flex flex-col gap-2.5">
        {steps.map((st, i) => (
          <li key={i} className="flex gap-3 text-[13px] leading-snug text-fg-muted">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-700 text-[11px] font-extrabold text-fg">{i + 1}</span>
            <span className="pt-0.5">{st}</span>
          </li>
        ))}
      </ol>
      {result && (
        <p className={cx('mt-3 rounded-xl px-3 py-2 text-xs', result.mode === 'none' || result.error || !result.trackers ? 'bg-warn/10 text-warn' : 'bg-ok/10 text-ok')}>
          {result.mode === 'none'
            ? 'Jackett на ПК пока не найден. Он установлен и запущен?'
            : result.error
              ? `Jackett найден, но ответил ошибкой: ${result.error}`
              : result.trackers
                ? `Готово: трекеров — ${result.trackers}`
                : 'Jackett найден, но в нём нет ни одного трекера — добавьте их кнопкой «+ Add indexer»'}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn-primary" onClick={() => void openExternal('https://github.com/Jackett/Jackett/releases/latest/download/Jackett.Installer.Windows.exe')}>
          <Download size={16} /> Скачать Jackett
        </button>
        <button className="btn-soft" disabled={checking} onClick={check}>
          {checking ? <Spinner size={15} /> : <Check size={16} />} Проверить
        </button>
        {owner && onOpenSettings && (
          <button className="btn-ghost" onClick={onOpenSettings}>
            Указать вручную
          </button>
        )}
      </div>
    </div>
  );
}
