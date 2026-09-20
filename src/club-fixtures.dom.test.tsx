/**
 * ClubFixturesView — progressive release (ADR 0011) on the club portal.
 *
 * The server strips a withheld series' venue/time fields from the wire but deliberately
 * leaves participants' home-ground snapshots intact (reps get those from `GET /clubs`).
 * So the portal must decide "withheld" from the series' `withheld` flag, NOT from a
 * missing venue name — this suite is the guard on that. It renders the real component
 * (no hook mocking) through `renderWithProviders`, mounting it exactly as `main.tsx`
 * does (~L2338): `club`, `allSeries`, `clubs`, `toast`, `onSendFixtures`.
 *
 * A `.dom.` suite because `club.tsx` imports leaflet, which reads `window` at module
 * load — the same reason `club-seasons.dom.test.tsx` carries the suffix.
 */
import { describe, it, expect, vi } from 'vitest';
import { within } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import { ClubFixturesView } from './club';

// Two clubs at meaningfully different coordinates so a real (non-zero) travel distance
// renders when nothing is withheld — the regression guard depends on seeing "N km".
const home = {
  id: 'home-club',
  name: 'Home CC',
  short: 'HOM',
  players: 4,
  ground: { venue: 'Home Oval', suburb: 'Glenwood', lat: -29.85, lon: 31.02 },
};
const away = {
  id: 'away-club',
  name: 'Away CC',
  short: 'AWY',
  ground: { venue: 'Away Park', suburb: 'Scottsville', lat: -29.6, lon: 30.38 },
};

// A single released legacy series (no participants ⇒ teamIds are club ids) whose one
// fixture is allocated to a named, pinned ground with a start time — the fields a
// withheld release must hide.
function series(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    name: 'Premier League',
    startDate: '2026-09-01',
    teams: ['home-club', 'away-club'],
    maxOvers: 50,
    seriesType: 'League',
    released: true,
    releasedAt: '2026-08-20T09:00:00.000Z',
    version: 1,
    fixtures: [
      {
        id: 'f1',
        home: 'home-club',
        away: 'away-club',
        round: 1,
        date: '2026-09-15',
        time: '09:00',
        venueName: 'Kingsmead Stadium',
        venueLat: -29.83,
        venueLon: 31.04,
      },
    ],
    ...over,
  };
}

function renderView(s: Record<string, unknown>) {
  return renderWithProviders(
    <ClubFixturesView
      club={home}
      allSeries={[s]}
      clubs={[home, away]}
      toast={vi.fn()}
      onSendFixtures={vi.fn()}
    />,
  );
}

// A series where Home CC fields two sides (A + B) under `tm_…` ids — the case the old
// table couldn't tell apart. Each side is named in full in the Fixture matchup, and the
// series meta strips the club-name prefix to "A"/"B" in its "your sides" summary.
function twoSideSeries(over: Record<string, unknown> = {}) {
  return {
    id: 's2',
    name: 'Veterans Promotion · 2026/27',
    startDate: '2026-09-01',
    teams: ['tm_home-club_vets_1', 'tm_home-club_vets_2', 'away-club'],
    maxOvers: 30,
    seriesType: 'League',
    released: true,
    releasedAt: '2026-08-20T09:00:00.000Z',
    version: 1,
    participants: [
      { teamId: 'tm_home-club_vets_1', clubId: 'home-club', name: 'Home CC A' },
      { teamId: 'tm_home-club_vets_2', clubId: 'home-club', name: 'Home CC B' },
      { teamId: 'away-club', clubId: 'away-club', name: 'Away CC' },
    ],
    fixtures: [
      {
        id: 'f1',
        home: 'tm_home-club_vets_1',
        away: 'away-club',
        round: 1,
        date: '2026-09-15',
        venueName: 'Kingsmead Stadium',
      },
      {
        id: 'f2',
        home: 'away-club',
        away: 'tm_home-club_vets_2',
        round: 2,
        date: '2026-09-22',
        venueName: 'Away Park',
      },
    ],
    ...over,
  };
}

