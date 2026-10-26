import { OAuth2Client } from 'google-auth-library';
import { normalizeEmail, type AccountInfo, type User } from '@tvbox/shared';
import type { BackendConfig } from './config';
import { hashPassword, isValidUsername, normalizeUsername, verifyPassword, type Account, type JsonStore } from './store';
import { signToken, verifyToken, type TokenClaims } from './tokens';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

/** Verifies a Google ID token. Injectable for tests. */
export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity | null>;

export function createGoogleVerifier(clientId: string): GoogleVerifier {
  const client = new OAuth2Client(clientId || undefined);
  return async (idToken) => {
    if (!clientId || !idToken) return null;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: clientId });
      const p = ticket.getPayload();
      if (!p?.sub || !p.email || p.email_verified === false) return null;
      return { sub: p.sub, email: p.email, name: p.name || p.email, picture: p.picture };
    } catch {
      return null;
    }
  };
}

export type AuthOutcome =
  | { ok: true; user: User; isTv: boolean; token?: string }
  | { ok: false; error: string; email?: string };

export const MIN_PASSWORD = 4;

export class AuthService {
  constructor(
    private readonly config: BackendConfig,
    private readonly store: JsonStore,
    private readonly verifyGoogle: GoogleVerifier,
  ) {}

  // ------------------------------------------------------------------ helpers
  userFor(a: Account): User {
    return {
      id: a.id,
      email: a.google?.email || '',
      username: a.username,
      name: a.name,
      picture: a.google?.picture,
      role: this.store.effectiveRole(a, this.config.ownerEmail) === 'owner' ? 'owner' : 'guest',
    };
  }

  private outcomeFor(a: Account, withToken: boolean): AuthOutcome {
    const role = this.store.effectiveRole(a, this.config.ownerEmail);
    if (role === 'pending') return { ok: false, error: 'pending_approval' };
    this.store.touch(a.id);
    const user = this.userFor(a);
    return { ok: true, user, isTv: false, ...(withToken ? { token: this.issueUserToken(user) } : {}) };
  }

  issueUserToken(user: Pick<User, 'id' | 'name'>): string {
    return signToken({ k: 'user', sub: user.id, name: user.name, email: '', iat: Date.now() }, this.config.sessionSecret);
  }

  issueTvToken(name: string): string {
    return signToken({ k: 'tv', v: this.store.tvTokenVersion, name, iat: Date.now() }, this.config.sessionSecret);
  }

  accountInfo(id: string): AccountInfo | null {
    const a = this.store.getAccount(id);
    if (!a) return null;
    return {
      id: a.id,
      name: a.name,
      username: a.username,
      hasPassword: Boolean(a.passwordHash),
      google: a.google ? { email: a.google.email, picture: a.google.picture } : undefined,
      role: this.store.effectiveRole(a, this.config.ownerEmail),
      createdAt: a.createdAt,
    };
  }

  // ------------------------------------------------------------------ Google
  /** Find or create the account for a Google identity. */
  private accountForGoogle(id: GoogleIdentity): Account | { error: string; email: string } {
    const email = normalizeEmail(id.email);
    let a = this.store.findByGoogle(id.sub, email);
    if (a) {
      if (!a.google || a.google.sub !== id.sub || a.google.picture !== id.picture) {
        this.store.updateAccount(a.id, { google: { sub: id.sub, email, picture: id.picture } });
      }
      return a;
    }
    const isOwner = Boolean(this.config.ownerEmail) && email === this.config.ownerEmail;
    const invited = this.store.isGuest(email);
    if (!isOwner && !invited && !this.store.registrationOpen) return { error: 'not_allowed', email };
    a = this.store.createAccount({
      name: id.name || email,
      google: { sub: id.sub, email, picture: id.picture },
      role: isOwner ? 'owner' : invited ? 'guest' : 'pending',
    });
    if (invited) this.store.setGuestName(email, id.name);
    return a;
  }

  async signInWithGoogle(idToken: string): Promise<AuthOutcome> {
    const id = await this.verifyGoogle(idToken);
    if (!id) return { ok: false, error: 'invalid_google_token' };
    const a = this.accountForGoogle(id);
    if ('error' in a) return { ok: false, error: a.error, email: a.email };
    return this.outcomeFor(a, true);
  }

