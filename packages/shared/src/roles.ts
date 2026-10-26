import { Events } from './events';
import type { Role } from './types';

export type CommandCategory =
  | 'control'
  | 'catalog'
  | 'library-edit'
  | 'torrent'
  | 'fs'
  | 'webrtc'
  | 'widgets'
  | 'settings'
  | 'power'
  | 'music'
  | 'music-admin'
  | 'admin';

/** What a guest may do. The owner may do everything. */
const GUEST_ALLOWED: Record<CommandCategory, boolean> = {
  control: true,
  catalog: true,
  'library-edit': false,
  torrent: true,
  fs: true,
  webrtc: true,
  widgets: false,
  settings: false,
  power: false,
  music: true,
  'music-admin': false,
  admin: false,
};

/** Categories still allowed to guests while dictator mode is on (read-only stuff). */
const DICTATOR_ALLOWED: Partial<Record<CommandCategory, boolean>> = {
  catalog: true,
  music: true,
};

export const CATEGORY_BY_EVENT: Record<string, CommandCategory> = {
  [Events.CONTROL]: 'control',
  [Events.CATALOG_GET]: 'catalog',
  [Events.TMDB_SEARCH]: 'catalog',
  [Events.MEDIA_UPDATE]: 'library-edit',
  [Events.MEDIA_DELETE]: 'library-edit',
  [Events.MEDIA_APPLY_TMDB]: 'library-edit',
  [Events.LIBRARY_RESCAN]: 'library-edit',
  [Events.TORRENT_ADD]: 'torrent',
  [Events.TORRENT_REMOVE]: 'torrent',
  [Events.FS_LIST]: 'fs',
  [Events.IDLE_GET]: 'catalog',
  [Events.IDLE_UPDATE]: 'widgets',
  [Events.TV_SETTINGS_GET]: 'settings',
  [Events.TV_SETTINGS_UPDATE]: 'settings',
  [Events.POWER]: 'power',
  [Events.TV_UPDATE]: 'power',
  [Events.YOUTUBE_LOGIN]: 'settings',
  [Events.YOUTUBE_LOGOUT]: 'settings',
  [Events.MUSIC_SOURCES]: 'music',
  [Events.MUSIC_BROWSE]: 'music',
  [Events.MUSIC_ITEM]: 'music',
  [Events.MUSIC_SEARCH]: 'music',
  [Events.MUSIC_COVER]: 'music',
  [Events.MUSIC_SOURCE_ADD]: 'music-admin',
  [Events.MUSIC_SOURCE_REMOVE]: 'music-admin',
  [Events.MUSIC_CACHE]: 'music-admin',
  [Events.UPLOAD_BEGIN]: 'widgets',
  [Events.UPLOAD_CHUNK]: 'widgets',
  [Events.UPLOAD_END]: 'widgets',
  [Events.ACCOUNT_UPDATE]: 'admin',
  [Events.ACCOUNT_DELETE]: 'admin',
  [Events.REGISTRATION_SET]: 'admin',
  [Events.ADMIN_GET]: 'admin',
  [Events.GUESTS_UPDATE]: 'admin',
  [Events.DICTATOR_MODE]: 'admin',
  [Events.TV_UNPAIR]: 'admin',
  [Events.WEBRTC_OFFER]: 'webrtc',
  [Events.WEBRTC_ANSWER]: 'webrtc',
  [Events.WEBRTC_ICE]: 'webrtc',
  [Events.WEBRTC_LEAVE]: 'webrtc',
};

export function canPerform(role: Role, category: CommandCategory, dictatorMode = false): boolean {
  if (role === 'owner') return true;
  if (role === 'device') return category === 'webrtc';
  if (!GUEST_ALLOWED[category]) return false;
  if (dictatorMode && !DICTATOR_ALLOWED[category]) return false;
  return true;
}

export function canPerformEvent(role: Role, event: string, dictatorMode = false): boolean {
  const category = CATEGORY_BY_EVENT[event];
  if (!category) return false;
  return canPerform(role, category, dictatorMode);
}

export function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}
