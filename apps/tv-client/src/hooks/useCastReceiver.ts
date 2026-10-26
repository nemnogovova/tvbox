import { useEffect, useRef, useState } from 'react';
import { Events, type SignalMessage } from '@tvbox/shared';

export interface CastView {
  active: boolean;
  label: string;
  stream: MediaStream | null;
  hasVideo: boolean;
  image: string | null;
  receiving: number | null;
}

const EMPTY: CastView = { active: false, label: '', stream: null, hasVideo: false, image: null, receiving: null };

/** Receives WebRTC casts (screen / camera / file stream / photos over a data channel). */
export function useCastReceiver(): CastView {
  const [view, setView] = useState<CastView>(EMPTY);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sess = useRef<{ sid: string; peer: string } | null>(null);
  const pending = useRef<RTCIceCandidateInit[]>([]);
  const remoteSet = useRef(false);
  const imageUrl = useRef<string | null>(null);

  useEffect(() => {
    const send = (event: string, msg: SignalMessage) => window.tvbox.signal(event, msg);

    const close = (notifyPeer: boolean) => {
      const s = sess.current;
      if (notifyPeer && s) send(Events.WEBRTC_LEAVE, { to: s.peer, sid: s.sid });
      try {
        pcRef.current?.close();
      } catch {
        // ignore
      }
      pcRef.current = null;
      sess.current = null;
      pending.current = [];
      remoteSet.current = false;
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = null;
      setView(EMPTY);
      window.tvbox.castState({ active: false });
    };

    const onOffer = async (msg: SignalMessage) => {
      if (!msg.from || !msg.payload) return;
      close(true);
      sess.current = { sid: msg.sid, peer: msg.from };
      const label = msg.label || 'Трансляция';
      const iceServers = (await window.tvbox.getIceServers()) as RTCIceServer[];
      if (sess.current?.sid !== msg.sid) return;
      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;

      const stream = new MediaStream();
      pc.ontrack = (e) => {
        stream.addTrack(e.track);
        setView((v) => ({ ...v, active: true, label, stream, hasVideo: v.hasVideo || e.track.kind === 'video' }));
        window.tvbox.castState({ active: true, label, kind: 'stream' });
      };
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        dc.binaryType = 'arraybuffer';
        let chunks: ArrayBuffer[] = [];
        let meta: { name: string; type: string; size: number } | null = null;
        let got = 0;
        dc.onmessage = (m) => {
          if (typeof m.data === 'string') {
            const j = JSON.parse(m.data) as { t: string; name?: string; type?: string; size?: number };
            if (j.t === 'begin') {
              meta = { name: j.name || 'photo', type: j.type || 'image/jpeg', size: j.size || 0 };
              chunks = [];
              got = 0;
              setView((v) => ({ ...v, active: true, label: meta!.name, receiving: 0 }));
            } else if (j.t === 'end' && meta) {
              const blob = new Blob(chunks, { type: meta.type });
              if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
              imageUrl.current = URL.createObjectURL(blob);
              const name = meta.name;
              setView((v) => ({ ...v, active: true, label: name, image: imageUrl.current, receiving: null }));
              window.tvbox.castState({ active: true, label: name, kind: 'image' });
              chunks = [];
            }
          } else {
            chunks.push(m.data as ArrayBuffer);
            got += (m.data as ArrayBuffer).byteLength;
            if (meta?.size) setView((v) => ({ ...v, receiving: got / meta!.size }));
          }
        };
      };
      pc.onicecandidate = (e) => {
        if (e.candidate && sess.current) send(Events.WEBRTC_ICE, { to: sess.current.peer, sid: sess.current.sid, payload: e.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          if (pcRef.current === pc) close(false);
        }
      };
      try {
        await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
        remoteSet.current = true;
        for (const c of pending.current.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send(Events.WEBRTC_ANSWER, { to: msg.from, sid: msg.sid, payload: pc.localDescription?.toJSON() });
      } catch (e) {
        console.error('[cast] answer failed', e);
        close(true);
      }
    };

    const offSignal = window.tvbox.onSignal(({ event, msg }) => {
      if (event === Events.WEBRTC_OFFER) void onOffer(msg);
      else if (!sess.current || msg.sid !== sess.current.sid) return;
      else if (event === Events.WEBRTC_ICE && msg.payload) {
        const c = msg.payload as RTCIceCandidateInit;
        if (remoteSet.current) void pcRef.current?.addIceCandidate(c).catch(() => undefined);
        else pending.current.push(c);
      } else if (event === Events.WEBRTC_LEAVE) close(false);
    });
    const offStop = window.tvbox.onCastStop(() => close(true));
    return () => {
      offSignal();
      offStop();
      close(true);
    };
  }, []);

  return view;
}
