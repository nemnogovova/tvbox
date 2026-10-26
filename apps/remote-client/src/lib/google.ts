/* Google Identity Services: renders the official "Sign in with Google" button. */

interface GoogleId {
  initialize: (opts: {
    client_id: string;
    callback: (resp: { credential?: string }) => void;
    auto_select?: boolean;
    use_fedcm_for_prompt?: boolean;
    itp_support?: boolean;
  }) => void;
  renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
  disableAutoSelect: () => void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleId } };
  }
}

let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => (window.google?.accounts?.id ? resolve() : reject(new Error('gsi')));
    s.onerror = () => {
      loading = null;
      reject(new Error('Не удалось загрузить Google Sign-In'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export async function renderGoogleButton(clientId: string, el: HTMLElement, onCredential: (c: string) => void): Promise<void> {
  await loadScript();
  const id = window.google!.accounts!.id!;
  id.initialize({
    client_id: clientId,
    callback: (resp) => resp.credential && onCredential(resp.credential),
    itp_support: true,
  });
  el.innerHTML = '';
  id.renderButton(el, {
    type: 'standard',
    theme: 'filled_black',
    size: 'large',
    shape: 'pill',
    text: 'continue_with',
    logo_alignment: 'left',
    locale: 'ru',
    width: Math.min(320, Math.max(220, el.clientWidth || 300)),
  });
}

export function googleSignOut(): void {
  window.google?.accounts?.id?.disableAutoSelect();
}
