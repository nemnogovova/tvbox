import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppWindow,
  ChevronLeft,
  Eye,
  EyeOff,
  Folder,
  HardDrive,
  LayoutGrid,
  Maximize2,
  Minimize2,
  MonitorUp,
  MoreHorizontal,
  MousePointer2,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Skull,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { Events, type AppEntry, type AppWindow as AppWin, type FsEntry, type FsListResult } from '@tvbox/shared';
import { act, errorText, isOwner, request, toast, useStore } from '../store/store';
import { Empty, Sheet, Spinner, Toggle, cx } from '../components/ui';
import { Touchpad } from '../components/Touchpad';
import { DPad } from '../components/DPad';

const KIND_LABEL: Record<AppEntry['kind'], string> = { desktop: 'Программа', store: 'Microsoft Store', steam: 'Steam', custom: 'Добавлена вручную' };

export function AppsPage() {
  const owner = useStore(isOwner);
  const tvOnline = useStore((s) => s.presence.tvConnected);
  const state = useStore((s) => s.apps);
  const [apps, setApps] = useState<AppEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [edit, setEdit] = useState<AppEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [touchpad, setTouchpad] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);

  const load = async (refresh = false) => {
    setLoading(true);
    const r = await request<AppEntry[]>(Events.APPS_LIST, { refresh, includeHidden: true }, 120000);
    setLoading(false);
    if (r.ok) {
      setApps(r.data || []);
      setError(null);
    } else setError(r.error || 'error');
  };

  useEffect(() => {
    if (tvOnline) void load();
  }, [tvOnline]);

  const launching = state?.launching?.appId;
  useEffect(() => {
    if (!launching) setStarting(null);
  }, [launching]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (apps || []).filter((a) => (showHidden || !a.hidden) && (!q || a.name.toLowerCase().includes(q)));
  }, [apps, query, showHidden]);
  const hiddenCount = (apps || []).filter((a) => a.hidden).length;
  const running = new Set((state?.windows || []).map((w) => w.appId).filter(Boolean));

  const launch = async (a: AppEntry) => {
    setStarting(a.id);
    const r = await act(Events.APPS_LAUNCH, { id: a.id });
    if (!r.ok) setStarting(null);
    else setTimeout(() => setStarting((x) => (x === a.id ? null : x)), 20000);
  };

  const patch = async (a: AppEntry, p: Partial<AppEntry>) => {
    setApps((list) => list?.map((x) => (x.id === a.id ? { ...x, ...p } : x)) || null);
    const r = await act<AppEntry>(Events.APPS_UPDATE, { id: a.id, patch: p });
    if (r.ok && r.data) {
      setApps((list) => list?.map((x) => (x.id === a.id ? r.data! : x)) || null);
      setEdit((e) => (e?.id === a.id ? r.data! : e));
    }
  };

  if (error === 'not_supported')
    return <Empty icon={<AppWindow size={28} />} title="Только для Windows" text="Запуск программ работает, когда TVBox установлен на ПК с Windows." />;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <h1 className="h-page mr-auto">Приложения</h1>
        <div className="flex flex-1 items-center gap-2 lg:flex-none">
          <div className="relative flex-1 lg:w-72">
            <Search size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim" />
            <input className="field h-11 pl-10" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти программу или игру" />
          </div>
          {owner && (
            <button className="icon-btn h-11 w-11 bg-ink-800" onClick={() => setTouchpad(true)} title="Тачпад">
              <MousePointer2 size={19} />
            </button>
          )}
        </div>
      </div>

      <OpenWindows windows={state?.windows || []} tvboxFront={state?.tvboxForeground ?? true} onTouchpad={owner ? () => setTouchpad(true) : undefined} />

      {!apps && loading && (
        <div className="flex flex-col items-center gap-3 py-16 text-sm text-fg-dim">
          <Spinner size={26} />
          Собираем список программ с ПК…
        </div>
      )}
      {!apps && error && <Empty icon={<AppWindow size={28} />} title="Не удалось получить список" text={errorText(error)} action={<button className="btn-soft" onClick={() => load(true)}>Повторить</button>} />}

      {apps && (
        <>
          <div className="grid grid-cols-3 gap-x-2 gap-y-4 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6">
            {owner && (
              <button onClick={() => setAdding(true)} className="group flex flex-col items-center gap-2 rounded-3xl p-2 text-center transition active:scale-95">
                <span className="flex aspect-square w-full max-w-[84px] items-center justify-center rounded-[22px] border-2 border-dashed border-white/10 text-fg-dim transition group-hover:border-ember/50 group-hover:text-ember">
                  <Plus size={28} />
                </span>
                <span className="text-xs font-semibold text-fg-dim">Добавить .exe</span>
              </button>
            )}
            {visible.map((a) => (
              <AppTile
                key={a.id}
                app={a}
                running={running.has(a.id)}
                starting={starting === a.id || launching === a.id}
                onLaunch={() => launch(a)}
                onMenu={owner ? () => setEdit(a) : undefined}
              />
            ))}
          </div>
          {!visible.length && <p className="py-8 text-center text-sm text-fg-dim">{query ? 'Ничего не найдено' : 'Список пуст'}</p>}
          <div className="flex flex-wrap items-center justify-center gap-2 pb-2">
            {hiddenCount > 0 && (
              <button className="btn-ghost px-3 py-2 text-xs" onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? <EyeOff size={15} /> : <Eye size={15} />} {showHidden ? 'Не показывать скрытые' : `Скрытые и системные · ${hiddenCount}`}
              </button>
            )}
            <button className="btn-ghost px-3 py-2 text-xs" disabled={loading} onClick={() => load(true)}>
              {loading ? <Spinner size={14} /> : <RefreshCw size={14} />} Обновить список
            </button>
          </div>
        </>
      )}

      <AppSheet
        app={edit}
        onClose={() => setEdit(null)}
        onPatch={patch}
        onRemove={async (a) => {
          const r = await act(Events.APPS_REMOVE, { id: a.id }, a.kind === 'custom' ? 'Удалено из списка' : 'Скрыто');
          if (r.ok) {
            setEdit(null);
            void load();
          }
        }}
      />
      <AddProgramSheet
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(a) => {
          setAdding(false);
          setApps((list) => [a, ...(list || []).filter((x) => x.id !== a.id)]);
        }}
      />
      <Touchpad open={touchpad} onClose={() => setTouchpad(false)} />
    </div>
  );
}

