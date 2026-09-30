/**
 * Operator client switcher — the admin-console sidebar control that hops an operator
 * into another client's console in one click.
 *
 * Lists every tenant from the /platform registry (tenant-independent, so it answers on
 * any tenant host). The current tenant is marked and inert; any other opens that
 * client's console with a full page load (openTenantConsole), because the tenant slug
 * is resolved once at module load and an in-app navigate would keep the old one.
 *
 * The menu is portaled to <body> and anchored with position:fixed, like InfoDot: the
 * sidebar is an overflow-scrolling container (and a horizontal strip on tablets), so an
 * absolutely positioned child would be clipped.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { qk } from './query';
import * as api from './api';
import { Icon } from './atoms';
import { openTenantConsole } from './config';
import type { TenantSummary } from './types';

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

  // Listeners live only while open (same shape as InfoDot).
  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const onReflow = () => place();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
    // place() reads live layout each open; deps intentionally just [open].
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tenants: TenantSummary[] = [...(q.data ?? [])].sort((a, b) =>
    (a.name || a.tenant).localeCompare(b.name || b.tenant),
  );

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
                return (
                  <button
                    key={t.tenant}
                    type="button"
                    role="menuitem"
                    className={`client-switch-item${current ? ' current' : ''}`}
                    aria-current={current ? 'true' : undefined}
                    disabled={current}
                    onClick={() => openTenantConsole(t.tenant)}
                  >
                    <span className="client-switch-name">{t.name || t.tenant}</span>
                    <span className="client-switch-slug">{t.tenant}</span>
                    {current && <span className="client-switch-tag">Current</span>}
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
