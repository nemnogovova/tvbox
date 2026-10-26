import { Events, type SignalMessage } from '@tvbox/shared';
import { getSocket, useStore } from '../store/store';
import { getToken } from './config';

export type CastKind = 'file' | 'screen' | 'camera' | 'image';
export type CastStatus = 'connecting' | 'live' | 'failed' | 'ended';

export interface CastSession {
  sid: string;
  kind: CastKind;
  label: string;
  status: CastStatus;
  /** Local media element for file casts (rendered with controls on the cast page) */
  media?: HTMLVideoElement | HTMLAudioElement;
  sendImage?: (file: File) => Promise<void>;
  stop: () => void;
  subscribe: (cb: (s: CastStatus) => void) => () => void;
}

let iceCache: { at: number; servers: RTCIceServer[] } | null = null;

async function iceServers(): Promise<RTCIceServer[]> {
  if (iceCache && Date.now() - iceCache.at < 10 * 60 * 1000) return iceCache.servers;
  const fallback: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
  try {
    const res = await fetch(`${useStore.getState().serverUrl}/api/ice`, {
      headers: { Authorization: `Bearer ${getToken() || ''}` },
    });
    const body = (await res.json()) as { ok: boolean; iceServers?: RTCIceServer[] };
    const servers = body.ok && body.iceServers?.length ? body.iceServers : fallback;
    iceCache = { at: Date.now(), servers };
    return servers;
  } catch {
    return fallback;
  }
}

const newSid = () => Math.random().toString(36).slice(2, 10);

let active: CastSession | null = null;
export const getActiveCast = () => active;

interface PeerOptions {
  kind: CastKind;
  label: string;
  stream?: MediaStream;
  dataChannel?: boolean;
  onCleanup?: () => void;
}

async function startPeer(opts: PeerOptions): Promise<CastSession & { dc?: RTCDataChannel }> {
  const socket = getSocket();
  if (!socket?.connected) throw new Error('Нет связи с сервером');
  if (!useStore.getState().presence.tvConnected) throw new Error('Телевизор не в сети');

  active?.stop();

  const sid = newSid();
  const pc = new RTCPeerConnection({ iceServers: await iceServers() });
  const listeners = new Set<(s: CastStatus) => void>();
  let dc: RTCDataChannel | undefined;

  const session: CastSession & { dc?: RTCDataChannel } = {
    sid,
    kind: opts.kind,
    label: opts.label,
    status: 'connecting',
    stop: () => finish('ended', true),
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  const setStatus = (s: CastStatus) => {
    if (session.status === s) return;
    session.status = s;
    listeners.forEach((cb) => cb(s));
  };

  const send = (event: string, payload?: unknown) => {
    const msg: SignalMessage = { to: 'tv', sid, payload, label: opts.label };
    socket.emit(event, msg);
  };

  if (opts.stream) {
    for (const track of opts.stream.getTracks()) {
      if (track.kind === 'video') track.contentHint = opts.kind === 'screen' ? 'detail' : 'motion';
      const sender = pc.addTrack(track, opts.stream);
      if (track.kind === 'video') {
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = opts.kind === 'screen' ? 6_000_000 : 8_000_000;
        params.degradationPreference = opts.kind === 'screen' ? 'maintain-resolution' : 'balanced';
        void sender.setParameters(params).catch(() => {});
      }
    }
    opts.stream.getVideoTracks().forEach((t) => (t.onended = () => finish('ended', true)));
  }
  if (opts.dataChannel) {
    dc = pc.createDataChannel('image', { ordered: true });
    session.dc = dc;
  }

  const pendingIce: RTCIceCandidateInit[] = [];
  let remoteSet = false;

  const onAnswer = async (m: SignalMessage) => {
    if (m.sid !== sid || !m.payload) return;
    try {
      await pc.setRemoteDescription(m.payload as RTCSessionDescriptionInit);
      remoteSet = true;
      for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } catch {
      finish('failed', true);
    }
  };
  const onIce = (m: SignalMessage) => {
    if (m.sid !== sid || !m.payload) return;
    const c = m.payload as RTCIceCandidateInit;
    if (remoteSet) void pc.addIceCandidate(c).catch(() => {});
    else pendingIce.push(c);
  };
  const onLeave = (m: SignalMessage) => {
    if (m.sid === sid) finish('ended', false);
  };
  socket.on(Events.WEBRTC_ANSWER, onAnswer);
  socket.on(Events.WEBRTC_ICE, onIce);
  socket.on(Events.WEBRTC_LEAVE, onLeave);

  pc.onicecandidate = (e) => e.candidate && send(Events.WEBRTC_ICE, e.candidate.toJSON());
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus('live');
    else if (pc.connectionState === 'failed') finish('failed', true);
  };

  const timeout = setTimeout(() => {
    if (session.status === 'connecting') finish('failed', true);
  }, 25000);

  let done = false;
  function finish(status: CastStatus, notify: boolean) {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    socket!.off(Events.WEBRTC_ANSWER, onAnswer);
    socket!.off(Events.WEBRTC_ICE, onIce);
    socket!.off(Events.WEBRTC_LEAVE, onLeave);
    if (notify) send(Events.WEBRTC_LEAVE);
    opts.stream?.getTracks().forEach((t) => t.stop());
    try {
      pc.close();
    } catch {
      // ignore
    }
    opts.onCleanup?.();
    setStatus(status);
    if (active === session) active = null;
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send(Events.WEBRTC_OFFER, pc.localDescription?.toJSON());
  active = session;
  return session;
}

// ---------------------------------------------------------------------------

export async function castScreen(): Promise<CastSession> {
  if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    throw new Error('Демонстрация экрана недоступна на этом устройстве');
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 60 } },
    audio: true,
  });
  return startPeer({ kind: 'screen', label: 'Экран', stream });
}