function AppIcon({ app, size = 'md' }: { app: Pick<AppEntry, 'icon' | 'name'>; size?: 'md' | 'sm' }) {
  const [broken, setBroken] = useState(false);
  const letter = app.name.replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase() || '?';
  const hue = [...app.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  if (app.icon && !broken)
    return <img src={app.icon} alt="" onError={() => setBroken(true)} className={cx('object-contain drop-shadow-lg', size === 'md' ? 'h-[52%] w-[52%]' : 'h-7 w-7')} draggable={false} />;
  return (
    <span className={cx('font-extrabold', size === 'md' ? 'text-3xl' : 'text-base')} style={{ color: `hsl(${hue} 80% 70%)` }}>
      {letter}
    </span>
  );
}

function AppTile({ app, running, starting, onLaunch, onMenu }: { app: AppEntry; running: boolean; starting: boolean; onLaunch: () => void; onMenu?: () => void }) {
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const long = useRef(false);
  const hue = [...app.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <div className={cx('group relative flex flex-col items-center gap-2 rounded-3xl p-2 text-center', app.hidden && 'opacity-50')}>
      <button
        onClick={() => !long.current && onLaunch()}
        onPointerDown={() => {
          long.current = false;
          if (onMenu) press.current = setTimeout(() => {
            long.current = true;
            onMenu();
          }, 550);
        }}
        onPointerUp={() => press.current && clearTimeout(press.current)}
        onPointerLeave={() => press.current && clearTimeout(press.current)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu?.();
        }}
        className="relative flex aspect-square w-full max-w-[84px] items-center justify-center overflow-hidden rounded-[22px] border border-white/[0.07] shadow-card transition active:scale-90"
        style={{ background: `radial-gradient(120% 120% at 30% 20%, hsl(${hue} 35% 22%), hsl(${hue} 30% 11%))` }}
        title={app.name}
      >
        <AppIcon app={app} />
        {starting && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/55">
            <Spinner size={24} className="text-ember" />
          </span>
        )}
        {app.pinned && <Pin size={11} className="absolute right-2 top-2 text-ember" fill="currentColor" />}
        {running && <span className="absolute bottom-1.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-ok shadow-[0_0_8px] shadow-ok" title="Запущено" />}
      </button>
      <span className="line-clamp-2 w-full text-[12px] font-semibold leading-tight text-fg-muted">{app.name}</span>
      {onMenu && (
        <button
          onClick={onMenu}
          className="absolute right-1 top-1 hidden h-7 w-7 items-center justify-center rounded-full bg-ink-900/80 text-fg-dim hover:text-fg group-hover:flex"
          aria-label="Настройки"
        >
          <MoreHorizontal size={15} />
        </button>
      )}
    </div>
  );
}

