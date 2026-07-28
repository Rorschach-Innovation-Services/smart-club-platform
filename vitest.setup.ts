/**
 * Test setup. Runs for EVERY suite, node and jsdom alike, so everything here has to be
 * safe without a DOM — the jsdom-only pieces are guarded on `document` existing.
 *
 * Why a DOM harness exists at all: ~5,400 lines of this app are React, `tsconfig.app.json`
 * has `strictNullChecks` off, and until now nothing rendered a component in CI. Every
 * defect in the ADR 0008 review rounds that reached the UI layer — clamp-on-keystroke,
 * remount-on-keystroke, a stale cache deciding create-vs-update — was found by a human
 * driving a browser. These are the tests that catch them without one.
 */
import { afterEach, expect } from 'vitest';

if (typeof document !== 'undefined') {
  const [{ cleanup }, matchers] = await Promise.all([
    import('@testing-library/react'),
    import('@testing-library/jest-dom/matchers'),
  ]);
  // The package's default export IS the matcher map; the named re-exports come along
  // for the ride, so pass the default and not the whole namespace object.
  expect.extend(matchers.default ?? matchers);
  afterEach(cleanup);

  /*
   * jsdom implements neither of these and React's error boundary logging is noisy about
   * the first. `matchMedia` is read by the theme code on mount; `scrollIntoView` by the
   * season-run stage list. Both are no-ops for assertion purposes — we never test that a
   * browser scrolled, only what the component rendered.
   */
  if (!window.matchMedia)
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
}
