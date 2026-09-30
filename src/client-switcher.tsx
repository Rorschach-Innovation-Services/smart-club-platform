/**
 * Operator client switcher — the admin-console sidebar control that hops an operator
 * into another client's console in one click.
 *
 * Lists every tenant from the /platform registry (tenant-independent, so it answers on
 * any tenant host). The current tenant is marked and inert; any other opens that
 * client's console with a full page load (openTenantConsole), because the tenant slug
 * is resolved once at module load and an in-app navigate would keep the old one. A
 * tenant with no reachable console from this host (tenantConsoleUrl → null) is listed
 * but inert, tagged "No address".
 *
 * The menu is portaled to <body> and anchored with position:fixed, like InfoDot: the
 * sidebar is an overflow-scrolling container (and a horizontal strip on tablets), so an
 * absolutely positioned child would be clipped.
 *
 * Keyboard: opening focuses the first enabled item; ArrowUp/ArrowDown cycle enabled
 * items (wrapping), Home/End jump; Escape or Tab closes and returns focus to the trigger;
 * focus leaving both trigger and menu closes it.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { qk } from './query';
import * as api from './api';
import { Icon } from './atoms';
import { openTenantConsole, tenantConsoleUrl } from './config';
import type { TenantSummary } from './types';

const ENABLED_ITEM = '[role="menuitem"]:not(:disabled)';

export function ClientSwitcher({
  currentSlug,
  enabled = true,
}: {
  currentSlug: string;
  /** Gate the registry fetch — only operators may call /platform/*. */
  enabled?: boolean;
}) {
  const q = useQuery({
    queryKey: qk.platformTenants(),
    queryFn: api.platformListTenants,
    enabled,
  });
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    flipY: boolean;
    maxHeight: number;
  } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Focus the first item once per opening — not again when the list re-renders.
  const focusedOnOpen = useRef(false);
  const menuId = useId();

  const place = () => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const W = 260;
    const margin = 8;
    const left = Math.max(margin, Math.min(b.left, window.innerWidth - W - margin));
    // The trigger sits low in the sidebar, so open on whichever side has more room;
    // a long client list then caps to that height and scrolls inside itself.
    const spaceBelow = window.innerHeight - b.bottom - margin;
    const spaceAbove = b.top - margin;
    const flipY = spaceBelow < 240 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(140, (flipY ? spaceAbove : spaceBelow) - 4);
    setPos({ top: flipY ? b.top - 4 : b.bottom + 4, left, flipY, maxHeight });
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };

  // Listeners live only while open (same shape as InfoDot).
  useEffect(() => {
    if (!open) {
      focusedOnOpen.current = false;
      return;
    }
    place();
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        close(true);
      }
    };
    const onResize = () => place();
    // Scrolling the list itself doesn't move the anchor — don't re-place on it.
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node)) return;
      place();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
    // place()/close() read live refs each open; deps intentionally just [open].
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tenants: TenantSummary[] = [...(q.data ?? [])].sort((a, b) =>
    (a.name || a.tenant).localeCompare(b.name || b.tenant),
  );

  // Move focus into the menu once it has rendered AND has items. This can't run in the
  // open effect itself: the portal mounts only after place() sets `pos`, and the items
  // only after the registry loads.
  useEffect(() => {
    if (!open || !pos || focusedOnOpen.current) return;
    const first = popRef.current?.querySelector<HTMLButtonElement>(ENABLED_ITEM);
    if (!first) return;
    first.focus();
    focusedOnOpen.current = true;
  }, [open, pos, tenants.length]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      close(true);
      return;
    }
    const items = Array.from(
      popRef.current?.querySelectorAll<HTMLButtonElement>(ENABLED_ITEM) ?? [],
    );
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
    else if (e.key === 'ArrowUp')
      next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next === null) return;
    e.preventDefault();
    items[next].focus();
  };

  // Focus moving to something outside both trigger and menu closes it (as InfoDot). A
  // click on non-focusable menu chrome blurs to <body> (no relatedTarget) — the
  // outside-click listener already handles real outside clicks.
  const onBlur = (e: FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (!next) return;
    if (btnRef.current?.contains(next) || popRef.current?.contains(next)) return;
    setOpen(false);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="nav-item"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onBlur={open ? onBlur : undefined}
      >
        <span className="ni-icon">
          <Icon.Clubs />
        </span>
        <span className="ni-label">Switch client</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            id={menuId}
            className="client-switch-pop"
            role="menu"
            aria-label="Switch client"
            onKeyDown={onMenuKeyDown}
            onBlur={onBlur}
            style={{
              top: pos.top,
              left: pos.left,
              maxHeight: pos.maxHeight,
              transform: pos.flipY ? 'translateY(-100%)' : undefined,
            }}
          >
            {q.isLoading ? (
              <div className="client-switch-note">Loading clients…</div>
            ) : q.isError ? (
              <div className="client-switch-note">Could not load clients — try again.</div>
            ) : tenants.length === 0 ? (
              <div className="client-switch-note">No clients on the platform.</div>
            ) : (
              tenants.map((t) => {
                const current = t.tenant === currentSlug;
                const unreachable = !current && tenantConsoleUrl(t.tenant) === null;
                return (
                  <button
                    key={t.tenant}
                    type="button"
                    role="menuitem"
                    className={`client-switch-item${current ? ' current' : ''}`}
                    aria-current={current ? 'true' : undefined}
                    disabled={current || unreachable}
                    title={unreachable ? 'No web address yet' : undefined}
                    onClick={() => openTenantConsole(t.tenant)}
                  >
                    <span className="client-switch-name">{t.name || t.tenant}</span>
                    <span className="client-switch-slug">{t.tenant}</span>
                    {current && <span className="client-switch-tag">Current</span>}
                    {unreachable && <span className="client-switch-tag">No address</span>}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
