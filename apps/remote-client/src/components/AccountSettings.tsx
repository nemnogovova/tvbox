import { ActivationCode } from './DPad';
import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Crown,
  Download,
  KeyRound,
  LogOut,
  Monitor,
  Music2,
  Shield,
  Smartphone,
  Unlink,
  Users,
  Youtube,
} from 'lucide-react';
import { Events, type AccountInfo, type TvSettings } from '@tvbox/shared';
import { act, api, errorText, isOwner, request, signOut, toast, useStore } from '../store/store';
import { fetchPublicConfig, type PublicConfig } from '../lib/config';
import { googleSignOut, renderGoogleButton } from '../lib/google';
import { isNative, openExternal } from '../lib/native';
import { APP_VERSION, downloadUrl, formatSize, newerVersion, useReleases } from '../lib/releases';
import { Section, Spinner, cx } from './ui';

// ---------------------------------------------------------------------------
// Own account: profile, login/password, linked services
// ---------------------------------------------------------------------------

export function AccountCard({ onOpenMusic }: { onOpenMusic?: () => void }) {
  const user = useStore((s) => s.user);
  const serverUrl = useStore((s) => s.serverUrl);
  const musicSources = useStore((s) => s.musicSources);
  const owner = useStore(isOwner);
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [pwOpen, setPwOpen] = useState(false);

  const load = () => void api<AccountInfo>('/api/account').then((r) => r.ok && r.data && setInfo(r.data));
  useEffect(load, [user?.id]);
  useEffect(() => {
    void fetchPublicConfig(serverUrl).then(setCfg);
  }, [serverUrl]);

  if (!user) return null;
  const picture = info?.google?.picture || user.picture;

  return (
    <Section title="Аккаунт и сервисы" icon={<Users size={18} />}>
      <div className="flex items-center gap-4">
        {picture ? (
          <img src={picture} alt="" className="h-12 w-12 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ember/20 text-lg font-extrabold text-ember">{user.name.charAt(0).toUpperCase()}</div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-bold">{user.name}</span>
            {user.admin && (
              <span className="chip shrink-0 bg-ember/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-ember">
                <Shield size={10} /> Админ сервера
              </span>
            )}
          </div>
          <div className="truncate text-sm text-fg-dim">{info?.username ? `@${info.username}` : user.email}</div>
        </div>
        <button
          className="icon-btn"
          title="Выйти"
          onClick={() => {
            googleSignOut();
            signOut();
          }}
        >
          <LogOut size={19} />
        </button>
      </div>

      <div className="mt-5 flex flex-col divide-y divide-white/5 rounded-2xl bg-ink-800">
        {/* login & password */}
        <ServiceRow
          icon={<KeyRound size={18} />}
          title="Логин и пароль"
          status={info?.hasPassword ? `@${info.username}` : 'не задан'}
          ok={!!info?.hasPassword}
          action={
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setPwOpen((v) => !v)}>
              {info?.hasPassword ? 'Изменить' : 'Задать'}
            </button>
          }
        />
        {pwOpen && info && (
          <PasswordForm
            info={info}
            onDone={(next) => {
              setInfo(next);
              setPwOpen(false);
            }}
          />
        )}

        {/* Google */}
        {(cfg?.oauthConfigured || info?.google) && (
          <ServiceRow
            icon={<GoogleIcon />}
            title="Google"
            status={info?.google ? info.google.email : 'не привязан'}
            ok={!!info?.google}
            action={info ? <GoogleLink info={info} clientId={cfg?.googleClientId || ''} onChange={setInfo} /> : null}
          />
        )}

        {/* music (lives on the TV: only in a home) */}
        {user.homeId !== null && <ServiceRow
          icon={<Music2 size={18} />}
          title="Музыкальные серверы"
          status={musicSources?.length ? musicSources.map((m) => m.name).join(', ') : 'не подключены'}
          ok={!!musicSources?.length}
          action={
            onOpenMusic && (
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onOpenMusic}>
                {owner ? (musicSources?.length ? 'Управлять' : 'Подключить') : 'Открыть'}
              </button>
            )
          }
        />}
        <ServiceRow icon={<SpotifyIcon />} title="Spotify" status="скоро" muted />
      </div>
    </Section>
  );
}

export function RoleChip({ role }: { role: string }) {
  return (
    <span
      className={cx(
        'chip shrink-0 px-2 py-0.5 text-[10px] uppercase tracking-wider',
        role === 'owner' ? 'bg-ember/15 text-ember' : role === 'pending' ? 'bg-warn/15 text-warn' : 'bg-white/5 text-fg-muted',
      )}
    >
      {role === 'owner' ? (
        <>
          <Crown size={10} /> Владелец
        </>
      ) : role === 'pending' ? (
        'Ждёт'
      ) : (
        'Гость'
      )}
    </span>
  );
}

