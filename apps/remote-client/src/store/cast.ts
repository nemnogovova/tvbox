import { create } from 'zustand';
import { castCamera, castFile, castScreen, type CastSession, type CastStatus } from '../lib/cast';
import { toast } from './store';

interface CastState {
  session: CastSession | null;
  status: CastStatus | null;
  busy: boolean;
}

export const useCast = create<CastState>(() => ({ session: null, status: null, busy: false }));

let unsub: (() => void) | null = null;

async function run(fn: () => Promise<CastSession>): Promise<void> {
  useCast.setState({ busy: true });
  try {
    const session = await fn();
    unsub?.();
    unsub = session.subscribe((status) => {
      useCast.setState({ status });
      if (status === 'failed') toast('Не удалось установить соединение с ТВ', 'error');
      if (status === 'ended' || status === 'failed') setTimeout(() => {
        if (useCast.getState().session === session) useCast.setState({ session: null, status: null });
      }, 300);
    });
    useCast.setState({ session, status: session.status, busy: false });
  } catch (e) {
    useCast.setState({ busy: false });
    const msg = e instanceof Error ? e.message : String(e);
    if (!/Permission|NotAllowed|denied|abort/i.test(msg)) toast(msg || 'Не удалось начать трансляцию', 'error');
  }
}

export const startScreenCast = () => run(castScreen);
export const startCameraCast = (facing?: 'user' | 'environment') => run(() => castCamera(facing));
export const startFileCast = (file: File) => {
  const cur = useCast.getState().session;
  // more photos go into the same image session
  if (cur?.kind === 'image' && cur.sendImage && file.type.startsWith('image/')) {
    void cur
      .sendImage(file)
      .then(() => useCast.setState({ session: cur }))
      .catch((e: unknown) => toast(`Фото не отправилось: ${e instanceof Error ? e.message : String(e)}`, 'error'));
    return Promise.resolve();
  }
  return run(() => castFile(file));
};
export const stopCast = () => {
  useCast.getState().session?.stop();
};
