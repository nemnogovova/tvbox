import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Clock, ExternalLink, Monitor, Server, ShieldAlert, Smartphone } from 'lucide-react';
import { changeServer, clearAuthError, errorText, registerAccount, signInWithGoogle, signInWithPassword, startDeviceLink, useStore } from '../store/store';
import { DownloadButton } from './AccountSettings';
import { downloadUrl, formatSize, useReleases } from '../lib/releases';
import { fetchPublicConfig, type PublicConfig } from '../lib/config';
import { renderGoogleButton } from '../lib/google';
import { isNative, openExternal } from '../lib/native';
import { Segmented, Spinner } from './ui';

export function Logo({ size = 64 }: { size?: number }) {
  return <img src="/icons/icon.svg" width={size} height={size} alt="" className="drop-shadow-[0_12px_30px_rgba(255,122,69,0.25)]" />;
}

export function AuthScreen({ heading, sub }: { heading?: ReactNode; sub?: ReactNode }) {
  const serverUrl = useStore((s) => s.serverUrl);
  const conn = useStore((s) => s.conn);
  const authError = useStore((s) => s.authError);
  const deniedEmail = useStore((s) => s.deniedEmail);
  const kicked = useStore((s) => s.kickedReason);
  const [cfg, setCfg] = useState<PublicConfig | null | undefined>(undefined);
  const native = isNative();

  useEffect(() => {
    setCfg(undefined);
    void fetchPublicConfig(serverUrl).then(setCfg);
  }, [serverUrl, conn]);

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden px-6 py-12">
      <Backdrop />
      <div className="relative w-full max-w-sm animate-rise text-center">
        <div className="mb-7 flex justify-center">
          <Logo size={76} />
        </div>
        <h1 className="text-[28px] font-extrabold leading-tight tracking-tight">{heading ?? 'TVBox'}</h1>
        <p className="mx-auto mt-2 max-w-[18rem] text-[15px] leading-relaxed text-fg-muted">
          {sub ?? 'Пульт для домашнего телевизора: фильмы, YouTube, торренты и трансляция с телефона.'}
        </p>

        <div className="mt-9">
          {cfg === undefined ? (
            <div className="flex justify-center py-3 text-fg-muted">
              <Spinner />
            </div>
          ) : cfg === null ? (
            <p className="rounded-2xl bg-bad/10 px-4 py-3 text-sm text-bad">Сервер {hostOf(serverUrl)} недоступен</p>
          ) : (
            <div className="flex flex-col gap-4">
              {cfg.oauthConfigured && (native ? <NativeSignIn /> : <GoogleButton clientId={cfg.googleClientId} />)}
              {cfg.oauthConfigured && (
                <div className="flex items-center gap-3 text-xs font-semibold uppercase tracking-wider text-fg-dim">
                  <span className="h-px flex-1 bg-white/10" /> или <span className="h-px flex-1 bg-white/10" />
                </div>
              )}
              <PasswordAuth registration={cfg.registration} />
            </div>
          )}
        </div>

        {(authError || kicked) && authError !== 'pending_approval' && !PASSWORD_ERRORS.has(authError || '') && (
          <div className="mt-5 flex items-start gap-3 rounded-2xl border border-bad/20 bg-bad/10 px-4 py-3 text-left text-sm">
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-bad" />
            <span className="leading-snug text-fg">
              {kicked ? (
                kicked
              ) : authError === 'not_allowed' ? (
                <>
                  Регистрация на сервере закрыта, а для <b>{deniedEmail || 'этого аккаунта'}</b> нет приглашения. Попросите владельца телевизора прислать ссылку-приглашение.
                </>
              ) : authError === 'network' ? (
                'Нет связи с сервером'
              ) : (
                'Не удалось войти. Попробуйте ещё раз.'
              )}
            </span>
          </div>
        )}
        {authError === 'pending_approval' && (
          <div className="mt-5 flex items-start gap-3 rounded-2xl border border-warn/25 bg-warn/10 px-4 py-3 text-left text-sm">
            <Clock size={18} className="mt-0.5 shrink-0 text-warn" />
            <span className="leading-snug text-fg">Заявка отправлена. Администратор сервера одобрит её — после этого войдите с тем же логином или Google-аккаунтом. Есть ссылка-приглашение от владельца телевизора? Откройте её — тогда одобрение не нужно.</span>
          </div>
        )}

        {!native && <AppDownloads />}
        <ServerSwitcher />
      </div>
    </div>
  );
}

const PASSWORD_ERRORS = new Set(['invalid_credentials', 'username_taken', 'weak_password', 'bad_username', 'registration_closed', 'too_many_attempts']);

