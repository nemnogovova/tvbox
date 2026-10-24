import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { renderSignInButton } from '../lib/auth';
import { fetchPublicConfig } from '../lib/config';

export function AuthScreen() {
  const { signIn, authError, connecting } = useStore();
  const [clientId, setClientId] = useState('');
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchPublicConfig().then((c) => {
      setClientId(c.googleClientId);
      setConfigured(c.oauthConfigured);
    });
  }, []);

  useEffect(() => {
    if (clientId && btnRef.current) {
      setBusy(true);
      renderSignInButton(clientId, btnRef.current, (token) => {
        setBusy(false);
        signIn(token);
      });
    }
  }, [clientId, signIn]);

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
          <p className="text-sm text-gray-500">Loading Google sign-in…</p>
        ) : (
          <div ref={btnRef} className="w-full flex justify-center min-h-[48px]" />
        )}

        {busy && clientId && <p className="mt-4 text-sm text-gray-500">{connecting ? 'Connecting…' : ''}</p>}
        {authError && <p className="mt-4 text-sm text-red-400">{authError}</p>}
      </div>
    </div>
  );
}
