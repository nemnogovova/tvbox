import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeEmail, type AccountRole, type AccountSummary, type GuestEntry, type RegistrationMode } from '@tvbox/shared';

export type MemberRole = 'owner' | 'guest';

export interface Account {
  id: string;
  name: string;
  username?: string;
  passwordHash?: string;
  google?: { sub: string; email: string; picture?: string };
  /** 'pending' — waits for the server admin (registration by approval) */
  status: 'active' | 'pending';
  /** Administrator of the whole server */
  admin?: boolean;
  /** The home this account works with (switchable) */
  activeHomeId?: string;
  createdAt: number;
  lastSeenAt?: number;
}

export interface Member {
  accountId: string;
  role: MemberRole;
  addedAt: number;
}

/**
 * A home: one TV and the people allowed to use it. Everything a remote sees and does
 * (player, library, torrents, commands) stays inside its home.
 */
export interface Home {
  id: string;
  name: string;
  createdAt: number;
  members: Member[];
  /** Google e-mails invited as guests (they get in on their first Google sign-in) */
  invites: GuestEntry[];
  /** Invitation link code: /join/<code> */
  inviteCode: string;
  dictatorMode: boolean;
  /** Bumped to invalidate the TV token of this home ("unpair TV") */
  tvTokenVersion: number;
  tvName?: string;
}

interface StoreData {
  version: 2;
  accounts: Account[];
  homes: Home[];
  registration: RegistrationMode;
  /** The home created from a single-TV installation (TV tokens issued before homes existed belong to it) */
  legacyHomeId?: string;
}

/** TVBox ≤ 3.1: one TV, accounts with a global role. */
interface StoreDataV1 {
  guests?: GuestEntry[];
  accounts?: (Omit<Account, 'status'> & { role?: AccountRole })[];
  dictatorMode?: boolean;
  registrationOpen?: boolean;
  tvTokenVersion?: number;
  tvName?: string;
}

export interface StoreOptions {
  /** Google e-mail of the server admin (.env OWNER_EMAIL) */
  ownerEmail?: string;
  /** Login of the server admin (.env OWNER_USERNAME) */
  ownerUsername?: string;
}

const DEFAULT_DATA = (): StoreData => ({ version: 2, accounts: [], homes: [], registration: 'approval' });

export const normalizeUsername = (u: string) => String(u || '').trim().toLowerCase();
export const isValidUsername = (u: string) => /^[a-z0-9а-яё._-]{3,32}$/i.test(normalizeUsername(u));
const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
/** Invitation codes: no look-alike characters, easy to type */
export function newInviteCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** Tiny JSON-file store: accounts, homes, flags. No database needed. */
export class JsonStore {
  private data: StoreData;
  private readonly filePath: string;
  private readonly opts: Required<StoreOptions>;

  constructor(dataDir: string, opts: StoreOptions = {}) {
    this.filePath = path.join(dataDir, 'store.json');
    this.opts = { ownerEmail: normalizeEmail(opts.ownerEmail || ''), ownerUsername: normalizeUsername(opts.ownerUsername || '') };
    this.data = this.read();
  }

