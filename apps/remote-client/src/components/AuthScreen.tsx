import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { renderSignInButton } from '../lib/auth';
import { fetchPublicConfig } from '../lib/config';
import { Loader2, Server } from 'lucide-react';

export function AuthScreen() {
  const { signIn, authError, connecting, serverUrl, connectTo } = useStore();
  const [clientId, setClientId] = useState('');
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState(false);
  const [urlInput, setUrlInput] = useState(serverUrl);
  const [showServer, setShowServer] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchPublicConfig(serverUrl).then((c) => {
      setClientId(c.googleClientId);
      setConfigured(c.oauthConfigured);
    });
  }, [serverUrl]);

  useEffect(() => {
    if (clientId && btnRef.current) {
      setBusy(true);
      renderSignInButton(clientId, btnRef.current, (token) => {
        setBusy(false);
        signIn(token);
      });
    }
  }, [clientId, signIn]);

  const applyUrl = () => {
    if (urlInput.trim()) connectTo(urlInput.trim());
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm text-center animate-fade-in">
        <div className="mx-auto mb-6 w-16 h-16 rounded-2xl bg-gradient-to-br from-accent to-accent2 flex items-center justify-center">
          <svg width="32" height="32" viewBox="0 0 512 512" fill="none">
            <rect x="64" y="104" width="384" height="224" rx="28" fill="#0b0b0f" stroke="white" strokeWidth="20" />
            <path d="M176 348l80 60 80-60" stroke="white" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold mb-1">TVBox Remote</h1>
        <p className="text-gray-400 text-sm mb-8">Control your TV from anywhere</p>

        {!configured ? (
          <p className="text-sm text-gray-500">Google sign-in is not configured yet. Add <code className="text-gray-400">GOOGLE_CLIENT_ID</code> to the server .env.</p>
        ) : !clientId ? (
          <p className="text-sm text-gray-500 flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </p>
        ) : (
          <div ref={btnRef} className="w-full flex justify-center min-h-[48px]" />
        )}

        {authError && <p className="mt-4 text-sm text-red-400">{authError}</p>}

        {/* Server connection */}
        <button
          onClick={() => setShowServer((s) => !s)}
          className="mt-8 mx-auto flex items-center gap-2 text-xs text-gray-500 hover:text-gray-300"
        >
          <Server size={14} /> {showServer ? 'Скрыть настройки сервера' : 'Настройки сервера'}
        </button>
        {showServer && (
          <div className="mt-3 flex gap-2">
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://tv.nemnogovova.com"
              className="flex-1 bg-surface border border-line rounded-xl px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button onClick={applyUrl} className="btn-primary !px-3">
              {connecting ? <Loader2 size={16} className="animate-spin" /> : 'Ок'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
