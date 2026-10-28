import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { net } from 'electron';
import {
  EMPTY_PLAYER_STATE,
  extractYouTubeId,
  extractYouTubeIndex,
  extractYouTubeList,
  extractYouTubeStart,
  mediaKindOfFile,
  parseMediaName,
  type ControlCommand,
  type MediaItem,
  type PlayRequest,
  type PlayerState,
  type QueueItem,
  type RepeatMode,
  type TorrentMeta,
} from '@tvbox/shared';
import type { Library } from './library';
import type { TorrentEngine } from './torrents';
import type { MediaServer } from './media-server';
import type { SystemVolume } from './system';
import type { YouTubeController } from './youtube';
import type { MusicService } from './music';
import { decidePlayback, probe, type ProbeResult } from './ffmpeg';
import { findExternalSubtitles } from './filesystem';
import type { CastState, PlayerCommand, PlayTarget, RendererReport, SubtitleTrack } from '../../src/bridge';

export interface PlayerDeps {
  library: Library;
  torrents: TorrentEngine;
  server: MediaServer;
  volume: SystemVolume;
  youtube: YouTubeController;
  music: MusicService;
  send: (channel: 'player:load' | 'player:cmd' | 'cast:stop', payload?: unknown) => void;
  setFullscreen: (v?: boolean) => boolean;
  /** Catalog info attached to a torrent started from the catalog */
  torrentMeta?: (torrentId: string) => TorrentMeta | undefined;
}

const LANG: Record<string, string> = {
  rus: 'Русский',
  eng: 'English',
  ukr: 'Українська',
  srp: 'Српски',
  scc: 'Српски',
  hrv: 'Hrvatski',
  ger: 'Deutsch',
  deu: 'Deutsch',
  fre: 'Français',
  fra: 'Français',
  spa: 'Español',
  ita: 'Italiano',
  jpn: '日本語',
  kor: '한국어',
  chi: '中文',
  zho: '中文',
  pol: 'Polski',
};

const trackLabel = (t: { lang?: string; title?: string; channels?: string }, i: number) => {
  const parts = [t.title, t.lang ? LANG[t.lang] || t.lang.toUpperCase() : undefined].filter(Boolean);
  const base = parts.length ? Array.from(new Set(parts)).join(' · ') : `Дорожка ${i + 1}`;
  return t.channels && /5\.1|7\.1/.test(t.channels) ? `${base} (${t.channels.replace(/\(.*\)/, '')})` : base;
};

const SHORT_LANG: Record<string, string> = { ru: 'rus', en: 'eng', uk: 'ukr', ua: 'ukr', sr: 'srp', de: 'ger', fr: 'fre', es: 'spa', it: 'ita', ja: 'jpn', ko: 'kor', zh: 'chi', pl: 'pol' };

/** "rus.forced" → "Русский · форсированные" (external subtitle file names). */
export function subtitleFileLabel(raw: string): string {
  const words = raw.split(/[.\s_-]+/).filter(Boolean);
  const nice = words.map((w) => {
    const k = w.toLowerCase();
    if (LANG[k]) return LANG[k];
    if (SHORT_LANG[k]) return LANG[SHORT_LANG[k]];
    if (k === 'forced') return 'форсированные';
    if (k === 'sdh' || k === 'cc') return 'для слабослышащих';
    return w;
  });
  return nice.join(' · ') || raw;
}

let keySeq = 1;
const newKey = () => `p${Date.now().toString(36)}${keySeq++}`;

/** Owns "what is playing": resolves requests, queue, progress, state for remotes. */
export class PlayerController extends EventEmitter {
  private target: PlayTarget | null = null;
  private request: PlayRequest | null = null;
  private queue: QueueItem[] = [];
  /** Previously played requests (for PREVIOUS) */
  private history: PlayRequest[] = [];
  /** Full list of the last QUEUE_SET (replayed with repeat=all) */
  private cycle: PlayRequest[] = [];
  private shuffle = false;
  private repeat: RepeatMode = 'off';
  private report: RendererReport | null = null;
  private cast: CastState = { active: false };
  private lastSave = 0;
  private lastEmit = 0;
  private emitTimer: NodeJS.Timeout | null = null;
  private fullscreen = true;
  private probeInfo: ProbeResult | null = null;

