export const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL ||
  (import.meta.env.DEV ? 'http://localhost:3000' : typeof window !== 'undefined' ? window.location.origin : '');

export interface PublicConfig {
  googleClientId: string;
  oauthConfigured: boolean;
}

export async function fetchPublicConfig(): Promise<PublicConfig> {
  try {
    const res = await fetch(`${SERVER_URL}/api/config`);
    if (!res.ok) return { googleClientId: '', oauthConfigured: false };
    return (await res.json()) as PublicConfig;
  } catch {
    return { googleClientId: '', oauthConfigured: false };
  }
}
