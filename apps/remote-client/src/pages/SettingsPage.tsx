import { useEffect, useState } from 'react';
import {
  Crown,
  FolderPlus,
  KeyRound,
  Link2,
  LogOut,
  Moon,
  Power,
  RefreshCw,
  RotateCw,
  Server,
  Shield,
  Smartphone,
  Trash2,
  Tv,
  Unplug,
  UserPlus,
  X,
} from 'lucide-react';
import { Events, normalizeLinkCode, type PowerAction, type TvSettings } from '@tvbox/shared';
import { act, changeServer, isOwner, request, signOut, useStore, errorText, toast } from '../store/store';
import { Section, Spinner, Toggle, cx } from '../components/ui';
import { navigate } from '../components/LinkPage';
import { hostOf } from '../components/AuthScreen';
import { IdleEditor } from '../components/IdleEditor';
import { AccessCard, AccountCard, AppsCard, TvExtrasCard } from '../components/AccountSettings';
import { getPref, setPref } from '../lib/config';
import { isNative, setVolumeKeysEnabled, startBackgroundControl, stopBackgroundControl } from '../lib/native';
import { getToken } from '../lib/config';
import { googleSignOut } from '../lib/google';

export function SettingsPage({ onOpenMusic }: { onOpenMusic?: () => void }) {
  const owner = useStore(isOwner);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="h-page">Настройки</h1>
      <AccountCard onOpenMusic={onOpenMusic} />
      <TvCard />
      {owner && <TvExtrasCard />}
      <LinkDeviceCard />
      {owner && <AccessCard />}
      {owner && <TvSettingsCard />}
      {owner && <IdleEditor />}
      <AppsCard />
      <AppCard />
    </div>
  );
}

