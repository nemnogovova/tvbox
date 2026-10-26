import { useEffect, useRef } from 'react';
import { Camera, FileVideo, ImagePlus, MonitorUp, Radio, Square, SwitchCamera } from 'lucide-react';
import { useStore } from '../store/store';
import { startCameraCast, startFileCast, startScreenCast, stopCast, useCast } from '../store/cast';
import { Spinner, cx } from '../components/ui';

const canScreen = () => typeof navigator.mediaDevices?.getDisplayMedia === 'function';

export function CastPage() {
  const tvOnline = useStore((s) => s.presence.tvConnected);
  const { session, status, busy } = useCast();
  const fileRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const mediaHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = mediaHost.current;
    const el = session?.media;
    if (!host || !el) return;
    el.className = 'w-full max-h-[50vh] rounded-2xl bg-black';
    host.appendChild(el);
    return () => {
      if (el.parentElement === host) host.removeChild(el);
    };
  }, [session]);

  const disabled = !tvOnline || busy;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="h-page">Трансляция</h1>
        <p className="mt-1 text-sm text-fg-muted">Напрямую на телевизор по WebRTC — без загрузки на сервер.</p>
      </div>

      {session && (
        <div className="panel overflow-hidden">
          <div className="flex items-center gap-3 p-4">
            <div className={cx('flex h-11 w-11 items-center justify-center rounded-2xl', status === 'live' ? 'bg-ember/15 text-ember' : 'bg-ink-750 text-fg-muted')}>
              {status === 'live' ? <Radio size={20} className="animate-pulse-dot" /> : <Spinner />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="label">{status === 'live' ? 'В эфире' : 'Подключаемся…'}</div>
              <div className="truncate text-sm font-bold">{session.label}</div>
            </div>
            <button className="btn-danger" onClick={stopCast}>
              <Square size={15} fill="currentColor" /> Стоп
            </button>
          </div>
          {session.media && <div ref={mediaHost} className="px-4 pb-4" />}
          {session.kind === 'image' && (
            <div className="px-4 pb-4">
              <button className="btn-soft w-full" onClick={() => photoRef.current?.click()}>
                <ImagePlus size={16} /> Показать другое фото
              </button>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <CastTile
          icon={<FileVideo size={26} />}
          title="Видео или музыка"
          text="Файл с этого устройства"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
        />
        <CastTile
          icon={<ImagePlus size={26} />}
          title="Фото"
          text="Без потери качества"
          disabled={disabled}
          onClick={() => photoRef.current?.click()}
        />
        <CastTile
          icon={<MonitorUp size={26} />}
          title="Экран"
          text={canScreen() ? 'Окно, вкладку или весь экран' : 'Доступно в браузере на ПК'}
          disabled={disabled || !canScreen()}
          onClick={() => void startScreenCast()}
        />
        <CastTile
          icon={<Camera size={26} />}
          title="Камера"
          text="Прямой эфир с камеры"
          disabled={disabled}
          onClick={() => void startCameraCast('environment')}
          extra={
            <button
              className="icon-btn h-9 w-9"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                void startCameraCast('user');
              }}
              title="Фронтальная камера"
            >
              <SwitchCamera size={16} />
            </button>
          }
        />
      </div>

      {!tvOnline && <p className="text-center text-sm text-warn">Телевизор не в сети — трансляция недоступна.</p>}
      <p className="text-center text-xs leading-relaxed text-fg-dim">
        Совет: на компьютере можно просто перетащить файл в окно пульта.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="video/*,audio/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void startFileCast(f);
          e.target.value = '';
        }}
      />
      <input
        ref={photoRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void startFileCast(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function CastTile({
  icon,
  title,
  text,
  onClick,
  disabled,
  extra,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  onClick: () => void;
  disabled?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !disabled && onClick()}
      onKeyDown={(e) => e.key === 'Enter' && !disabled && onClick()}
      className={cx(
        'panel group flex cursor-pointer items-center gap-4 p-5 transition hover:border-ember/40 active:scale-[0.99]',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-750 text-ember transition group-hover:bg-ember group-hover:text-ink-950">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="font-bold">{title}</div>
        <div className="text-sm text-fg-muted">{text}</div>
      </div>
      {extra}
    </div>
  );
}
