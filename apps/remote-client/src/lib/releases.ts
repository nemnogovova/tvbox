import { useEffect, useState } from 'react';
import type { ReleasesManifest } from '@tvbox/shared';
import { useStore } from '../store/store';

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** "1.10.2" > "1.9.9" */
export function newerVersion(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

let cached: { at: number; url: string; data: ReleasesManifest } | null = null;

export async function fetchReleases(serverUrl: string, force = false): Promise<ReleasesManifest> {
  if (!force && cached && cached.url === serverUrl && Date.now() - cached.at < 5 * 60_000) return cached.data;
  try {
    const res = await fetch(`${serverUrl}/api/releases`, { cache: 'no-store' });
    const body = (await res.json()) as { data?: ReleasesManifest };
    cached = { at: Date.now(), url: serverUrl, data: body.data || {} };
    return cached.data;
  } catch {
    return cached?.data || {};
  }
}

export function useReleases(): ReleasesManifest | null {
  const serverUrl = useStore((s) => s.serverUrl);
  const [data, setData] = useState<ReleasesManifest | null>(cached?.url === serverUrl ? cached.data : null);
  useEffect(() => {
    let alive = true;
    void fetchReleases(serverUrl).then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [serverUrl]);
  return data;
}

export const downloadUrl = (serverUrl: string, platform: 'windows' | 'android') => `${serverUrl}/download/${platform}`;

export function formatSize(bytes: number): string {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} МБ`;
}
