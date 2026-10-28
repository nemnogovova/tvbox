export * from './types';
export * from './events';
export * from './commands';
export * from './features';
export * from './roles';
export * from './torrent-parse';
export * from './release-parse';
export * from './util';

export const APP_NAME = 'TVBox';
/**
 * Version of the remote ⇄ server ⇄ TV protocol. Bump it when new socket events are added:
 * a remote newer than the server shows "update the server" instead of silently failing.
 *   1 – TVBox 3.0
 *   2 – catalog, app launcher, touchpad, YouTube TV
 *   3 – homes: several isolated TVs with their own people on one server
 */
export const PROTOCOL_VERSION = 3;
export const DEFAULT_SERVER_URL = 'https://tv.nemnogovova.com';
