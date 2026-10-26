/**
 * Socket.io event names. Request/response events use socket.io acknowledgements
 * (the last argument of `emit` is a callback receiving an `Ack`).
 */
export const Events = {
  // ---- auth / linking ----
  AUTH: 'auth',
  PING: 'ping:tvbox', // any -> server (ack: {ok}) — liveness probe after the app resumes
  LINK_START: 'link:start', // unauthenticated client -> server (ack: LinkStartResult)
  LINK_INFO: 'link:info', // any -> server (ack: LinkInfoResult)
  LINK_APPROVE: 'link:approve', // authed user -> server (ack)
  LINK_DONE: 'link:done', // server -> waiting client
  PRESENCE: 'presence',
  SYNC: 'sync', // server -> remote snapshot after auth
  KICKED: 'kicked', // server -> client (access revoked)

  // ---- player ----
  CONTROL: 'control', // remote -> tv
  PLAYER_STATE: 'player:state', // tv -> remotes

  // ---- catalog ----
  CATALOG_GET: 'catalog:get', // remote -> tv (ack: MediaItem[])
  CATALOG: 'catalog', // tv -> remotes (full list)
  MEDIA_UPDATE: 'media:update', // remote -> tv (edit metadata, ack)
  MEDIA_DELETE: 'media:delete', // remote -> tv (delete file, ack)
  TMDB_SEARCH: 'tmdb:search', // remote -> tv (ack: TmdbResult[])
  MEDIA_APPLY_TMDB: 'media:apply-tmdb', // remote -> tv (ack)
  LIBRARY_RESCAN: 'library:rescan', // remote -> tv (ack)

  // ---- torrents ----
  TORRENT_ADD: 'torrent:add', // remote -> tv (ack)
  TORRENT_REMOVE: 'torrent:remove', // remote -> tv (ack)
  TORRENTS: 'torrents', // tv -> remotes (full list)

  // ---- filesystem ----
  FS_LIST: 'fs:list', // remote -> tv (ack: FsListResult)

  // ---- idle screen ----
  IDLE_GET: 'idle:get', // remote -> tv (ack: IdleSettings)
  IDLE_UPDATE: 'idle:update', // remote -> tv (ack)
  IDLE: 'idle', // tv -> remotes

  // ---- tv settings / system ----
  TV_SETTINGS_GET: 'tv:settings:get', // owner -> tv (ack: TvSettings)
  TV_SETTINGS_UPDATE: 'tv:settings:update', // owner -> tv (ack)
  POWER: 'power', // owner -> tv
  TV_UPDATE: 'tv:update', // owner -> tv (download & install the latest build)
  YOUTUBE_LOGIN: 'youtube:login', // owner -> tv (open Google sign-in for YouTube on the TV)
  YOUTUBE_LOGOUT: 'youtube:logout', // owner -> tv

  // ---- music services ----
  MUSIC_SOURCES: 'music:sources', // remote -> tv (ack: MusicSource[])
  MUSIC_SOURCES_CHANGED: 'music:sources:changed', // tv -> remotes (MusicSource[])
  MUSIC_SOURCE_ADD: 'music:source:add', // remote -> tv (ack: MusicSource)
  MUSIC_SOURCE_REMOVE: 'music:source:remove',
  MUSIC_BROWSE: 'music:browse', // ack: MusicBrowseResult
  MUSIC_ITEM: 'music:item', // ack: MusicItemResult
  MUSIC_SEARCH: 'music:search', // ack: MusicBrowseResult
  MUSIC_CACHE: 'music:cache', // ack: MusicCacheInfo ({clear:true} empties it)
  MUSIC_COVER: 'music:cover', // ack: data: URL of a small cover picture ({sourceId, id})

  // ---- uploads (remote -> tv, relayed in chunks) ----
  UPLOAD_BEGIN: 'upload:begin',
  UPLOAD_CHUNK: 'upload:chunk',
  UPLOAD_END: 'upload:end',

  // ---- admin (handled by the server) ----
  ADMIN_GET: 'admin:get', // owner -> server (ack: AdminState)
  GUESTS_UPDATE: 'guests:update', // owner -> server (ack: AdminState)
  DICTATOR_MODE: 'dictator:mode', // owner -> server (ack: AdminState)
  ADMIN: 'admin', // server -> owners
  TV_UNPAIR: 'tv:unpair', // owner -> server
  ACCOUNT_UPDATE: 'account:update', // owner -> server ({id, role})
  ACCOUNT_DELETE: 'account:delete', // owner -> server ({id})
  REGISTRATION_SET: 'registration:set', // owner -> server ({open})

  // ---- WebRTC signaling ----
  WEBRTC_OFFER: 'webrtc:offer',
  WEBRTC_ANSWER: 'webrtc:answer',
  WEBRTC_ICE: 'webrtc:ice',
  WEBRTC_LEAVE: 'webrtc:leave',

  // ---- misc ----
  TOAST: 'toast', // tv/server -> remotes, short notification
  ERROR: 'error:msg',
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

/** Events a remote sends that the server forwards to the TV (with ack relay). */
export const TV_REQUEST_EVENTS = [
  Events.CONTROL,
  Events.CATALOG_GET,
  Events.MEDIA_UPDATE,
  Events.MEDIA_DELETE,
  Events.TMDB_SEARCH,
  Events.MEDIA_APPLY_TMDB,
  Events.LIBRARY_RESCAN,
  Events.TORRENT_ADD,
  Events.TORRENT_REMOVE,
  Events.FS_LIST,
  Events.IDLE_GET,
  Events.IDLE_UPDATE,
  Events.TV_SETTINGS_GET,
  Events.TV_SETTINGS_UPDATE,
  Events.POWER,
  Events.TV_UPDATE,
  Events.YOUTUBE_LOGIN,
  Events.YOUTUBE_LOGOUT,
  Events.MUSIC_SOURCES,
  Events.MUSIC_SOURCE_ADD,
  Events.MUSIC_SOURCE_REMOVE,
  Events.MUSIC_BROWSE,
  Events.MUSIC_ITEM,
  Events.MUSIC_SEARCH,
  Events.MUSIC_CACHE,
  Events.MUSIC_COVER,
  Events.UPLOAD_BEGIN,
  Events.UPLOAD_CHUNK,
  Events.UPLOAD_END,
] as const;

/** Events the TV pushes that the server caches and broadcasts to remotes. */
export const TV_BROADCAST_EVENTS = [
  Events.PLAYER_STATE,
  Events.CATALOG,
  Events.TORRENTS,
  Events.IDLE,
  Events.TOAST,
  Events.MUSIC_SOURCES_CHANGED,
] as const;

export const WEBRTC_EVENTS = [
  Events.WEBRTC_OFFER,
  Events.WEBRTC_ANSWER,
  Events.WEBRTC_ICE,
  Events.WEBRTC_LEAVE,
] as const;
