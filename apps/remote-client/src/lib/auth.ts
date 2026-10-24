/* Google Identity Services (GIS) integration.
 * Uses the official "Sign in with Google" button (renderButton) so we avoid the
 * deprecated One Tap `prompt()` UI-status methods flagged by the FedCM migration. */

interface CredentialResponse {
  credential?: string;
}

interface GoogleAccountId {
  initialize: (opts: { client_id: string; callback: (resp: CredentialResponse) => void }) => void;
  renderButton: (
    el: HTMLElement,
    opts: { theme?: string; size?: string; shape?: string; text?: string; width?: string },
  ) => void;
  disableAutoSelect: () => void;
}

declare global {
  interface Window {
    google?: {
      accounts?: { id?: GoogleAccountId };
    };
  }
}

let scriptLoaded = false;

export function loadGoogleIdentity(clientId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!clientId) return reject(new Error('Google Client ID is not configured'));
    if (scriptLoaded && window.google?.accounts?.id) return resolve();

    window.google = window.google || {};
    const handler = () => {
      if (window.google?.accounts?.id) {
        scriptLoaded = true;
        resolve();
      } else {
        reject(new Error('Google Identity Services failed to load'));
      }
    };

    const existing = document.getElementById('gsi-script') as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', handler);
      return;
    }

    const s = document.createElement('script');
    s.id = 'gsi-script';
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = handler;
    s.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(s);
  });
}

export function renderSignInButton(
  clientId: string,
  el: HTMLElement,
  onToken: (token: string) => void,
): void {
  loadGoogleIdentity(clientId)
    .then(() => {
      const id = window.google!.accounts!.id!;
      id.initialize({
        client_id: clientId,
        callback: (resp) => {
          if (resp?.credential) onToken(resp.credential);
        },
      });
      id.renderButton(el, {
        theme: 'outline',
        size: 'large',
        shape: 'pill',
        text: 'signin_with',
        width: '100%',
      });
    })
    .catch(() => {});
}
