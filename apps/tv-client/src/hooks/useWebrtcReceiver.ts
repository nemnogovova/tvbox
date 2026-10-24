import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { SignalMessage } from '@tvbox/shared';

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

export function useWebrtcReceiver(): { stream: MediaStream | null; active: boolean; stop: () => void } {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [active, setActive] = useState(false);

  const stop = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    setStream(null);
    setActive(false);
  }, []);

  useEffect(() => {
    const off = window.tvbox.onSignal(({ event, msg }) => {
      if (event === 'webrtc:offer' && msg.kind === 'offer') {
        void handleOffer(msg, pcRef, setStream, setActive);
      } else if (event === 'webrtc:ice' && msg.kind === 'ice') {
        pcRef.current?.addIceCandidate(msg.payload as RTCIceCandidateInit).catch(() => {});
      } else if (event === 'webrtc:leave') {
        stop();
      }
    });
    return off;
  }, [stop]);

  return { stream, active, stop };
}

async function handleOffer(
  msg: SignalMessage,
  pcRef: MutableRefObject<RTCPeerConnection | null>,
  setStream: (s: MediaStream | null) => void,
  setActive: (a: boolean) => void,
): Promise<void> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pcRef.current = pc;

  const remoteStream = new MediaStream();
  let gotTrack = false;
  pc.ontrack = (e) => {
    remoteStream.addTrack(e.track);
    if (!gotTrack) {
      gotTrack = true;
      setStream(remoteStream);
      setActive(true);
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      window.tvbox.signalReply('webrtc:ice', {
        from: 'tv',
        to: msg.from,
        kind: 'ice',
        payload: e.candidate.toJSON(),
      });
    }
  };

  try {
    await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    window.tvbox.signalReply('webrtc:answer', {
      from: 'tv',
      to: msg.from,
      kind: 'answer',
      payload: pc.localDescription,
    });
  } catch (e) {
    console.error('[tv-client] webrtc answer failed', e);
    pc.close();
    pcRef.current = null;
  }
}