function OpenWindows({ windows, tvboxFront, onTouchpad }: { windows: AppWin[]; tvboxFront: boolean; onTouchpad?: () => void }) {
  const [pad, setPad] = useState(false);
  if (!windows.length) return null;
  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="label flex-1">Открыто на ПК · {windows.length}</span>
        {!tvboxFront && (
          <button className="chip bg-white/5 text-fg-muted hover:text-fg" onClick={() => act(Events.APPS_FOCUS, { tvbox: true })}>
            <MonitorUp size={13} /> Вернуться в TVBox
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {windows.slice(0, 8).map((w) => (
          <div key={w.hwnd} className={cx('flex items-center gap-3 rounded-2xl px-2 py-1.5', w.foreground && 'bg-ember/[0.07] ring-1 ring-ember/20')}>
            <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => act(Events.APPS_FOCUS, { hwnd: w.hwnd })} title="Показать на экране">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink-750">
                <AppIcon app={{ icon: w.icon, name: w.title }} size="sm" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{w.title}</span>
                <span className="block truncate text-[11px] text-fg-dim">
                  {w.foreground ? 'на экране' : w.minimized ? 'свёрнуто' : 'в фоне'}
                  {w.exe ? ` · ${w.exe}` : ''}
                </span>
              </span>
            </button>
            <button className="icon-btn h-9 w-9" title="На весь экран" onClick={() => act(Events.APPS_WINDOW, { hwnd: w.hwnd, action: 'fullscreen' })}>
              <Maximize2 size={16} />
            </button>
            <button className="icon-btn h-9 w-9" title="Свернуть" onClick={() => act(Events.APPS_WINDOW, { hwnd: w.hwnd, action: 'minimize' })}>
              <Minimize2 size={16} />
            </button>
            <CloseButton hwnd={w.hwnd} />
          </div>
        ))}
      </div>
      {!tvboxFront && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {onTouchpad && (
            <button className="btn-soft h-11" onClick={onTouchpad}>
              <MousePointer2 size={16} /> Тачпад
            </button>
          )}
          <button className={cx('btn-soft h-11', !onTouchpad && 'col-span-2')} onClick={() => setPad((v) => !v)}>
            <LayoutGrid size={16} /> {pad ? 'Скрыть стрелки' : 'Стрелки и OK'}
          </button>
        </div>
      )}
      {pad && <DPad className="mt-4" />}
    </div>
  );
}

/** Close politely; if the program ignores it, offer to kill it. */
function CloseButton({ hwnd }: { hwnd: string }) {
  const [asked, setAsked] = useState(false);
  const windows = useStore((s) => s.apps?.windows);
  const stillOpen = windows?.some((w) => w.hwnd === hwnd);
  useEffect(() => {
    if (!asked) return;
    const t = setTimeout(() => setAsked(false), 8000);
    return () => clearTimeout(t);
  }, [asked]);
  if (asked && stillOpen)
    return (
      <button className="icon-btn h-9 w-9 text-bad" title="Завершить принудительно" onClick={() => act(Events.APPS_CLOSE, { hwnd, force: true }, 'Процесс завершён')}>
        <Skull size={16} />
      </button>
    );
  return (
    <button
      className="icon-btn h-9 w-9 hover:text-bad"
      title="Закрыть"
      onClick={async () => {
        const r = await act(Events.APPS_CLOSE, { hwnd });
        if (r.ok) setTimeout(() => setAsked(true), 2500);
      }}
    >
      <XCircle size={17} />
    </button>
  );
}

