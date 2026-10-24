import type { Role } from './types';

export type CommandCategory =
  | 'control'
  | 'catalog'
  | 'torrent'
  | 'file'
  | 'fs'
  | 'webrtc'
  | 'widgets'
  | 'power'
  | 'admin';

const OWNER_PERMISSIONS: Record<CommandCategory, boolean> = {
  control: true,
  catalog: true,
  torrent: true,
  file: true,
  fs: true,
  webrtc: true,
  widgets: true,
  power: true,
  admin: true,
};

const GUEST_PERMISSIONS: Record<CommandCategory, boolean> = {
  control: true,
  catalog: true,
  torrent: true,
  file: false,
  fs: true,
  webrtc: true,
  widgets: false,
  power: false,
  admin: false,
};

const DEVICE_PERMISSIONS: Record<CommandCategory, boolean> = {
  control: false,
  catalog: false,
  torrent: false,
  file: false,
  fs: false,
  webrtc: true,
  widgets: false,
  power: false,
  admin: false,
};

const PERMISSIONS: Record<Role, Record<CommandCategory, boolean>> = {
  owner: OWNER_PERMISSIONS,
  guest: GUEST_PERMISSIONS,
  device: DEVICE_PERMISSIONS,
};

export function canPerform(role: Role, category: CommandCategory, dictatorMode = false): boolean {
  if (role === 'owner') return true;
  if (role === 'guest' && dictatorMode) return false;
  return PERMISSIONS[role]?.[category] ?? false;
}

export function isOwner(role: Role | undefined): boolean {
  return role === 'owner';
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function sanitizeRole(role: unknown): Role {
  if (role === 'owner' || role === 'guest' || role === 'device') return role;
  return 'guest';
}