  async linkGoogle(accountId: string, idToken: string): Promise<{ ok: boolean; error?: string }> {
    const id = await this.verifyGoogle(idToken);
    if (!id) return { ok: false, error: 'invalid_google_token' };
    const other = this.store.findByGoogle(id.sub, id.email);
    if (other && other.id !== accountId) return { ok: false, error: 'google_in_use' };
    this.store.updateAccount(accountId, { google: { sub: id.sub, email: normalizeEmail(id.email), picture: id.picture } });
    return { ok: true };
  }

  unlinkGoogle(accountId: string): { ok: boolean; error?: string } {
    const a = this.store.getAccount(accountId);
    if (!a) return { ok: false, error: 'not_found' };
    if (!a.passwordHash) return { ok: false, error: 'need_password' };
    this.store.updateAccount(accountId, { google: undefined });
    return { ok: true };
  }

  // ------------------------------------------------------------------ login / password
  register(usernameRaw: string, password: string, name?: string): AuthOutcome & { pending?: boolean } {
    const username = normalizeUsername(usernameRaw);
    if (!isValidUsername(username)) return { ok: false, error: 'bad_username' };
    if (!password || password.length < MIN_PASSWORD) return { ok: false, error: 'weak_password' };
    if (this.store.findByUsername(username)) return { ok: false, error: 'username_taken' };
    const bootstrapOwner =
      (this.config.ownerUsername && username === this.config.ownerUsername) ||
      (!this.config.googleClientId && !this.store.hasOwnerAccount(this.config.ownerEmail));
    if (!bootstrapOwner && !this.store.registrationOpen) return { ok: false, error: 'registration_closed' };
    const a = this.store.createAccount({
      name: (name || '').trim().slice(0, 60) || username,
      username,
      passwordHash: hashPassword(password),
      role: bootstrapOwner ? 'owner' : 'pending',
    });
    const out = this.outcomeFor(a, true);
    if (!out.ok && out.error === 'pending_approval') return { ...out, pending: true };
    return out;
  }

  login(username: string, password: string): AuthOutcome {
    const a = this.store.findByUsername(username);
    if (!a || !verifyPassword(password, a.passwordHash)) return { ok: false, error: 'invalid_credentials' };
    return this.outcomeFor(a, true);
  }

  setPassword(accountId: string, usernameRaw: string | undefined, password: string, currentPassword?: string): { ok: boolean; error?: string } {
    const a = this.store.getAccount(accountId);
    if (!a) return { ok: false, error: 'not_found' };
    if (a.passwordHash && !verifyPassword(currentPassword || '', a.passwordHash)) return { ok: false, error: 'wrong_password' };
    if (!password || password.length < MIN_PASSWORD) return { ok: false, error: 'weak_password' };
    const username = normalizeUsername(usernameRaw || a.username || '');
    if (!isValidUsername(username)) return { ok: false, error: 'bad_username' };
    const other = this.store.findByUsername(username);
    if (other && other.id !== a.id) return { ok: false, error: 'username_taken' };
    this.store.updateAccount(a.id, { username, passwordHash: hashPassword(password) });
    return { ok: true };
  }

  // ------------------------------------------------------------------ sessions
  /** Validate a session token. Roles are re-evaluated every time (removal is instant). */
  verifySession(token: string): AuthOutcome {
    const claims: TokenClaims | null = verifyToken(token, this.config.sessionSecret);
    if (!claims) return { ok: false, error: 'invalid_token' };
    if (claims.k === 'tv') {
      if (claims.v !== this.store.tvTokenVersion) return { ok: false, error: 'tv_unpaired' };
      return { ok: true, isTv: true, user: { id: 'tv', email: 'tv', name: claims.name || 'TV', role: 'device' } };
    }
    let a = this.store.getAccount(claims.sub);
    if (!a && claims.email) {
      // session issued by TVBox 2.0 (before accounts existed): sub = Google id
      const r = this.accountForGoogle({ sub: claims.sub, email: claims.email, name: claims.name, picture: claims.picture });
      if ('error' in r) return { ok: false, error: r.error };
      a = r;
    }
    if (!a) return { ok: false, error: 'invalid_token' };
    return this.outcomeFor(a, false);
  }

  verifyLegacyDeviceToken(token: string): AuthOutcome {
    if (!this.config.deviceToken || token !== this.config.deviceToken) return { ok: false, error: 'invalid_device_token' };
    return { ok: true, isTv: true, user: { id: 'tv', email: 'tv', name: this.store.tvName || 'TV', role: 'device' } };
  }
}
