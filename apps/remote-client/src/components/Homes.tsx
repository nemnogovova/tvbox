import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Crown,
  DoorOpen,
  Home as HomeIcon,
  LogIn,
  Pencil,
  RefreshCw,
  Server,
  Share2,
  Shield,
  Trash2,
  Tv,
  UserCheck,
  UserPlus,
  UserX,
  Users,
} from 'lucide-react';
import { Events, normalizeLinkCode, type InviteInfo, type RegistrationMode } from '@tvbox/shared';
import { act, joinHome, request, setPendingInvite, switchHome, toast, useStore } from '../store/store';
import { AccountCard, Avatar, DownloadButton, RoleChip, timeAgo } from './AccountSettings';
import { AuthScreen, Backdrop, Logo } from './AuthScreen';
import { navigate } from './LinkPage';
import { Section, Segmented, Spinner, Toggle, cx } from './ui';
import { downloadUrl, formatSize, useReleases } from '../lib/releases';
import { Monitor } from 'lucide-react';

/** Load the admin view (home + server) once a card that needs it appears. */
function useAdmin() {
  const admin = useStore((s) => s.admin);
  const homeId = useStore((s) => s.user?.homeId);
  useEffect(() => {
    void request(Events.ADMIN_GET).then((r) => r.ok && r.data && useStore.setState({ admin: r.data as never }));
  }, [homeId]);
  return admin;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // older WebViews: the selection trick
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// ---------------------------------------------------------------------------
// The current home: switching, invitation link, people, owner tools
// ---------------------------------------------------------------------------

export function HomeCard() {
  const user = useStore((s) => s.user);
  const admin = useAdmin();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (!user?.homeId) return null;
  const owner = user.role === 'owner';
  const home = admin?.home;
  const homes = user.homes || [];
  const members = admin?.members || [];

  const share = async () => {
    if (!home) return;
    const text = `Присоединяйтесь к телевизору «${home.name}» в TVBox`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'TVBox', text, url: home.inviteUrl });
        return;
      } catch {
        // cancelled or not allowed — copy instead
      }
    }
    if (await copyText(home.inviteUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Section title="Дом" icon={<HomeIcon size={18} />} right={<RoleChip role={user.role} />}>
      {/* name */}
      {renaming ? (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await act(Events.HOME_RENAME, { name: name.trim() }, 'Название сохранено');
            if (r.ok) setRenaming(false);
          }}
        >
          <input className="field" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-primary" disabled={!name.trim()}>
            <Check size={18} />
          </button>
        </form>
      ) : (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-extrabold">{user.homeName || 'Дом'}</div>
            <div className="text-xs text-fg-dim">Свой телевизор и свои люди — другие дома на сервере этого не видят</div>
          </div>
          {owner && (
            <button
              className="icon-btn"
              title="Переименовать"
              onClick={() => {
                setName(user.homeName || '');
                setRenaming(true);
              }}
            >
              <Pencil size={17} />
            </button>
          )}
        </div>
      )}

      {/* other homes */}
      {homes.length > 1 && (
        <div className="mt-4">
          <div className="label mb-2">Ваши дома</div>
          <div className="flex flex-col gap-1.5">
            {homes.map((h) => (
              <button
                key={h.id}
                disabled={h.id === user.homeId}
                onClick={() => void switchHome(h.id).then((ok) => ok && toast(`Теперь пульт управляет «${h.name}»`, 'success'))}
                className={cx(
                  'flex items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition',
                  h.id === user.homeId ? 'border-ember/40 bg-ember/10' : 'border-white/5 bg-ink-800 hover:border-white/15',
                )}
              >
                <Tv size={17} className={h.id === user.homeId ? 'text-ember' : 'text-fg-muted'} />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{h.name}</span>
                {h.role === 'owner' && <Crown size={13} className="text-ember" />}
                {h.id === user.homeId && <span className="text-[11px] font-bold text-ember">сейчас</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {owner && home && (
        <>
          {/* invitation */}
          <div className="mt-5 rounded-2xl bg-ink-800 p-4">
            <div className="flex items-center gap-2 text-sm font-bold">
              <UserPlus size={16} className="text-ember" /> Пригласить в дом
            </div>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              Отправьте ссылку тем, кто будет пользоваться телевизором: они войдут или зарегистрируются и сразу станут гостями — без одобрения.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate rounded-xl bg-ink-750 px-3 py-2.5 font-mono text-xs" data-testid="invite-url">
                {home.inviteUrl}
              </div>
              <button
                className="icon-btn"
                title="Скопировать"
                onClick={async () => {
                  if (await copyText(home.inviteUrl)) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }
                }}
              >
                {copied ? <Check size={17} className="text-ok" /> : <Copy size={17} />}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="btn-primary px-3 py-2 text-xs" onClick={share}>
                <Share2 size={14} /> Поделиться
              </button>
              <button
                className={cx('btn-ghost px-3 py-2 text-xs', confirm === 'reset' && 'text-warn')}
                onClick={async () => {
                  if (confirm !== 'reset') return setConfirm('reset');
                  setConfirm(null);
                  await act(Events.HOME_INVITE_RESET, {}, 'Старая ссылка больше не работает');
                }}
              >
                <RefreshCw size={14} /> {confirm === 'reset' ? 'Точно? Старая ссылка перестанет работать' : 'Новая ссылка'}
              </button>
            </div>
          </div>

          {/* people */}
          <div className="mt-5">
            <div className="label mb-1">Люди · {members.length}</div>
            {members.map((a) => {
              const self = a.id === user.id;
              return (
                <div key={a.id} className="flex items-center gap-3 border-t border-white/5 py-2.5 first:border-0">
                  <Avatar name={a.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{a.name}</span>
                      {self && <span className="text-[11px] text-fg-dim">(вы)</span>}
                    </div>
                    <div className="truncate text-xs text-fg-dim">
                      {[a.username && `@${a.username}`, a.email].filter(Boolean).join(' · ')}
                      {a.lastSeenAt ? ` · был ${timeAgo(a.lastSeenAt)}` : ''}
                    </div>
                  </div>
                  {self ? (
                    <RoleChip role={a.role} />
                  ) : (
                    <>
                      <select
                        className="rounded-xl border border-white/10 bg-ink-750 px-2 py-1.5 text-xs font-semibold"
                        value={a.role === 'owner' ? 'owner' : 'guest'}
                        onChange={(e) => void act(Events.ACCOUNT_UPDATE, { id: a.id, role: e.target.value })}
                      >
                        <option value="guest">Гость</option>
                        <option value="owner">Владелец</option>
                      </select>
                      <button
                        className={cx('icon-btn h-9 w-9', confirm === a.id ? 'text-bad' : 'hover:text-bad')}
                        title={confirm === a.id ? 'Нажмите ещё раз' : 'Убрать из дома'}
                        onClick={() => {
                          if (confirm !== a.id) return setConfirm(a.id);
                          setConfirm(null);
                          void act(Events.MEMBER_REMOVE, { id: a.id }, `${a.name} больше не в доме`);
                        }}
                      >
                        <UserX size={16} />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Google invitations */}
          <div className="mt-5">
            <div className="label mb-2">Пустить по Google-почте</div>
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!email.trim()) return;
                const r = await act(Events.GUESTS_UPDATE, { add: [email.trim()] }, 'Приглашение добавлено');
                if (r.ok) setEmail('');
              }}
            >
              <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@gmail.com" />
              <button className="btn-soft" disabled={!email.trim()}>
                <UserPlus size={18} />
              </button>
            </form>
            <div className="mt-2 flex flex-col">
              {!admin?.guests.length && <p className="py-1 text-xs text-fg-dim">Владелец Google-адреса из списка попадёт в дом, как только войдёт.</p>}
              {admin?.guests.map((g) => (
                <div key={g.email} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{g.name ? `${g.name} · ${g.email}` : g.email}</span>
                  <button className="icon-btn h-8 w-8 hover:text-bad" onClick={() => act(Events.GUESTS_UPDATE, { remove: [g.email] }, 'Приглашение удалено')}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5 flex items-center gap-4 rounded-2xl bg-ink-800 p-4">
            <div className="min-w-0 flex-1">
              <div className="font-bold">Режим диктатора</div>
              <div className="text-xs leading-relaxed text-fg-muted">Гости могут смотреть медиатеку, но не управлять ТВ</div>
            </div>
            <Toggle checked={!!admin?.dictatorMode} onChange={(v) => void act(Events.DICTATOR_MODE, { enabled: v })} />
          </div>
        </>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <button className="btn-ghost px-3 py-2 text-xs" onClick={() => navigate('/join')}>
          <LogIn size={14} /> Войти в другой дом
        </button>
        {(!owner || members.filter((m) => m.role === 'owner').length > 1) && (
          <button
            className={cx('btn-ghost px-3 py-2 text-xs', confirm === 'leave' && 'text-bad')}
            onClick={async () => {
              if (confirm !== 'leave') return setConfirm('leave');
              setConfirm(null);
              await act(Events.HOME_LEAVE, { homeId: user.homeId }, `Вы вышли из дома «${user.homeName}»`);
            }}
          >
            <DoorOpen size={14} /> {confirm === 'leave' ? 'Точно выйти?' : 'Выйти из дома'}
          </button>
        )}
        {owner && (
          <button
            className={cx('btn-ghost px-3 py-2 text-xs', confirm === 'delete' ? 'text-bad' : 'text-fg-dim')}
            onClick={async () => {
              if (confirm !== 'delete') return setConfirm('delete');
              setConfirm(null);
              await act(Events.HOME_DELETE, {}, 'Дом удалён, телевизор отвязан');
            }}
          >
            <Trash2 size={14} /> {confirm === 'delete' ? 'Удалить дом и отвязать ТВ?' : 'Удалить дом'}
          </button>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Server administration (the admin of the whole server)
// ---------------------------------------------------------------------------

const MODES: { value: RegistrationMode; label: string; hint: string }[] = [
  { value: 'open', label: 'Открыта', hint: 'Любой создаёт аккаунт и подключает свой телевизор сразу.' },
  { value: 'approval', label: 'По одобрению', hint: 'Новые аккаунты ждут вашего одобрения. По ссылке-приглашению в дом пускает без него.' },
  { value: 'closed', label: 'Закрыта', hint: 'Новые аккаунты — только по ссылке-приглашению в дом или Google-приглашению.' },
];

export function ServerCard() {
  const user = useStore((s) => s.user);
  const admin = useAdmin();
  const [confirm, setConfirm] = useState<string | null>(null);
  const server = admin?.server;
  if (!user?.admin) return null;
  if (!server)
    return (
      <Section title="Сервер" icon={<Server size={18} />}>
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      </Section>
    );
  const mode = MODES.find((m) => m.value === server.registration) || MODES[1];

  return (
    <Section title="Сервер" icon={<Shield size={18} />} right={<span className="chip bg-ember/10 text-[10px] uppercase tracking-wider text-ember">Администратор</span>}>
      <div className="label mb-2">Регистрация</div>
      <Segmented<RegistrationMode> value={server.registration} onChange={(v) => void act(Events.REGISTRATION_SET, { mode: v })} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
      <p className="mt-2 text-xs leading-relaxed text-fg-muted">{mode.hint}</p>

      {server.pending.length > 0 && (
        <div className="mt-5">
          <div className="label mb-2 text-warn">Ждут одобрения · {server.pending.length}</div>
          <div className="flex flex-col gap-2">
            {server.pending.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-2xl border border-warn/20 bg-warn/5 px-3 py-2.5">
                <Avatar name={a.name} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{a.name}</div>
                  <div className="truncate text-xs text-fg-dim">{a.username ? `@${a.username}` : a.email}</div>
                </div>
                <button className="btn-primary px-3 py-2 text-xs" onClick={() => act(Events.ACCOUNT_UPDATE, { id: a.id, role: 'guest' }, `${a.name} может войти`)}>
                  <UserCheck size={14} /> Одобрить
                </button>
                <button className="icon-btn h-9 w-9 hover:text-bad" title="Отклонить" onClick={() => act(Events.ACCOUNT_DELETE, { id: a.id }, 'Заявка отклонена')}>
                  <UserX size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5">
        <div className="label mb-1">Дома · {server.homes.length}</div>
        {server.homes.map((h) => (
          <div key={h.id} className="flex items-center gap-3 border-t border-white/5 py-2.5 first:border-0">
            <div className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', h.tvOnline ? 'bg-ok/10 text-ok' : 'bg-ink-750 text-fg-dim')}>
              <Tv size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{h.name}</div>
              <div className="truncate text-xs text-fg-dim">
                {h.owners.join(', ') || 'без владельца'} · людей: {h.members} · {h.tvOnline ? 'ТВ в сети' : h.tvName ? 'ТВ офлайн' : 'без ТВ'}
              </div>
            </div>
          </div>
        ))}
        {!server.homes.length && <p className="py-1 text-xs text-fg-dim">Пока никто не подключил телевизор.</p>}
      </div>

      <div className="mt-5">
        <div className="label mb-1">Аккаунты · {server.accounts.length}</div>
        {server.accounts.map((a) => {
          const self = a.id === user.id;
          return (
            <div key={a.id} className="flex items-center gap-3 border-t border-white/5 py-2.5 first:border-0">
              <Avatar name={a.name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">{a.name}</span>
                  {a.admin && <Shield size={12} className="shrink-0 text-ember" />}
                  {self && <span className="text-[11px] text-fg-dim">(вы)</span>}
                </div>
                <div className="truncate text-xs text-fg-dim">
                  {[a.username && `@${a.username}`, a.email].filter(Boolean).join(' · ')}
                  {a.homes.length ? ` · ${a.homes.join(', ')}` : ' · без дома'}
                  {a.lastSeenAt ? ` · был ${timeAgo(a.lastSeenAt)}` : ''}
                </div>
              </div>
              {!self && !a.admin && (
                <button
                  className={cx('icon-btn h-9 w-9', confirm === a.id ? 'text-bad' : 'hover:text-bad')}
                  title={confirm === a.id ? 'Нажмите ещё раз: аккаунт и его дома будут удалены' : 'Удалить аккаунт'}
                  onClick={() => {
                    if (confirm !== a.id) return setConfirm(a.id);
                    setConfirm(null);
                    void act(Events.ACCOUNT_DELETE, { id: a.id }, 'Аккаунт удалён');
                  }}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Signed in, but not in any home yet
// ---------------------------------------------------------------------------

export function NoHomeScreen() {
  const user = useStore((s) => s.user);
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const releases = useReleases();
  const serverUrl = useStore((s) => s.serverUrl);

  return (
    <div className="relative min-h-full overflow-y-auto px-5 py-10">
      <Backdrop />
      <div className="relative mx-auto flex w-full max-w-md flex-col gap-4">
        <div className="mb-2 text-center">
          <div className="mb-5 flex justify-center">
            <Logo size={64} />
          </div>
          <h1 className="text-2xl font-extrabold">Привет, {user?.name.split(' ')[0]}!</h1>
          <p className="mx-auto mt-2 max-w-xs text-[15px] leading-relaxed text-fg-muted">У вас пока нет телевизора. Подключите свой — или войдите в чужой дом по приглашению.</p>
        </div>

        <Section title="Подключить свой телевизор" icon={<Tv size={18} />}>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-relaxed text-fg-muted">
            <li>Установите TVBox на компьютер, подключённый к телевизору.</li>
            <li>При первом запуске на экране появится QR-код — отсканируйте его камерой телефона.</li>
            <li>Или введите код с экрана здесь:</li>
          </ol>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const c = normalizeLinkCode(code);
              if (c.length >= 6) navigate(`/link/${c}`);
            }}
          >
            <input className="field font-mono text-lg font-bold uppercase tracking-[0.25em]" value={code} maxLength={8} onChange={(e) => setCode(e.target.value)} placeholder="ABC123" />
            <button className="btn-primary" disabled={normalizeLinkCode(code).length < 6}>
              Далее
            </button>
          </form>
          {releases?.windows && (
            <div className="mt-4">
              <DownloadButton label="TVBox для ТВ (Windows)" sub={`${releases.windows.version} · ${formatSize(releases.windows.size)}`} href={downloadUrl(serverUrl, 'windows')} icon={<Monitor size={20} />} />
            </div>
          )}
        </Section>

        <Section title="Войти по приглашению" icon={<Users size={18} />}>
          <p className="mb-3 text-sm text-fg-muted">Владелец телевизора может прислать ссылку: «Настройки → Дом → Пригласить». Вставьте её или код:</p>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              await joinHome(inviteCodeOf(invite));
              setBusy(false);
            }}
          >
            <input className="field" value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="https://…/join/ABCD… или код" autoCapitalize="characters" />
            <button className="btn-soft" disabled={busy || inviteCodeOf(invite).length < 6}>
              {busy ? <Spinner /> : <LogIn size={18} />}
            </button>
          </form>
        </Section>

        {user?.admin && <ServerCard />}
        <AccountCard />
      </div>
    </div>
  );
}

/** "https://host/join/ABCD2345" or just the code */
export function inviteCodeOf(text: string): string {
  const m = /\/join\/([A-Za-z0-9]+)/.exec(text);
  return (m ? m[1] : text).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

// ---------------------------------------------------------------------------
// /join/<code>: an invitation link
// ---------------------------------------------------------------------------

export function JoinPage({ initialCode }: { initialCode: string }) {
  const auth = useStore((s) => s.auth);
  const conn = useStore((s) => s.conn);
  const user = useStore((s) => s.user);
  const serverUrl = useStore((s) => s.serverUrl);
  const [code, setCode] = useState(inviteCodeOf(initialCode));
  const [input, setInput] = useState('');
  const [info, setInfo] = useState<InviteInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPendingInvite(code || null);
    if (!code) return setInfo(null);
    setInfo(undefined);
    fetch(`${serverUrl}/api/invite/${encodeURIComponent(code)}`)
      .then((r) => r.json())
      .then((b: { ok: boolean; data?: InviteInfo }) => setInfo(b.ok && b.data ? b.data : null))
      .catch(() => setInfo(null));
  }, [code, serverUrl]);

  // signed in through this invitation: the server has already put the user into the home
  const already = !!info && !!user?.homes?.some((h) => h.name === info.homeName && h.id === user.homeId);

  if (code && info && auth !== 'authed') {
    return (
      <AuthScreen
        heading={<>Приглашение в «{info.homeName}»</>}
        sub={
          <>
            {info.ownerName ? <b className="text-fg">{info.ownerName}</b> : 'Владелец'} приглашает вас пользоваться телевизором. Войдите или создайте аккаунт — одобрение не понадобится.
          </>
        }
      />
    );
  }
  if (auth === 'unknown' || (code && info === undefined))
    return (
      <div className="relative flex h-full items-center justify-center">
        <Backdrop />
        <Spinner size={26} className="text-fg-muted" />
      </div>
    );

  return (
    <div className="relative flex min-h-full items-center justify-center px-6 py-12">
      <Backdrop />
      <div className="panel relative w-full max-w-sm animate-rise p-7 text-center">
        {!code || info === null ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setCode(inviteCodeOf(input));
            }}
          >
            <Users size={40} className="mx-auto text-ember" />
            <h1 className="mt-4 text-xl font-extrabold">{code ? 'Приглашение не найдено' : 'Приглашение в дом'}</h1>
            <p className="mt-2 text-sm text-fg-muted">{code ? 'Ссылка устарела или с ошибкой. Попросите владельца прислать новую.' : 'Вставьте ссылку-приглашение или код.'}</p>
            <input className="field mt-5 text-center font-mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="ABCD2345EF" />
            <button className="btn-primary mt-4 w-full" disabled={inviteCodeOf(input).length < 6}>
              Продолжить
            </button>
            {auth === 'authed' && (
              <button type="button" className="btn-ghost mt-2 w-full" onClick={() => navigate('/')}>
                Назад
              </button>
            )}
          </form>
        ) : (
          <>
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-ember/15 text-ember">
              <HomeIcon size={38} />
            </div>
            <h1 className="mt-5 text-xl font-extrabold">{already ? `Вы в доме «${info!.homeName}»` : `Войти в «${info!.homeName}»?`}</h1>
            <p className="mt-2 text-sm leading-relaxed text-fg-muted">
              {already ? 'Пульт уже управляет этим телевизором.' : <>Вы станете гостем этого дома{info!.ownerName ? <> (владелец — {info!.ownerName})</> : null}. Ваши другие дома останутся — между ними можно переключаться в настройках.</>}
            </p>
            <div className="mt-6 flex gap-2">
              {!already && (
                <button className="btn-soft flex-1" onClick={() => navigate('/')}>
                  Отмена
                </button>
              )}
              <button
                className="btn-primary flex-1"
                disabled={busy || conn !== 'online'}
                onClick={async () => {
                  if (already) return navigate('/');
                  setBusy(true);
                  const r = await joinHome(code);
                  setBusy(false);
                  if (r.ok) {
                    toast(`Добро пожаловать в «${r.name}»`, 'success');
                    setPendingInvite(null);
                    navigate('/');
                  }
                }}
              >
                {busy ? <Spinner /> : already ? 'Открыть пульт' : 'Войти'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

