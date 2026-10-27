/**
 * Preload for the YouTube TV view. It runs in the page's main world (contextIsolation is off
 * for this view, sandbox stays on, nothing is exposed to the page) before YouTube's own
 * scripts, so it can strip ads out of the API responses before the player sees them —
 * the same approach as uBlock Origin / Brave's YouTube scriptlets:
 *  - player responses lose adPlacements / playerAds / adSlots → no pre-/mid-roll ads,
 *  - feed / search / watch-next responses lose promoted tiles, masthead and banner ads.
 * Ad servers are additionally blocked at the network level by the main process, and a
 * fallback in the main process fast-forwards anything that still slips through.
 */
(() => {
  const w = window as unknown as { __tvboxAdblock?: { removed: number } };
  if (w.__tvboxAdblock) return;
  const st = (w.__tvboxAdblock = { removed: 0 });

  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams', 'adBreakParams'];
  const AD_RENDERERS =
    /^(adSlotRenderer|promotedSparklesWebRenderer|promotedVideoRenderer|tvMastheadRenderer|bannerPromoRenderer|statementBannerRenderer|compactPromotedItemRenderer|adBreakServiceRenderer|inFeedAdLayoutRenderer|displayAdRenderer|searchPyvRenderer|movieOfferModuleRenderer|primetimePromoRenderer|brandVideoShelfRenderer|brandVideoSingletonRenderer|mealbarPromoRenderer|actionCompanionAdRenderer|instreamVideoAdRenderer|linearAdSequenceRenderer|adActionInterstitialRenderer)$/;

  type Json = Record<string, unknown> | unknown[];

  const isAdTile = (x: Record<string, unknown>): boolean => {
    const tile = x.tileRenderer as Record<string, unknown> | undefined;
    if (!tile) return false;
    if (tile.contentType === 'TILE_CONTENT_TYPE_AD') return true;
    const header = JSON.stringify(tile.metadata || '').slice(0, 2000);
    return /"(Реклама|Ad|Sponsored|Спонсор)"/.test(header) && !!(tile.onSelectCommand as Record<string, unknown> | undefined)?.urlEndpoint;
  };

  const prune = (o: unknown, depth: number): unknown => {
    if (!o || typeof o !== 'object' || depth > 48) return o;
    if (Array.isArray(o)) {
      for (let i = o.length - 1; i >= 0; i--) {
        const x = o[i];
        if (x && typeof x === 'object' && !Array.isArray(x)) {
          const keys = Object.keys(x);
          if ((keys.length === 1 && AD_RENDERERS.test(keys[0])) || isAdTile(x as Record<string, unknown>)) {
            o.splice(i, 1);
            st.removed++;
            continue;
          }
        }
        prune(x, depth + 1);
      }
      return o;
    }
    const rec = o as Record<string, unknown>;
    for (const k of AD_KEYS) {
      if (k in rec) {
        const v = rec[k];
        // count real ads only (the heartbeat / params keys come with every video)
        if ((k === 'adPlacements' || k === 'adSlots' || k === 'playerAds') && v && (!Array.isArray(v) || v.length)) st.removed++;
        delete rec[k];
      }
    }
    for (const k of Object.keys(rec)) {
      if (AD_RENDERERS.test(k)) {
        delete rec[k];
        st.removed++;
        continue;
      }
      const v = rec[k];
      if (v && typeof v === 'object') prune(v, depth + 1);
    }
    return o;
  };

  const looksLikeApi = (r: unknown): boolean => {
    if (!r || typeof r !== 'object') return false;
    const o = r as Record<string, unknown>;
    return !!(o.playabilityStatus || o.adPlacements || o.playerAds || o.contents || o.onResponseReceivedActions || o.continuationContents || o.playerResponse);
  };

  const API_URL = /\/youtubei\/v1\/(player|next|browse|search|guide|reel)/;

  // 1) JSON.parse — catches responses parsed by YouTube itself and inline initial data
  const origParse = JSON.parse;
  JSON.parse = function (this: unknown, text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
    const r = origParse.call(this, text, reviver as never);
    try {
      if (looksLikeApi(r)) prune(r, 0);
    } catch {
      // never break the page
    }
    return r;
  } as typeof JSON.parse;

  // 2) fetch() responses
  const origJson = Response.prototype.json;
  Response.prototype.json = function (this: Response) {
    const url = this.url || '';
    return origJson.call(this).then((r: unknown) => {
      try {
        if (API_URL.test(url)) prune(r, 0);
      } catch {
        // ignore
      }
      return r;
    });
  };
  const origText = Response.prototype.text;
  Response.prototype.text = function (this: Response) {
    const url = this.url || '';
    return origText.call(this).then((t: string) => {
      if (!API_URL.test(url) || !t || t[0] !== '{') return t;
      try {
        return JSON.stringify(prune(origParse(t), 0));
      } catch {
        return t;
      }
    });
  };

  // 3) XMLHttpRequest responses
  type Xhr = XMLHttpRequest & { __tvboxUrl?: string; __tvboxSrc?: unknown; __tvboxOut?: unknown };
  const xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: Xhr, ...args: unknown[]) {
    this.__tvboxUrl = String(args[1] || '');
    return (xo as (...a: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
  for (const prop of ['responseText', 'response'] as const) {
    const d = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, prop);
    if (!d || !d.get) continue;
    const getter = d.get;
    Object.defineProperty(XMLHttpRequest.prototype, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get(this: Xhr) {
        const v = getter.call(this);
        if (this.readyState !== 4 || !API_URL.test(this.__tvboxUrl || '')) return v;
        if (this.__tvboxSrc === v && this.__tvboxOut !== undefined) return this.__tvboxOut;
        try {
          let out: unknown = v;
          if (typeof v === 'string' && v[0] === '{') out = JSON.stringify(prune(origParse(v), 0));
          else if (v && typeof v === 'object' && !(v instanceof ArrayBuffer) && !(v instanceof Blob) && !(v instanceof Document)) out = prune(v as Json, 0);
          this.__tvboxSrc = v;
          this.__tvboxOut = out;
          return out;
        } catch {
          return v;
        }
      },
    });
  }

  // Black page background from the very first frame (no white flash) and a soft fade-in.
  const style = () => {
    const s = document.createElement('style');
    s.textContent = 'html,body{background:#000!important} ytlr-app{animation:tvbox-in .5s ease both} @keyframes tvbox-in{from{opacity:0}to{opacity:1}}';
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.documentElement) style();
  else document.addEventListener('DOMContentLoaded', style, { once: true });
})();