  private read(): StoreData {
    let parsed: (Partial<StoreData> & StoreDataV1) | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    } catch {
      return DEFAULT_DATA();
    }
    if (!parsed || typeof parsed !== 'object') return DEFAULT_DATA();
    if (parsed.version === 2 && Array.isArray(parsed.homes)) {
      const regs: RegistrationMode[] = ['open', 'approval', 'closed'];
      return {
        version: 2,
        accounts: (Array.isArray(parsed.accounts) ? (parsed.accounts as Account[]) : []).filter((a) => a && typeof a.id === 'string').map((a) => ({ ...a, status: a.status === 'pending' ? 'pending' : 'active' })),
        homes: parsed.homes.filter((h) => h && typeof h.id === 'string').map((h) => ({
          ...h,
          members: Array.isArray(h.members) ? h.members.filter((m) => m && typeof m.accountId === 'string') : [],
          invites: Array.isArray(h.invites) ? h.invites : [],
          inviteCode: h.inviteCode || newInviteCode(),
          dictatorMode: Boolean(h.dictatorMode),
          tvTokenVersion: Number(h.tvTokenVersion) || 1,
        })),
        registration: regs.includes(parsed.registration as RegistrationMode) ? (parsed.registration as RegistrationMode) : 'approval',
        legacyHomeId: typeof parsed.legacyHomeId === 'string' ? parsed.legacyHomeId : undefined,
      };
    }
    const migrated = this.migrateV1(parsed);
    // keep the old file next to the new one, just in case
    try {
      fs.copyFileSync(this.filePath, `${this.filePath}.v1.bak`);
    } catch {
      // read-only? the migrated data is still used
    }
    this.data = migrated;
    this.persist();
    return migrated;
  }

  /**
   * TVBox ≤ 3.1 → homes. The one TV and its people become one home: owners stay owners,
   * guests stay guests, invites and the TV token keep working (no re-pairing). The server
   * admin is the owner from .env (or the first owner when .env names nobody).
   */
  private migrateV1(v1: StoreDataV1): StoreData {
    const old = (Array.isArray(v1.accounts) ? v1.accounts : []).filter((a) => a && typeof a.id === 'string');
    const guests = (Array.isArray(v1.guests) ? v1.guests : []).filter((g) => g && typeof g.email === 'string');
    const invited = (a: (typeof old)[number]) => !!a.google && guests.some((g) => g.email === normalizeEmail(a.google!.email));
    const roleOf = (a: (typeof old)[number]): AccountRole => {
      if (this.matchesEnvOwner(a)) return 'owner';
      if (a.role === 'pending' && invited(a)) return 'guest';
      return a.role === 'owner' || a.role === 'guest' ? a.role : 'pending';
    };
    const owners = old.filter((a) => roleOf(a) === 'owner').sort((a, b) => a.createdAt - b.createdAt);
    const envAdmin = owners.some((a) => this.matchesEnvOwner(a));
    const accounts: Account[] = old.map((a) => {
      const { role: _role, ...rest } = a;
      const role = roleOf(a);
      const admin = this.matchesEnvOwner(a) || (!envAdmin && owners[0]?.id === a.id);
      return { ...rest, status: role === 'pending' ? 'pending' : 'active', ...(admin ? { admin: true } : {}) };
    });
    const data: StoreData = { version: 2, accounts, homes: [], registration: v1.registrationOpen === false ? 'closed' : 'approval' };
    const hadTv = Number(v1.tvTokenVersion) > 1 || !!v1.tvName;
    if (old.length || hadTv) {
      const now = Date.now();
      const home: Home = {
        id: newId('h'),
        name: v1.tvName || 'Дом',
        createdAt: now,
        members: old
          .filter((a) => roleOf(a) !== 'pending')
          .map((a) => ({ accountId: a.id, role: roleOf(a) === 'owner' ? 'owner' : 'guest', addedAt: a.createdAt || now })),
        invites: guests,
        inviteCode: newInviteCode(),
        dictatorMode: Boolean(v1.dictatorMode),
        tvTokenVersion: Number(v1.tvTokenVersion) || 1,
        tvName: v1.tvName,
      };
      data.homes.push(home);
      data.legacyHomeId = home.id;
      for (const a of accounts) if (home.members.some((m) => m.accountId === a.id)) a.activeHomeId = home.id;
    }
    return data;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  // ------------------------------------------------------------------ server admin
  private matchesEnvOwner(a: Pick<Account, 'google' | 'username'>): boolean {
    if (this.opts.ownerEmail && a.google && normalizeEmail(a.google.email) === this.opts.ownerEmail) return true;
    if (this.opts.ownerUsername && a.username && normalizeUsername(a.username) === this.opts.ownerUsername) return true;
    return false;
  }

  /** The server admin: named in .env, or marked (the first account of a fresh server). */
  isAdmin(a: Account): boolean {
    return Boolean(a.admin) || this.matchesEnvOwner(a);
  }

  hasAdmin(): boolean {
    return this.data.accounts.some((a) => this.isAdmin(a));
  }

  /** Account status, admins are always active. */
  statusOf(a: Account): Account['status'] {
    return this.isAdmin(a) ? 'active' : a.status;
  }

  get registration(): RegistrationMode {
    return this.data.registration;
  }

  setRegistration(mode: RegistrationMode): void {
    if (this.data.registration === mode) return;
    this.data.registration = mode;
    this.persist();
  }

  // ------------------------------------------------------------------ accounts
  get accounts(): Account[] {
    return this.data.accounts;
  }

  getAccount(id: string): Account | undefined {
    return this.data.accounts.find((a) => a.id === id);
  }

  findByUsername(username: string): Account | undefined {
    const u = normalizeUsername(username);
    return this.data.accounts.find((a) => a.username === u);
  }

  findByGoogle(sub: string, email?: string): Account | undefined {
    return (
      this.data.accounts.find((a) => a.google?.sub === sub) ||
      (email ? this.data.accounts.find((a) => a.google && normalizeEmail(a.google.email) === normalizeEmail(email)) : undefined)
    );
  }

  createAccount(init: Omit<Account, 'id' | 'createdAt'>): Account {
    const a: Account = { id: newId('u'), createdAt: Date.now(), ...init };
    if (a.username) a.username = normalizeUsername(a.username);
    this.data.accounts.push(a);
    this.persist();
    return a;
  }

  updateAccount(id: string, patch: Partial<Account>): Account | undefined {
    const a = this.getAccount(id);
    if (!a) return undefined;
    Object.assign(a, patch);
    if (patch.username) a.username = normalizeUsername(patch.username);
    for (const k of Object.keys(patch) as (keyof Account)[]) if (patch[k] === undefined) delete a[k];
    this.persist();
    return a;
  }

  touch(id: string): void {
    const a = this.getAccount(id);
    if (!a) return;
    const now = Date.now();
    // persist at most every 10 minutes
    if (!a.lastSeenAt || now - a.lastSeenAt > 10 * 60 * 1000) {
      a.lastSeenAt = now;
      this.persist();
    }
  }

  /**
   * Delete an account everywhere. Homes left without an owner are deleted too
   * (their ids are returned, so their TV and people can be told).
   */
  deleteAccount(id: string): { deleted: boolean; homesDeleted: string[] } {
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (before === this.data.accounts.length) return { deleted: false, homesDeleted: [] };
    const homesDeleted: string[] = [];
    for (const h of this.data.homes) {
      h.members = h.members.filter((m) => m.accountId !== id);
      if (!h.members.some((m) => m.role === 'owner')) homesDeleted.push(h.id);
    }
    this.removeHomes(homesDeleted);
    this.persist();
    return { deleted: true, homesDeleted };
  }

  summary(a: Account, role?: AccountRole): AccountSummary {
    return {
      id: a.id,
      name: a.name,
      username: a.username,
      email: a.google?.email,
      role: role ?? (this.statusOf(a) === 'pending' ? 'pending' : 'guest'),
      createdAt: a.createdAt,
      lastSeenAt: a.lastSeenAt,
    };
  }

  // ------------------------------------------------------------------ homes
  get homes(): Home[] {
    return this.data.homes;
  }

  get legacyHomeId(): string | undefined {
    return this.data.legacyHomeId && this.getHome(this.data.legacyHomeId) ? this.data.legacyHomeId : undefined;
  }

  getHome(id: string | undefined | null): Home | undefined {
    return id ? this.data.homes.find((h) => h.id === id) : undefined;
  }

  memberRole(home: Home | undefined, accountId: string): MemberRole | null {
    return home?.members.find((m) => m.accountId === accountId)?.role ?? null;
  }

  /** Homes of an account, the ones it owns first. */
  homesOf(accountId: string): { home: Home; role: MemberRole }[] {
    const out: { home: Home; role: MemberRole }[] = [];
    for (const home of this.data.homes) {
      const role = this.memberRole(home, accountId);
      if (role) out.push({ home, role });
    }
    return out.sort((a, b) => (a.role === b.role ? a.home.createdAt - b.home.createdAt : a.role === 'owner' ? -1 : 1));
  }

  /** The home an account works with now: its chosen one while still a member, else its first. */
  activeHomeOf(a: Account): { home: Home; role: MemberRole } | null {
    const all = this.homesOf(a.id);
    return all.find((x) => x.home.id === a.activeHomeId) || all[0] || null;
  }

  createHome(ownerId: string, name: string): Home {
    const home: Home = {
      id: newId('h'),
      name: name.trim().slice(0, 60) || 'Дом',
      createdAt: Date.now(),
      members: [{ accountId: ownerId, role: 'owner', addedAt: Date.now() }],
      invites: [],
      inviteCode: newInviteCode(),
      dictatorMode: false,
      tvTokenVersion: 1,
    };
    this.data.homes.push(home);
    this.persist();
    return home;
  }

  renameHome(id: string, name: string): boolean {
    const h = this.getHome(id);
    const n = name.trim().slice(0, 60);
    if (!h || !n) return false;
    h.name = n;
    this.persist();
    return true;
  }

  /** Add someone to a home (an existing member keeps their role). */
  addMember(homeId: string, accountId: string, role: MemberRole): boolean {
    const h = this.getHome(homeId);
    if (!h) return false;
    if (!h.members.some((m) => m.accountId === accountId)) {
      h.members.push({ accountId, role, addedAt: Date.now() });
      this.persist();
    }
    return true;
  }

  setMemberRole(homeId: string, accountId: string, role: MemberRole): boolean {
    const m = this.getHome(homeId)?.members.find((x) => x.accountId === accountId);
    if (!m) return false;
    m.role = role;
    this.persist();
    return true;
  }

  removeMember(homeId: string, accountId: string): boolean {
    const h = this.getHome(homeId);
    if (!h) return false;
    const before = h.members.length;
    h.members = h.members.filter((m) => m.accountId !== accountId);
    if (before === h.members.length) return false;
    this.persist();
    return true;
  }

  ownerCount(home: Home): number {
    return home.members.filter((m) => m.role === 'owner').length;
  }

  deleteHome(id: string): boolean {
    if (!this.getHome(id)) return false;
    this.removeHomes([id]);
    this.persist();
    return true;
  }

  private removeHomes(ids: string[]): void {
    if (!ids.length) return;
    this.data.homes = this.data.homes.filter((h) => !ids.includes(h.id));
    for (const a of this.data.accounts) if (a.activeHomeId && ids.includes(a.activeHomeId)) delete a.activeHomeId;
    if (this.data.legacyHomeId && ids.includes(this.data.legacyHomeId)) delete this.data.legacyHomeId;
  }

  findHomeByInvite(code: string): Home | undefined {
    const c = String(code || '').trim().toUpperCase();
    return c.length >= 6 ? this.data.homes.find((h) => h.inviteCode === c) : undefined;
  }

  resetInviteCode(homeId: string): string | null {
    const h = this.getHome(homeId);
    if (!h) return null;
    h.inviteCode = newInviteCode();
    this.persist();
    return h.inviteCode;
  }

  setDictatorMode(homeId: string, enabled: boolean): void {
    const h = this.getHome(homeId);
    if (!h || h.dictatorMode === enabled) return;
    h.dictatorMode = enabled;
    this.persist();
  }

  bumpTvTokenVersion(homeId: string): number {
    const h = this.getHome(homeId);
    if (!h) return 0;
    h.tvTokenVersion += 1;
    this.persist();
    return h.tvTokenVersion;
  }

  setTvName(homeId: string, name: string): void {
    const h = this.getHome(homeId);
    if (!h || h.tvName === name) return;
    h.tvName = name;
    this.persist();
  }

  // ------------------------------------------------------------------ Google invites (per home)
  homesInvitingEmail(email: string): Home[] {
    const e = normalizeEmail(email);
    return this.data.homes.filter((h) => h.invites.some((g) => g.email === e));
  }

  addInvite(homeId: string, email: string, name?: string): GuestEntry | null {
    const h = this.getHome(homeId);
    if (!h) return null;
    const e = normalizeEmail(email);
    const existing = h.invites.find((g) => g.email === e);
    if (existing) return existing;
    const entry: GuestEntry = { email: e, addedAt: Date.now(), ...(name ? { name } : {}) };
    h.invites.push(entry);
    this.persist();
    return entry;
  }

  setInviteName(email: string, name: string): void {
    let changed = false;
    for (const h of this.data.homes)
      for (const g of h.invites)
        if (g.email === normalizeEmail(email) && g.name !== name) {
          g.name = name;
          changed = true;
        }
    if (changed) this.persist();
  }

  /** Remove an invite; guests who got in through it leave the home (their ids are returned). */
  removeInvite(homeId: string, email: string): string[] {
    const h = this.getHome(homeId);
    if (!h) return [];
    const e = normalizeEmail(email);
    const before = h.invites.length;
    h.invites = h.invites.filter((g) => g.email !== e);
    const removed: string[] = [];
    for (const m of [...h.members]) {
      const a = this.getAccount(m.accountId);
      if (m.role === 'guest' && a?.google && normalizeEmail(a.google.email) === e) {
        h.members = h.members.filter((x) => x !== m);
        removed.push(a.id);
      }
    }
    if (before !== h.invites.length || removed.length) this.persist();
    return removed;
  }
}
