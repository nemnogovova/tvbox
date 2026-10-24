import fs from 'node:fs';
import path from 'node:path';
import type { GuestEntry, ServerConfig } from '@tvbox/shared';

interface StoreData {
  guests: GuestEntry[];
  dictatorMode: boolean;
}

const DEFAULT_DATA: StoreData = { guests: [], dictatorMode: false };

export class JsonStore {
  private data: StoreData;
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'store.json');
    this.data = this.read();
  }

  private read(): StoreData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<StoreData>;
        return {
          guests: Array.isArray(parsed.guests) ? parsed.guests : [],
          dictatorMode: Boolean(parsed.dictatorMode),
        };
      }
    } catch {
      // corrupt file -> fall through to defaults
    }
    return { ...DEFAULT_DATA, guests: [...DEFAULT_DATA.guests] };
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  getConfig(): ServerConfig {
    return {
      guests: this.data.guests.map((g) => ({ ...g })),
      dictatorMode: this.data.dictatorMode,
    };
  }

  isGuest(email: string): boolean {
    return this.data.guests.some((g) => g.email.toLowerCase() === email.toLowerCase());
  }

  addGuest(email: string, name?: string): GuestEntry {
    const normalized = email.trim().toLowerCase();
    const existing = this.data.guests.find((g) => g.email.toLowerCase() === normalized);
    if (existing) return existing;
    const entry: GuestEntry = { email: normalized, name, addedAt: Date.now() };
    this.data.guests.push(entry);
    this.persist();
    return entry;
  }

  removeGuest(email: string): boolean {
    const normalized = email.trim().toLowerCase();
    const before = this.data.guests.length;
    this.data.guests = this.data.guests.filter((g) => g.email.toLowerCase() !== normalized);
    const changed = this.data.guests.length !== before;
    if (changed) this.persist();
    return changed;
  }

  setDictatorMode(enabled: boolean): void {
    if (this.data.dictatorMode === enabled) return;
    this.data.dictatorMode = enabled;
    this.persist();
  }
}