function ServiceRow({ icon, title, status, ok, action, muted }: { icon: React.ReactNode; title: string; status: string; ok?: boolean; action?: React.ReactNode; muted?: boolean }) {
  return (
    <div className={cx('flex items-center gap-3 px-4 py-3', muted && 'opacity-50')}>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink-750 text-fg-muted">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{title}</div>
        <div className={cx('truncate text-xs', ok ? 'text-ok' : 'text-fg-dim')}>
          {ok && <Check size={11} className="mr-1 inline" />}
          {status}
        </div>
      </div>
      {action}
    </div>
  );
}

function PasswordForm({ info, onDone }: { info: AccountInfo; onDone: (i: AccountInfo) => void }) {
  const [username, setUsername] = useState(info.username || '');
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await api<AccountInfo>('/api/account/password', {
      body: { username: username.trim() || undefined, password, currentPassword: info.hasPassword ? current : undefined },
    });
    setBusy(false);
    if (!r.ok) return setError(errorText(r.error));
    toast(info.hasPassword ? 'Пароль изменён' : 'Теперь можно входить по логину и паролю', 'success');
    if (r.data) onDone(r.data);
  };
  return (
    <form
      className="flex flex-col gap-2 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input className="field" placeholder="Логин" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="off" autoCorrect="off" autoComplete="username" />
      {info.hasPassword && (
        <input className="field" type="password" placeholder="Текущий пароль" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      )}
      <input className="field" type="password" placeholder="Новый пароль (от 4 символов)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      {error && <p className="text-sm text-bad">{error}</p>}
      <button className="btn-primary" disabled={busy || password.length < 4 || username.trim().length < 3}>
        {busy ? <Spinner /> : 'Сохранить'}
      </button>
    </form>
  );
}

function GoogleLink({ info, clientId, onChange }: { info: AccountInfo; clientId: string; onChange: (i: AccountInfo) => void }) {
  const [linking, setLinking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!linking || !ref.current || !clientId) return;
    renderGoogleButton(clientId, ref.current, async (credential) => {
      const r = await api<AccountInfo>('/api/account/google', { body: { credential } });
      setLinking(false);
      if (!r.ok) return toast(errorText(r.error), 'error');
      toast('Google-аккаунт привязан', 'success');
      if (r.data) onChange(r.data);
    }).catch(() => {
      setLinking(false);
      toast('Не удалось загрузить вход Google', 'error');
    });
  }, [linking, clientId, onChange]);

  if (info.google) {
    return (
      <button
        className="btn-ghost px-3 py-1.5 text-xs"
        onClick={async () => {
          const r = await api<AccountInfo>('/api/account/google', { method: 'DELETE' });
          if (!r.ok) return toast(errorText(r.error), 'error');
          toast('Google-аккаунт отвязан', 'success');
          if (r.data) onChange(r.data);
        }}
      >
        <Unlink size={13} /> Отвязать
      </button>
    );
  }
  if (isNative()) return <span className="text-[11px] text-fg-dim">привязка — в веб-версии</span>;
  if (!clientId) return null;
  return linking ? (
    <div ref={ref} className="min-w-[200px] [color-scheme:light]" />
  ) : (
    <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setLinking(true)}>
      Привязать
    </button>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3.1 14.7 2 12 2 6.5 2 2 6.5 2 12s4.5 10 10 10c5.8 0 9.6-4.1 9.6-9.8 0-.7-.1-1.2-.2-1.7H12z" />
    </svg>
  );
}

function SpotifyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="#1DB954" />
      <path d="M7 9.5c3.5-1 7.3-.7 10 1M7.6 12.6c2.9-.8 5.9-.5 8.3.9M8.2 15.5c2.3-.6 4.6-.4 6.5.7" stroke="#000" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function Avatar({ name }: { name: string }) {
  return <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink-750 text-sm font-bold text-fg-muted">{(name || '?').charAt(0).toUpperCase()}</div>;
}

export function timeAgo(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 2) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

// ---------------------------------------------------------------------------
// TV: YouTube account + version / update
// ---------------------------------------------------------------------------

