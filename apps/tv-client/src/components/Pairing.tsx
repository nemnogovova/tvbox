import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Server, WifiOff } from 'lucide-react';
import type { TvStatus } from '../bridge';
import { Ambient, useNow } from './Home';

export function Pairing({ status }: { status: TvStatus }) {
  const [qr, setQr] = useState('');
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(status.serverUrl);
  const now = useNow();
  const p = status.pairing;

  useEffect(() => {
    if (!p) return;
    void QRCode.toDataURL(p.url, { margin: 1, width: 640, color: { dark: '#0b0c10', light: '#ffffff' } }).then(setQr);
  }, [p?.url]);

  const left = p ? Math.max(0, Math.round((p.expiresAt - now.getTime()) / 1000)) : 0;
  let host = status.serverUrl;
  try {
    host = new URL(status.serverUrl).host;
  } catch {
    // keep
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <Ambient />
      <div className="relative grid w-[84vw] animate-rise grid-cols-[1.15fr_1fr] items-center gap-[6vw]">
        <div>
          <div className="flex items-center gap-4">
            <img src="./icon.svg" alt="" className="h-[4.5rem] w-[4.5rem]" />
            <span className="text-[2rem] font-extrabold tracking-tight">TVBox</span>
          </div>
          <h1 className="mt-[5vh] text-[4.2rem] font-extrabold leading-[1.05] tracking-tight">Подключите телевизор к пульту</h1>
          <ol className="mt-[5vh] space-y-[2.4vh] text-[1.7rem] text-fg-muted">
            <li className="flex gap-5">
              <Step n={1} /> Наведите камеру телефона на QR-код
            </li>
            <li className="flex gap-5">
              <Step n={2} /> Войдите аккаунтом Google владельца
            </li>
            <li className="flex gap-5">
              <Step n={3} /> Нажмите «Подключить» — готово
            </li>
          </ol>
          <div className="mt-[5vh] flex items-center gap-3 text-[1.2rem] text-fg-dim">
            <Server size={20} />
            {editing ? (
              <form
                className="flex gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void window.tvbox.setServerUrl(url).then(() => setEditing(false));
                }}
              >
                <input
                  autoFocus
                  className="w-[28rem] rounded-xl border border-white/10 bg-ink-800 px-4 py-2 text-fg outline-none focus:border-ember"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <button className="rounded-xl bg-ember px-5 py-2 font-bold text-ink-950">OK</button>
              </form>
            ) : (
              <button onClick={() => setEditing(true)} className="hover:text-fg-muted">
                Сервер: {host} · изменить
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center">
          {status.conn === 'pairing' && p ? (
            <>
              <div className="rounded-[2.4rem] bg-white p-[1.6vw] shadow-[0_30px_120px_-30px_rgba(255,122,69,0.6)]">
                {qr && <img src={qr} alt="" className="h-[42vh] w-[42vh]" />}
              </div>
              <div className="mt-[4vh] text-[1.3rem] text-fg-muted">или откройте {host}/link и введите код</div>
              <div className="mt-3 font-mono text-[4.4rem] font-bold tracking-[0.35em] text-ember">{p.code}</div>
              <div className="tabular mt-2 text-[1.1rem] text-fg-dim">
                код обновится через {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-6 text-center">
              {status.conn === 'connecting' ? (
                <div className="h-20 w-20 animate-spin rounded-full border-4 border-white/10 border-t-ember" />
              ) : (
                <WifiOff size={90} className="text-fg-dim" />
              )}
              <div className="text-[2rem] font-bold">{status.conn === 'connecting' ? 'Подключаемся к серверу…' : 'Нет связи с сервером'}</div>
              {status.error && <div className="text-[1.3rem] text-fg-dim">{status.error}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span className="flex h-[2.6rem] w-[2.6rem] shrink-0 items-center justify-center rounded-full bg-ember/15 text-[1.3rem] font-extrabold text-ember">{n}</span>
  );
}
