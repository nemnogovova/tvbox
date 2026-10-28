import { useEffect, useState } from 'react';
import { useStore } from './store/store';
import { AuthScreen, Backdrop } from './components/AuthScreen';
import { LinkPage } from './components/LinkPage';
import { JoinPage, NoHomeScreen } from './components/Homes';
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
import { useBack } from './lib/back';

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
  const joinMatch = /^\/join\/?([A-Za-z0-9-]*)/.exec(path);
  const user = useStore((s) => s.user);

  let body;
  if (linkMatch) body = <LinkPage initialCode={linkMatch[1] || ''} />;
  else if (joinMatch) body = <JoinPage initialCode={joinMatch[1] || ''} />;
  else if (auth === 'unknown')
    body = (
      <div className="relative flex h-full items-center justify-center">
        <Backdrop />
        <Spinner size={26} className="text-fg-muted" />
      </div>
    );
  else if (auth === 'anon') body = <AuthScreen />;
  // signed in, but no TV yet: connect one or join a home by invitation
  // (a server older than homes sends no homeId at all — then there is just its one TV)
  else if (user?.homeId === null) body = <NoHomeScreen />;
  // another home is a different TV: everything starts fresh
  else body = <Main key={user?.homeId || 'tv'} />;

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
  // back from any tab leads to the remote first (phones), then out of the app
  useBack(!desktop && effective !== 'remote', () => setTab('remote'), 0);
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