describe('ClubFixturesView — withheld venue and time', () => {
  it('hides venue, distance and time when both are withheld', () => {
    const { queryAllByText, queryByText, getByText } = renderView(
      series({ withheld: { venue: true, time: true } }),
    );

    // Both "to be confirmed" strings show (hero + table), the real ground never leaks.
    expect(queryAllByText(/venue to be confirmed/i).length).toBeGreaterThan(0);
    expect(queryAllByText(/time to be confirmed/i).length).toBeGreaterThan(0);
    expect(queryAllByText(/kingsmead stadium/i)).toHaveLength(0);

    // Distance / Travel-cost columns are gone entirely, not just blanked.
    expect(queryByText('Distance')).toBeNull();
    expect(queryByText('Travel cost')).toBeNull();

    // No travel figure anywhere; the "Travel · away" KPI tile stands down — scope the
    // assertion to that tile (its "—" value and its explanatory meta) rather than counting
    // bare em-dashes anywhere on the page.
    expect(queryAllByText(/\d+\s*km/i)).toHaveLength(0);
    const travelTile = getByText('Travel · away').closest('.club-fix-kpi') as HTMLElement;
    expect(within(travelTile).getByText('—')).toBeTruthy();
    expect(within(travelTile).getByText(/shown once venues are confirmed/i)).toBeTruthy();
  });

  it('shows every field when nothing is withheld (regression guard)', () => {
    const { queryAllByText, getByText } = renderView(series());

    expect(queryAllByText(/kingsmead stadium/i).length).toBeGreaterThan(0);
    expect(getByText('Distance')).toBeTruthy();
    expect(getByText('Travel cost')).toBeTruthy();
    expect(queryAllByText(/\d+\s*km/i).length).toBeGreaterThan(0);
    expect(queryAllByText(/venue to be confirmed/i)).toHaveLength(0);
    expect(queryAllByText(/time to be confirmed/i)).toHaveLength(0);
  });

  it('records both venues and times in the eyebrow once each is revealed', () => {
    // The eyebrow must reflect BOTH reveal stamps, not just the venue one — a series can
    // have its venues confirmed on one date and its times on another.
    const { getByText } = renderView(
      series({
        revealedAt: { venue: '2026-09-03T09:00:00.000Z', time: '2026-09-05T09:00:00.000Z' },
      }),
    );

    const eyebrow = getByText(/venues confirmed/i);
    expect(eyebrow.textContent).toMatch(/venues confirmed 3 Sep 2026/i);
    expect(eyebrow.textContent).toMatch(/times confirmed 5 Sep 2026/i);
  });

  it('keeps venue and distance but replaces the time when only the time is withheld', () => {
    const { queryAllByText, getByText } = renderView(series({ withheld: { time: true } }));

    // Venue and travel survive a time-only withhold.
    expect(queryAllByText(/kingsmead stadium/i).length).toBeGreaterThan(0);
    expect(getByText('Distance')).toBeTruthy();
    expect(queryAllByText(/\d+\s*km/i).length).toBeGreaterThan(0);

    // Only the time is masked.
    expect(queryAllByText(/time to be confirmed/i).length).toBeGreaterThan(0);
    expect(queryAllByText(/venue to be confirmed/i)).toHaveLength(0);
  });
});

// The index of a substring within an element's text, asserting it is present. Lets the
// matchup tests prove home-first ordering ("<home> vs <away>") from one row's textContent.
function orderOf(el: HTMLElement, needle: string) {
  const i = (el.textContent || '').indexOf(needle);
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
}

