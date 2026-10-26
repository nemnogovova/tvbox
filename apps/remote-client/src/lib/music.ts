import { useEffect, useState } from 'react';
import { Events, type MusicTrack, type PlayRequest } from '@tvbox/shared';
import { control, request } from '../store/store';

/**
 * Music covers are stored on the TV (the music server is usually only reachable from the
 * home network), so remotes ask the TV for a small data: URL and keep it in memory.
 */
const cache = new Map<string, Promise<string | null>>();
const MAX = 400;

function fetchCover(sourceId: string, id: string): Promise<string | null> {
  const key = `${sourceId}:${id}`;
  let p = cache.get(key);
  if (!p) {
    p = request<string>(Events.MUSIC_COVER, { sourceId, id }, 20000).then((r) => (r.ok && r.data ? r.data : null));
    // failed lookups may be retried later
    void p.then((v) => v === null && setTimeout(() => cache.delete(key), 60_000));
    cache.set(key, p);
    if (cache.size > MAX) cache.delete(cache.keys().next().value as string);
  }
  return p;
}

/** Resolve a cover reference: plain URL, "music-cover:<sourceId>:<id>" or (sourceId, id). */
export function useCover(ref?: string | null, sourceId?: string): string | null {
  let src: string | null = null;
  let sid = sourceId;
  let id = ref || null;
  if (ref && ref.startsWith('music-cover:')) {
    const rest = ref.slice('music-cover:'.length);
    const i = rest.indexOf(':');
    sid = rest.slice(0, i);
    id = rest.slice(i + 1);
  } else if (ref && !sourceId) {
    src = ref;
  }
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (src || !sid || !id) return;
    let alive = true;
    void fetchCover(sid, id).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [src, sid, id]);
  return src ?? url;
}

export const trackRequest = (t: MusicTrack): PlayRequest => ({ source: 'music', track: t });

export function playTracks(tracks: MusicTrack[], startIndex = 0, shuffle = false): Promise<boolean> {
  return control({ type: 'QUEUE_SET', requests: tracks.map(trackRequest), startIndex: shuffle ? undefined : startIndex, shuffle });
}

export const queueTrack = (t: MusicTrack) => control({ type: 'QUEUE_ADD', request: trackRequest(t) });

export function formatTotal(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}
