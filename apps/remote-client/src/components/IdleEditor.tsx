import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Code2, Film, Globe, Image as ImageIcon, LayoutDashboard, Link2, Pencil, Plus, Trash2, Upload, Youtube } from 'lucide-react';
import { DEFAULT_IDLE_SETTINGS, Events, classifyLink, extractYouTubeId, extractYouTubeList, type IdleSettings, type ScreensaverItem, type UploadEndResult, type WidgetConfig } from '@tvbox/shared';
import { act, errorText, request, toast, useStore } from '../store/store';
import { Section, Segmented, Sheet, Spinner, Toggle, cx } from './ui';

const TYPE_LABEL: Record<WidgetConfig['type'], string> = {
  clock: 'Часы и дата',
  weather: 'Погода',
  continue: 'Продолжить просмотр',
  recent: 'Недавно добавленные',
  qr: 'QR-код для подключения',
  api: 'Виджет по API',
  custom: 'Свой HTML/CSS/JS',
};

const SAMPLE_HTML = `<div class="box">
  <div class="big" id="v">…</div>
  <div class="small">Курс USD → RSD</div>
</div>`;
const SAMPLE_CSS = `.box{height:100%;display:flex;flex-direction:column;justify-content:center;padding:28px}
.big{font-size:64px;font-weight:200}
.small{opacity:.6;font-size:20px}`;
const SAMPLE_JS = `fetch('https://open.er-api.com/v6/latest/USD')
  .then(r => r.json())
  .then(j => document.getElementById('v').textContent = j.rates.RSD.toFixed(2));`;

