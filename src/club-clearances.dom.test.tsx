/**
 * ClubClearancesView — the club-portal copy for a rejected clearance (reject now cancels
 * the move) and for a reopened one.
 *
 * The source club (this club is where the player is leaving from) sees the reject outcome
 * on its incoming card; the destination club (this club is where the player was moving to)
 * sees the move-cancelled line on its outbound card; and a reopened pending request carries
 * a "Reopened by Union office" eyebrow on both. This suite guards that copy. It renders the
 * real component (no hook mocking) through `renderWithProviders`, mounting it exactly as
 * `main.tsx` does (~L2469): `club`, `clearances`, `leagues`, `onClearFees`,
 * `onClearMisconduct`, `onApprove`, `onOpenRequest`, `busyId`.
 *
 * A `.dom.` suite because `club.tsx` imports leaflet, which reads `window` at module load —
 * the same reason `club-fixtures.dom.test.tsx` carries the suffix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import { ClubClearancesView } from './club';

const club = { id: 'src-club', name: 'Riverside CC' };

// A rejected/pending clearance row shaped like the ones `GET /clubs/:id/clearances` returns.
// `origin: 'request'` keeps the "via registration" chrome out of the way; each scenario
// overrides the fields it cares about.
function clr(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    status: 'rejected',
    origin: 'request',
    playerName: 'Sipho Ndlovu',
    team: 'Premier',
    idNumber: '0001015800088',
    requestedAt: '2026-08-01T09:00:00.000Z',
    rejectedAt: '2026-08-10T09:00:00.000Z',
    fromClubName: 'Riverside CC',
    toClubName: 'Hillcrest CC',
    ...over,
  };
}

function renderView(clearances: { incoming?: unknown[]; outbound?: unknown[] }) {
  return renderWithProviders(
    <ClubClearancesView
      club={club}
      clearances={clearances}
      leagues={[]}
      onClearFees={vi.fn()}
      onClearMisconduct={vi.fn()}
      onApprove={vi.fn()}
      onOpenRequest={vi.fn()}
      busyId={undefined}
    />,
  );
}

describe('ClubClearancesView — rejected source card (incoming)', () => {
  it('source-reactivated: the player remains registered at the source club, with the reason as a note', () => {
    const { getByText, queryByText } = renderView({
      incoming: [clr({ rejectOutcome: 'source-reactivated', rejectReason: 'Fees outstanding' })],
    });

    expect(getByText('Remains registered at Riverside CC')).toBeTruthy();
    expect(getByText('"Fees outstanding"')).toBeTruthy();
    expect(getByText('Rejected')).toBeTruthy();
    expect(queryByText(/Their registration is now at/)).toBeNull();
  });

  it('moved-to-source: the registration now sits at the source club', () => {
    const { getByText } = renderView({
      incoming: [
        clr({ rejectOutcome: 'moved-to-source', rejectReason: 'Registered at wrong club' }),
      ],
    });

    expect(getByText('Their registration is now at Riverside CC')).toBeTruthy();
    expect(getByText('"Registered at wrong club"')).toBeTruthy();
  });

  it('stays-at-destination shows the stayed-at-destination line and shows no note when no reason was given', () => {
    const { getByText, queryByText } = renderView({
      incoming: [clr({ rejectOutcome: 'stays-at-destination' })],
    });

    expect(
      getByText(
        'Stays registered at Hillcrest CC — Riverside CC was not on the system when this was rejected',
      ),
    ).toBeTruthy();
    expect(queryByText('Remains registered at Riverside CC')).toBeNull();
    expect(queryByText(/Their registration is now at/)).toBeNull();
    // No rejectReason ⇒ no clr-note quote on the card.
    expect(queryByText(/^"/)).toBeNull();
  });
});

describe('ClubClearancesView — rejected destination card (outbound)', () => {
  it('shows the move-cancelled line pointing at the previous club, with the reason as a note', () => {
    const { getByText } = renderView({
      outbound: [
        clr({
          id: 'd1',
          status: 'rejected',
          rejectOutcome: 'source-reactivated',
          rejectReason: 'Not eligible',
          fromClubName: 'Hillcrest CC',
          toClubName: 'Riverside CC',
        }),
      ],
    });

    expect(
      getByText(/The move was cancelled.*the player is registered at Hillcrest CC/),
    ).toBeTruthy();
    expect(getByText('"Not eligible"')).toBeTruthy();
  });

  it('stays-at-destination: the player stays registered with your club', () => {
    const { getByText } = renderView({
      outbound: [
        clr({
          id: 'd2',
          status: 'rejected',
          rejectOutcome: 'stays-at-destination',
          fromClubName: 'Hillcrest CC',
          toClubName: 'Riverside CC',
        }),
      ],
    });

    expect(
      getByText(/Hillcrest CC is not on the system, so the player stays registered with your club/),
    ).toBeTruthy();
  });
});

describe('ClubClearancesView — reopened pending card', () => {
  it('shows the "Reopened by Union office" eyebrow on a reopened pending request', () => {
    const { getByText, queryByText } = renderView({
      incoming: [
        clr({
          status: 'pending',
          rejectOutcome: undefined,
          rejectReason: undefined,
          reopenedAt: '2026-08-25T09:00:00.000Z',
        }),
      ],
    });

    expect(getByText('Reopened by Union office · 25 Aug 2026')).toBeTruthy();
    expect(queryByText('Pending · Union may override')).toBeNull();
  });
});

describe('ClubClearancesView — a ?clearance=<id> notification deep link', () => {
  const NO_MATCH = /no clearance matches this link/i;
  const linkTo = (id: string) =>
    window.history.replaceState({}, '', `/club/src-club/clearances?clearance=${id}`);
  const queue = {
    incoming: [
      clr({ id: 'c1', status: 'pending', rejectOutcome: undefined }),
      clr({ id: 'c2', status: 'pending', rejectOutcome: undefined, playerName: 'Thabo Mokoena' }),
    ],
    outbound: [
      clr({
        id: 'd1',
        status: 'pending',
        playerName: 'Ayanda Zulu',
        fromClubName: 'Hillcrest CC',
        toClubName: 'Riverside CC',
      }),
    ],
  };
  const cardOf = (getByText: (t: string) => HTMLElement, name: string) =>
    getByText(name).closest('.clr-card') as HTMLElement;
  let scrolled: HTMLElement[];

  beforeEach(() => {
    scrolled = [];
    // jsdom has no layout, so no scrollIntoView — record which card the view scrolls to.
    Element.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState({}, '', '/');
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it('scrolls to and briefly highlights the linked card, keeping the whole queue visible', () => {
    vi.useFakeTimers();
    linkTo('c2');
    const { getByText, queryByText } = renderView(queue);

    const target = cardOf(getByText, 'Thabo Mokoena');
    expect(scrolled).toEqual([target]);
    expect(target.classList.contains('linked')).toBe(true);
    // The rest of the chair's queue stays on screen, un-highlighted.
    expect(cardOf(getByText, 'Sipho Ndlovu').classList.contains('linked')).toBe(false);
    expect(getByText('Ayanda Zulu')).toBeTruthy();
    expect(queryByText(NO_MATCH)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(target.classList.contains('linked')).toBe(false);
  });

  it('finds an outbound card too (this club is the destination)', () => {
    linkTo('d1');
    const { getByText } = renderView(queue);

    const target = cardOf(getByText, 'Ayanda Zulu');
    expect(scrolled).toEqual([target]);
    expect(target.classList.contains('linked')).toBe(true);
  });

  it('says so when the linked clearance is gone, and the notice can be dismissed', () => {
    linkTo('c-gone');
    const { getByText, getByRole, queryByText } = renderView(queue);

    expect(getByText(NO_MATCH)).toBeTruthy();
    expect(scrolled).toEqual([]);
    expect(getByText('Sipho Ndlovu')).toBeTruthy();

    fireEvent.click(getByRole('button', { name: /dismiss/i }));
    expect(queryByText(NO_MATCH)).toBeNull();
  });

  it('waits for the list to load before deciding the link is dead', () => {
    linkTo('c2');
    const props = {
      club,
      leagues: [],
      onClearFees: vi.fn(),
      onClearMisconduct: vi.fn(),
      onApprove: vi.fn(),
      onOpenRequest: vi.fn(),
      busyId: undefined,
    };
    const { queryByText, getByText, rerender } = renderWithProviders(
      <ClubClearancesView {...props} clearances={{}} clearancesLoaded={false} />,
    );
    expect(queryByText(NO_MATCH)).toBeNull();
    expect(scrolled).toEqual([]);

    rerender(<ClubClearancesView {...props} clearances={queue} clearancesLoaded />);
    expect(queryByText(NO_MATCH)).toBeNull();
    expect(scrolled).toEqual([cardOf(getByText, 'Thabo Mokoena')]);
  });

  it('does nothing special without a link', () => {
    const { container, queryByText } = renderView(queue);
    expect(container.querySelector('.clr-card.linked')).toBeNull();
    expect(scrolled).toEqual([]);
    expect(queryByText(NO_MATCH)).toBeNull();
  });
});
