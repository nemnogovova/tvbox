import crypto from 'node:crypto';

/**
 * Compact signed session tokens (HMAC-SHA256), so clients don't depend on
 * Google ID tokens (which expire after one hour).
 */
export type TokenClaims =
  | { k: 'user'; sub: string; email: string; name: string; picture?: string; iat: number }
  | { k: 'tv'; v: number; name: string; iat: number };

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export function signToken(claims: TokenClaims, secret: string): string {
  const body = b64(JSON.stringify(claims));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string, secret: string, maxAgeMs = 400 * 24 * 3600 * 1000): TokenClaims | null {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as TokenClaims;
    if (!claims || (claims.k !== 'user' && claims.k !== 'tv')) return null;
    if (typeof claims.iat !== 'number' || Date.now() - claims.iat > maxAgeMs) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Time-limited TURN REST credentials (coturn --use-auth-secret). */
export function turnCredentials(secret: string, user: string, ttlSec = 12 * 3600): { username: string; credential: string } {
  const username = `${Math.floor(Date.now() / 1000) + ttlSec}:${user.replace(/[^a-z0-9@._-]/gi, '')}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}
