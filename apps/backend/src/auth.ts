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
  /** The session's user: role in the current home, the list of homes, admin flag. */
  userFor(a: Account): User {
    const active = this.store.activeHomeOf(a);
    return {
      id: a.id,
      email: a.google?.email || '',
      username: a.username,
      name: a.name,
      picture: a.google?.picture,
      role: active?.role ?? 'guest',
      homeId: active?.home.id ?? null,
      homeName: active?.home.name,
      homes: this.store.homesOf(a.id).map(({ home, role }) => ({ id: home.id, name: home.name, role })),
      admin: this.store.isAdmin(a) || undefined,
    };
  }

  /**
   * An invitation (link code) lets its holder in: their account is approved and they
   * join the home as a guest, which becomes their current home.
   */
  private applyInvite(a: Account, invite?: string): void {
    if (!invite) return;
    const home = this.store.findHomeByInvite(invite);
    if (!home) return;
    if (a.status === 'pending') this.store.updateAccount(a.id, { status: 'active' });
    this.store.addMember(home.id, a.id, 'guest');
    this.store.updateAccount(a.id, { activeHomeId: home.id });
  }

  /** Google e-mail invitations of homes: the invited person gets in at once. */
  private applyEmailInvites(a: Account): void {
    if (!a.google) return;
    const homes = this.store.homesInvitingEmail(a.google.email);
    if (!homes.length) return;
    if (a.status === 'pending') this.store.updateAccount(a.id, { status: 'active' });
    for (const h of homes) {
      if (!this.store.memberRole(h, a.id)) {
        this.store.addMember(h.id, a.id, 'guest');
        if (!a.activeHomeId) this.store.updateAccount(a.id, { activeHomeId: h.id });
      }
    }
  }

  /** A single-TV installation migrated without its owner account: the admin takes it over. */
  private adoptOrphanHome(a: Account): void {
    const legacy = this.store.getHome(this.store.legacyHomeId);
    if (legacy && this.store.isAdmin(a) && this.store.ownerCount(legacy) === 0) {
      this.store.addMember(legacy.id, a.id, 'owner');
      if (!a.activeHomeId) this.store.updateAccount(a.id, { activeHomeId: legacy.id });
    }
  }

  private outcomeFor(a: Account, withToken: boolean, invite?: string): AuthOutcome {
    this.applyInvite(a, invite);
    this.adoptOrphanHome(a);
    if (this.store.statusOf(a) === 'pending') return { ok: false, error: 'pending_approval' };
    this.store.touch(a.id);
    const user = this.userFor(a);
    return { ok: true, user, isTv: false, ...(withToken ? { token: this.issueUserToken(user) } : {}) };
  }

  issueUserToken(user: Pick<User, 'id' | 'name'>): string {
    return signToken({ k: 'user', sub: user.id, name: user.name, email: '', iat: Date.now() }, this.config.sessionSecret);
  }

  /** A TV token belongs to one home; unpairing the home invalidates it. */
  issueTvToken(homeId: string, name: string): string {
    const v = this.store.getHome(homeId)?.tvTokenVersion ?? 1;
    return signToken({ k: 'tv', h: homeId, v, name, iat: Date.now() }, this.config.sessionSecret);
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
      role: this.store.statusOf(a) === 'pending' ? 'pending' : this.userFor(a).role === 'owner' ? 'owner' : 'guest',
      createdAt: a.createdAt,
    };
  }

  // ------------------------------------------------------------------ Google
  /** Find or create the account for a Google identity. */
  private accountForGoogle(id: GoogleIdentity, invite?: string): Account | { error: string; email: string } {
    const email = normalizeEmail(id.email);
    let a = this.store.findByGoogle(id.sub, email);
    if (a) {
      if (!a.google || a.google.sub !== id.sub || a.google.picture !== id.picture) {
        this.store.updateAccount(a.id, { google: { sub: id.sub, email, picture: id.picture } });
      }
      this.applyEmailInvites(a);
      return a;
    }
    const isAdmin = Boolean(this.config.ownerEmail) && email === this.config.ownerEmail;
    const invited = this.store.homesInvitingEmail(email).length > 0 || !!this.store.findHomeByInvite(invite || '');
    const mode = this.store.registration;
    if (!isAdmin && !invited && mode === 'closed') return { error: 'not_allowed', email };
    a = this.store.createAccount({
      name: id.name || email,
      google: { sub: id.sub, email, picture: id.picture },
      status: isAdmin || invited || mode === 'open' ? 'active' : 'pending',
      ...(isAdmin ? { admin: true } : {}),
    });
    this.store.setInviteName(email, id.name);
    this.applyEmailInvites(a);
    return a;
  }

  async signInWithGoogle(idToken: string, invite?: string): Promise<AuthOutcome> {
    const id = await this.verifyGoogle(idToken);
    if (!id) return { ok: false, error: 'invalid_google_token' };
    const a = this.accountForGoogle(id, invite);
    if ('error' in a) return { ok: false, error: a.error, email: a.email };
    return this.outcomeFor(a, true, invite);
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
  register(usernameRaw: string, password: string, name?: string, invite?: string): AuthOutcome & { pending?: boolean } {
    const username = normalizeUsername(usernameRaw);
    if (!isValidUsername(username)) return { ok: false, error: 'bad_username' };
    if (!password || password.length < MIN_PASSWORD) return { ok: false, error: 'weak_password' };
    if (this.store.findByUsername(username)) return { ok: false, error: 'username_taken' };
    // the first account of a server without Google sign-in (or the login named in .env) runs the server
    const bootstrapAdmin =
      (this.config.ownerUsername && username === this.config.ownerUsername) || (!this.config.googleClientId && !this.store.hasAdmin());
    const invited = !!this.store.findHomeByInvite(invite || '');
    const mode = this.store.registration;
    if (!bootstrapAdmin && !invited && mode === 'closed') return { ok: false, error: 'registration_closed' };
    const a = this.store.createAccount({
      name: (name || '').trim().slice(0, 60) || username,
      username,
      passwordHash: hashPassword(password),
      status: bootstrapAdmin || invited || mode === 'open' ? 'active' : 'pending',
      ...(bootstrapAdmin ? { admin: true } : {}),
    });
    const out = this.outcomeFor(a, true, invite);
    if (!out.ok && out.error === 'pending_approval') return { ...out, pending: true };
    return out;
  }

  login(username: string, password: string, invite?: string): AuthOutcome {
    const a = this.store.findByUsername(username);
    if (!a || !verifyPassword(password, a.passwordHash)) return { ok: false, error: 'invalid_credentials' };
    return this.outcomeFor(a, true, invite);
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
  private tvUser(homeId: string, name: string): User {
    const home = this.store.getHome(homeId);
    return { id: `tv:${homeId}`, email: 'tv', name: name || home?.tvName || 'TV', role: 'device', homeId, homeName: home?.name };
  }

  /** Validate a session token. Roles are re-evaluated every time (removal is instant). */
  verifySession(token: string): AuthOutcome {
    const claims: TokenClaims | null = verifyToken(token, this.config.sessionSecret);
    if (!claims) return { ok: false, error: 'invalid_token' };
    if (claims.k === 'tv') {
      // tokens issued before homes existed belong to the migrated home
      const homeId = claims.h || this.store.legacyHomeId;
      const home = this.store.getHome(homeId);
      if (!home || claims.v !== home.tvTokenVersion) return { ok: false, error: 'tv_unpaired' };
      return { ok: true, isTv: true, user: this.tvUser(home.id, claims.name) };
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

  /** The static DEVICE_TOKEN from .env (TVBox 1.x TVs) belongs to the migrated home. */
  verifyLegacyDeviceToken(token: string): AuthOutcome {
    if (!this.config.deviceToken || token !== this.config.deviceToken) return { ok: false, error: 'invalid_device_token' };
    const homeId =
      this.store.legacyHomeId ||
      this.store.homes.find((h) =>
        h.members.some((m) => {
          const a = m.role === 'owner' ? this.store.getAccount(m.accountId) : undefined;
          return !!a && this.store.isAdmin(a);
        }),
      )?.id;
    if (!homeId) return { ok: false, error: 'tv_unpaired' };
    return { ok: true, isTv: true, user: this.tvUser(homeId, '') };
  }
}
