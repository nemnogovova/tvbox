import type { TvBoxApi } from './types';

declare global {
  interface Window {
    tvbox: TvBoxApi;
  }
}

export {};