describe('ClubFixturesView — the fixture matchup', () => {
  it('reads home-first with the own side bold; no Side column', () => {
    // An AWAY fixture (Away CC is the home team) with a future date so the Next Match hero
    // renders — it demonstrates the opponent coming first, then our own side.
    const { getByText, queryByText, getAllByRole } = renderView(
      series({
        fixtures: [
          {
            id: 'f1',
            home: 'away-club',
            away: 'home-club',
            round: 1,
            date: '2026-12-15',
            time: '09:00',
            venueName: 'Kingsmead Stadium',
            venueLat: -29.83,
            venueLon: 31.04,
          },
        ],
      }),
    );
    // The Side and Opponent columns are gone; a single Fixture column replaces them.
    expect(queryByText('Side')).toBeNull();
    expect(queryByText('Opponent')).toBeNull();
    expect(getByText('Fixture')).toBeTruthy();
    // The series meta still states which side we field.
    expect(getByText(/playing as Home CC/i)).toBeTruthy();
    // Home-first ordering: on an away fixture the opponent (the home team) is listed first,
    // our own side after. Full names, no abbreviation.
    const row = getAllByRole('row').find((r) => within(r).queryByText('R1')) as HTMLElement;
    expect(orderOf(row, 'Away CC')).toBeLessThan(orderOf(row, 'Home CC'));
    // The opponent no longer carries an identity chip — no avatar in any fixture cell.
    expect(row.querySelector('.club-avatar')).toBeNull();
    // The Next Match hero names our own side in full (a headline, not a column).
    const hero = document.querySelector('.club-fix-next-title') as HTMLElement;
    expect(hero.textContent).toMatch(/Home CC/);
  });

  it('names each side in full per row for a multi-side series', () => {
    // f2 (round 2) is in the future, so the Next Match hero also names its sides — scope the
    // per-side assertions to the table rows rather than the whole page.
    const { getByText, getAllByRole } = renderView(twoSideSeries());
    expect(getByText('Fixture')).toBeTruthy();
    // The meta summarises both sides (stripped to A, B).
    expect(getByText(/your sides: A, B/i)).toBeTruthy();
    // Round 1: A is the home side, named in full and listed first; the opponent after.
    const r1 = getAllByRole('row').find((r) => within(r).queryByText('R1')) as HTMLElement;
    expect(within(r1).getByText('Home CC A')).toBeTruthy();
    expect(orderOf(r1, 'Home CC A')).toBeLessThan(orderOf(r1, 'Away CC'));
    // Round 2: the opponent is at home, so it comes first; B (in full) after.
    const r2 = getAllByRole('row').find((r) => within(r).queryByText('R2')) as HTMLElement;
    expect(within(r2).getByText('Home CC B')).toBeTruthy();
    expect(orderOf(r2, 'Away CC')).toBeLessThan(orderOf(r2, 'Home CC B'));
  });

  it('renders an intra-club derby once, both sides bold, home first', () => {
    const { getAllByRole, getByText } = renderView(
      twoSideSeries({
        teams: ['tm_home-club_vets_1', 'tm_home-club_vets_2'],
        fixtures: [
          {
            id: 'derby',
            home: 'tm_home-club_vets_1',
            away: 'tm_home-club_vets_2',
            round: 1,
            date: '2026-09-15',
            venueName: 'Kingsmead Stadium',
          },
        ],
      }),
    );
    // Exactly one body row for the derby (home + away both ours ⇒ not listed twice).
    const bodyRows = getAllByRole('row').filter((r) => within(r).queryByText('R1'));
    expect(bodyRows).toHaveLength(1);
    const row = bodyRows[0];
    // Both sides named in full, home (A) before away (B).
    expect(getByText('Home CC A')).toBeTruthy();
    expect(getByText('Home CC B')).toBeTruthy();
    expect(orderOf(row, 'Home CC A')).toBeLessThan(orderOf(row, 'Home CC B'));
    // Cell-wide invariant: no identity chip in any fixture cell — every side is plain text.
    expect(document.querySelectorAll('.club-avatar')).toHaveLength(0);
  });
});
