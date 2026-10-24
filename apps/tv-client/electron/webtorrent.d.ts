declare module 'webtorrent' {
  const WebTorrent: new (opts?: Record<string, unknown>) => unknown;
  export default WebTorrent;
}
