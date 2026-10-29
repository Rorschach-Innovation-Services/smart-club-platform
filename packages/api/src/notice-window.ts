/**
 * Test-only override state for the automatic-send notice windows (captain's reports 18:00,
 * squad links 08:00 SAST). Production never sets it; the local stack's `/__e2e/` hook and the
 * integration tests do. Each window has its own slot so a test can force one open while the
 * other stays closed (proving squads and reports gate independently).
 */
export type NoticeWindow = 'reports' | 'squads';
export type NoticeWindowScope = 'all' | NoticeWindow;
type WindowFn = ((now: Date) => boolean) | undefined;

const overrides: Record<NoticeWindow, WindowFn> = { reports: undefined, squads: undefined };

/**
 * Force a notice window open/closed regardless of the clock (`undefined` restores the real
 * rule). `scope` defaults to `'all'`, which sets every window at once.
 */
export function setNoticeWindowOverride(fn: WindowFn, scope: NoticeWindowScope = 'all'): void {
  if (scope === 'all' || scope === 'reports') overrides.reports = fn;
  if (scope === 'all' || scope === 'squads') overrides.squads = fn;
}

/** The forced override for one window, if any. */
export function noticeWindowOverride(window: NoticeWindow): WindowFn {
  return overrides[window];
}
