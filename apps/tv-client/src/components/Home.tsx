import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Film,
  Moon,
  Sun,
  Wind,
  Droplets,
  Smartphone,
} from 'lucide-react';
import { formatDuration, type IdleSettings, type MediaItem, type WidgetConfig } from '@tvbox/shared';
import type { TvStatus } from '../bridge';

export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const inProgress = (m: MediaItem) => !!m.position && !!m.duration && m.position > 30 && m.position < m.duration * 0.92;

export function Home({ idle, catalog, status }: { idle: IdleSettings; catalog: MediaItem[]; status: TvStatus }) {
  const widgets = idle.widgets.filter((w) => w.enabled);
  const backdrop = useMemo(() => {
    const withArt = catalog.filter((m) => m.backdrop);
    const recent = [...withArt].sort((a, b) => (b.watchedAt ?? b.addedAt) - (a.watchedAt ?? a.addedAt));
    return recent[0]?.backdrop;
  }, [catalog]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <Ambient image={idle.wallpaper || backdrop} />
      {/* every row (however many the widgets need) gets an equal share of the screen — nothing can push the layout */}
      <div
        className="relative grid h-full w-full gap-[1.6vw] overflow-hidden p-[3vw]"
        style={{ gridAutoFlow: 'dense', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridAutoRows: 'minmax(0, 1fr)' }}
      >
        {widgets.map((w) => (
          <div key={w.id} className="widget min-h-0 min-w-0 animate-rise" style={{ gridColumn: `span ${Math.min(12, w.w)}`, gridRow: `span ${Math.max(1, Math.min(6, w.h))}` }}>
            <Widget w={w} idle={idle} catalog={catalog} status={status} />
          </div>
        ))}
      </div>
      <ConnChip status={status} />
    </div>
  );
}

export function Ambient({ image }: { image?: string }) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {image ? (
        <img key={image} src={image} alt="" className="absolute inset-0 h-full w-full animate-drift object-cover opacity-40" />
      ) : (
        <>
          <div className="absolute -left-[10vw] -top-[20vh] h-[70vh] w-[60vw] rounded-full bg-ember/15 blur-[140px]" />
          <div className="absolute -bottom-[25vh] right-[-10vw] h-[70vh] w-[60vw] rounded-full bg-indigo-500/10 blur-[160px]" />
        </>
      )}
      <div className="absolute inset-0 bg-gradient-to-br from-ink-950/80 via-ink-950/60 to-ink-950/90" />
    </div>
  );
}

function ConnChip({ status }: { status: TvStatus }) {
  if (status.conn === 'online') return null;
  const text = status.conn === 'replaced' ? 'Подключён другой телевизор' : status.conn === 'connecting' ? 'Подключение к серверу…' : 'Нет связи с сервером';
  return (
    <div className="absolute bottom-[2vh] left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full bg-black/60 px-6 py-3 text-[1.1rem] text-fg-muted backdrop-blur">
      <span className="h-3 w-3 animate-pulse-dot rounded-full bg-warn" /> {text}
    </div>
  );
}

function Widget({ w, idle, catalog, status }: { w: WidgetConfig; idle: IdleSettings; catalog: MediaItem[]; status: TvStatus }) {
  switch (w.type) {
    case 'clock':
      return <ClockWidget />;
    case 'weather':
      return <WeatherWidget city={idle.weatherCity} />;
    case 'continue':
      return <PosterRow title="Продолжить просмотр" items={catalog.filter(inProgress).sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0))} wide empty="Здесь появится то, что вы начали смотреть" />;
    case 'recent':
      return <PosterRow title="Недавно добавленные" items={recentUnique(catalog)} empty="Медиатека пока пуста — скачайте что-нибудь с пульта" />;
    case 'qr':
      return <QrWidget url={status.publicUrl} />;
    case 'api':
      return <ApiWidget w={w} />;
    case 'custom':
      return <CustomWidget w={w} />;
    default:
      return null;
  }
}

