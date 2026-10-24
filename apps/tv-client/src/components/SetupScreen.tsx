import { useEffect, useState } from 'react';
import type { TvInfo } from '../types';
import { Check, Loader2, AlertCircle, ArrowLeft, ArrowRight, FolderPlus, X, Eye, EyeOff, Play, Wifi } from 'lucide-react';

interface Props {
  initial: TvInfo | null;
  onDone: () => void;
}

export function SetupScreen({ initial, onDone }: Props) {
  const [step, setStep] = useState(0);
  const [url, setUrl] = useState(initial?.backendUrl || 'https://tv.nemnogovova.com');
  const [token, setToken] = useState(initial?.deviceToken || '');
  const [tmdb, setTmdb] = useState(initial?.tmdbApiKey || '');
  const [dirs, setDirs] = useState<string[]>(initial?.mediaDirs || []);
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (initial) {
      setUrl(initial.backendUrl || 'https://tv.nemnogovova.com');
      setToken(initial.deviceToken || '');
      setTmdb(initial.tmdbApiKey || '');
      setDirs(initial.mediaDirs || []);
    }
  }, [initial]);

  const test = async () => {
    if (!url.trim() || !token.trim()) {
      setTestResult({ ok: false, message: 'Enter the server address and device token first.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    const r = await window.tvbox.testConnection(url.trim(), token.trim());
    setTesting(false);
    setTestResult(r);
  };

  const addDir = async () => {
    const picked = await window.tvbox.pickDirectory();
    if (picked.length) {
      setDirs((d) => Array.from(new Set([...d, ...picked])));
    }
  };

  const removeDir = (dir: string) => setDirs((d) => d.filter((x) => x !== dir));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await window.tvbox.saveSettings({
        backendUrl: url.trim(),
        deviceToken: token.trim(),
        tmdbApiKey: tmdb.trim(),
        mediaDirs: dirs,
      });
      onDone();
    } catch {
      setError('Failed to save settings.');
      setSaving(false);
    }
  };

  const canNext = url.trim().length > 0 && token.trim().length > 0;

  return (
    <div className="min-h-screen w-full bg-base flex items-center justify-center p-6 text-white overflow-y-auto">
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-accent to-accent2 flex items-center justify-center">
            <Play size={22} className="ml-0.5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">TVBox</h1>
            <p className="text-sm text-gray-400">Настройка ТВ-клиента</p>
          </div>
        </div>

        {/* Step indicator */}
        <div className="flex gap-2 mb-8">
          {['Подключение', 'Медиатека'].map((label, i) => (
            <div key={label} className="flex-1">
              <div className={`h-1.5 rounded-full ${i <= step ? 'bg-accent' : 'bg-line'}`} />
              <p className={`text-xs mt-2 ${i === step ? 'text-white' : 'text-gray-500'}`}>
                {i + 1}. {label}
              </p>
            </div>
          ))}
        </div>

        <div className="card p-6 flex flex-col gap-5">
          {step === 0 ? (
            <>
              <div>
                <label className="text-sm text-gray-300 font-medium">Адрес сервера</label>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://tv.nemnogovova.com"
                  className="mt-1.5 w-full bg-raised border border-line rounded-xl px-3 py-2.5 text-sm outline-none focus:border-accent"
                  autoFocus
                />
              </div>

              <div>
                <label className="text-sm text-gray-300 font-medium">Токен устройства</label>
                <div className="relative mt-1.5">
                  <input
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    type={showToken ? 'text' : 'password'}
                    placeholder="Токен из .env сервера (DEVICE_TOKEN)"
                    className="w-full bg-raised border border-line rounded-xl px-3 py-2.5 pr-10 text-sm outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => setShowToken((s) => !s)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  >
                    {showToken ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </div>

              <button onClick={test} disabled={testing} className="btn-ghost w-full">
                {testing ? <Loader2 size={16} className="animate-spin" /> : <Wifi size={16} />}
                Проверить подключение
              </button>

              {testResult && (
                <div
                  className={`flex items-center gap-2 text-sm px-3 py-2.5 rounded-xl ${
                    testResult.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
                  }`}
                >
                  {testResult.ok ? <Check size={16} /> : <AlertCircle size={16} />}
                  {testResult.message}
                </div>
              )}

              <button onClick={() => setStep(1)} disabled={!canNext} className="btn-primary w-full py-3">
                Далее <ArrowRight size={16} />
              </button>
            </>
          ) : (
            <>
              <div>
                <label className="text-sm text-gray-300 font-medium">Папки с медиа</label>
                <div className="mt-1.5 flex flex-col gap-2">
                  {dirs.map((d) => (
                    <div key={d} className="flex items-center gap-2 bg-raised border border-line rounded-xl px-3 py-2 text-sm">
                      <span className="truncate flex-1 text-gray-200">{d}</span>
                      <button onClick={() => removeDir(d)} className="text-gray-500 hover:text-red-400 shrink-0">
                        <X size={15} />
                      </button>
                    </div>
                  ))}
                  <button onClick={addDir} className="btn-ghost">
                    <FolderPlus size={16} /> Выбрать папку
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-2">Видео/аудио/фото из этих папок появятся в каталоге.</p>
              </div>

              <div>
                <label className="text-sm text-gray-300 font-medium">TMDb API ключ (обложки и описания)</label>
                <input
                  value={tmdb}
                  onChange={(e) => setTmdb(e.target.value)}
                  placeholder="Необязательно"
                  className="mt-1.5 w-full bg-raised border border-line rounded-xl px-3 py-2.5 text-sm outline-none focus:border-accent"
                />
              </div>

              {error && <p className="text-sm text-red-400 flex items-center gap-2"><AlertCircle size={16} /> {error}</p>}

              <div className="flex gap-3">
                <button onClick={() => setStep(0)} className="btn-ghost flex-1">
                  <ArrowLeft size={16} /> Назад
                </button>
                <button onClick={save} disabled={saving} className="btn-primary flex-1 py-3">
                  {saving ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                  Начать
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
