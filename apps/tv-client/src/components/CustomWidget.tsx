import { useMemo } from 'react';
import type { CustomWidgetConfig } from '@tvbox/shared';

export function CustomWidget({ config }: { config: CustomWidgetConfig }) {
  const srcdoc = useMemo(() => {
    const { html, css, js } = config;
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:transparent;color:#e8e8f0;font-family:sans-serif;overflow:hidden}${css || ''}</style></head><body>${html || ''}<script>${js || ''}<\/script></body></html>`;
  }, [config]);

  return <iframe title="custom-widget" sandbox="allow-scripts" srcDoc={srcdoc} className="w-full h-full border-0" />;
}