export async function castCamera(facing: 'user' | 'environment' = 'environment'): Promise<CastSession> {
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') throw new Error('Камера недоступна');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: true,
  });
  return startPeer({ kind: 'camera', label: 'Камера', stream });
}

/** Stream a local video/audio file. The returned session exposes the media element for local controls. */
export async function castMediaFile(file: File): Promise<CastSession> {
  const isVideo = file.type.startsWith('video/') || /\.(mp4|m4v|webm|mkv|mov)$/i.test(file.name);
  const url = URL.createObjectURL(file);
  const el = document.createElement(isVideo ? 'video' : 'audio') as HTMLVideoElement;
  el.src = url;
  el.playsInline = true;
  el.preload = 'auto';
  el.controls = true;

  if (typeof (el as unknown as { captureStream?: unknown }).captureStream !== 'function') {
    URL.revokeObjectURL(url);
    throw new Error('Этот браузер не умеет транслировать файлы. Используйте Chrome.');
  }

  // Audio goes only to the WebRTC stream (not to the local speakers).
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ac = new AC();
  const src = ac.createMediaElementSource(el);
  const dest = ac.createMediaStreamDestination();
  src.connect(dest);

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Файл не открывается')), 15000);
    el.addEventListener('loadedmetadata', () => (clearTimeout(t), resolve()), { once: true });
    el.addEventListener('error', () => (clearTimeout(t), reject(new Error('Формат файла не поддерживается браузером'))), { once: true });
    el.load();
  });
  await ac.resume().catch(() => {});
  await el.play().catch(() => {});

  const cap = (el as unknown as { captureStream: () => MediaStream }).captureStream();
  for (let i = 0; i < 40 && isVideo && cap.getVideoTracks().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  const stream = new MediaStream([...cap.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  // captureStream's video tracks must not be stopped by the "ended" hook when the element is paused
  stream.getVideoTracks().forEach((t) => (t.onended = null));

  const session = await startPeer({
    kind: 'file',
    label: file.name,
    stream,
    onCleanup: () => {
      el.pause();
      el.removeAttribute('src');
      el.load();
      void ac.close().catch(() => {});
      URL.revokeObjectURL(url);
    },
  });
  session.media = el;
  return session;
}

/** Send photos losslessly over a WebRTC data channel (P2P). */
export async function castImages(first: File): Promise<CastSession> {
  const session = await startPeer({ kind: 'image', label: first.name, dataChannel: true });
  const dc = session.dc!;
  const opened = new Promise<void>((resolve, reject) => {
    if (dc.readyState === 'open') return resolve();
    dc.onopen = () => resolve();
    dc.onerror = () => reject(new Error('Канал не открылся'));
    setTimeout(() => reject(new Error('Телевизор не ответил')), 25000);
  });

  const sendImage = async (file: File) => {
    await opened;
    const buf = await file.arrayBuffer();
    dc.send(JSON.stringify({ t: 'begin', name: file.name, type: file.type || 'image/jpeg', size: buf.byteLength }));
    const CHUNK = 16 * 1024;
    dc.bufferedAmountLowThreshold = 1024 * 1024;
    for (let off = 0; off < buf.byteLength; off += CHUNK) {
      if (dc.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise<void>((r) => dc.addEventListener('bufferedamountlow', () => r(), { once: true }));
      }
      dc.send(buf.slice(off, off + CHUNK));
    }
    dc.send(JSON.stringify({ t: 'end' }));
    session.label = file.name;
  };
  session.sendImage = sendImage;
  void sendImage(first).catch(() => session.stop());
  return session;
}

export async function castFile(file: File): Promise<CastSession> {
  if (file.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(file.name)) {
    const cur = active;
    if (cur?.kind === 'image' && cur.status !== 'ended' && cur.sendImage) {
      await cur.sendImage(file);
      return cur;
    }
    return castImages(file);
  }
  return castMediaFile(file);
}
