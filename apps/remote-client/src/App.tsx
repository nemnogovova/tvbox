import { useEffect, useState } from 'react';
import { useStore } from './store/store';
import { AuthScreen, Backdrop } from './components/AuthScreen';
import { LinkPage } from './components/LinkPage';
import { Shell, useIsDesktop, type Tab } from './components/Shell';
import { RemotePanel } from './components/RemotePanel';
import { GlobalInputs } from './components/GlobalInputs';
import { Spinner, Toasts } from './components/ui';
import { LibraryPage } from './pages/LibraryPage';
import { DownloadsPage } from './pages/DownloadsPage';
import { CastPage } from './pages/CastPage';
import { SettingsPage } from './pages/SettingsPage';
import { MusicPage } from './pages/MusicPage';
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
  const setTab = (t: Tab) => {
    setTabState(t);
    setPref('tab', t);
  };
  const effective: Tab = desktop && tab === 'remote' ? 'library' : tab;

  return (
    <>
      <Shell
        tab={effective}
        onTab={setTab}
        remote={<RemotePanel compact={!desktop} />}
        content={
          effective === 'library' ? (
            <LibraryPage />
          ) : effective === 'downloads' ? (
            <DownloadsPage />
          ) : effective === 'cast' ? (
            <CastPage />
          ) : effective === 'music' ? (
            <MusicPage />
          ) : effective === 'settings' ? (
            <SettingsPage onOpenMusic={() => setTab('music')} />
          ) : null
        }
      />
      <GlobalInputs />
    </>
  );
}
