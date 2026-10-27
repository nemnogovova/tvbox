import { useEffect, useState, type ReactNode } from 'react';
import { AppWindow, Cast, Clapperboard, Download, Gamepad2, LayoutGrid, Library, Music2, Settings } from 'lucide-react';
import { Events } from '@tvbox/shared';
import { act, isOwner, serverOutdated, useStore } from '../store/store';
import { APP_VERSION, newerVersion } from '../lib/releases';
import { useCast } from '../store/cast';
import { Logo } from './AuthScreen';
import { TvStatusPill, cx } from './ui';

export type Tab = 'remote' | 'catalog' | 'library' | 'music' | 'apps' | 'downloads' | 'cast' | 'settings';
type NavTab = Tab | 'more';

/** Tabs that live under "Ещё" on phones */
export const MORE_TABS: Tab[] = ['downloads', 'cast', 'settings'];

const NAV: { tab: Tab; label: string; short?: string; icon: typeof Library }[] = [
  { tab: 'remote', label: 'Пульт', icon: Gamepad2 },
  { tab: 'catalog', label: 'Каталог', icon: Clapperboard },
  { tab: 'library', label: 'Медиатека', icon: Library },
  { tab: 'music', label: 'Музыка', icon: Music2 },
  { tab: 'apps', label: 'Приложения', short: 'Игры', icon: AppWindow },
  { tab: 'downloads', label: 'Загрузки', icon: Download },
  { tab: 'cast', label: 'Трансляция', short: 'Экран', icon: Cast },
  { tab: 'settings', label: 'Настройки', icon: Settings },
];

const MOBILE_NAV: { tab: NavTab; label: string; icon: typeof Library }[] = [
  { tab: 'remote', label: 'Пульт', icon: Gamepad2 },
  { tab: 'catalog', label: 'Каталог', icon: Clapperboard },
  { tab: 'library', label: 'Медиатека', icon: Library },
  { tab: 'music', label: 'Музыка', icon: Music2 },
  { tab: 'apps', label: 'Игры', icon: AppWindow },
  { tab: 'more', label: 'Ещё', icon: LayoutGrid },
];

export function useIsDesktop(): boolean {
  const q = '(min-width: 1024px)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/** The server is older than this remote: new features would silently do nothing. */
function OutdatedBanner() {
  const outdated = useStore(serverOutdated);
  const tvVersion = useStore((st) => st.presence.tvVersion);
  const tvOnline = useStore((st) => st.presence.tvConnected);
  const owner = useStore(isOwner);
  const [updating, setUpdating] = useState(false);
  if (!outdated && tvOnline && tvVersion && newerVersion(APP_VERSION, tvVersion)) {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-2xl border border-warn/30 bg-warn/10 px-4 py-3 text-[13px] leading-snug text-fg-muted">
        <span className="flex-1">
          <b className="text-warn">На телевизоре старый TVBox ({tvVersion}).</b> Новые функции пульта ({APP_VERSION}) там не заработают, пока его не обновить.
        </span>
        {owner && (
          <button
            className="btn-primary shrink-0 px-3 py-2 text-xs"
            disabled={updating}
            onClick={async () => {
              setUpdating(true);
              const r = await act(Events.TV_UPDATE, {}, 'ТВ скачивает обновление и перезапустится');
              if (!r.ok) setUpdating(false);
            }}
          >
            {updating ? 'Обновляем…' : 'Обновить ТВ'}
          </button>
        )}
      </div>
    );
  }
  if (!outdated) return null;
  return (
    <div className="mb-4 rounded-2xl border border-warn/30 bg-warn/10 px-4 py-3 text-[13px] leading-snug text-fg-muted">
      <b className="text-warn">Сервер TVBox устарел.</b> Каталог, игры, тачпад и открытие YouTube не заработают, пока его не обновить: на ПК запустите{' '}
      <code className="rounded bg-black/30 px-1.5 py-0.5 text-fg">deploy.ps1</code>.
    </div>
  );
}