function TvCard() {
  const presence = useStore((s) => s.presence);
  const owner = useStore(isOwner);
  const [confirm, setConfirm] = useState<PowerAction | 'unpair' | null>(null);

  const power = async (action: PowerAction) => {
    setConfirm(null);
    await act(Events.POWER, { action }, 'Команда отправлена');
  };

  const buttons: { action: PowerAction; label: string; icon: typeof Power; danger?: boolean }[] = [
    { action: 'sleep', label: 'Сон', icon: Moon },
    { action: 'reboot', label: 'Перезагрузка', icon: RotateCw },
    { action: 'shutdown', label: 'Выключить', icon: Power, danger: true },
  ];

  return (
    <Section
      title="Телевизор"
      icon={<Tv size={18} />}
      right={
        <span className={cx('chip', presence.tvConnected ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad')}>
          <span className={cx('h-2 w-2 rounded-full', presence.tvConnected ? 'bg-ok' : 'bg-bad')} />
          {presence.tvConnected ? 'В сети' : 'Офлайн'}
        </span>
      }
    >
      <div className="text-sm text-fg-muted">
        {presence.tvName ? <>«{presence.tvName}»</> : 'Телевизор ещё не подключён'}
        {presence.remotes.length > 0 && <> · сейчас на пульте: {presence.remotes.map((r) => r.name.split(' ')[0]).join(', ')}</>}
      </div>
      {!presence.tvName && owner && (
        <p className="mt-3 text-sm leading-relaxed text-fg-dim">
          Запустите TVBox на компьютере у телевизора и отсканируйте QR-код с экрана этим телефоном — или введите код ниже.
        </p>
      )}
      {owner && (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {buttons.map((b) => (
              <button
                key={b.action}
                disabled={!presence.tvConnected}
                onClick={() => (confirm === b.action ? void power(b.action) : setConfirm(b.action))}
                className={cx(
                  'flex flex-col items-center gap-2 rounded-2xl border px-2 py-3.5 text-xs font-bold transition disabled:opacity-40',
                  confirm === b.action
                    ? 'border-bad bg-bad/15 text-bad'
                    : b.danger
                      ? 'border-white/5 bg-ink-800 text-bad hover:border-bad/40'
                      : 'border-white/5 bg-ink-800 text-fg-muted hover:border-ember/40 hover:text-fg',
                )}
              >
                <b.icon size={20} />
                {confirm === b.action ? 'Точно?' : b.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn-ghost px-3 py-2 text-xs" disabled={!presence.tvConnected} onClick={() => power('restart-app')}>
              <RefreshCw size={14} /> Перезапустить TVBox
            </button>
            {presence.tvName && (
              <button
                className={cx('btn-ghost px-3 py-2 text-xs', confirm === 'unpair' && 'text-bad')}
                onClick={async () => {
                  if (confirm !== 'unpair') return setConfirm('unpair');
                  setConfirm(null);
                  await act(Events.TV_UNPAIR, {}, 'Телевизор отвязан — подключите его заново по QR-коду');
                }}
              >
                <Unplug size={14} /> {confirm === 'unpair' ? 'Подтвердите отвязку' : 'Отвязать телевизор'}
              </button>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

function LinkDeviceCard() {
  const [code, setCode] = useState('');
  return (
    <Section title="Подключить по коду" icon={<Link2 size={18} />}>
      <p className="mb-3 text-sm text-fg-muted">Код показан на экране телевизора или в приложении на телефоне.</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const c = normalizeLinkCode(code);
          if (c.length >= 6) navigate(`/link/${c}`);
        }}
      >
        <input
          className="field font-mono text-lg font-bold uppercase tracking-[0.25em]"
          value={code}
          maxLength={8}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ABC123"
        />
        <button className="btn-primary" disabled={normalizeLinkCode(code).length < 6}>
          Далее
        </button>
      </form>
    </Section>
  );
}

function TvSettingsCard() {
  const tvOnline = useStore((s) => s.presence.tvConnected);
  const [s, setS] = useState<TvSettings | null>(null);
  const [dir, setDir] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!tvOnline) return;
    void request<TvSettings>(Events.TV_SETTINGS_GET).then((r) => r.ok && r.data && setS(r.data));
  }, [tvOnline]);

  if (!tvOnline) return null;
  if (!s)
    return (
      <Section title="Настройки ТВ-клиента" icon={<KeyRound size={18} />}>
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      </Section>
    );

  const save = async (patch: Partial<TvSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    setSaving(true);
    const r = await request<TvSettings>(Events.TV_SETTINGS_UPDATE, patch);
    setSaving(false);
    if (!r.ok) toast(errorText(r.error), 'error');
    else if (r.data) setS(r.data);
  };

  return (
    <Section title="Настройки ТВ-клиента" icon={<KeyRound size={18} />} right={saving ? <Spinner size={16} /> : null}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="label">Ключ TMDb API (обложки и описания)</label>
          <input
            className="field mt-2 font-mono text-sm"
            defaultValue={s.tmdbApiKey}
            placeholder="Ключ v3 или токен v4 с themoviedb.org"
            onBlur={(e) => e.target.value.trim() !== s.tmdbApiKey && void save({ tmdbApiKey: e.target.value.trim() })}
          />
          <p className="mt-1.5 text-xs text-fg-dim">Бесплатно: themoviedb.org → Настройки → API.</p>
        </div>

        <div>
          <label className="label">Папки с медиа на ТВ-компьютере</label>
          <div className="mt-2 flex flex-col gap-1.5">
            {s.mediaDirs.map((d) => (
              <div key={d} className="flex items-center gap-2 rounded-xl bg-ink-800 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{d}</span>
                <button className="icon-btn h-7 w-7" onClick={() => save({ mediaDirs: s.mediaDirs.filter((x) => x !== d) })}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (dir.trim()) void save({ mediaDirs: [...s.mediaDirs, dir.trim()] }).then(() => setDir(''));
            }}
          >
            <input className="field font-mono text-sm" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="D:\Фильмы" />
            <button className="btn-soft" disabled={!dir.trim()}>
              <FolderPlus size={18} />
            </button>
          </form>
        </div>

        <div>
          <label className="label">Папка для загрузок</label>
          <input
            className="field mt-2 font-mono text-sm"
            defaultValue={s.downloadDir}
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== s.downloadDir && void save({ downloadDir: e.target.value.trim() })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-3 rounded-2xl bg-ink-800 px-4 py-3">
            <span className="flex-1 text-sm font-semibold">Запуск вместе с Windows</span>
            <Toggle checked={s.autostart} onChange={(v) => void save({ autostart: v })} />
          </div>
          <select className="field" value={s.language} onChange={(e) => void save({ language: e.target.value })}>
            <option value="ru-RU">Описания на русском</option>
            <option value="en-US">Описания на английском</option>
            <option value="sr-RS">Описания на сербском</option>
          </select>
        </div>

        <button className="btn-soft" onClick={() => act(Events.LIBRARY_RESCAN, {}, 'Медиатека обновляется')}>
          <RefreshCw size={16} /> Пересканировать медиатеку
        </button>
      </div>
    </Section>
  );
}

function AppCard() {
  const serverUrl = useStore((s) => s.serverUrl);
  const [volKeys, setVolKeys] = useState(getPref('volumeKeys', true));
  const [bg, setBg] = useState(getPref('bgControl', true));
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(serverUrl);
  const native = isNative();
  return (
    <Section title="Подключение" icon={native ? <Smartphone size={18} /> : <Server size={18} />}>
      {native && (
        <div className="mb-4 flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Кнопки громкости телефона</div>
            <div className="text-xs text-fg-dim">Управляют громкостью телевизора, пока открыт пульт</div>
          </div>
          <Toggle
            checked={volKeys}
            onChange={(v) => {
              setVolKeys(v);
              setPref('volumeKeys', v);
              void setVolumeKeysEnabled(v);
            }}
          />
        </div>
      )}
      {native && (
        <div className="mb-4 flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Управление при выключенном экране</div>
            <div className="text-xs text-fg-dim">Уведомление с кнопками и громкость ТВ кнопками телефона — даже на экране блокировки</div>
          </div>
          <Toggle
            checked={bg}
            onChange={(v) => {
              setBg(v);
              setPref('bgControl', v);
              const t = getToken();
              if (v && t) void startBackgroundControl(serverUrl, t);
              else void stopBackgroundControl();
            }}
          />
        </div>
      )}
      <div className="flex items-center gap-3 text-sm">
        <span className="text-fg-muted">Сервер</span>
        <span className="min-w-0 flex-1 truncate font-semibold">{hostOf(serverUrl)}</span>
        <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setEditing((v) => !v)}>
          Изменить
        </button>
      </div>
      {editing && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = url.trim();
            changeServer(v ? (/^https?:\/\//.test(v) ? v : `https://${v}`) : null);
            setEditing(false);
          }}
        >
          <input className="field" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn-soft">OK</button>
        </form>
      )}

    </Section>
  );
}
