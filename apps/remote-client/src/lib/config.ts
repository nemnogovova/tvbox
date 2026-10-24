const PROD_DEFAULT = 'https://tv.nemnogovova.com';
const STORAGE_KEY = 'tvbox.serverUrl';

export function getServerUrl(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved.replace(/\/$/, '');
  } catch {
    // ignore
  }
  if (import.meta.env.VITE_SERVER_URL) return import.meta.env.VITE_SERVER_URL.replace(/\/$/, '');
  if (import.meta.env.DEV) return 'http://localhost:3000';
  if (typeof window !== 'undefined' && window.location.origin.startsWith('http')) {
    return window.location.origin;
  }
  return PROD_DEFAULT;
}

export function saveServerUrl(url: string): string {
  const normalized = url.trim().replace(/\/$/, '');
  try {
    localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    // ignore
  }
  return normalized;
}

export function clearServerUrl(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export interface PublicConfig {
  googleClientId: string;
  oauthConfigured: boolean;
}

export async function fetchPublicConfig(serverUrl: string): Promise<PublicConfig> {
  try {
    const res = await fetch(`${serverUrl}/api/config`);
    if (!res.ok) return { googleClientId: '', oauthConfigured: false };
    return (await res.json()) as PublicConfig;
  } catch {
    return { googleClientId: '', oauthConfigured: false };
  }
}
