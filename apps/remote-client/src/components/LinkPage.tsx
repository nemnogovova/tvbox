import { useEffect, useState } from 'react';
import { CheckCircle2, MonitorSmartphone, Tv, XCircle } from 'lucide-react';
import { Events, normalizeLinkCode, type LinkInfoResult } from '@tvbox/shared';
import { errorText, request, useStore } from '../store/store';
import { AuthScreen, Backdrop } from './AuthScreen';
import { Spinner } from './ui';

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function LinkPage({ initialCode }: { initialCode: string }) {
  const auth = useStore((s) => s.auth);
  const conn = useStore((s) => s.conn);
  const user = useStore((s) => s.user);
  const [code, setCode] = useState(normalizeLinkCode(initialCode));
  const [input, setInput] = useState('');
  const [info, setInfo] = useState<LinkInfoResult | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auth !== 'authed' || conn !== 'online' || !code) return;
    setInfo(null);
    void request<never>(Events.LINK_INFO, { code }).then((r) => setInfo(r as unknown as LinkInfoResult));
  }, [auth, conn, code]);

  if (auth !== 'authed') {
    return (
      <AuthScreen
        heading="Подключение устройства"
        sub="Войдите в свой аккаунт TVBox, чтобы подтвердить подключение телевизора или телефона."
      />
    );
  }

  const approve = async () => {
    setState('busy');
    const r = await request(Events.LINK_APPROVE, { code });
    if (r.ok) setState('done');
    else {
      setState('error');
      setError(errorText(r.error));
    }
  };

  const isTv = info?.kind === 'tv';

  return (
    <div className="relative flex min-h-full items-center justify-center px-6 py-12">
      <Backdrop />
      <div className="panel relative w-full max-w-sm animate-rise p-7 text-center">
        {!code ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setCode(normalizeLinkCode(input));
            }}
          >
            <MonitorSmartphone size={40} className="mx-auto text-ember" />
            <h1 className="mt-4 text-xl font-extrabold">Введите код с экрана</h1>
            <input
              autoFocus
              className="field mt-5 text-center font-mono text-2xl font-bold uppercase tracking-[0.3em]"
              maxLength={8}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="ABC123"
            />
            <button className="btn-primary mt-4 w-full" disabled={normalizeLinkCode(input).length < 6}>
              Продолжить
            </button>
          </form>
        ) : state === 'done' ? (
          <>
            <CheckCircle2 size={52} className="mx-auto text-ok" />
            <h1 className="mt-4 text-xl font-extrabold">Готово!</h1>
            <p className="mt-2 text-sm text-fg-muted">
              {isTv ? 'Телевизор подключён. Можно вернуться к нему.' : 'Устройство вошло в ваш аккаунт. Вернитесь в приложение.'}
            </p>
            <button className="btn-soft mt-6 w-full" onClick={() => navigate('/')}>
              Открыть пульт
            </button>
          </>
        ) : !info ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : !info.ok ? (
          <>
            <XCircle size={48} className="mx-auto text-bad" />
            <h1 className="mt-4 text-lg font-extrabold">Код {code} не найден</h1>
            <p className="mt-2 text-sm text-fg-muted">Он действует 10 минут. Обновите код на устройстве и попробуйте снова.</p>
            <button className="btn-soft mt-6 w-full" onClick={() => setCode('')}>
              Ввести другой код
            </button>
          </>
        ) : (
          <>
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-ember/15 text-ember">
              {isTv ? <Tv size={38} /> : <MonitorSmartphone size={38} />}
            </div>
            <h1 className="mt-5 text-xl font-extrabold">{isTv ? 'Подключить телевизор?' : 'Войти на устройстве?'}</h1>
            <p className="mt-2 text-sm leading-relaxed text-fg-muted">
              «{info.name}» {isTv ? 'станет вашим ТВ-клиентом.' : `получит доступ к пульту от имени ${user?.email}.`}
            </p>
            <div className="mt-4 font-mono text-sm tracking-[0.25em] text-fg-dim">{code}</div>
            {error && <p className="mt-3 text-sm text-bad">{error}</p>}
            <div className="mt-6 flex gap-2">
              <button className="btn-soft flex-1" onClick={() => navigate('/')}>
                Отмена
              </button>
              <button className="btn-primary flex-1" onClick={approve} disabled={state === 'busy'}>
                {state === 'busy' ? <Spinner /> : 'Подключить'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
