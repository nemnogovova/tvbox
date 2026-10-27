import { useEffect, useState } from 'react';
import { useStore } from './store/store';
import { AuthScreen, Backdrop } from './components/AuthScreen';
import { LinkPage } from './components/LinkPage';
import { MORE_TABS, Shell, useIsDesktop, type Tab } from './components/Shell';
import { RemotePanel } from './components/RemotePanel';
import { GlobalInputs } from './components/GlobalInputs';
import { Segmented, Spinner, Toasts } from './components/ui';
import { LibraryPage } from './pages/LibraryPage';
import { DownloadsPage } from './pages/DownloadsPage';
import { CastPage } from './pages/CastPage';
import { SettingsPage } from './pages/SettingsPage';
import { MusicPage } from './pages/MusicPage';
import { CatalogPage } from './pages/CatalogPage';
import { AppsPage } from './pages/AppsPage';
import { getPref, setPref } from './lib/config';

function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

export default function App() {
  const auth = useStore((s) => s.auth);
  const path = usePath();
  const linkMatch = /^\/link\/?([A-Za-z0-9-]*)/.exec(path);

  let body;
  if (linkMatch) body = <LinkPage initialCode={linkMatch[1] || ''} />;
  else if (auth === 'unknown')
    body = (
      <div className="relative flex h-full items-center justify-center">
        <Backdrop />
        <Spinner size={26} className="text-fg-muted" />
      </div>
    );
  else if (auth === 'anon') body = <AuthScreen />;
  else body = <Main />;

  return (
    <>
      {body}
      <Toasts />
    </>
  );
}

function Main() {
  const desktop = useIsDesktop();
  const [tab, setTabState] = useState<Tab>(() => getPref<Tab>('tab', 'remote'));
  const [lastMore, setLastMore] = useState<Tab>(() => getPref<Tab>('tabMore', 'settings'));
  const setTab = (t: Tab) => {
    setTabState(t);
    setPref('tab', t);
    if (MORE_TABS.includes(t)) {
      setLastMore(t);
      setPref('tabMore', t);
    }
    document.querySelector('main')?.scrollTo({ top: 0 });
  };
  const effective: Tab = desktop && tab === 'remote' ? 'catalog' : tab;
  const moreSwitch = !desktop && MORE_TABS.includes(effective) && (
    <div className="mb-4">
      <Segmented<Tab>
        value={effective}
        onChange={setTab}
        options={[
          { value: 'downloads', label: 'Загрузки' },
          { value: 'cast', label: 'Трансляция' },
          { value: 'settings', label: 'Настройки' },
        ]}
      />
    </div>
  );

  return (
    <>
      <Shell
        tab={effective}
        onTab={setTab}
        lastMore={lastMore}
        remote={<RemotePanel compact={!desktop} />}
        content={
          effective === 'catalog' ? (
            <CatalogPage onWatch={() => !desktop && setTab('remote')} onOpenSettings={() => setTab('settings')} />
          ) : effective === 'apps' ? (
            <AppsPage />
          ) : effective === 'library' ? (
            <LibraryPage />
          ) : effective === 'downloads' ? (
            <>
              {moreSwitch}
              <DownloadsPage />
            </>
          ) : effective === 'cast' ? (
            <>
              {moreSwitch}
              <CastPage />
            </>
          ) : effective === 'music' ? (
            <MusicPage />
          ) : effective === 'settings' ? (
            <>
              {moreSwitch}
              <SettingsPage onOpenMusic={() => setTab('music')} />
            </>
          ) : null
        }
      />
      <GlobalInputs />
    </>
  );
}
