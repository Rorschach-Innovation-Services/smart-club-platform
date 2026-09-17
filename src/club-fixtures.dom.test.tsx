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
// table couldn't tell apart. Participant names carry the club-name prefix, which the
// portal strips to "A"/"B" in the Side column.
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

describe("ClubFixturesView — the club's own side", () => {
  it('single-side series shows no Side column and "playing as" the club', () => {
    const { queryByText, getByText } = renderView(series());
    // Legacy single-team series ⇒ one own side ⇒ no extra column, no ambiguity.
    expect(queryByText('Side')).toBeNull();
    expect(getByText(/playing as Home CC/i)).toBeTruthy();
  });

  it('multi-side series adds a Side column with the right name per row', () => {
    const { getByText, getByTitle } = renderView(twoSideSeries());
    // The column exists and the meta summarises both sides (stripped to A, B).
    expect(getByText('Side')).toBeTruthy();
    expect(getByText(/your sides: A, B/i)).toBeTruthy();
    // Each row names the side actually playing — A at home, B away — full name on hover.
    const aCell = getByTitle('Home CC A');
    const bCell = getByTitle('Home CC B');
    expect(within(aCell).getByText('A')).toBeTruthy();
    expect(within(bCell).getByText('B')).toBeTruthy();
  });

  it('derby row appears once, naming both own sides as Side and Opponent', () => {
    const { getAllByRole, getByTitle, getByText } = renderView(
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
    // Side = the home side (A), Opponent = the away side (B).
    expect(within(getByTitle('Home CC A')).getByText('A')).toBeTruthy();
    expect(getByText('Home CC B')).toBeTruthy();
  });
});
