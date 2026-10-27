// Types for the app launcher, remote input, the movie catalog and YouTube TV.
import type { TmdbResult } from './types';

// ---------------------------------------------------------------------------
// App launcher
// ---------------------------------------------------------------------------

/**
 * desktop – Start menu shortcut / registry entry, store – Microsoft Store app,
 * steam – a game launched through steam://, custom – an .exe added from the remote.
 */
export type AppKind = 'desktop' | 'store' | 'steam' | 'custom';

export interface AppEntry {
  id: string;
  name: string;
  kind: AppKind;
  /** exe / lnk / url path, shell:AppsFolder id or steam:// URL */
  target: string;
  args?: string;
  /** data: URL of the icon (PNG) */
  icon?: string;
  /** Stretch the window over the whole screen (borderless) after launch */
  fullscreen: boolean;
  /** Hidden from the main list (still visible in "hidden") */
  hidden?: boolean;
  /** Pinned to the top */
  pinned?: boolean;
  lastLaunchedAt?: number;
}

export interface AppWindow {
  /** Window handle (decimal string) */
  hwnd: string;
  title: string;
  pid: number;
  exe?: string;
  /** Launched from TVBox: id of the AppEntry */
  appId?: string;
  icon?: string;
  foreground?: boolean;
  minimized?: boolean;
}

export interface AppsState {
  /** Visible top-level windows of other programs */
  windows: AppWindow[];
  /** TVBox itself is in front */
  tvboxForeground: boolean;
  /** App that is starting right now */
  launching?: { appId: string; name: string } | null;
}

export interface AppsListPayload {
  refresh?: boolean;
  includeHidden?: boolean;
}

export interface AppUpdatePayload {
  id: string;
  patch: Partial<Pick<AppEntry, 'name' | 'hidden' | 'pinned' | 'fullscreen' | 'args'>>;
}

// ---------------------------------------------------------------------------
// Remote input (touchpad / keyboard). Sent in small batches without acks.
// ---------------------------------------------------------------------------

export type MouseButton = 'left' | 'right' | 'middle';

/** Named keys understood by the TV ("a".."z", "0".."9" too). */
export type InputKey =
  | 'enter' | 'escape' | 'backspace' | 'tab' | 'space' | 'delete'
  | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12'
  | 'win' | 'alt' | 'ctrl' | 'shift'
  | 'volumeup' | 'volumedown' | 'mute' | 'playpause'
  | string;

export type InputEvent =
  | { t: 'move'; dx: number; dy: number }
  | { t: 'click'; b?: MouseButton; double?: boolean }
  | { t: 'down'; b?: MouseButton }
  | { t: 'up'; b?: MouseButton }
  | { t: 'scroll'; dy: number; dx?: number }
  | { t: 'key'; key: InputKey; mods?: ('ctrl' | 'alt' | 'shift' | 'win')[] }
  | { t: 'text'; text: string };

export interface InputPayload {
  events: InputEvent[];
}

// ---------------------------------------------------------------------------
// Catalog (TMDb) + torrent search (Jackett / Prowlarr)
// ---------------------------------------------------------------------------

export type CatalogKind = 'movie' | 'tv';

export interface CatalogItem extends TmdbResult {
  genreIds?: number[];
  voteCount?: number;
  /** Already in the TV library */
  inLibrary?: boolean;
}

export interface CatalogGenre {
  id: number;
  name: string;
}

export interface CatalogSection {
  id: string;
  title: string;
  /** Opens a full browse with these params */
  browse?: CatalogBrowsePayload;
  items: CatalogItem[];
}

export interface CatalogHome {
  hero: CatalogItem[];
  sections: CatalogSection[];
  genres: { movie: CatalogGenre[]; tv: CatalogGenre[] };
  /** Torrent search set up? (the catalog shows setup steps when not) */
  indexer?: IndexerStatus;
}

export type CatalogSort = 'popular' | 'rating' | 'new' | 'trending';

