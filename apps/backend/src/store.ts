import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeEmail, type AccountRole, type AccountSummary, type AdminState, type GuestEntry } from '@tvbox/shared';

export interface Account {
  id: string;
  name: string;
  username?: string;
  passwordHash?: string;
  google?: { sub: string; email: string; picture?: string };
  /** Role stored for the account. The owner e-mail from .env is always owner. */
  role: AccountRole;
  createdAt: number;
  lastSeenAt?: number;
}

interface StoreData {
  guests: GuestEntry[];
  accounts: Account[];
  dictatorMode: boolean;
  registrationOpen: boolean;
  /** Bumped to invalidate every issued TV token ("unpair TV"). */
  tvTokenVersion: number;
  tvName?: string;
}

const DEFAULT_DATA = (): StoreData => ({
  guests: [],
  accounts: [],
  dictatorMode: false,
  registrationOpen: true,
  tvTokenVersion: 1,
});

export const normalizeUsername = (u: string) => String(u || '').trim().toLowerCase();
export const isValidUsername = (u: string) => /^[a-z0-9а-яё._-]{3,32}$/i.test(normalizeUsername(u));

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

/** Tiny JSON-file store: accounts, guest invites, flags. No database needed. */
export class JsonStore {
  private data: StoreData;
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'store.json');
    this.data = this.read();
  }

  private read(): StoreData {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<StoreData>;
      const d = DEFAULT_DATA();
      return {
        guests: Array.isArray(parsed.guests) ? parsed.guests.filter((g) => g && typeof g.email === 'string') : [],
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts.filter((a) => a && typeof a.id === 'string') : [],
        dictatorMode: Boolean(parsed.dictatorMode),
        registrationOpen: parsed.registrationOpen === undefined ? d.registrationOpen : Boolean(parsed.registrationOpen),
        tvTokenVersion: Number(parsed.tvTokenVersion) || 1,
        tvName: typeof parsed.tvName === 'string' ? parsed.tvName : undefined,
      };
    } catch {
      return DEFAULT_DATA();
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  // ------------------------------------------------------------------ admin view
  getAdminState(ownerEmail = ''): AdminState {
    return {
      guests: this.data.guests.map((g) => ({ ...g })),
      accounts: this.data.accounts.map((a) => this.summary(a, ownerEmail)).sort((a, b) => a.createdAt - b.createdAt),
      dictatorMode: this.data.dictatorMode,
      registrationOpen: this.data.registrationOpen,
    };
  }

  summary(a: Account, ownerEmail = ''): AccountSummary {
    return {
      id: a.id,
      name: a.name,
      username: a.username,
      email: a.google?.email,
      role: this.effectiveRole(a, ownerEmail),
      createdAt: a.createdAt,
      lastSeenAt: a.lastSeenAt,
    };
  }

  /** Owner by .env e-mail beats everything; invited Google e-mails are guests. */
  effectiveRole(a: Account, ownerEmail = ''): AccountRole {
    if (ownerEmail && a.google && normalizeEmail(a.google.email) === ownerEmail) return 'owner';
    if (a.role === 'pending' && a.google && this.isGuest(a.google.email)) return 'guest';
    return a.role;
  }

  // ------------------------------------------------------------------ invites (Google e-mails)
  isGuest(email: string): boolean {
    const e = normalizeEmail(email);
    return this.data.guests.some((g) => g.email === e);
  }

  addGuest(email: string, name?: string): GuestEntry {
    const e = normalizeEmail(email);
    const existing = this.data.guests.find((g) => g.email === e);
    if (existing) return existing;
    const entry: GuestEntry = { email: e, addedAt: Date.now(), ...(name ? { name } : {}) };
    this.data.guests.push(entry);
    this.persist();
    return entry;
  }

  setGuestName(email: string, name: string): void {
    const g = this.data.guests.find((x) => x.email === normalizeEmail(email));
    if (g && g.name !== name) {
      g.name = name;
      this.persist();
    }
  }

  removeGuest(email: string): boolean {
    const e = normalizeEmail(email);
    const before = this.data.guests.length;
    this.data.guests = this.data.guests.filter((g) => g.email !== e);
    // accounts that got in only through this invite lose access
    for (const a of this.data.accounts) if (a.google?.email === e && a.role === 'guest') a.role = 'pending';
    const changed = this.data.guests.length !== before;
    if (changed) this.persist();
    return changed;
  }

  // ------------------------------------------------------------------ accounts
  get accounts(): Account[] {
    return this.data.accounts;
  }

  hasOwnerAccount(ownerEmail = ''): boolean {
    return this.data.accounts.some((a) => this.effectiveRole(a, ownerEmail) === 'owner');
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
    const a: Account = { id: `u_${crypto.randomBytes(8).toString('hex')}`, createdAt: Date.now(), ...init };
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

  deleteAccount(id: string): boolean {
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    const changed = before !== this.data.accounts.length;
    if (changed) this.persist();
    return changed;
  }

  // ------------------------------------------------------------------ flags
  get dictatorMode(): boolean {
    return this.data.dictatorMode;
  }

  setDictatorMode(enabled: boolean): void {
    if (this.data.dictatorMode === enabled) return;
    this.data.dictatorMode = enabled;
    this.persist();
  }

  get registrationOpen(): boolean {
    return this.data.registrationOpen;
  }

  setRegistrationOpen(open: boolean): void {
    this.data.registrationOpen = open;
    this.persist();
  }

  get tvTokenVersion(): number {
    return this.data.tvTokenVersion;
  }

  bumpTvTokenVersion(): number {
    this.data.tvTokenVersion += 1;
    this.persist();
    return this.data.tvTokenVersion;
  }

  get tvName(): string | undefined {
    return this.data.tvName;
  }

  setTvName(name: string): void {
    if (this.data.tvName === name) return;
    this.data.tvName = name;
    this.persist();
  }
}