export function IdleEditor() {
  const idle = useStore((s) => s.idle);
  const tvOnline = useStore((s) => s.presence.tvConnected);
  const [draft, setDraft] = useState<IdleSettings>(idle || DEFAULT_IDLE_SETTINGS);
  const [dirty, setDirty] = useState(false);
  const [edit, setEdit] = useState<WidgetConfig | null>(null);

  useEffect(() => {
    if (tvOnline && !idle) void request(Events.IDLE_GET).then((r) => r.ok && r.data && useStore.setState({ idle: r.data as IdleSettings }));
  }, [tvOnline, idle]);
  useEffect(() => {
    if (idle && !dirty) setDraft(idle);
  }, [idle, dirty]);

  const update = (patch: Partial<IdleSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const setWidgets = (fn: (w: WidgetConfig[]) => WidgetConfig[]) => update({ widgets: fn(draft.widgets) });
  const move = (i: number, d: -1 | 1) =>
    setWidgets((w) => {
      const next = [...w];
      const j = i + d;
      if (j < 0 || j >= next.length) return w;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = async () => {
    const r = await act(Events.IDLE_UPDATE, draft, 'Экран ожидания обновлён');
    if (r.ok) setDirty(false);
  };

  if (!tvOnline) return null;

  return (
    <Section title="Экран ожидания ТВ" icon={<LayoutDashboard size={18} />}>
      <div className="flex flex-col gap-2">
        {draft.widgets.map((w, i) => (
          <div key={w.id} className={cx('flex items-center gap-2 rounded-2xl bg-ink-800 py-2 pl-4 pr-2', !w.enabled && 'opacity-60')}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{w.title || TYPE_LABEL[w.type]}</div>
              <div className="text-[11px] text-fg-dim">
                {w.w}×{w.h} {w.type === 'api' || w.type === 'custom' ? `· ${TYPE_LABEL[w.type]}` : ''}
              </div>
            </div>
            <button className="icon-btn h-8 w-8" onClick={() => move(i, -1)} disabled={i === 0}>
              <ArrowUp size={15} />
            </button>
            <button className="icon-btn h-8 w-8" onClick={() => move(i, 1)} disabled={i === draft.widgets.length - 1}>
              <ArrowDown size={15} />
            </button>
            <button className="icon-btn h-8 w-8" onClick={() => setEdit(w)}>
              <Pencil size={14} />
            </button>
            <Toggle checked={w.enabled} onChange={(v) => setWidgets((ws) => ws.map((x) => (x.id === w.id ? { ...x, enabled: v } : x)))} />
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          className="btn-soft text-xs"
          onClick={() => setEdit({ id: `api-${Date.now()}`, type: 'api', title: 'Новый виджет', enabled: true, w: 4, h: 2, apiUrl: '', apiPath: '', apiRefreshSec: 300 })}
        >
          <Globe size={15} /> Виджет по API
        </button>
        <button
          className="btn-soft text-xs"
          onClick={() => setEdit({ id: `custom-${Date.now()}`, type: 'custom', title: 'Мой виджет', enabled: true, w: 4, h: 3, html: SAMPLE_HTML, css: SAMPLE_CSS, js: SAMPLE_JS })}
        >
          <Code2 size={15} /> HTML / CSS / JS
        </button>
      </div>

      <HomeBackgroundEditor draft={draft} update={update} />

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Город для погоды</label>
          <input className="field mt-2" value={draft.weatherCity} onChange={(e) => update({ weatherCity: e.target.value })} />
        </div>
        <div>
          <label className="label">Заставка через, мин</label>
          <input
            className="field mt-2"
            inputMode="numeric"
            value={draft.screensaverMinutes}
            onChange={(e) => update({ screensaverMinutes: Math.max(1, Math.min(240, Number(e.target.value.replace(/\D/g, '')) || 1)) })}
          />
        </div>
      </div>
      <div className="mt-3">
        <label className="label">Заставка</label>
        <div className="mt-2 overflow-x-auto">
          <Segmented<IdleSettings['screensaver']>
            value={draft.screensaver}
            onChange={(v) => update({ screensaver: v })}
            options={[
              { value: 'clock', label: 'Часы' },
              { value: 'media', label: 'Фото и видео' },
              { value: 'wallpaper', label: 'Обложки' },
              { value: 'black', label: 'Чёрный' },
              { value: 'off', label: 'Нет' },
            ]}
          />
        </div>
      </div>
      {draft.screensaver === 'media' && <ScreensaverMediaEditor draft={draft} update={update} />}

      <button className="btn-primary mt-5 w-full" disabled={!dirty} onClick={save}>
        {dirty ? 'Применить на телевизоре' : 'Сохранено'}
      </button>

      {edit && (
        <WidgetSheet
          widget={edit}
          isNew={!draft.widgets.some((w) => w.id === edit.id)}
          onClose={() => setEdit(null)}
          onSave={(w) => {
            setWidgets((ws) => (ws.some((x) => x.id === w.id) ? ws.map((x) => (x.id === w.id ? w : x)) : [...ws, w]));
            setEdit(null);
          }}
          onDelete={() => {
            setWidgets((ws) => ws.filter((x) => x.id !== edit.id));
            setEdit(null);
          }}
        />
      )}
    </Section>
  );
}

function WidgetSheet({
  widget,
  isNew,
  onClose,
  onSave,
  onDelete,
}: {
  widget: WidgetConfig;
  isNew: boolean;
  onClose: () => void;
  onSave: (w: WidgetConfig) => void;
  onDelete: () => void;
}) {
  const [w, setW] = useState(widget);
  const [tab, setTab] = useState<'html' | 'css' | 'js'>('html');
  const builtIn = !['api', 'custom'].includes(w.type);
  const preview = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#151820;color:#eceef3;font-family:system-ui,sans-serif;overflow:hidden}${w.css || ''}</style></head><body>${w.html || ''}<script>${(w.js || '').replace(/<\/script/gi, '<\\/script')}<\/script></body></html>`,
    [w.html, w.css, w.js],
  );

  return (
    <Sheet open onClose={onClose} title={isNew ? 'Новый виджет' : w.title || TYPE_LABEL[w.type]} wide>
      <div className="flex flex-col gap-3">
        {!builtIn && (
          <>
            <label className="label">Заголовок</label>
            <input className="field" value={w.title || ''} onChange={(e) => setW({ ...w, title: e.target.value })} />
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Ширина (из 12)</label>
            <select className="field mt-2" value={w.w} onChange={(e) => setW({ ...w, w: Number(e.target.value) })}>
              {[3, 4, 5, 6, 7, 8, 9, 12].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Высота (из 6)</label>
            <select className="field mt-2" value={w.h} onChange={(e) => setW({ ...w, h: Number(e.target.value) })}>
              {[1, 2, 3, 4, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        {w.type === 'api' && (
          <>
            <label className="label">URL (JSON или текст)</label>
            <input className="field font-mono text-sm" value={w.apiUrl || ''} onChange={(e) => setW({ ...w, apiUrl: e.target.value })} placeholder="https://api.example.com/data" />
            <label className="label">Путь к значению в JSON (необязательно)</label>
            <input className="field font-mono text-sm" value={w.apiPath || ''} onChange={(e) => setW({ ...w, apiPath: e.target.value })} placeholder="data.items.0.price" />
            <label className="label">Обновлять каждые, сек</label>
            <input className="field" inputMode="numeric" value={w.apiRefreshSec ?? 300} onChange={(e) => setW({ ...w, apiRefreshSec: Number(e.target.value.replace(/\D/g, '')) || 60 })} />
          </>
        )}

        {w.type === 'custom' && (
          <>
            <Segmented<'html' | 'css' | 'js'>
              value={tab}
              onChange={setTab}
              options={[
                { value: 'html', label: 'HTML' },
                { value: 'css', label: 'CSS' },
                { value: 'js', label: 'JS' },
              ]}
            />
            <textarea
              spellCheck={false}
              className="field min-h-[180px] resize-y font-mono text-[13px] leading-relaxed"
              value={(w[tab] as string) || ''}
              onChange={(e) => setW({ ...w, [tab]: e.target.value })}
            />
            <div className="label">Предпросмотр</div>
            <div className="overflow-hidden rounded-2xl ring-1 ring-white/10" style={{ aspectRatio: `${w.w * 1.6} / ${w.h}`, maxHeight: 260 }}>
              <iframe title="preview" sandbox="allow-scripts" srcDoc={preview} className="h-full w-full border-0" />
            </div>
            <p className="text-xs text-fg-dim">Код выполняется в изолированном iframe без доступа к TVBox.</p>
          </>
        )}

        <div className="mt-2 flex gap-2">
          {!builtIn && !isNew && (
            <button className="btn-danger" onClick={onDelete}>
              <Trash2 size={16} />
            </button>
          )}
          <button className="btn-soft flex-1" onClick={onClose}>
            Отмена
          </button>
          <button className="btn-primary flex-1" onClick={() => onSave(w)}>
            {isNew ? (
              <>
                <Plus size={16} /> Добавить
              </>
            ) : (
              'Готово'
            )}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Screensaver pictures & videos: links or files uploaded to the TV
// ---------------------------------------------------------------------------

const VIDEO_RE = /\.(mp4|webm|m4v|mov)(\?|#|$)/i;
const CHUNK = 512 * 1024;

async function uploadToTv(file: File, onProgress: (p: number) => void, purpose: 'screensaver' | 'wallpaper' = 'screensaver'): Promise<UploadEndResult> {
  const begin = await request<{ uploadId: string; chunkSize?: number }>(Events.UPLOAD_BEGIN, { name: file.name, size: file.size, type: file.type, purpose });
  if (!begin.ok || !begin.data) throw new Error(errorText(begin.error));
  const { uploadId } = begin.data;
  const size = Math.min(begin.data.chunkSize || CHUNK, CHUNK);
  let index = 0;
  for (let off = 0; off < file.size; off += size) {
    const data = await file.slice(off, off + size).arrayBuffer();
    let r = await request(Events.UPLOAD_CHUNK, { uploadId, index, data }, 60000);
    if (!r.ok && r.error === 'tv_timeout') r = await request(Events.UPLOAD_CHUNK, { uploadId, index, data }, 60000);
    if (!r.ok) throw new Error(errorText(r.error));
    index++;
    onProgress(Math.min(1, (off + size) / file.size));
  }
  const end = await request<UploadEndResult>(Events.UPLOAD_END, { uploadId }, 90000);
  if (!end.ok || !end.data) throw new Error(errorText(end.error));
  return end.data;
}

/** What the remote shows for a screensaver item: the TV's preview, YouTube's thumbnail or the picture itself. */
export function previewOf(it: Pick<ScreensaverItem, 'type' | 'src' | 'thumb'>): string | null {
  if (it.thumb) return it.thumb;
  if (it.type === 'youtube') {
    const id = extractYouTubeId(it.src);
    return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
  }
  if (it.type === 'image' && /^https?:/i.test(it.src)) return it.src;
  return null;
}

const itemLabel = (it: ScreensaverItem) =>
  it.name || (it.type === 'youtube' ? (extractYouTubeList(it.src) && !extractYouTubeId(it.src) ? 'Плейлист YouTube' : 'YouTube') : it.src.replace(/^tvbox-file:|^https?:\/\//, ''));

function ScreensaverMediaEditor({ draft, update }: { draft: IdleSettings; update: (p: Partial<IdleSettings>) => void }) {
  const items = draft.screensaverMedia || [];
  const [url, setUrl] = useState('');
  const [uploading, setUploading] = useState<{ name: string; p: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const setItems = (next: ScreensaverItem[]) => update({ screensaverMedia: next });
  const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const addUrl = () => {
    let u = url.trim();
    if (classifyLink(u) === 'youtube') {
      if (!/^https?:/i.test(u)) u = `https://${u}`;
      if (!extractYouTubeId(u) && !extractYouTubeList(u)) return toast('В ссылке нет ни видео, ни плейлиста YouTube', 'error');
      setItems([...items, { id: newId(), type: 'youtube', src: u }]);
      setUrl('');
      return;
    }
    if (!/^https?:\/\//i.test(u)) return toast('Нужна ссылка, начинающаяся с http(s)://', 'error');
    setItems([...items, { id: newId(), type: VIDEO_RE.test(u) ? 'video' : 'image', src: u }]);
    setUrl('');
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    let next = [...items];
    for (const f of Array.from(files)) {
      const isVideo = f.type.startsWith('video/') || VIDEO_RE.test(f.name);
      if (!isVideo && !f.type.startsWith('image/')) {
        toast(`${f.name}: это не картинка и не видео`, 'error');
        continue;
      }
      setUploading({ name: f.name, p: 0 });
      try {
        const up = await uploadToTv(f, (p) => setUploading({ name: f.name, p }));
        next = [...next, { id: newId(), type: isVideo ? 'video' : 'image', src: up.src, name: f.name, thumb: up.thumb }];
        setItems(next);
      } catch (e) {
        toast(`${f.name}: ${(e as Error).message}`, 'error');
      }
    }
    setUploading(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="mt-4 rounded-2xl bg-ink-800 p-4">
      <div className="label mb-3">Картинки и видео для заставки · {items.length}</div>
      {items.length > 0 && (
        <div className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {items.map((it) => {
            const pic = previewOf(it);
            return (
              <div key={it.id} className="group relative aspect-video overflow-hidden rounded-xl bg-ink-750">
                {pic ? (
                  <img src={pic} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-fg-dim">
                    {it.type === 'video' ? <Film size={20} /> : it.type === 'youtube' ? <Youtube size={20} /> : <ImageIcon size={20} />}
                    <span className="w-full truncate text-center text-[10px]">{itemLabel(it)}</span>
                  </div>
                )}
                <button
                  className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white"
                  onClick={() => setItems(items.filter((x) => x.id !== it.id))}
                  aria-label="Убрать"
                >
                  <Trash2 size={13} />
                </button>
                {it.type !== 'image' && (
                  <span className={cx('absolute bottom-1 left-1 rounded px-1.5 text-[9px] font-bold uppercase', it.type === 'youtube' ? 'bg-[#ff0033]/90 text-white' : 'bg-black/70')}>
                    {it.type === 'youtube' ? 'YouTube' : 'видео'}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          addUrl();
        }}
      >
        <div className="relative flex-1">
          <Link2 size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-dim" />
          <input className="field pl-9" placeholder="Картинка, видео (.mp4) или YouTube" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" />
        </div>
        <button className="btn-soft" disabled={!url.trim()}>
          <Plus size={16} />
        </button>
      </form>
      <input ref={fileRef} type="file" accept="image/*,video/mp4,video/webm,video/quicktime" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
      <button className="btn-soft mt-2 w-full" disabled={!!uploading} onClick={() => fileRef.current?.click()}>
        {uploading ? (
          <>
            <Spinner size={15} /> {uploading.name.slice(0, 24)} · {Math.round(uploading.p * 100)}%
          </>
        ) : (
          <>
            <Upload size={16} /> Загрузить с устройства
          </>
        )}
      </button>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Смена картинки, сек</label>
          <input
            className="field mt-2"
            inputMode="numeric"
            value={draft.screensaverInterval ?? 20}
            onChange={(e) => update({ screensaverInterval: Math.max(5, Math.min(3600, Number(e.target.value.replace(/\D/g, '')) || 5)) })}
          />
        </div>
        <div className="flex flex-col justify-end gap-2">
          <label className="flex items-center gap-3 text-sm font-semibold">
            <span className="flex-1">Вперемешку</span>
            <Toggle checked={draft.screensaverShuffle !== false} onChange={(v) => update({ screensaverShuffle: v })} />
          </label>
          <label className="flex items-center gap-3 text-sm font-semibold">
            <span className="flex-1">Часы поверх</span>
            <Toggle checked={draft.screensaverClock !== false} onChange={(v) => update({ screensaverClock: v })} />
          </label>
          <label className="flex items-center gap-3 text-sm font-semibold">
            <span className="flex-1">Видео без звука</span>
            <Toggle checked={draft.screensaverMuted !== false} onChange={(v) => update({ screensaverMuted: v })} />
          </label>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-fg-dim">Загруженные файлы хранятся на ТВ-компьютере. Видео и ролики YouTube меняются, когда доиграют до конца (плейлист YouTube играет по кругу). Не забудьте нажать «Применить».</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home screen background
// ---------------------------------------------------------------------------

function HomeBackgroundEditor({ draft, update }: { draft: IdleSettings; update: (p: Partial<IdleSettings>) => void }) {
  const mode = draft.homeBackground || (draft.wallpaper ? 'image' : 'auto');
  const [url, setUrl] = useState('');
  const [uploading, setUploading] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pic = draft.wallpaperThumb || (draft.wallpaper && /^https?:/i.test(draft.wallpaper) ? draft.wallpaper : null);

  const upload = async (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) return toast(`${f.name}: это не картинка`, 'error');
    setUploading(0);
    try {
      const up = await uploadToTv(f, setUploading, 'wallpaper');
      update({ homeBackground: 'image', wallpaper: up.src, wallpaperThumb: up.thumb });
    } catch (e) {
      toast(`${f.name}: ${(e as Error).message}`, 'error');
    }
    setUploading(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="mt-5">
      <label className="label">Фон главного экрана</label>
      <div className="mt-2 overflow-x-auto">
        <Segmented<NonNullable<IdleSettings['homeBackground']>>
          value={mode}
          onChange={(v) => update({ homeBackground: v })}
          options={[
            { value: 'auto', label: 'Из фильмов' },
            { value: 'image', label: 'Своя картинка' },
            { value: 'plain', label: 'Нет' },
          ]}
        />
      </div>
      {mode === 'auto' && <p className="mt-2 text-xs text-fg-dim">Кадр из фильма или сериала, который смотрели последним.</p>}
      {mode === 'image' && (
        <div className="mt-3 flex flex-col gap-2 rounded-2xl bg-ink-800 p-3">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-ink-750">
            {pic ? (
              <img src={pic} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-fg-dim">
                <ImageIcon size={22} />
                {draft.wallpaper ? 'Картинка выбрана' : 'Картинка не выбрана'}
              </div>
            )}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const u = url.trim();
              if (!/^https?:\/\//i.test(u)) return toast('Нужна ссылка на картинку, начинающаяся с http(s)://', 'error');
              update({ homeBackground: 'image', wallpaper: u, wallpaperThumb: undefined });
              setUrl('');
            }}
          >
            <input className="field flex-1" placeholder="Ссылка на картинку" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" />
            <button className="btn-soft" disabled={!url.trim()} aria-label="Поставить">
              <Plus size={16} />
            </button>
          </form>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void upload(e.target.files?.[0])} />
          <button className="btn-soft w-full" disabled={uploading !== null} onClick={() => fileRef.current?.click()}>
            {uploading !== null ? (
              <>
                <Spinner size={15} /> Загрузка · {Math.round(uploading * 100)}%
              </>
            ) : (
              <>
                <Upload size={16} /> Загрузить с устройства
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