  constructor(private readonly d: PlayerDeps) {
    super();
    d.youtube.on('report', (r: RendererReport) => this.onReport(r));
    // YouTube TV switched videos by itself (the user picked one on the TV, autoplay, end screen)
    d.youtube.on('watch', (videoId: string, title: string, author: string) => {
      const t = this.target;
      if (t?.kind !== 'youtube') return;
      const changed = t.videoId !== videoId;
      t.videoId = videoId;
      t.title = title || (changed ? 'YouTube' : t.title);
      t.subtitle = author || undefined;
      t.poster = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      t.backdrop = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      if (changed) t.startAt = 0;
      if (changed && !title) {
        void youtubeTitle(`https://www.youtube.com/watch?v=${videoId}`).then((x) => {
          if (x && this.target === t && t.videoId === videoId) {
            t.title = x;
            this.emitState(true);
          }
        });
      }
      this.emitState(true);
    });
    d.youtube.on('browse', () => {
      const t = this.target;
      if (t?.kind !== 'youtube') return;
      t.videoId = undefined;
      t.title = 'YouTube';
      t.subtitle = 'Главная, подписки, плейлисты';
      t.poster = undefined;
      t.backdrop = undefined;
      this.emitState(true);
    });
    d.youtube.on('exit', () => {
      if (this.target?.kind === 'youtube') this.stop();
    });
  }

  /** Open YouTube TV on the home screen, a video or search results. */
  async openYoutube(opts: { videoId?: string; search?: string } = {}): Promise<{ ok: boolean; error?: string }> {
    if (this.target?.kind === 'youtube' && !opts.videoId) {
      if (opts.search) this.d.youtube.search(opts.search);
      else this.d.youtube.home();
      return { ok: true };
    }
    if (opts.videoId) return this.play({ source: 'youtube', url: `https://www.youtube.com/watch?v=${opts.videoId}` });
    if (this.cast.active) this.d.send('cast:stop');
    if (this.target?.mediaId && this.report?.duration) this.d.library.saveProgress(this.target.mediaId, this.report.position, this.report.duration, true);
    if (this.request) this.history.push(this.request);
    this.request = null;
    this.load({ key: newKey(), kind: 'youtube', source: 'youtube', title: 'YouTube', subtitle: 'Главная, подписки, плейлисты' });
    if (opts.search) this.d.youtube.search(opts.search);
    return { ok: true };
  }

  get youtubeOpen(): boolean {
    return this.target?.kind === 'youtube';
  }

  /** Send a command to whatever renders the current item. */
  private cmd(c: PlayerCommand): void {
    if (this.target?.kind === 'youtube') this.d.youtube.command(c);
    else this.d.send('player:cmd', c);
  }

  // ------------------------------------------------------------------ state
  state(): PlayerState {
    const vol = this.d.volume.state;
    const base: PlayerState = {
      ...EMPTY_PLAYER_STATE,
      volume: vol.volume,
      muted: vol.muted,
      fullscreen: this.fullscreen,
      queue: this.queue,
      repeat: this.repeat,
      hasPrevious: this.history.length > 0,
      hasNext: this.hasNext(),
      updatedAt: Date.now(),
    };
    if (this.cast.active) {
      return { ...base, source: 'webrtc', status: 'playing', title: this.cast.label || 'Трансляция', subtitle: 'Прямая трансляция' };
    }
    const t = this.target;
    if (!t) return base;
    const r = this.report && this.report.key === t.key ? this.report : null;
    const status: PlayerState['status'] = !r ? 'loading' : r.status === 'ended' ? 'paused' : r.status;
    return {
      ...base,
      source: t.source,
      status,
      title: t.title,
      subtitle: t.subtitle,
      poster: t.coverRef ?? t.poster,
      backdrop: t.coverRef ?? t.backdrop,
      mediaId: t.mediaId,
      duration: r?.duration || t.duration || 0,
      position: r?.position ?? t.startAt ?? 0,
      error: r?.error,
      subtitles: t.subtitles?.map((s) => ({ id: s.id, label: s.label })),
      subtitleId: r?.subtitleId ?? null,
      audioTracks: t.audioTracks,
      audioIndex: t.audioIndex,
      artist: t.artist,
      album: t.album,
    };
  }

