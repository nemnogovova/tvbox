import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowBigUp, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Delete, Keyboard, MousePointer2, Send, X } from 'lucide-react';
import type { InputKey } from '@tvbox/shared';
import { sendInput } from '../store/store';
import { useBack } from '../lib/back';
import { getPref, setPref } from '../lib/config';
import { cx } from './ui';
import { haptic } from '../lib/haptics';


interface Pt {
  x: number;
  y: number;
}

/**
 * Phone as a laptop touchpad for the TV PC:
 *  1 finger – move · tap – click · double tap – double click
 *  2 fingers – scroll · 2-finger tap – right click
 *  press & hold, then move – drag (select, move windows / cards)
 */
export function Touchpad({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [speed, setSpeed] = useState(() => getPref<number>('touchpadSpeed', 1.4));
  const [keyboard, setKeyboard] = useState(false);
  const [dragging, setDragging] = useState(false);
  const surface = useRef<HTMLDivElement | null>(null);

  useEffect(() => setPref('touchpadSpeed', speed), [speed]);

  // gesture state lives in a ref: touch events fire far too often for React state
  const g = useRef({
    touches: new Map<number, Pt>(),
    start: 0,
    startPt: { x: 0, y: 0 } as Pt,
    moved: 0,
    maxFingers: 0,
    lastT: 0,
    scrollAcc: 0,
    holdTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    drag: false,
    lastTap: 0,
  });

  useEffect(() => {
    const el = surface.current;
    if (!open || !el) return;
    const st = g.current;

    const pts = (e: TouchEvent) => Array.from(e.touches).map((t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));

    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      const list = pts(e);
      if (st.touches.size === 0) {
        st.start = performance.now();
        st.startPt = { x: list[0].x, y: list[0].y };
        st.moved = 0;
        st.maxFingers = 0;
        st.scrollAcc = 0;
        // press & hold → drag
        clearTimeout(st.holdTimer);
        st.holdTimer = setTimeout(() => {
          if (st.touches.size === 1 && st.moved < 8) {
            st.drag = true;
            setDragging(true);
            haptic('heavy');
            sendInput({ t: 'down', b: 'left' });
          }
        }, 420);
      }
      for (const p of list) st.touches.set(p.id, { x: p.x, y: p.y });
      st.maxFingers = Math.max(st.maxFingers, list.length);
      st.lastT = performance.now();
    };

    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      const list = pts(e);
      const now = performance.now();
      const dt = Math.max(1, now - st.lastT);
      st.lastT = now;
      let dx = 0;
      let dy = 0;
      let n = 0;
      for (const p of list) {
        const prev = st.touches.get(p.id);
        if (prev) {
          dx += p.x - prev.x;
          dy += p.y - prev.y;
          n++;
        }
        st.touches.set(p.id, { x: p.x, y: p.y });
      }
      if (!n) return;
      dx /= n;
      dy /= n;
      st.moved += Math.hypot(dx, dy);
      if (st.moved > 8) clearTimeout(st.holdTimer);

      if (list.length >= 2) {
        // two-finger scroll: content follows the fingers
        st.scrollAcc += dy * 3;
        if (Math.abs(st.scrollAcc) >= 30) {
          const step = Math.trunc(st.scrollAcc / 30) * 30;
          st.scrollAcc -= step;
          sendInput({ t: 'scroll', dy: step });
        }
        return;
      }
      // pointer acceleration: slow moves are precise, fast flicks cross the screen
      const v = Math.hypot(dx, dy) / dt;
      const gain = speed * (1 + Math.min(3, Math.max(0, (v - 0.25) * 2.2)));
      sendInput({ t: 'move', dx: dx * gain, dy: dy * gain });
    };

    const onEnd = (e: TouchEvent) => {
      e.preventDefault();
      const left = new Set(Array.from(e.touches).map((t) => t.identifier));
      for (const id of Array.from(st.touches.keys())) if (!left.has(id)) st.touches.delete(id);
      if (st.touches.size) return;
      clearTimeout(st.holdTimer);
      const dur = performance.now() - st.start;
      if (st.drag) {
        st.drag = false;
        setDragging(false);
        sendInput({ t: 'up', b: 'left' });
        return;
      }
      if (dur < 260 && st.moved < 10) {
        if (st.maxFingers >= 2) {
          sendInput({ t: 'click', b: 'right' });
          haptic('click');
        } else {
          sendInput({ t: 'click', b: 'left' });
          haptic('tick');
        }
      }
    };

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onEnd, { passive: false });

    // desktop browsers: drag with the mouse, wheel to scroll
    let mouseDown = false;
    let last: Pt | null = null;
    let downAt = 0;
    let travel = 0;
    const md = (e: MouseEvent) => {
      mouseDown = true;
      last = { x: e.clientX, y: e.clientY };
      downAt = performance.now();
      travel = 0;
    };
    const mm = (e: MouseEvent) => {
      if (!mouseDown || !last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      travel += Math.hypot(dx, dy);
      last = { x: e.clientX, y: e.clientY };
      sendInput({ t: 'move', dx: dx * speed, dy: dy * speed });
    };
    const mu = (e: MouseEvent) => {
      if (mouseDown && travel < 5 && performance.now() - downAt < 300) sendInput({ t: 'click', b: e.button === 2 ? 'right' : 'left' });
      mouseDown = false;
      last = null;
    };
    const wh = (e: WheelEvent) => {
      e.preventDefault();
      sendInput({ t: 'scroll', dy: -Math.sign(e.deltaY) * 120 });
    };
    const cm = (e: MouseEvent) => e.preventDefault();
    el.addEventListener('mousedown', md);
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
    el.addEventListener('wheel', wh, { passive: false });
    el.addEventListener('contextmenu', cm);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('mousedown', md);
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('mouseup', mu);
      el.removeEventListener('wheel', wh);
      el.removeEventListener('contextmenu', cm);
      clearTimeout(st.holdTimer);
      if (st.drag) sendInput({ t: 'up', b: 'left' });
      st.drag = false;
      st.touches.clear();
    };
  }, [open, speed]);

  // back: the keyboard panel first, then the touchpad itself
  useBack(open, () => (keyboard ? setKeyboard(false) : onClose()));

  if (!open) return null;
  const key = (k: InputKey, mods?: ('ctrl' | 'alt' | 'shift' | 'win')[]) => {
    sendInput({ t: 'key', key: k, mods });
  };

  return createPortal(
    <div className="fixed inset-0 z-[220] flex animate-fade-in flex-col bg-ink-950" style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}>
      <div className="flex items-center gap-3 px-4 py-3">
        <MousePointer2 size={20} className="text-ember" />
        <span className="flex-1 font-bold">Тачпад</span>
        <label className="flex items-center gap-2 text-xs text-fg-dim">
          Скорость
          <input
            type="range"
            min={0.6}
            max={3}
            step={0.1}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="range w-24"
            style={{ ['--pct' as string]: `${((speed - 0.6) / 2.4) * 100}%` }}
          />
        </label>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <X size={22} />
        </button>
      </div>

      <div
        ref={surface}
        className={cx(
          'relative mx-3 flex flex-1 touch-none select-none items-center justify-center overflow-hidden rounded-[28px] border transition-colors',
          dragging ? 'border-ember/60 bg-ember/[0.06]' : 'border-white/[0.07] bg-gradient-to-b from-ink-800 to-ink-850',
        )}
      >
        <div className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:radial-gradient(rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:22px_22px]" />
        <div className="pointer-events-none relative px-8 text-center text-[13px] leading-relaxed text-fg-dim">
          {dragging ? (
            <span className="text-base font-bold text-ember">Перетаскивание — отпустите палец</span>
          ) : (
            <>
              <p className="mb-2 text-sm font-semibold text-fg-muted">Водите пальцем, как по тачпаду ноутбука</p>
              <p>Тап — клик · два пальца — прокрутка</p>
              <p>Тап двумя пальцами — правый клик</p>
              <p>Удержание и движение — перетащить</p>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 px-3 pt-2">
        <button className="btn-soft h-12" onClick={() => sendInput({ t: 'click', b: 'left' })}>
          Левая кнопка
        </button>
        <button className="btn-soft h-12" onClick={() => sendInput({ t: 'click', b: 'right' })}>
          Правая кнопка
        </button>
      </div>

      <div className="flex gap-1.5 overflow-x-auto px-3 py-2 [scrollbar-width:none]">
        <KeyBtn onClick={() => setKeyboard((k) => !k)} active={keyboard}>
          <Keyboard size={16} /> Текст
        </KeyBtn>
        <KeyBtn onClick={() => key('escape')}>Esc</KeyBtn>
        <KeyBtn onClick={() => key('enter')}>
          <CornerDownLeft size={15} />
        </KeyBtn>
        <KeyBtn onClick={() => key('backspace')}>
          <Delete size={15} />
        </KeyBtn>
        <KeyBtn onClick={() => key('tab')}>Tab</KeyBtn>
        <KeyBtn onClick={() => key('space')}>Пробел</KeyBtn>
        <KeyBtn onClick={() => key('left')}>
          <ArrowLeft size={15} />
        </KeyBtn>
        <KeyBtn onClick={() => key('up')}>
          <ArrowUp size={15} />
        </KeyBtn>
        <KeyBtn onClick={() => key('down')}>
          <ArrowDown size={15} />
        </KeyBtn>
        <KeyBtn onClick={() => key('right')}>
          <ArrowRight size={15} />
        </KeyBtn>
        <KeyBtn onClick={() => key('enter', ['alt'])}>Alt+Enter</KeyBtn>
        <KeyBtn onClick={() => key('f11')}>F11</KeyBtn>
        <KeyBtn onClick={() => key('tab', ['alt'])}>Alt+Tab</KeyBtn>
        <KeyBtn onClick={() => key('win')}>Win</KeyBtn>
        <KeyBtn onClick={() => key('shift')}>
          <ArrowBigUp size={15} />
        </KeyBtn>
      </div>
      {keyboard && <TextSender />}
    </div>,
    document.body,
  );
}

