import { useEffect, useMemo, useState } from 'react';
import type { IdleSettings, MediaItem, WidgetConfig } from '@tvbox/shared';
import { CustomWidget } from './CustomWidget';
import QRCode from 'qrcode';

interface Props {
  settings: IdleSettings;
  catalog: MediaItem[];
  backendUrl: string;
}

export function IdleScreen({ settings, catalog, backendUrl }: Props) {
  const widgets = settings.widgets.filter((w) => w.enabled);

  return (
    <div className="w-full h-full p-10 overflow-hidden">
      <div className="w-full h-full grid gap-6" style={{ gridTemplateColumns: 'repeat(6, 1fr)', gridTemplateRows: 'repeat(5, 1fr)' }}>
        {widgets.map((w) => (
          <div
            key={w.id}
            className="rounded-3xl bg-surface border border-line overflow-hidden"
            style={{ gridArea: w.gridArea || undefined }}
          >
            <WidgetContent widget={w} catalog={catalog} backendUrl={backendUrl} />
          </div>
        ))}
      </div>
    </div>
  );
}

function WidgetContent({ widget, catalog, backendUrl }: { widget: WidgetConfig; catalog: MediaItem[]; backendUrl: string }) {
  switch (widget.type) {
    case 'clock':
      return <Clock />;
    case 'weather':
      return <Weather city={widget.settings?.city as string | undefined} />;
    case 'qr':
      return <Qr backendUrl={backendUrl} />;
    case 'continue-watching':
      return <ContinueWatching catalog={catalog} />;
    case 'recently-added':
      return <RecentlyAdded catalog={catalog} />;
    case 'api':
      return widget.api ? <ApiWidget url={widget.api.url} /> : null;
    case 'custom':
      return widget.custom ? <CustomWidget config={widget.custom} /> : null;
    default:
      return null;
  }
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <div className="w-full h-full flex flex-col items-center justify-center p-8">
      <div className="text-8xl font-extralight tracking-tight tabular-nums">{time}</div>
      <div className="text-xl text-gray-400 mt-3 capitalize">{date}</div>
    </div>
  );
}

function Weather({ city }: { city?: string }) {
  const [data, setData] = useState<{ temp: number; code: number; wind: number } | null>(null);
  useEffect(() => {
    // Default to Moscow; city override uses geocoding
    const lat = city ? undefined : 55.7558;
    const lon = city ? undefined : 37.6173;
    let url: string;
    if (city) {
      url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`;
      fetch(url)
        .then((r) => r.json())
        .then((j) => {
          const r = j?.results?.[0];
          if (r) return fetch(`https://api.open-meteo.com/v1/forecast?latitude=${r.latitude}&longitude=${r.longitude}&current_weather=true`).then((x) => x.json());
          return null;
        })
        .then((j) => j && setData({ temp: j.current_weather.temperature, code: j.current_weather.weathercode, wind: j.current_weather.windspeed }))
        .catch(() => {});
    } else {
      url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
      fetch(url)
        .then((r) => r.json())
        .then((j) => setData({ temp: j.current_weather.temperature, code: j.current_weather.weathercode, wind: j.current_weather.windspeed }))
        .catch(() => {});
    }
  }, [city]);

  return (
    <div className="w-full h-full flex flex-col justify-center p-6">
      <div className="text-sm uppercase tracking-widest text-gray-500">{city || 'Moscow'}</div>
      {data ? (
        <>
          <div className="text-6xl font-light mt-2">{Math.round(data.temp)}°</div>
          <div className="text-gray-400 mt-1">{weatherLabel(data.code)} · {Math.round(data.wind)} km/h</div>
        </>
      ) : (
        <div className="text-gray-500">Loading…</div>
      )}
    </div>
  );
}

function weatherLabel(code: number): string {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 48) return 'Fog';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Showers';
  return 'Storm';
}

function Qr({ backendUrl }: { backendUrl: string }) {
  const [dataUrl, setDataUrl] = useState('');
  useEffect(() => {
    QRCode.toDataURL(backendUrl || 'http://localhost:3000', { margin: 1, width: 400 })
      .then(setDataUrl)
      .catch(() => {});
  }, [backendUrl]);
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-4 p-6">
      {dataUrl ? (
        <img src={dataUrl} alt="Connect QR" className="w-40 h-40 rounded-xl" />
      ) : (
        <div className="w-40 h-40 rounded-xl bg-raised" />
      )}
      <div className="text-center">
        <div className="font-medium">Connect your phone</div>
        <div className="text-sm text-gray-500 break-all">{backendUrl}</div>
      </div>
    </div>
  );
}

function ContinueWatching({ catalog }: { catalog: MediaItem[] }) {
  const items = catalog.filter((m) => m.progress && m.duration && m.progress > 0).slice(0, 6);
  return <PosterStrip items={items} empty="Nothing in progress" />;
}

function RecentlyAdded({ catalog }: { catalog: MediaItem[] }) {
  const items = [...catalog].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)).slice(0, 6);
  return <PosterStrip items={items} empty="Library is empty" />;
}

function PosterStrip({ items, empty }: { items: MediaItem[]; empty: string }) {
  if (!items.length) return <div className="w-full h-full flex items-center justify-center text-gray-600">{empty}</div>;
  return (
    <div className="w-full h-full p-5">
      <div className="flex gap-4 h-full">
        {items.map((m) => (
          <div key={m.id} className="flex-1 min-w-0 flex flex-col gap-2">
            <div className="flex-1 rounded-2xl bg-raised overflow-hidden">
              {m.poster ? (
                <img src={m.poster} alt={m.title} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-4xl">🎬</div>
              )}
            </div>
            <div className="text-sm truncate text-center">{m.title}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ApiWidget({ url }: { url: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then(setHtml)
      .catch(() => setHtml('<p>Failed to load</p>'));
  }, [url]);
  return <iframe title="api-widget" sandbox="" srcDoc={html} className="w-full h-full border-0" />;
}
