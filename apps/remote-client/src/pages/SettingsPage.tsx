import { useEffect, useState } from 'react';
import { useStore, useIsOwner } from '../store/store';
import type { PowerAction, WidgetConfig } from '@tvbox/shared';
import { Power, Moon, RotateCw, Plus, Trash2, User, Shield, Tv, Server, Loader2 } from 'lucide-react';

export function SettingsPage() {
  const { user, signOut, presence, guests, dictatorMode, setDictatorMode, updateGuests, sendPower, widgets, idleSettings, updateWidgets, serverUrl, connectTo, connected } =
    useStore();
  const isOwner = useIsOwner();
  const [email, setEmail] = useState('');
  const [urlInput, setUrlInput] = useState(serverUrl);
  const { socket } = useStore();

  useEffect(() => {
    if (isOwner && socket) {
      socket.emit('guests:get');
      socket.emit('widgets:get');
    }
  }, [isOwner, socket]);

  const addGuest = () => {
    if (!email.trim()) return;
    updateGuests([email.trim()], []);
    setEmail('');
  };

  const applyUrl = () => {
    if (urlInput.trim()) connectTo(urlInput.trim());
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Настройки</h1>

      {/* Server */}
      <section className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Server size={16} className="text-accent" />
          <h2 className="font-medium">Сервер</h2>
          <span className={`ml-auto text-xs flex items-center gap-1.5 ${connected ? 'text-emerald-400' : 'text-yellow-400'}`}>
            {connected ? '● Подключено' : 'Переподключение…'}
          </span>
        </div>
        <div className="flex gap-2">
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://tv.nemnogovova.com"
            className="flex-1 bg-raised border border-line rounded-xl px-3 py-2.5 text-sm outline-none focus:border-accent"
          />
          <button onClick={applyUrl} className="btn-primary !px-4">
            {!connected ? <Loader2 size={16} className="animate-spin" /> : 'Подключить'}
          </button>
        </div>
      </section>

      {/* Account */}
      <section className="card p-5 flex items-center gap-4">
        <div className="w-11 h-11 rounded-full bg-gradient-to-br from-accent to-accent2 flex items-center justify-center text-white font-semibold">
          {user?.name?.charAt(0)?.toUpperCase() || 'U'}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium truncate">{user?.name}</p>
          <p className="text-xs text-gray-500 truncate">{user?.email}</p>
        </div>
        <span className={`px-2 py-1 rounded-md text-[11px] uppercase tracking-wide ${user?.role === 'owner' ? 'bg-accent/15 text-accent' : 'bg-raised text-gray-400'}`}>
          {user?.role}
        </span>
        <button onClick={signOut} className="btn-ghost !py-2">
          Sign out
        </button>
      </section>

      {/* TV status */}
      <section className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Tv size={16} className="text-accent" />
          <h2 className="font-medium">TV Device</h2>
        </div>
        <p className="text-sm text-gray-400">
          Status: <span className={presence.tvConnected ? 'text-emerald-400' : 'text-red-400'}>{presence.tvConnected ? 'Online' : 'Offline'}</span>
        </p>
        {isOwner && (
          <div className="grid grid-cols-3 gap-2 mt-4">
            <PowerButton action="sleep" icon={Moon} label="Sleep" sendPower={sendPower} />
            <PowerButton action="reboot" icon={RotateCw} label="Reboot" sendPower={sendPower} />
            <PowerButton action="shutdown" icon={Power} label="Off" sendPower={sendPower} danger />
          </div>
        )}
      </section>

      {/* Admin */}
      {isOwner && (
        <>
          <section className="card p-5">
            <div className="flex items-center gap-2 mb-3">
              <Shield size={16} className="text-accent" />
              <h2 className="font-medium">Guests</h2>
            </div>
            <div className="flex gap-2 mb-3">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addGuest()}
                placeholder="guest@example.com"
                className="flex-1 bg-raised border border-line rounded-xl px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <button onClick={addGuest} className="btn-primary !px-3">
                <Plus size={16} />
              </button>
            </div>
            <div className="flex flex-col divide-y divide-line">
              {guests.length === 0 && <p className="text-sm text-gray-600 py-2">No guests yet</p>}
              {guests.map((g) => (
                <div key={g.email} className="flex items-center justify-between py-2">
                  <span className="text-sm">{g.email}</span>
                  <button onClick={() => updateGuests([], [g.email])} className="text-gray-500 hover:text-red-400">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="card p-5 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <User size={16} className="text-accent" />
                <h2 className="font-medium">Dictator mode</h2>
              </div>
              <p className="text-xs text-gray-500 mt-1">Block all guest commands</p>
            </div>
            <button
              onClick={() => setDictatorMode(!dictatorMode)}
              className={`relative w-12 h-7 rounded-full transition-colors ${dictatorMode ? 'bg-red-500' : 'bg-raised'}`}
            >
              <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${dictatorMode ? 'left-6' : 'left-1'}`} />
            </button>
          </section>

          <WidgetEditor widgets={widgets} idleSettings={idleSettings} onSave={updateWidgets} />
        </>
      )}
    </div>
  );
}

function PowerButton({
  action,
  icon: Icon,
  label,
  sendPower,
  danger,
}: {
  action: PowerAction;
  icon: typeof Power;
  label: string;
  sendPower: (a: PowerAction) => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={() => sendPower(action)}
      className={`flex flex-col items-center gap-1.5 py-3 rounded-xl border border-line text-xs ${
        danger ? 'text-red-400 hover:border-red-500/40' : 'text-gray-300 hover:border-accent/50'
      }`}
    >
      <Icon size={18} />
      {label}
    </button>
  );
}

function WidgetEditor({
  widgets,
  idleSettings,
  onSave,
}: {
  widgets: WidgetConfig[];
  idleSettings: import('@tvbox/shared').IdleSettings | null;
  onSave: (w: WidgetConfig[], s?: Partial<import('@tvbox/shared').IdleSettings>) => void;
}) {
  const [draft, setDraft] = useState<WidgetConfig[]>(widgets);
  const [screensaver, setScreensaver] = useState<string>(idleSettings?.screensaver || 'off');

  useEffect(() => {
    setDraft(widgets);
  }, [widgets]);
  useEffect(() => {
    setScreensaver(idleSettings?.screensaver || 'off');
  }, [idleSettings]);

  const save = () =>
    onSave(draft, { screensaver: screensaver as import('@tvbox/shared').IdleSettings['screensaver'] });

  const toggle = (id: string) => setDraft((d) => d.map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w)));

  const addCustom = () => {
    setDraft((d) => [
      ...d,
      {
        id: `custom-${Date.now()}`,
        type: 'custom',
        title: 'Custom widget',
        enabled: true,
        custom: { html: '<div class="widget">Hello, TV!</div>', css: '', js: '' },
      },
    ]);
  };

  const updateCustom = (id: string, field: 'html' | 'css' | 'js', value: string) => {
    setDraft((d) => d.map((w) => (w.id === id ? { ...w, custom: { ...w.custom!, [field]: value } } : w)));
  };

  return (
    <section className="card p-5">
      <h2 className="font-medium mb-3">Idle screen widgets</h2>
      <div className="flex flex-col gap-3">
        {draft.map((w) => (
          <div key={w.id} className="border border-line rounded-xl p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{w.title || w.type}</span>
              <button
                onClick={() => toggle(w.id)}
                className={`relative w-11 h-6 rounded-full transition-colors ${w.enabled ? 'bg-accent' : 'bg-raised'}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${w.enabled ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>
            {w.type === 'custom' && w.custom && (
              <div className="flex flex-col gap-2 mt-3">
                <textarea
                  value={w.custom.html}
                  onChange={(e) => updateCustom(w.id, 'html', e.target.value)}
                  placeholder="HTML"
                  rows={2}
                  className="w-full bg-raised border border-line rounded-lg px-2 py-1.5 text-xs font-mono outline-none focus:border-accent"
                />
                <textarea
                  value={w.custom.css}
                  onChange={(e) => updateCustom(w.id, 'css', e.target.value)}
                  placeholder="CSS"
                  rows={2}
                  className="w-full bg-raised border border-line rounded-lg px-2 py-1.5 text-xs font-mono outline-none focus:border-accent"
                />
                <textarea
                  value={w.custom.js}
                  onChange={(e) => updateCustom(w.id, 'js', e.target.value)}
                  placeholder="JS"
                  rows={2}
                  className="w-full bg-raised border border-line rounded-lg px-2 py-1.5 text-xs font-mono outline-none focus:border-accent"
                />
              </div>
            )}
          </div>
        ))}
        <div className="flex items-center gap-3">
          <button onClick={addCustom} className="btn-ghost !py-2">
            <Plus size={16} /> Add custom widget
          </button>
          <label className="text-xs text-gray-500 ml-auto flex items-center gap-2">
            Screensaver
            <select
              value={screensaver}
              onChange={(e) => setScreensaver(e.target.value)}
              className="bg-raised border border-line rounded-lg px-2 py-1.5 text-xs outline-none"
            >
              <option value="off">Off</option>
              <option value="black">Black</option>
              <option value="clock">Floating clock</option>
              <option value="wallpaper">Wallpaper</option>
            </select>
          </label>
        </div>
        <button onClick={save} className="btn-primary self-end">
          Save widgets
        </button>
      </div>
    </section>
  );
}
