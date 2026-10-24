export const Events = {
  // Auth
  AUTH: 'auth',
  AUTH_RESULT: 'auth:result',
  PRESENCE: 'presence',

  // Player control (remote -> tv)
  CONTROL: 'control',
  // Player state broadcast (tv -> remotes)
  PLAYER_STATE: 'player:state',

  // Catalog
  CATALOG_GET: 'catalog:get',
  CATALOG: 'catalog',
  CATALOG_UPDATE: 'catalog:update',

  // Torrents
  TORRENT_ADD: 'torrent:add',
  TORRENT_REMOVE: 'torrent:remove',
  TORRENT_WATCH: 'torrent:watch',
  TORRENTS_GET: 'torrents:get',
  TORRENT_LIST: 'torrent:list',
  TORRENT_PROGRESS: 'torrent:progress',

  // Files / metadata
  FILE_DELETE: 'file:delete',
  METADATA_UPDATE: 'metadata:update',

  // Filesystem browser
  FS_LIST: 'fs:list',
  FS_LIST_RESULT: 'fs:list:result',

  // Power (owner only)
  POWER: 'power',

  // WebRTC signaling
  WEBRTC_OFFER: 'webrtc:offer',
  WEBRTC_ANSWER: 'webrtc:answer',
  WEBRTC_ICE: 'webrtc:ice',
  WEBRTC_LEAVE: 'webrtc:leave',

  // Idle screen / widgets
  WIDGETS_GET: 'widgets:get',
  WIDGETS_UPDATE: 'widgets:update',
  WIDGETS_RESULT: 'widgets:result',
  IDLE_SETTINGS_UPDATE: 'idle:settings:update',

  // Admin
  GUESTS_GET: 'guests:get',
  GUESTS_UPDATE: 'guests:update',
  GUESTS_RESULT: 'guests:result',
  DICTATOR_MODE: 'dictator:mode',

  // Generic
  ERROR: 'error',
} as const;

export type EventName = (typeof Events)[keyof typeof Events];