function KeyBtn({ children, onClick, active }: { children: ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl px-3.5 text-[13px] font-bold transition active:scale-95',
        active ? 'bg-ember text-ink-950' : 'bg-ink-750 text-fg-muted',
      )}
    >
      {children}
    </button>
  );
}

/** Types into whatever has focus on the TV. Letters go through as text (any layout / language). */
function TextSender() {
  const [text, setText] = useState('');
  const [live, setLive] = useState(() => getPref<boolean>('touchpadLive', true));
  const prev = useRef('');
  useEffect(() => setPref('touchpadLive', live), [live]);

  const onChange = (v: string) => {
    if (live) {
      // send the difference right away: typed characters or backspaces
      const old = prev.current;
      let common = 0;
      while (common < old.length && common < v.length && old[common] === v[common]) common++;
      for (let i = 0; i < old.length - common; i++) sendInput({ t: 'key', key: 'backspace' });
      const added = v.slice(common);
      if (added) sendInput({ t: 'text', text: added });
    }
    prev.current = v;
    setText(v);
  };
  const submit = () => {
    if (!live && text) sendInput({ t: 'text', text });
    sendInput({ t: 'key', key: 'enter' });
    setText('');
    prev.current = '';
  };
  return (
    <form
      className="flex items-center gap-2 px-3 pb-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        autoFocus
        className="field h-12 flex-1"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder={live ? 'Печатайте — сразу на ТВ' : 'Текст для отправки'}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
      />
      <button type="button" className={cx('chip h-12 rounded-2xl px-3', live ? 'bg-ember/15 text-ember' : 'bg-ink-750 text-fg-dim')} onClick={() => setLive((l) => !l)}>
        Сразу
      </button>
      <button className="btn-primary h-12 w-12 px-0" aria-label="Отправить и нажать Enter">
        <Send size={18} />
      </button>
    </form>
  );
}
