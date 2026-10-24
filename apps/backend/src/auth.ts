import { OAuth2Client } from 'google-auth-library';
import type { User } from '@tvbox/shared';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export type Authenticator = (idToken?: string) => Promise<User | null>;

export function createGoogleAuthenticator(
  googleClientId: string,
  ownerEmail: string,
  isGuest: (email: string) => boolean,
): Authenticator {
  const client = new OAuth2Client(googleClientId || undefined);

  return async (idToken?: string): Promise<User | null> => {
    if (!idToken) return null;
    let identity: GoogleIdentity | null = null;

    if (googleClientId) {
      try {
        const ticket = await client.verifyIdToken({
          idToken,
          audience: googleClientId,
        });
        const payload = ticket.getPayload();
        if (payload?.sub && payload.email) {
          identity = {
            sub: payload.sub,
            email: payload.email,
            name: payload.name || payload.email,
            picture: payload.picture,
          };
        }
      } catch {
        identity = null;
      }
    }

    if (!identity) {
      identity = await verifyViaTokenInfo(idToken);
    }

    if (!identity) return null;

    const email = identity.email.trim().toLowerCase();
    const role = email === ownerEmail.toLowerCase() ? 'owner' : isGuest(email) ? 'guest' : null;
    if (!role) return null;

    return {
      id: identity.sub,
      email,
      name: identity.name,
      picture: identity.picture,
      role,
    };
  };
}

async function verifyViaTokenInfo(idToken: string): Promise<GoogleIdentity | null> {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      sub?: string;
      email?: string;
      name?: string;
      picture?: string;
    };
    if (!data.sub || !data.email) return null;
    return { sub: data.sub, email: data.email, name: data.name || data.email, picture: data.picture };
  } catch {
    return null;
  }
}