/** Newest first, one card per show. */
function recentUnique(catalog: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  const out: MediaItem[] = [];
  for (const m of [...catalog].sort((a, b) => b.addedAt - a.addedAt)) {
    if (m.kind === 'audio') continue;
    const key = m.showKey || m.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

function ClockWidget() {
  const now = useNow();
  const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const d = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const date = d.charAt(0).toUpperCase() + d.slice(1);
  const hour = now.getHours();
  const greet = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
  return (
    <div className="flex h-full flex-col justify-end p-[2.4vw]">
      <div className="text-[1.5rem] font-semibold text-ember">{greet}</div>
      <div className="tabular text-[clamp(4rem,9vw,14rem)] font-extralight leading-[0.95] tracking-tight">{time}</div>
      <div className="mt-2 text-[1.8rem] font-medium text-fg-muted">{date}</div>
    </div>
  );
}

const WMO: Record<number, [string, typeof Sun]> = {
  0: ['Ясно', Sun],
  1: ['Преимущественно ясно', CloudSun],
  2: ['Переменная облачность', CloudSun],
  3: ['Пасмурно', Cloud],
  45: ['Туман', CloudFog],
  48: ['Изморозь', CloudFog],
  51: ['Морось', CloudDrizzle],
  53: ['Морось', CloudDrizzle],
  55: ['Сильная морось', CloudDrizzle],
  61: ['Небольшой дождь', CloudRain],
  63: ['Дождь', CloudRain],
  65: ['Ливень', CloudRain],
  71: ['Небольшой снег', CloudSnow],
  73: ['Снег', CloudSnow],
  75: ['Снегопад', CloudSnow],
  80: ['Ливневый дождь', CloudRain],
  81: ['Ливни', CloudRain],
  82: ['Сильные ливни', CloudRain],
  85: ['Снегопад', CloudSnow],
  86: ['Сильный снегопад', CloudSnow],
  95: ['Гроза', CloudLightning],
  96: ['Гроза с градом', CloudLightning],
  99: ['Гроза с градом', CloudLightning],
};

interface Weather {
  place: string;
  temp: number;
  code: number;
  wind: number;
  humidity: number;
  isDay: boolean;
  max: number;
  min: number;
  hours: { t: string; temp: number; code: number }[];
}

function WeatherWidget({ city }: { city: string }) {
  const [w, setW] = useState<Weather | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=ru&name=${encodeURIComponent(city || 'Belgrade')}`)).json();
        const r = g.results?.[0];
        if (!r) throw new Error('city');
        const f = await (
          await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${r.latitude}&longitude=${r.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,is_day&hourly=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&forecast_days=2&timezone=auto`,
          )
        ).json();
        const nowIdx = (f.hourly.time as string[]).findIndex((t) => new Date(t).getTime() > Date.now());
        const hours = [3, 6, 9, 12].map((d) => {
          const i = Math.max(0, nowIdx) + d - 1;
          return { t: String(f.hourly.time[i]).slice(11, 16), temp: f.hourly.temperature_2m[i], code: f.hourly.weather_code[i] };
        });
        if (!cancelled)
          setW({
            place: r.name,
            temp: f.current.temperature_2m,
            code: f.current.weather_code,
            wind: f.current.wind_speed_10m,
            humidity: f.current.relative_humidity_2m,
            isDay: !!f.current.is_day,
            max: f.daily.temperature_2m_max[0],
            min: f.daily.temperature_2m_min[0],
            hours,
          });
        setErr(false);
      } catch {
        if (!cancelled) setErr(true);
      }
    };
    void load();
    const t = setInterval(load, 15 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [city]);

  if (!w)
    return <div className="flex h-full items-center justify-center text-[1.3rem] text-fg-dim">{err ? 'Погода недоступна' : 'Загружаем погоду…'}</div>;
  const [label, Icon0] = WMO[w.code] || ['', Cloud];
  const Icon = !w.isDay && (w.code === 0 || w.code === 1) ? Moon : Icon0;
  return (
    <div className="flex h-full flex-col justify-between gap-[1vh] p-[1.8vw]">
      <div className="flex items-start justify-between">
        <div>
          <div className="label">{w.place}</div>
          <div className="mt-2 flex items-end gap-3">
            <span className="tabular text-[clamp(2.6rem,4.2vw,7rem)] font-light leading-none">{Math.round(w.temp)}°</span>
          </div>
          <div className="mt-1 text-[1.35rem] font-semibold">{label}</div>
          <div className="mt-1 flex items-center gap-4 text-[1.1rem] text-fg-muted">
            <span>
              ↑{Math.round(w.max)}° ↓{Math.round(w.min)}°
            </span>
            <span className="flex items-center gap-1">
              <Wind size={18} /> {Math.round(w.wind)} км/ч
            </span>
            <span className="flex items-center gap-1">
              <Droplets size={18} /> {w.humidity}%
            </span>
          </div>
        </div>
        <Icon size={76} strokeWidth={1.4} className="shrink-0 text-ember" />
      </div>
      <div className="grid grid-cols-4 gap-2">
        {w.hours.map((h) => {
          const HI = (WMO[h.code] || ['', Cloud])[1];
          return (
            <div key={h.t} className="flex items-center justify-center gap-2 rounded-2xl bg-white/[0.04] py-[0.6vh]">
              <span className="text-[1rem] text-fg-dim">{h.t}</span>
              <HI size={22} strokeWidth={1.6} />
              <span className="tabular text-[1.2rem] font-semibold">{Math.round(h.temp)}°</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PosterRow({ title, items, wide, empty }: { title: string; items: MediaItem[]; wide?: boolean; empty: string }) {
  return (
    <div className="flex h-full flex-col p-[1.6vw]">
      <div className="label mb-[1.2vh]">{title}</div>
      {items.length === 0 ? (
        <div className="flex flex-1 items-center gap-4 text-[1.3rem] text-fg-dim">
          <Film size={32} /> {empty}
        </div>
      ) : (
        // absolutely positioned row → definite height, so posters can never stretch the grid
        <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex gap-[1vw] overflow-hidden">
          {items.slice(0, 12).map((m) =>
            wide ? (
              <div key={m.id} className="relative aspect-video h-full shrink-0 overflow-hidden rounded-2xl bg-ink-750">
                {(m.backdrop || m.poster) && <img src={m.backdrop || m.poster} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/30 to-transparent" />
                <div className="absolute inset-x-[0.9vw] bottom-[0.9vw]">
                  <div className="truncate text-[1.25rem] font-bold">{m.title}</div>
                  <div className="text-[1rem] text-fg-muted">
                    {m.kind === 'episode' ? `S${m.season ?? 1}E${m.episode ?? '?'} · ` : ''}осталось {formatDuration((m.duration || 0) - (m.position || 0))}
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/20">
                    <div className="h-full bg-ember" style={{ width: `${((m.position || 0) / (m.duration || 1)) * 100}%` }} />
                  </div>
                </div>
              </div>
            ) : (
              <div key={m.id} className="aspect-[2/3] h-full shrink-0">
                <div className="relative h-full w-full overflow-hidden rounded-2xl bg-gradient-to-br from-ink-700 to-ink-800">
                  {m.poster ? (
                    <img src={m.poster} alt="" className="absolute inset-0 h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center p-3 text-center text-[1rem] font-semibold text-fg-muted">{m.title}</div>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
        </div>
      )}
    </div>
  );
}

function QrWidget({ url }: { url: string }) {
  const [img, setImg] = useState('');
  useEffect(() => {
    void QRCode.toDataURL(url, { margin: 1, width: 480, color: { dark: '#0b0c10', light: '#ffffff' } }).then(setImg);
  }, [url]);
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-[1.2vh] p-[1.4vw] text-center">
      {img && <img src={img} alt="" className="aspect-square min-h-0 w-auto flex-1 rounded-2xl" />}
      <div className="flex items-center gap-2 text-[1.1rem] font-semibold text-fg-muted">
        <Smartphone size={18} className="text-ember" /> Пульт: {host}
      </div>
    </div>
  );
}

function getPath(obj: unknown, p: string): unknown {
  if (!p) return obj;
  return p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function ApiWidget({ w }: { w: WidgetConfig }) {
  const [value, setValue] = useState<string>('…');
  useEffect(() => {
    if (!w.apiUrl) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(w.apiUrl!);
        const text = await res.text();
        let v: unknown = text;
        try {
          v = getPath(JSON.parse(text), w.apiPath || '');
        } catch {
          // plain text
        }
        if (!cancelled) setValue(typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v));
      } catch {
        if (!cancelled) setValue('нет данных');
      }
    };
    void load();
    const t = setInterval(load, Math.max(15, w.apiRefreshSec || 300) * 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [w.apiUrl, w.apiPath, w.apiRefreshSec]);
  const long = value.length > 24;
  return (
    <div className="flex h-full flex-col justify-center p-[2vw]">
      <div className="label">{w.title}</div>
      <div className={`mt-2 overflow-hidden font-light ${long ? 'whitespace-pre-wrap text-[1.4rem]' : 'tabular text-[clamp(2.4rem,4vw,6rem)] leading-none'}`}>{value}</div>
    </div>
  );
}

function CustomWidget({ w }: { w: WidgetConfig }) {
  const doc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:transparent;color:#eceef3;font-family:'Segoe UI',system-ui,sans-serif;overflow:hidden}${w.css || ''}</style></head><body>${w.html || ''}<script>${(w.js || '').replace(/<\/script/gi, '<\\/script')}<\/script></body></html>`,
    [w.html, w.css, w.js],
  );
  return <iframe title={w.title || 'widget'} sandbox="allow-scripts" srcDoc={doc} className="h-full w-full border-0 bg-transparent" />;
}
