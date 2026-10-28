import { useEffect, useRef } from 'react';

/**
 * "Back" for the whole remote: the Android back gesture / button, the browser's back button
 * (PWA) and Esc all close the topmost thing that is open — a sheet, a full-screen panel,
 * a details page — instead of leaving the app. Only when nothing is open does the app
 * go to the main tab, and from there to the background.
 *
 * Levels: 1 = popups and sub-pages (closed first), 0 = leaving a tab for the main one.
 */
interface Entry {
  fn: () => void;
  level: number;
  seq: number;
}

const stack: Entry[] = [];
let seq = 0;

export function useBack(active: boolean, fn: () => void, level = 1): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const entry: Entry = { fn: () => ref.current(), level, seq: ++seq };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active, level]);
}

/** Handle one "back": returns false when there was nothing to close. */
export function goBack(): boolean {
  let top: Entry | null = null;
  for (const e of stack) if (!top || e.level > top.level || (e.level === top.level && e.seq > top.seq)) top = e;
  if (!top) return false;
  top.fn();
  return true;
}

/** Anything above the tab level open (a popup, a details page…)? */
export function hasOpenPopups(): boolean {
  return stack.some((e) => e.level > 0);
}

let installed = false;

/**
 * Esc and the browser's back button. On the web a dummy history entry catches "back"
 * while something can be closed; with nothing open, back leaves the page as usual.
 */
export function installBackHandling(native: boolean): void {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (hasOpenPopups() && goBack()) e.preventDefault();
  });
  if (native) return;
  const arm = () => {
    if (!(history.state && history.state.tvboxBack)) history.pushState({ ...(history.state || {}), tvboxBack: true }, '');
  };
  arm();
  window.addEventListener('popstate', () => {
    if (goBack()) arm();
    else history.back();
  });
}