function AppSheet({
  app,
  onClose,
  onPatch,
  onRemove,
}: {
  app: AppEntry | null;
  onClose: () => void;
  onPatch: (a: AppEntry, p: Partial<AppEntry>) => void;
  onRemove: (a: AppEntry) => void;
}) {
  const [name, setName] = useState('');
  const [args, setArgs] = useState('');
  useEffect(() => {
    setName(app?.name || '');
    setArgs(app?.args || '');
  }, [app?.id]);
  if (!app) return null;
  return (
    <Sheet open onClose={onClose} title={app.name}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-2xl bg-ink-800 p-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink-700">
            <AppIcon app={app} size="sm" />
          </span>
          <div className="min-w-0 text-xs text-fg-dim">
            <div className="font-semibold text-fg-muted">{KIND_LABEL[app.kind]}</div>
            <div className="truncate" title={app.target}>
              {app.target}
            </div>
          </div>
        </div>
        <label className="flex items-center gap-3">
          <span className="flex-1">
            <span className="block text-sm font-semibold">На весь экран</span>
            <span className="block text-xs text-fg-dim">Растягивать окно без рамок сразу после запуска</span>
          </span>
          <Toggle checked={app.fullscreen} onChange={(v) => onPatch(app, { fullscreen: v })} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button className="btn-soft" onClick={() => onPatch(app, { pinned: !app.pinned })}>
            {app.pinned ? <PinOff size={16} /> : <Pin size={16} />} {app.pinned ? 'Открепить' : 'Закрепить'}
          </button>
          <button className="btn-soft" onClick={() => onPatch(app, { hidden: !app.hidden })}>
            {app.hidden ? <Eye size={16} /> : <EyeOff size={16} />} {app.hidden ? 'Показывать' : 'Скрыть'}
          </button>
        </div>
        <div>
          <div className="label mb-2">Название</div>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== app.name && onPatch(app, { name })} />
        </div>
        {app.kind !== 'store' && app.kind !== 'steam' && (
          <div>
            <div className="label mb-2">Параметры запуска</div>
            <input
              className="field font-mono text-sm"
              value={args}
              placeholder="например: -fullscreen"
              onChange={(e) => setArgs(e.target.value)}
              onBlur={() => args !== (app.args || '') && onPatch(app, { args })}
            />
          </div>
        )}
        {app.kind === 'custom' && (
          <button className="btn-danger" onClick={() => onRemove(app)}>
            <Trash2 size={16} /> Убрать из списка
          </button>
        )}
      </div>
    </Sheet>
  );
}

/** Pick an .exe (or a shortcut) on the TV PC and add it to the launcher. */
function AddProgramSheet({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (a: AppEntry) => void }) {
  const [list, setList] = useState<FsListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  const go = async (path?: string) => {
    setLoading(true);
    const r = await request<FsListResult>(Events.FS_LIST, { path, purpose: 'apps' });
    setLoading(false);
    if (r.ok && r.data) setList(r.data);
    else toast(errorText(r.error), 'error');
  };
  useEffect(() => {
    if (open) void go();
    else setList(null);
  }, [open]);

  const add = async (path: string) => {
    setBusy(path);
    const r = await act<AppEntry>(Events.APPS_ADD, { path }, 'Программа добавлена');
    setBusy(null);
    if (r.ok && r.data) onAdded(r.data);
  };

  const entries = (list?.entries || []).filter((e) => e.kind === 'dir' || e.kind === 'app');
  const icon = (e: FsEntry) => (e.kind === 'app' ? <AppWindow size={18} className="text-ember" /> : !list?.path ? <HardDrive size={18} /> : <Folder size={18} />);

  return (
    <Sheet open={open} onClose={onClose} title="Добавить программу" wide>
      <p className="mb-3 text-sm text-fg-muted">Выберите .exe, ярлык или .bat на ПК — даже если программы нет в «Пуске» и в реестре.</p>
      <div className="mb-3 flex items-center gap-2">
        <button className="icon-btn h-10 w-10 bg-ink-800" disabled={list?.parent === null || loading} onClick={() => go(list?.parent || undefined)} aria-label="Назад">
          <ChevronLeft size={18} />
        </button>
        <div className="min-w-0 flex-1 truncate rounded-xl bg-ink-800 px-3 py-2.5 font-mono text-xs text-fg-muted" title={list?.path}>
          {list?.path || 'Компьютер'}
        </div>
        {loading && <Spinner size={16} className="text-fg-dim" />}
      </div>
      <div className="flex max-h-[50vh] flex-col overflow-y-auto">
        {list?.error && <p className="py-4 text-sm text-bad">{list.error}</p>}
        {entries.map((e) => (
          <button
            key={e.path}
            disabled={!!busy}
            onClick={() => (e.kind === 'dir' ? go(e.path) : add(e.path))}
            className={cx('flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition hover:bg-white/5', e.kind === 'app' && 'font-semibold')}
          >
            <span className="shrink-0 text-fg-dim">{icon(e)}</span>
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
            {busy === e.path ? <Spinner size={15} /> : e.kind === 'app' && <span className="chip bg-ember/15 py-1 text-[11px] text-ember">Добавить</span>}
          </button>
        ))}
        {list && !entries.length && !list.error && <p className="py-6 text-center text-sm text-fg-dim">Здесь нет программ и папок</p>}
      </div>
      <form
        className="mt-4 flex gap-2 border-t border-white/5 pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (manual.trim()) void add(manual.trim());
        }}
      >
        <input className="field flex-1 font-mono text-xs" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="или путь: D:\Games\Jackbox\Jackbox.exe" />
        <button className="btn-primary" disabled={!manual.trim() || !!busy}>
          <Plus size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <X size={18} />
        </button>
      </form>
    </Sheet>
  );
}
