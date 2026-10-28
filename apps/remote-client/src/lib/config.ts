import { DEFAULT_SERVER_URL } from '@tvbox/shared';
import { isNative } from './native';

const SERVER_KEY = 'tvbox.server';
const TOKEN_KEY = 'tvbox.token';

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}

/** Where the backend lives. On the web it is the page's own origin. */
export function getServerUrl(): string {
  const saved = lsGet(SERVER_KEY);
  if (saved) return saved;
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env.replace(/\/$/, '');
  if (!isNative() && /^https?:/.test(window.location.origin)) return window.location.origin;
  return DEFAULT_SERVER_URL;
}

export function setServerUrl(url: string | null): void {
  lsSet(SERVER_KEY, url ? url.trim().replace(/\/$/, '') : null);
}

export function canChangeServer(): boolean {
  return isNative() || Boolean(lsGet(SERVER_KEY));
}

export const getToken = () => lsGet(TOKEN_KEY);
export const setToken = (t: string | null) => lsSet(TOKEN_KEY, t);

export function getPref<T>(key: string, fallback: T): T {
  const v = lsGet(`tvbox.pref.${key}`);
  if (v === null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
export function setPref(key: string, value: unknown): void {
  lsSet(`tvbox.pref.${key}`, JSON.stringify(value));
}

export interface PublicConfig {
  googleClientId: string;
  oauthConfigured: boolean;
  publicUrl: string;
  turn: boolean;
  /** Who may create an account (TVBox ≥ 3.2 servers) */
  registration?: 'open' | 'approval' | 'closed';
}

export async function fetchPublicConfig(serverUrl: string): Promise<PublicConfig | null> {
  try {
    const res = await fetch(`${serverUrl}/api/config`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as PublicConfig;
  } catch {
    return null;
  }
}
