import type { ReactNode } from 'react';
import { useStore } from '../store/store';
import type { Tab } from '../App';
import { Monitor, LayoutGrid, Download, Cast, Settings, Power } from 'lucide-react';

const NAV: { tab: Tab; label: string; icon: typeof Monitor }[] = [
  { tab: 'remote', label: 'Пульт', icon: Monitor },
  { tab: 'catalog', label: 'Каталог', icon: LayoutGrid },
  { tab: 'downloads', label: 'Загрузки', icon: Download },
  { tab: 'cast', label: 'Кастинг', icon: Cast },
  { tab: 'settings', label: 'Настройки', icon: Settings },
];

export function Layout({
  tab,
  onTab,
  remotePanel,
  content,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  remotePanel: ReactNode;
  content: ReactNode;
}) {
  const { presence, signOut, user } = useStore();

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Desktop left / mobile content area */}
      <main className="flex-1 lg:max-w-none lg:border-r lg:border-line overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-4 pb-24 lg:pb-6">{content}</div>
      </main>

      {/* Desktop right panel: persistent remote */}
      <aside className="hidden lg:flex lg:w-[400px] xl:w-[440px] flex-col border-l border-line shrink-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <span className={`w-2 h-2 rounded-full ${presence.tvConnected ? 'bg-emerald-400' : 'bg-red-400'}`} />
            {presence.tvConnected ? 'TV online' : 'TV offline'}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 truncate max-w-[140px]">{user?.name}</span>
            <button onClick={signOut} className="text-gray-500 hover:text-gray-300 text-xs">
              Sign out
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{remotePanel}</div>
      </aside>

      {/* Mobile header */}
      <header className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-line sticky top-0 bg-base/90 backdrop-blur z-20">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-accent2 flex items-center justify-center text-white text-xs font-bold">
            TV
          </div>
          <span className="font-semibold text-sm">TVBox</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`flex items-center gap-1.5 text-xs ${presence.tvConnected ? 'text-emerald-400' : 'text-red-400'}`}>
            <span className={`w-2 h-2 rounded-full ${presence.tvConnected ? 'bg-emerald-400' : 'bg-red-400'}`} />
            {presence.tvConnected ? 'TV' : 'Offline'}
          </span>
          <button onClick={signOut} className="text-gray-500 hover:text-gray-300">
            <Power size={16} />
          </button>
        </div>
      </header>

      {/* Mobile bottom nav */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 bg-surface/95 backdrop-blur border-t border-line z-30">
        <div className="grid grid-cols-5">
          {NAV.map(({ tab: t, label, icon: Icon }) => (
            <button
              key={t}
              onClick={() => onTab(t)}
              className={`flex flex-col items-center gap-1 py-2.5 text-[11px] ${
                tab === t ? 'text-accent' : 'text-gray-500'
              }`}
            >
              <Icon size={20} strokeWidth={tab === t ? 2.4 : 2} />
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