  private emitState(force = false): void {
    const now = Date.now();
    if (force || now - this.lastEmit > 900) {
      this.lastEmit = now;
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.emit('state', this.state());
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => this.emitState(true), 900 - (now - this.lastEmit));
    }
  }

  /** A video / song from the media server is playing or buffering (not YouTube, not a picture). */
  private stalls = 0;
  private resumeTries = 0;
  /** when the current stream first played / when the user last jumped (seek, other track) */
  private playingSince = 0;
  private lastJumpAt = 0;
  private stallTimes: number[] = [];
  /** set by main: a notice on the TV and the remotes */
  notify?: (message: string, kind: 'info' | 'warning') => void;

  get mediaActive(): boolean {
    const t = this.target;
    const st = this.report?.status;
    return !!t && t.kind !== 'youtube' && t.kind !== 'image' && (st === 'playing' || st === 'loading');
  }

  get isPlaying(): boolean {
    return this.cast.active || (!!this.target && this.report?.status === 'playing');
  }

  // ------------------------------------------------------------------ renderer reports
  onReport(r: RendererReport): void {
    if (!this.target || r.key !== this.target.key) return;
    const prevStatus = this.report?.status;
    this.report = r;
    // stalls are written to the log (logs/tvbox.log): how the file was played tells why
    if (r.status === 'playing' && !this.playingSince) this.playingSince = Date.now();
    // a real stall: not the start of the stream, not right after a seek / track change
    const settled = this.playingSince > 0 && Date.now() - this.playingSince > 6000 && Date.now() - this.lastJumpAt > 8000;
    if (prevStatus === 'playing' && r.status === 'loading' && settled) {
      this.stalls++;
      const t = this.target;
      const how = t.url ? 'direct' : /[?&]copy=1/.test(t.transcode?.base || '') ? 'remux (video copied)' : 'full transcode';
      console.log(`[player] stall #${this.stalls} at ${Math.round(r.position)}s · ${how} · ${t.source} · ${t.title}`);
      // The PC converts the video slower than it plays: the picture stops every few seconds.
      // After a second stall within a minute, switch to the fastest conversion at 720p.
      const now = Date.now();
      this.stallTimes = [...this.stallTimes.filter((x) => now - x < 60_000), now];
      const base = t.transcode?.base || '';
      if (how === 'full transcode' && !/[?&]light=1/.test(base) && this.stallTimes.length >= 2) {
        console.log('[player] the TV cannot convert fast enough: lighter conversion (720p, fastest)');
        this.stallTimes = [];
        this.notify?.('Компьютер не успевает перекодировать это видео — включаю облегчённое качество (720p)', 'warning');
        this.load({ ...t, key: newKey(), url: undefined, transcode: { base: `${base}&light=1` }, subtitleId: r.subtitleId ?? null, startAt: r.position || t.startAt });
        return;
      }
    }

    if (r.needFallback) {
      if (this.target.fallback) {
        console.log('[player] switching to transcoding');
        this.load({ ...this.target, key: newKey(), url: undefined, transcode: this.target.fallback, fallback: undefined, subtitleId: r.subtitleId ?? null, startAt: r.position || this.target.startAt });
        return;
      }
      this.report = { ...r, status: 'error', error: r.error || 'Не удалось воспроизвести файл' };
    }
    if (r.needAudio !== undefined && this.probeInfo) {
      void this.restartWithAudio(r.needAudio, r.position);
      return;
    }
    if (this.target.mediaId && r.duration > 0 && (Date.now() - this.lastSave > 5000 || r.status !== 'playing')) {
      this.lastSave = Date.now();
      this.d.library.saveProgress(this.target.mediaId, r.position, r.duration, r.status !== 'playing');
    }
    if (r.status === 'ended') {
      // A converted stream that stops long before the end is a broken stream (the torrent stalled,
      // ffmpeg died), not the end of the film: continue from there instead of jumping to the next one.
      const dur = r.duration || this.target.duration || 0;
      if (this.target.transcode && dur > 60 && r.position < dur - 20 && this.resumeTries < 3) {
        this.resumeTries++;
        console.log(`[player] stream ended early at ${Math.round(r.position)}s of ${Math.round(dur)}s — resuming (${this.resumeTries})`);
        this.load({ ...this.target, key: newKey(), subtitleId: r.subtitleId ?? null, startAt: r.position });
        return;
      }
      void this.onEnded();
      return;
    }
    if (r.status === 'playing' && r.position > 0 && this.playingSince && Date.now() - this.playingSince > 30_000) this.resumeTries = 0;
    this.emitState(prevStatus !== r.status);
  }

  onCastState(s: CastState): void {
    this.cast = s;
    if (s.active && this.target) this.cmd({ type: 'pause' });
    this.emitState(true);
  }

  private async onEnded(): Promise<void> {
    const t = this.target;
    // YouTube shows its own end screen / autoplay: only move on if something is queued
    if (t?.kind === 'youtube' && !this.queue.length && !(this.repeat === 'all' && this.cycle.length)) return;
    if (t?.mediaId) {
      const dur = this.report?.duration || t.duration || 0;
      if (dur) this.d.library.saveProgress(t.mediaId, dur, dur, true);
    }
    if (this.repeat === 'one' && this.request) {
      await this.play(this.request, { keepHistory: true });
      return;
    }
    const r = await this.advance();
    if (!r.ok) this.stop();
  }

  /** Go to the next item: queue → repeat-all cycle → next episode. */
  private async advance(): Promise<{ ok: boolean; error?: string }> {
    if (!this.queue.length && this.repeat === 'all' && this.cycle.length) {
      const list = this.shuffle ? shuffled(this.cycle) : [...this.cycle];
      this.queue = await this.toQueue(list);
    }
    const next = this.queue.shift();
    if (next) return this.play(next.request);
    const ep = this.target?.mediaId ? this.d.library.nextEpisode(this.target.mediaId) : undefined;
    if (ep) return this.play({ source: 'local', mediaId: ep.id, startAt: 0 });
    // an episode of a season torrent (still downloading, so not in the library yet): the next file of the torrent
    const nextFile = this.nextTorrentEpisode();
    if (nextFile) return this.play(nextFile);
    return { ok: false, error: 'queue_empty' };
  }

  private nextCache: { key: string; v: boolean } | null = null;

  /** Is there something to go to with "next" (cheap: remembered per stream). */
  private hasNext(): boolean {
    if (this.queue.length || (this.repeat === 'all' && this.cycle.length)) return true;
    const t = this.target;
    if (!t || t.kind === 'youtube') return false;
    if (this.nextCache?.key === t.key) return this.nextCache.v;
    const v = !!(t.mediaId && this.d.library.nextEpisode(t.mediaId)) || !!this.nextTorrentEpisode();
    this.nextCache = { key: t.key, v };
    return v;
  }

  private nextTorrentEpisode(): PlayRequest | null {
    const req = this.request;
    if (req?.source !== 'torrent' || !req.torrentId) return null;
    const id = req.torrentId.toLowerCase();
    const files = this.d.torrents.playableFiles(id).filter((f) => mediaKindOfFile(f.name) === 'video');
    const curIdx = req.fileIndex ?? this.d.torrents.mainFileIndex(id);
    const cur = files.find((f) => f.index === curIdx);
    if (!cur) return null;
    const key = (name: string) => {
      const p = parseMediaName(name);
      return p.episode !== undefined ? (p.season ?? 1) * 10000 + p.episode : null;
    };
    const k = key(cur.name);
    if (k === null) return null;
    const next = files
      .map((f) => ({ f, k: key(f.name) }))
      .filter((x): x is { f: { index: number; name: string }; k: number } => x.k !== null && x.k > k)
      .sort((a, b) => a.k - b.k)[0];
    return next ? { source: 'torrent', torrentId: id, fileIndex: next.f.index } : null;
  }

  private async toQueue(list: PlayRequest[]): Promise<QueueItem[]> {
    return Promise.all(list.map(async (request) => ({ id: newKey(), title: await this.titleFor(request), request })));
  }

  private prefetchNext(): void {
    const next = this.queue[0]?.request;
    if (next?.source === 'music' && next.track) void this.d.music.ensureCached(next.track.sourceId, next.track.itemId).catch(() => undefined);
  }

  // ------------------------------------------------------------------ control
  async control(cmd: ControlCommand): Promise<{ ok: boolean; error?: string }> {
    switch (cmd.type) {
      case 'PLAY_SOURCE':
        return this.play(cmd.request);
      case 'QUEUE_ADD': {
        if (!this.target && !this.cast.active) return this.play(cmd.request);
        this.queue.push({ id: newKey(), title: await this.titleFor(cmd.request), request: cmd.request });
        this.emitState(true);
        if (this.queue.length === 1) this.prefetchNext();
        return { ok: true };
      }
      case 'QUEUE_SET': {
        const list = (cmd.requests || []).slice(0, 2000);
        if (!list.length) return { ok: false, error: 'empty' };
        this.shuffle = !!cmd.shuffle;
        this.cycle = list;
        let start = Math.min(Math.max(cmd.startIndex ?? 0, 0), list.length - 1);
        let order = list;
        if (this.shuffle) {
          const first = cmd.startIndex !== undefined ? list[start] : list[Math.floor(Math.random() * list.length)];
          order = [first, ...shuffled(list.filter((r) => r !== first))];
          start = 0;
        }
        this.queue = await this.toQueue(order.slice(start + 1));
        return this.play(order[start]);
      }
      case 'QUEUE_JUMP': {
        const idx = this.queue.findIndex((q) => q.id === cmd.id);
        if (idx < 0) return { ok: false, error: 'not_found' };
        const [item] = this.queue.splice(0, idx + 1).slice(-1);
        return this.play(item.request);
      }
      case 'QUEUE_MOVE': {
        const idx = this.queue.findIndex((q) => q.id === cmd.id);
        if (idx < 0) return { ok: false, error: 'not_found' };
        const [item] = this.queue.splice(idx, 1);
        this.queue.splice(Math.min(Math.max(cmd.to, 0), this.queue.length), 0, item);
        this.emitState(true);
        this.prefetchNext();
        return { ok: true };
      }
      case 'QUEUE_SHUFFLE':
        this.queue = shuffled(this.queue);
        this.shuffle = true;
        this.emitState(true);
        this.prefetchNext();
        return { ok: true };
      case 'REPEAT':
        this.repeat = cmd.mode === 'one' || cmd.mode === 'all' ? cmd.mode : 'off';
        this.emitState(true);
        return { ok: true };
      case 'PREVIOUS': {
        if ((this.report?.position ?? 0) > 5 || !this.history.length) {
          if (!this.target) return { ok: false, error: 'nothing' };
          this.cmd({ type: 'seek', position: 0 });
          return { ok: true };
        }
        const prev = this.history.pop()!;
        if (this.request) this.queue.unshift({ id: newKey(), title: await this.titleFor(this.request), request: this.request });
        return this.play(prev, { keepHistory: true });
      }
      case 'QUEUE_REMOVE':
        this.queue = this.queue.filter((q) => q.id !== cmd.id);
        this.emitState(true);
        return { ok: true };
      case 'QUEUE_CLEAR':
        this.queue = [];
        this.cycle = [];
        this.emitState(true);
        return { ok: true };
      case 'NEXT':
        return this.advance();
      case 'STOP':
        if (this.cast.active) this.d.send('cast:stop');
        this.stop();
        return { ok: true };
      case 'PLAY_PAUSE':
        if (this.cast.active) return { ok: true };
        this.cmd({ type: 'toggle' });
        return { ok: !!this.target };
      case 'PLAY':
        this.cmd({ type: 'play' });
        return { ok: true };
      case 'PAUSE':
        this.cmd({ type: 'pause' });
        return { ok: true };
      case 'SEEK':
        this.lastJumpAt = Date.now();
        this.cmd({ type: 'seek', position: Math.max(0, cmd.position) });
        return { ok: true };
      case 'SEEK_RELATIVE': {
        this.lastJumpAt = Date.now();
        const pos = (this.report?.position ?? 0) + cmd.delta;
        const dur = this.report?.duration || this.target?.duration || Infinity;
        this.cmd({ type: 'seek', position: Math.max(0, Math.min(dur - 1, pos)) });
        return { ok: true };
      }
      case 'SUBTITLES':
        this.lastJumpAt = Date.now();
        this.cmd({ type: 'subtitles', id: cmd.id });
        return { ok: true };
      case 'AUDIO_TRACK':
        this.lastJumpAt = Date.now();
        if (!this.target) return { ok: false };
        this.target.audioIndex = cmd.index;
        this.d.send('player:cmd', { type: 'audio', index: cmd.index } satisfies PlayerCommand);
        this.emitState(true);
        return { ok: true };
      case 'VOLUME':
        await this.d.volume.setVolume(cmd.volume);
        this.emitState(true);
        return { ok: true };
      case 'VOLUME_STEP': {
        const cur = this.d.volume.state.volume;
        await this.d.volume.setVolume(Math.round((cur + cmd.delta) * 100) / 100);
        this.emitState(true);
        return { ok: true };
      }
      case 'MUTE':
        await this.d.volume.setMuted(cmd.muted ?? !this.d.volume.state.muted);
        this.emitState(true);
        return { ok: true };
      case 'FULLSCREEN':
        this.fullscreen = this.d.setFullscreen(cmd.fullscreen);
        this.emitState(true);
        return { ok: true };
      default:
        return { ok: false, error: 'unknown_command' };
    }
  }

  stop(): void {
    const t = this.target;
    if (t?.mediaId && this.report && this.report.key === t.key && this.report.duration > 0) {
      this.d.library.saveProgress(t.mediaId, this.report.position, this.report.duration, true);
    }
    this.target = null;
    this.request = null;
    this.report = null;
    this.probeInfo = null;
    if (this.d.youtube.active) this.d.youtube.hide();
    this.d.send('player:load', null);
    this.emitState(true);
  }

  private load(t: PlayTarget): void {
    this.target = t;
    this.report = null;
    this.playingSince = 0;
    if (t.kind === 'youtube') this.d.youtube.play(t);
    else if (this.d.youtube.active) this.d.youtube.hide();
    this.d.send('player:load', t);
    this.emitState(true);
  }

  // ------------------------------------------------------------------ resolving requests
  async play(req: PlayRequest, opts: { keepHistory?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    try {
      if (this.cast.active) this.d.send('cast:stop');
      // save progress of what was playing
      if (this.target?.mediaId && this.report?.duration) this.d.library.saveProgress(this.target.mediaId, this.report.position, this.report.duration, true);
      const t = await this.resolve(req);
      if (!t) return { ok: false, error: 'not_found' };
      if (!opts.keepHistory && this.request && this.request !== req) {
        this.history.push(this.request);
        if (this.history.length > 100) this.history.shift();
      }
      this.request = req;
      this.load(t);
      this.prefetchNext();
      return { ok: true };
    } catch (e) {
      console.error('[player] resolve failed', e);
      return { ok: false, error: (e as Error).message || 'play_failed' };
    }
  }

  private async titleFor(req: PlayRequest): Promise<string> {
    if (req.source === 'music' && req.track) return req.track.artist ? `${req.track.title} · ${req.track.artist}` : req.track.title;
    if (req.title) return req.title;
    if (req.mediaId) return this.d.library.get(req.mediaId)?.title || 'Видео';
    if (req.path) return parseMediaName(path.basename(req.path)).title;
    if (req.source === 'youtube') return (await youtubeTitle(req.url || '')) || 'YouTube';
    return req.url || 'Видео';
  }

  private async resolve(req: PlayRequest): Promise<PlayTarget | null> {
    const key = newKey();
    if (req.source === 'youtube') {
      const list = extractYouTubeList(req.url || '') || undefined;
      let videoId = extractYouTubeId(req.url || '');
      let listTitle: string | null = null;
      if (!videoId && list) {
        // a playlist link without a video: its first video comes from YouTube's oEmbed thumbnail
        const first = await youtubePlaylistFirst(list);
        videoId = first?.videoId || null;
        listTitle = first?.title || null;
      }
      if (!videoId) throw new Error(list ? 'youtube_playlist_unavailable' : 'bad_youtube_link');
      const t: PlayTarget = {
        key,
        kind: 'youtube',
        source: 'youtube',
        videoId,
        list,
        listIndex: list ? extractYouTubeIndex(req.url || '') : undefined,
        title: req.title || listTitle || 'YouTube',
        subtitle: list ? 'Плейлист' : undefined,
        poster: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        backdrop: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        startAt: req.startAt ?? extractYouTubeStart(req.url || ''),
      };
      if (!req.title && !listTitle)
        void youtubeTitle(req.url || '').then((title) => {
          if (title && this.target?.key === key) {
            this.target.title = title;
            this.emitState(true);
          }
        });
      return t;
    }

    if (req.source === 'music') {
      const tr = req.track;
      if (!tr) throw new Error('bad_track');
      const base = this.d.server.base;
      const cover = tr.cover ? `${base}/music-cover?s=${encodeURIComponent(tr.sourceId)}&c=${encodeURIComponent(tr.cover)}` : undefined;
      return {
        key,
        kind: 'audio',
        source: 'music',
        url: `${base}/music?s=${encodeURIComponent(tr.sourceId)}&i=${encodeURIComponent(tr.itemId)}`,
        title: tr.title,
        subtitle: [tr.artist, tr.album].filter(Boolean).join(' — ') || undefined,
        artist: tr.artist,
        album: tr.album,
        poster: cover,
        backdrop: cover,
        coverRef: tr.cover ? `music-cover:${tr.sourceId}:${tr.cover}` : undefined,
        duration: tr.duration,
        startAt: req.startAt,
      };
    }

    if (req.source === 'url') {
      const url = req.url || '';
      const kind = mediaKindOfFile(url.split('?')[0]) || 'video';
      return {
        key,
        kind: kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : 'video',
        source: 'url',
        url,
        title: req.title || decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'Видео'),
        fallback: { base: this.d.server.transcodeUrl(url, { copy: false }) },
        startAt: req.startAt,
      };
    }

    let item: MediaItem | undefined;
    let filePath: string | null = null;
    let input: string | null = null; // what ffmpeg / the player reads
    let source: PlayTarget['source'] = 'local';
    let title = req.title || '';
    let meta: TorrentMeta | undefined;
    let metaSubtitle: string | undefined;

    if (req.source === 'torrent' && req.torrentId) {
      const id = req.torrentId.toLowerCase();
      const idx = req.fileIndex ?? this.d.torrents.mainFileIndex(id);
      if (idx === undefined || !this.d.torrents.has(id)) throw new Error('torrent_not_ready');
      const fp = this.d.torrents.filePath(id, idx);
      const name = this.d.torrents.fileName(id, idx) || '';
      const parsed = parseMediaName(name);
      title = parsed.title || title;
      meta = this.d.torrentMeta?.(id);
      if (meta) {
        title = meta.title;
        if (meta.type === 'tv' && parsed.episode !== undefined) metaSubtitle = `S${String(parsed.season ?? 1).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}`;
      }
      if (fp && this.d.torrents.isComplete(id, idx) && fs.existsSync(fp)) {
        filePath = fp;
        input = fp;
        item = this.d.library.addFile(fp, { origin: 'torrent', torrentId: id }) || undefined;
      } else {
        input = this.d.server.torrentUrl(id, idx);
        source = 'torrent';
        filePath = name;
      }
    } else if (req.mediaId) {
      item = this.d.library.get(req.mediaId);
      if (!item) throw new Error('not_found');
      filePath = item.path;
      input = item.path;
    } else if (req.path) {
      filePath = req.path;
      input = req.path;
      item = this.d.library.list().find((m) => path.resolve(m.path).toLowerCase() === path.resolve(req.path!).toLowerCase());
    }
    if (!input || !filePath) return null;
    if (source === 'local' && !fs.existsSync(input)) throw new Error('file_missing');

    const fileKind = mediaKindOfFile(filePath);
    if (item && !(meta && !item.tmdbId)) {
      title = item.title;
    } else if (!title) {
      title = parseMediaName(path.basename(filePath)).title;
    }
    const subtitle = item?.kind === 'episode' && item.tmdbId ? episodeLabel(item) : metaSubtitle ?? (item?.kind === 'episode' ? episodeLabel(item) : undefined);
    const progress = item ? this.d.library.getProgress(item.id) : undefined;
    let startAt = req.startAt;
    if (startAt === undefined && progress && progress.position > 30 && progress.position < progress.duration * 0.92) startAt = progress.position;

    const isHttp = /^https?:/.test(input);
    const directUrl = isHttp ? input : this.d.server.fileUrl(input);

    if (fileKind === 'image') {
      return { key, kind: 'image', source, url: directUrl, title, mediaId: item?.id };
    }

    const info = await probe(input, isHttp ? 45000 : 20000);
    this.probeInfo = info;
    const decision = decidePlayback(info, filePath);
    this.stalls = 0;
    this.resumeTries = 0;
    console.log(
      `[player] ${path.basename(filePath)} · ${source}${source === 'torrent' ? ' (not fully downloaded)' : ''} · ${info?.container || '?'} ${info?.video[0]?.codec || '-'}/${info?.audio[0]?.codec || '-'} · ${decision.direct ? 'direct' : decision.copyVideo ? 'remux' : 'transcode'}${decision.reason ? ` (${decision.reason})` : ''}`,
    );
    const vcodec = info?.video[0]?.codec;
    const audioTracks = (info?.audio || []).map((a, i) => ({ index: i, label: trackLabel(a, i) }));
    const audioIndex = 0;
    const transcode = { base: this.d.server.transcodeUrl(input, { copy: decision.copyVideo, vcodec, audio: audioIndex }) };
    const fallback = { base: this.d.server.transcodeUrl(input, { copy: false, audio: audioIndex }) };

    // Subtitles: embedded text tracks + external .srt/.vtt files next to the video
    const subtitles: SubtitleTrack[] = [];
    for (const s of info?.subtitles || []) {
      subtitles.push({ id: `e${s.index}`, label: trackLabel(s, s.index), url: this.d.server.subsUrl(input, { sub: s.index }) });
    }
    if (!isHttp) {
      for (const [i, ext] of findExternalSubtitles(input).entries()) {
        subtitles.push({ id: `x${i}`, label: subtitleFileLabel(ext.label), url: this.d.server.subsUrl(input, { ext: ext.path }) });
      }
    }

    return {
      key,
      kind: fileKind === 'audio' || (info && !info.video.length) ? 'audio' : 'video',
      source,
      title,
      subtitle,
      poster: item?.poster || meta?.poster,
      backdrop: item?.backdrop || meta?.backdrop,
      mediaId: item?.id,
      url: decision.direct ? directUrl : undefined,
      transcode: decision.direct ? undefined : transcode,
      fallback: decision.direct ? (decision.copyVideo && vcodec !== 'hevc' ? transcode : fallback) : decision.copyVideo ? fallback : undefined,
      duration: info?.duration || item?.duration,
      startAt,
      subtitles,
      audioTracks: audioTracks.length > 1 ? audioTracks : undefined,
      audioIndex,
    };
  }

  /**
   * Another audio track: the stream is restarted with that track, in the same way the picture was
   * playing so far. A video that had to be converted (HEVC the graphics card can't show, old codecs)
   * stays converted — copying it again gave a black screen with sound.
   */
  private async restartWithAudio(index: number, position: number): Promise<void> {
    const t = this.target;
    const info = this.probeInfo;
    if (!t || !info) return;
    const withAudio = (base: string) => {
      const u = new URL(base);
      u.searchParams.set('audio', String(index));
      u.searchParams.delete('start');
      return u.toString();
    };
    const current = t.transcode?.base;
    const anyBase = current || t.fallback?.base;
    const input = anyBase ? new URL(anyBase).searchParams.get('src') : null;
    if (!input) return;
    const vcodec = info.video[0]?.codec;
    const full = this.d.server.transcodeUrl(input, { copy: false, audio: index });
    let base: string;
    let fallback: string | undefined;
    if (current) {
      // keep the current way: copied video stays copied, converted stays converted (and light stays light)
      base = withAudio(current);
      fallback = /[?&]copy=1/.test(current) ? full : undefined;
    } else {
      // it played directly: the picture decodes fine, so it can be copied with the other audio
      const copyable = !!vcodec && ['h264', 'hevc'].includes(vcodec);
      base = copyable ? this.d.server.transcodeUrl(input, { copy: true, vcodec, audio: index }) : full;
      fallback = copyable ? full : undefined;
    }
    console.log(`[player] audio track ${index + 1}: ${/[?&]copy=1/.test(base) ? 'video copied' : 'video converted'}${/light=1/.test(base) ? ' (light)' : ''}`);
    this.load({
      ...t,
      key: newKey(),
      url: undefined,
      transcode: { base },
      fallback: fallback ? { base: fallback } : undefined,
      startAt: position,
      audioIndex: index,
      subtitleId: this.report?.subtitleId ?? null,
    });
  }


  /** Torrent finished buffering a file with play:true → start it. */
  async autoplayTorrent(torrentId: string, fileIndex: number): Promise<void> {
    await this.play({ source: 'torrent', torrentId, fileIndex });
  }

  currentTorrentFile(): { torrentId: string; fileIndex?: number } | null {
    return this.request?.source === 'torrent' && this.request.torrentId ? { torrentId: this.request.torrentId, fileIndex: this.request.fileIndex } : null;
  }
}

function shuffled<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function episodeLabel(m: MediaItem): string {
  const se = `S${String(m.season ?? 1).padStart(2, '0')}E${String(m.episode ?? 0).padStart(2, '0')}`;
  return m.episodeTitle ? `${se} · ${m.episodeTitle}` : se;
}

/** First video and title of a YouTube playlist (oEmbed returns the first video's thumbnail). */
async function youtubePlaylistFirst(list: string): Promise<{ videoId: string; title: string } | null> {
  try {
    // Chromium's network stack: goes through the system proxy like YouTube itself
    const res = await net.fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/playlist?list=${list}`)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { title?: string; thumbnail_url?: string };
    const id = /\/vi\/([A-Za-z0-9_-]{11})\//.exec(j.thumbnail_url || '')?.[1];
    return id ? { videoId: id, title: j.title || 'Плейлист' } : null;
  } catch {
    return null;
  }
}

async function youtubeTitle(url: string): Promise<string | null> {
  try {
    const id = extractYouTubeId(url);
    if (!id) return null;
    const res = await net.fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { title?: string }).title || null;
  } catch {
    return null;
  }
}