export function Shell({
  tab,
  onTab,
  content,
  remote,
  lastMore = 'settings',
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  content: ReactNode;
  remote: ReactNode;
  lastMore?: Tab;
}) {
  const desktop = useIsDesktop();
  const activeDownloads = useStore((s) => s.torrents.filter((t) => t.status === 'downloading' || t.status === 'metadata').length);
  const casting = useCast((s) => !!s.session);
  const user = useStore((s) => s.user);
  const badge = (t: NavTab) =>
    t === 'downloads' && activeDownloads ? activeDownloads : t === 'cast' && casting ? '●' : t === 'more' && (activeDownloads || casting) ? '●' : null;

  if (desktop) {
    return (
      <div className="flex h-full">
        <nav className="flex w-60 shrink-0 flex-col border-r border-white/5 bg-ink-950/60 px-3 py-5">
          <div className="mb-8 flex items-center gap-3 px-3">
            <Logo size={34} />
            <span className="text-lg font-extrabold tracking-tight">TVBox</span>
          </div>
          {NAV.filter((n) => n.tab !== 'remote').map(({ tab: t, label, icon: Icon }) => (
            <button
              key={t}
              onClick={() => onTab(t)}
              className={cx(
                'mb-1 flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-bold transition',
                tab === t ? 'bg-white/[0.06] text-fg' : 'text-fg-dim hover:bg-white/[0.03] hover:text-fg-muted',
              )}
            >
              <Icon size={19} className={tab === t ? 'text-ember' : ''} />
              <span className="flex-1 text-left">{label}</span>
              {badge(t) && <span className="chip bg-ember/15 px-2 py-0.5 text-[11px] text-ember">{badge(t)}</span>}
            </button>
          ))}
          <div className="mt-auto px-3">
            <TvStatusPill />
            {user && <div className="mt-3 truncate text-xs text-fg-dim">{user.username ? `@${user.username}` : user.email || user.name}</div>}
          </div>
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-8 py-8">
            <OutdatedBanner />
            {content}
          </div>
        </main>
        <aside className="w-[400px] shrink-0 overflow-y-auto border-l border-white/5 bg-ink-950/40 px-5 py-6 xl:w-[430px]">{remote}</aside>
      </div>
    );
  }

  const current = NAV.find((n) => n.tab === tab);
  const activeNav: NavTab = MORE_TABS.includes(tab) ? 'more' : tab;
  return (
    <div className="flex h-full flex-col">
      <header
        className="sticky top-0 z-30 flex items-center gap-3 border-b border-white/5 bg-ink-900/85 px-4 pb-3 backdrop-blur-xl"
        style={{ paddingTop: 'calc(var(--safe-top) + 12px)' }}
      >
        <Logo size={28} />
        <span className="flex-1 text-base font-extrabold">{tab === 'remote' ? 'TVBox' : current?.label}</span>
        <TvStatusPill />
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 pb-28 pt-4">
          <OutdatedBanner />
          {tab === 'remote' ? remote : content}
        </div>
      </main>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-white/5 bg-ink-900/90 backdrop-blur-xl"
        style={{ paddingBottom: 'var(--safe-bottom)' }}
      >
        <div className="mx-auto grid max-w-2xl grid-cols-6">
          {MOBILE_NAV.map(({ tab: t, label, icon: Icon }) => (
            <button
              key={t}
              onClick={() => onTab(t === 'more' ? (MORE_TABS.includes(tab) ? tab : lastMore) : t)}
              className={cx('relative flex min-w-0 flex-col items-center gap-1 pb-2.5 pt-3 text-[10px] font-bold transition', activeNav === t ? 'text-fg' : 'text-fg-dim')}
            >
              <span className={cx('flex h-8 w-12 items-center justify-center rounded-full transition', activeNav === t && 'bg-ember/15 text-ember')}>
                <Icon size={21} strokeWidth={activeNav === t ? 2.4 : 2} />
              </span>
              {label}
              {badge(t) && <span className="absolute right-[18%] top-2 h-2 w-2 rounded-full bg-ember" />}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