export interface CatalogBrowsePayload {
  kind: CatalogKind;
  genre?: number;
  /** "animation" — cartoons, "anime" — Japanese animation */
  special?: 'animation' | 'anime' | 'kids' | 'russian';
  sort?: CatalogSort;
  page?: number;
  query?: string;
  yearFrom?: number;
  yearTo?: number;
  minRating?: number;
}

export interface CatalogPage {
  items: CatalogItem[];
  page: number;
  totalPages: number;
}

export interface CatalogPerson {
  name: string;
  character?: string;
  photo?: string;
}

export interface CatalogSeason {
  number: number;
  name: string;
  episodes: number;
  year?: number;
  poster?: string;
}

export interface CatalogDetails extends CatalogItem {
  genres: string[];
  tagline?: string;
  runtime?: number;
  countries?: string[];
  certification?: string;
  status?: string;
  seasons?: CatalogSeason[];
  /** YouTube video ids of trailers (best first) */
  trailers: { key: string; name: string }[];
  cast: CatalogPerson[];
  directors?: string[];
  recommendations: CatalogItem[];
  /** Matching items already in the TV library */
  libraryIds: string[];
  imdbId?: string;
}

export interface CatalogDetailsPayload {
  id: number;
  type: CatalogKind;
}

export interface TorrentSearchPayload {
  /** Search by a catalog item (smart query) … */
  tmdbId?: number;
  type?: CatalogKind;
  season?: number;
  /** … or by free text */
  query?: string;
}

export interface TorrentResult {
  id: string;
  title: string;
  size: number;
  seeders: number;
  leechers: number;
  tracker: string;
  publishedAt?: number;
  magnet?: string;
  /** Download link of the .torrent through the indexer (resolved by the TV) */
  link?: string;
  /** 2160p / 1080p / 720p / SD */
  quality?: string;
  /** HDR, Dolby Vision, Remux, WEB-DL, Дубляж, … */
  tags: string[];
  season?: number;
  /** Season pack vs single episode */
  pack?: boolean;
  /** Ranking (higher is better) */
  score: number;
  /** Looks like the requested title / year */
  matched: boolean;
}

export interface TorrentSearchResult {
  results: TorrentResult[];
  queries: string[];
  /** Indexers / trackers that failed */
  errors?: string[];
}

export type IndexerKind = 'jackett' | 'prowlarr';

export interface IndexerSettings {
  kind: IndexerKind;
  url: string;
  apiKey: string;
}

/** What the catalog uses for torrent search right now */
export interface IndexerStatus {
  /** configured – set in settings, auto – found on the TV PC (Jackett / Prowlarr installed locally) */
  mode: 'configured' | 'auto' | 'none';
  kind?: IndexerKind;
  url?: string;
  /** Number of trackers enabled in the indexer */
  trackers?: number;
  error?: string;
}

/** Metadata attached to a torrent started from the catalog */
export interface TorrentMeta {
  tmdbId: number;
  type: CatalogKind;
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
}

// ---------------------------------------------------------------------------
// YouTube on TV
// ---------------------------------------------------------------------------

/** Remote D-pad keys */
export type NavKey = 'up' | 'down' | 'left' | 'right' | 'enter' | 'back' | 'home' | 'search' | 'backspace' | 'playpause';

export interface YoutubeState {
  open: boolean;
  /** browse – YouTube TV home/search, watch – a video is on screen, login – activation code screen */
  mode: 'closed' | 'browse' | 'watch' | 'login';
  signedIn: boolean;
  /** Activation code shown on the TV ("ABC-DEF-GHI") — enter it at yt.be/activate */
  code?: string;
  /** Ads removed in this session */
  adsBlocked?: number;
  /** Video on screen (watch mode) */
  videoId?: string;
  title?: string;
}

export interface YoutubeOpenPayload {
  videoId?: string;
  /** Open the search results for this text */
  search?: string;
}
