/** Address of the TV's local media server (the page itself is served by it in production). */
export const mediaBase = () => (location.origin.startsWith('http') ? location.origin : 'http://127.0.0.1:8765');

/** tvbox-file:<name> → file uploaded to the TV, served by the local media server (display: a screen-sized copy). */
export const mediaSrc = (src: string, variant?: 'display') =>
  src.startsWith('tvbox-file:') ? `${mediaBase()}/screensaver-file?n=${encodeURIComponent(src.slice(11))}${variant ? `&v=${variant}` : ''}` : src;
