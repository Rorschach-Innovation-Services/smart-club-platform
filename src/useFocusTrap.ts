/**
 * Keep Tab and Shift+Tab inside a modal surface while it is open: Tab from the last
 * focusable element wraps to the first, Shift+Tab from the first wraps to the last, and a
 * Tab pressed while focus has escaped the surface pulls it back in.
 *
 * Shared by `Modal` (atoms.tsx) and the help drawer, which can stack — the drawer opens over
 * a modal, a confirm over a task modal. Only the most recently activated trap acts, so the
 * surface underneath never pulls focus back out of the one on top.
 *
 * Deliberately imports nothing from atoms.tsx: HelpDrawer uses it, and atoms renders
 * HelpLink, so importing atoms here would make a cycle.
 */
import { useEffect, type RefObject } from 'react';

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Active traps, oldest first. Only the last one handles Tab. */
const stack: Array<RefObject<HTMLElement>> = [];

export function useFocusTrap(ref: RefObject<HTMLElement>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    stack.push(ref);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || stack[stack.length - 1] !== ref) return;
      const panel = ref.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !panel.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !panel.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [ref, active]);
}