function PasswordAuth({ registration }: { registration?: 'open' | 'approval' | 'closed' }) {
  const authError = useStore((s) => s.authError);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    if (mode === 'login') await signInWithPassword(username.trim(), password);
    else await registerAccount(username.trim(), password, name.trim() || undefined);
    setBusy(false);
  };
  const err = authError && PASSWORD_ERRORS.has(authError) ? errorText(authError) : null;
  return (
    <form
      className="flex flex-col gap-2.5 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="mb-1 flex justify-center">
        <Segmented
          value={mode}
          onChange={(m) => {
            setMode(m);
            clearAuthError();
          }}
          options={[
            { value: 'login', label: 'Вход' },
            { value: 'register', label: 'Регистрация' },
          ]}
        />
      </div>
      <input className="field" placeholder="Логин" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="off" autoCorrect="off" autoComplete="username" />
      {mode === 'register' && <input className="field" placeholder="Имя (необязательно)" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
      <input
        className="field"
        type="password"
        placeholder={mode === 'register' ? 'Пароль (от 4 символов)' : 'Пароль'}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
      />
      {err && <p className="px-1 text-sm text-bad">{err}</p>}
      <button className="btn-primary mt-1 w-full py-3.5" disabled={busy || username.trim().length < 3 || password.length < (mode === 'register' ? 4 : 1)}>
        {busy ? <Spinner /> : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
      </button>
      {mode === 'register' && (
        <p className="px-1 text-xs leading-relaxed text-fg-dim">
          {registration === 'open'
            ? 'После регистрации подключите свой телевизор — или войдите в дом по приглашению.'
            : registration === 'closed'
              ? 'Регистрация только по ссылке-приглашению от владельца телевизора.'
              : 'Новый аккаунт одобряет администратор сервера. По ссылке-приглашению от владельца телевизора — сразу.'}
        </p>
      )}
    </form>
  );
}

function AppDownloads() {
  const serverUrl = useStore((s) => s.serverUrl);
  const r = useReleases();
  if (!r || (!r.android && !r.windows)) return null;
  return (
    <div className="mt-8 text-left">
      <div className="label mb-2 text-center">Приложения</div>
      <div className="grid gap-2">
        {r.android && <DownloadButton label="Пульт для Android" sub={`${r.android.version} · ${formatSize(r.android.size)}`} href={downloadUrl(serverUrl, 'android')} icon={<Smartphone size={20} />} />}
        {r.windows && <DownloadButton label="TVBox для ТВ (Windows)" sub={`${r.windows.version} · ${formatSize(r.windows.size)}`} href={downloadUrl(serverUrl, 'windows')} icon={<Monitor size={20} />} />}
      </div>
    </div>
  );
}

function GoogleButton({ clientId }: { clientId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    renderGoogleButton(clientId, ref.current, async (cred) => {
      setBusy(true);
      await signInWithGoogle(cred);
      setBusy(false);
    }).catch(() => setFailed(true));
  }, [clientId]);
  if (failed) return <p className="text-sm text-bad">Не удалось загрузить вход Google. Проверьте интернет.</p>;
  return (
    <div className="flex min-h-[44px] items-center justify-center">
      {busy ? <Spinner /> : <div ref={ref} className="flex w-full justify-center [color-scheme:light]" />}
    </div>
  );
}

function NativeSignIn() {
  const [link, setLink] = useState<{ code: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    const res = await startDeviceLink(deviceName());
    setBusy(false);
    if (!res.ok || !res.code || !res.url) {
      setError('Сервер недоступен');
      return;
    }
    setLink({ code: res.code, url: res.url });
    void openExternal(res.url);
  };

  if (!link) {
    return (
      <div className="flex flex-col gap-3">
        <button onClick={start} disabled={busy} className="btn-soft w-full py-3.5">
          {busy ? <Spinner /> : <ExternalLink size={18} />} Войти через Google
        </button>
        <p className="text-xs leading-relaxed text-fg-dim">Откроется браузер: войдите там своим Google-аккаунтом и подтвердите подключение.</p>
        {error && <p className="text-sm text-bad">{error}</p>}
      </div>
    );
  }
  return (
    <div className="panel p-5 text-left">
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <Spinner size={14} /> Ждём подтверждения…
      </div>
      <p className="mt-3 text-sm leading-relaxed text-fg-muted">
        Подтвердите вход в открывшемся браузере. Или откройте <b className="text-fg">{hostOf(link.url)}/link</b> на устройстве, где вы уже вошли, и введите код:
      </p>
      <div className="mt-4 rounded-2xl bg-ink-800 py-4 text-center font-mono text-3xl font-bold tracking-[0.3em] text-ember">{link.code}</div>
      <div className="mt-4 flex gap-2">
        <button className="btn-soft flex-1" onClick={() => void openExternal(link.url)}>
          <ExternalLink size={16} /> Открыть снова
        </button>
        <button className="btn-ghost" onClick={() => setLink(null)}>
          Отмена
        </button>
      </div>
    </div>
  );
}

function ServerSwitcher() {
  const serverUrl = useStore((s) => s.serverUrl);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(serverUrl);
  if (!isNative() && !open) {
    return (
      <button onClick={() => setOpen(true)} className="mx-auto mt-10 flex items-center gap-1.5 text-xs text-fg-dim hover:text-fg-muted">
        <Server size={12} /> {hostOf(serverUrl)}
      </button>
    );
  }
  return (
    <div className="mt-10 text-left">
      {!open ? (
        <button onClick={() => setOpen(true)} className="mx-auto flex items-center gap-1.5 text-xs text-fg-dim hover:text-fg-muted">
          <Smartphone size={12} /> Сервер: {hostOf(serverUrl)} · изменить
        </button>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = value.trim();
            changeServer(v ? (/^https?:\/\//.test(v) ? v : `https://${v}`) : null);
            setOpen(false);
          }}
        >
          <input className="field" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://tv.nemnogovova.com" />
          <button className="btn-soft">OK</button>
        </form>
      )}
    </div>
  );
}

export function Backdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-ember/20 blur-[120px]" />
      <div className="absolute -bottom-48 -right-24 h-[420px] w-[420px] rounded-full bg-indigo-500/10 blur-[120px]" />
    </div>
  );
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const m = /Android [\d.]+; ([^;)]+)/.exec(ua);
  if (m) return m[1].replace(/ Build.*/, '').trim();
  return 'Телефон';
}
