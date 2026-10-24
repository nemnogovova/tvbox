import type { Socket } from 'socket.io-client';
import { Events } from '@tvbox/shared';

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

export interface ActiveCast {
  kind: 'file' | 'screen' | 'webcam';
  label: string;
  close: () => void;
}

interface SignalMessage {
  from: string;
  to: string;
  kind: 'offer' | 'answer' | 'ice' | 'leave';
  payload: unknown;
}

function startCast(socket: Socket, stream: MediaStream, kind: ActiveCast['kind'], label: string): ActiveCast {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  const onAnswer = (msg: SignalMessage) => {
    if (msg.kind === 'answer' && msg.payload) {
      pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit).catch(() => {});
    }
  };
  const onIce = (msg: SignalMessage) => {
    if (msg.kind === 'ice' && msg.payload) {
      pc.addIceCandidate(msg.payload as RTCIceCandidateInit).catch(() => {});
    }
  };
  socket.on(Events.WEBRTC_ANSWER, onAnswer);
  socket.on(Events.WEBRTC_ICE, onIce);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit(Events.WEBRTC_ICE, { to: 'tv', kind: 'ice', payload: e.candidate.toJSON() });
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      // let it try to recover
    }
  };

  pc.createOffer()
    .then((o) => pc.setLocalDescription(o))
    .then(() => {
      socket.emit(Events.WEBRTC_OFFER, { to: 'tv', kind: 'offer', payload: pc.localDescription });
    })
    .catch(() => {});

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stream.getTracks().forEach((t) => t.stop());
    pc.close();
    socket.off(Events.WEBRTC_ANSWER, onAnswer);
    socket.off(Events.WEBRTC_ICE, onIce);
    socket.emit(Events.WEBRTC_LEAVE, { to: 'tv', kind: 'leave' });
  };

  return { kind, label, close };
}

function mediaElementStream(url: string, file: File): MediaStream {
  type Capture = { captureStream(): MediaStream };
  const type = file.type;
  if (type.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.play().catch(() => {});
    return (video as unknown as Capture).captureStream();
  }
  const audio = document.createElement('audio');
  audio.src = url;
  audio.loop = true;
  audio.play().catch(() => {});
  return (audio as unknown as Capture).captureStream();
}

export async function castFile(socket: Socket, file: File): Promise<ActiveCast> {
  if (file.type.startsWith('image/')) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('Failed to load image'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 1280;
    canvas.height = img.naturalHeight || 720;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const stream = canvas.captureStream(1);
    const timer = setInterval(() => ctx.drawImage(img, 0, 0), 500);
    const cast = startCast(socket, stream, 'file', file.name);
    const originalClose = cast.close;
    cast.close = () => {
      clearInterval(timer);
      URL.revokeObjectURL(url);
      originalClose();
    };
    return cast;
  }

  const url = URL.createObjectURL(file);
  const stream = mediaElementStream(url, file);
  const cast = startCast(socket, stream, 'file', file.name);
  const originalClose = cast.close;
  cast.close = () => {
    URL.revokeObjectURL(url);
    originalClose();
  };
  return cast;
}

export async function castScreen(socket: Socket): Promise<ActiveCast> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });
  return startCast(socket, stream, 'screen', 'Screen share');
}

export async function castWebcam(socket: Socket): Promise<ActiveCast> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
  });
  return startCast(socket, stream, 'webcam', 'Camera');
}
