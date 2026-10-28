import { getPref, setPref } from './config';
import { isNative, nativeHaptic } from './native';

/**
 * Vibration feedback, so the remote can be used without looking at it:
 *  tick   – any button
 *  detent – a step of a slider (lightest)
 *  click  – D-pad arrows (a bit firmer: you feel every press)
 *  heavy  – OK / confirm, the start of a drag, the end of a slider
 *  double – something did not work (an error)
 * In the Android app the phone's own haptic effects are used; in a browser, navigator.vibrate.
 */
export type HapticKind = 'tick' | 'click' | 'heavy' | 'double' | 'detent';

const WEB_PATTERN: Record<HapticKind, number | number[]> = {
  tick: 12,
  detent: 5,
  click: 18,
  heavy: 28,
  double: [22, 70, 22],
};

let enabled = getPref('haptics', true);
let last = 0;

export const hapticsAvailable = (): boolean => isNative() || (typeof navigator !== 'undefined' && 'vibrate' in navigator);
export const hapticsEnabled = (): boolean => enabled;

export function setHapticsEnabled(v: boolean): void {
  enabled = v;
  setPref('haptics', v);
  if (v) haptic('click');
}

export function haptic(kind: HapticKind = 'tick'): void {
  if (!enabled) return;
  const now = performance.now();
  // one press = one buzz, even if several handlers react to it
  if (kind !== 'double' && now - last < 35) return;
  last = now;
  if (isNative()) {
    void nativeHaptic(kind).then((ok) => {
      if (!ok) webVibrate(kind);
    });
    return;
  }
  webVibrate(kind);
}

function webVibrate(kind: HapticKind): void {
  try {
    navigator.vibrate?.(WEB_PATTERN[kind]);
  } catch {
    // no vibration API
  }
}

const PRESSABLE = 'button, [role=button], [role=switch], [role=tab], [role=option], a[href], summary, select, label, input[type=checkbox], input[type=radio]';

let installed = false;

/**
 * Every button of the remote buzzes when it is pressed (on the tap itself, so scrolling a list
 * past tiles does not buzz).
 * An element (or a parent) can choose the feel with data-haptic="click|heavy|tick" or opt out with "off".
 */
export function installHaptics(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  let touch = false;
  document.addEventListener('pointerdown', (e) => (touch = e.pointerType !== 'mouse'), { capture: true, passive: true });
  document.addEventListener(
    'click',
    (e) => {
      // a mouse on a computer: nothing to feel
      if (!enabled || (!touch && !isNative())) return;
      const t = e.target as Element | null;
      const el = t?.closest?.(PRESSABLE) as HTMLElement | null;
      if (!el) return;
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return;
      const pref = (t?.closest?.('[data-haptic]') as HTMLElement | null)?.dataset.haptic;
      if (pref === 'off') return;
      haptic(pref === 'click' || pref === 'heavy' || pref === 'double' ? pref : 'tick');
    },
    { capture: true, passive: true },
  );
}