export function TvExtrasCard() {
  const tvOnline = useStore((s) => s.presence.tvConnected);
  const tvVersion = useStore((s) => s.presence.tvVersion);
  const releases = useReleases();
  const [s, setS] = useState<TvSettings | null>(null);
  const [updating, setUpdating] = useState(false);
  const yt = useStore((st) => st.youtube);

  useEffect(() => {
    if (!tvOnline) return;
    void request<TvSettings>(Events.TV_SETTINGS_GET).then((r) => r.ok && r.data && setS(r.data));
  }, [tvOnline, yt?.signedIn]);
  if (!tvOnline) return null;

  const version = s?.version || tvVersion;
  const latest = releases?.windows;
  const updateAvailable = !!latest && newerVersion(latest.version, version);

  return (
    <Section title="YouTube и обновления ТВ" icon={<Monitor size={18} />}>
      <div className="flex flex-col divide-y divide-white/5 rounded-2xl bg-ink-800">
        <ServiceRow
          icon={<Youtube size={18} className="text-[#ff3d3d]" />}
          title="Аккаунт YouTube на ТВ"
          status={yt?.code ? 'ждём подтверждения кода' : s ? (s.youtubeSignedIn ? 'аккаунт подключён' : 'без аккаунта') : '…'}
          ok={!!s?.youtubeSignedIn}
          action={
            s?.youtubeSignedIn ? (
              <button
                className="btn-ghost px-3 py-1.5 text-xs"
                onClick={async () => {
                  const r = await act<TvSettings>(Events.YOUTUBE_LOGOUT, {}, 'Вы вышли из YouTube на ТВ');
                  if (r.ok && r.data) setS(r.data);
                }}
              >
                Выйти
              </button>
            ) : (
              <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => act(Events.YOUTUBE_LOGIN, {})}>
                Подключить
              </button>
            )
          }
        />
        {yt?.code && !s?.youtubeSignedIn && (
          <div className="overflow-hidden rounded-b-none">
            <ActivationCode code={yt.code} />
          </div>
        )}
        <ServiceRow
          icon={<Download size={18} />}
          title={`TVBox для ТВ ${version ? `· ${version}` : ''}`}
          status={updateAvailable ? `доступна версия ${latest!.version}` : latest ? 'последняя версия' : 'сборки ещё не опубликованы'}
          ok={!updateAvailable && !!latest}
          action={
            updateAvailable && (
              <button
                className="btn-primary px-3 py-1.5 text-xs"
                disabled={updating}
                onClick={async () => {
                  setUpdating(true);
                  const r = await act(Events.TV_UPDATE, {}, 'ТВ скачивает обновление и перезапустится');
                  if (!r.ok) setUpdating(false);
                }}
              >
                {updating ? <Spinner size={14} /> : 'Обновить'}
              </button>
            )
          }
        />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-fg-dim">
        YouTube на ТВ — это настоящий YouTube для телевизоров: главная, подписки, плейлисты, история и поиск, управление стрелками с пульта. Реклама вырезается ещё до
        показа. Аккаунт подключается кодом: откройте yt.be/activate на телефоне и введите код — на ТВ ничего печатать не нужно.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Downloads of the apps + own update
// ---------------------------------------------------------------------------

export function AppsCard() {
  const serverUrl = useStore((s) => s.serverUrl);
  const releases = useReleases();
  const native = isNative();
  const android = releases?.android;
  const windows = releases?.windows;
  const apkUpdate = native && android && newerVersion(android.version, APP_VERSION);

  return (
    <Section title="Приложения" icon={<Smartphone size={18} />} right={<span className="text-xs text-fg-dim">пульт {APP_VERSION}</span>}>
      {apkUpdate && (
        <div className="mb-3 flex items-center gap-3 rounded-2xl border border-ember/30 bg-ember/10 p-3">
          <div className="min-w-0 flex-1 text-sm">
            <b>Доступна версия {android!.version}</b>
            <div className="text-xs text-fg-muted">Скачайте и установите APK поверх текущего</div>
          </div>
          <button className="btn-primary px-3 py-2 text-xs" onClick={() => void openExternal(downloadUrl(serverUrl, 'android'))}>
            Обновить
          </button>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <DownloadButton label="Android" sub={android ? `${android.version} · ${formatSize(android.size)}` : 'ещё не опубликовано'} href={android ? downloadUrl(serverUrl, 'android') : null} icon={<Smartphone size={20} />} />
        <DownloadButton label="Windows (ТВ)" sub={windows ? `${windows.version} · ${formatSize(windows.size)}` : 'ещё не опубликовано'} href={windows ? downloadUrl(serverUrl, 'windows') : null} icon={<Monitor size={20} />} />
      </div>
    </Section>
  );
}

export function DownloadButton({ label, sub, href, icon }: { label: string; sub: string; href: string | null; icon: React.ReactNode }) {
  const native = isNative();
  const content = (
    <>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink-750 text-ember">{icon}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-sm font-bold">{label}</span>
        <span className="block truncate text-xs text-fg-dim">{sub}</span>
      </span>
      <Download size={16} className="text-fg-dim" />
    </>
  );
  const cls = cx('flex items-center gap-3 rounded-2xl border border-white/5 bg-ink-800 px-3 py-2.5 transition', href ? 'hover:border-ember/40' : 'pointer-events-none opacity-40');
  if (!href) return <div className={cls}>{content}</div>;
  if (native)
    return (
      <button className={cls} onClick={() => void openExternal(href)}>
        {content}
      </button>
    );
  return (
    <a className={cls} href={href} download>
      {content}
    </a>
  );
}
