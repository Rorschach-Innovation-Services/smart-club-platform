/**
 * Terminology + season-label sweep (plan 1F/1I): school-facing surfaces read the tenant's
 * vertical nouns (club → school, union → league, chairperson → principal) and its display
 * `seasonLabel` instead of hardcoded cricket copy / "2026/27". A cricket (legacy, no
 * `sport`) tenant must render today's exact strings.
 *
 * The tenant payload is seeded into the real react-query cache (qk.tenant()), so the
 * components' own useVertical/useSeasonLabel hooks resolve it — no hook mocking. A `.dom.`
 * suite because `club.tsx` imports leaflet at module load.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import { qk } from './query';
import { currentSeasonLabel } from './data';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return { ...actual, getTenant: vi.fn(async () => ({})) };
});

import { ClubFixturesView } from './club';
import { ChairContactModal } from './admin';

const club = { id: 'alpha', name: 'Alpha', chair: 'Sam Dube', exco: {} };

/** Match an element by its full textContent (copy is split across text nodes / <em>). */
const byText = (text: string) => (_: string, el: Element | null) =>
  !!el && el.textContent === text && Array.from(el.children).every((c) => c.textContent !== text);

function renderFixtures(tenant: Record<string, unknown>) {
  return renderWithProviders(
    <ClubFixturesView
      club={club}
      allSeries={[]}
      clubs={[club]}
      toast={vi.fn()}
      onSendFixtures={vi.fn()}
    />,
    { seed: [[qk.tenant(), tenant]] },
  );
}

function renderChairModal(tenant: Record<string, unknown>) {
  return renderWithProviders(
    <ChairContactModal club={club} onClose={vi.fn()} onSave={vi.fn()} toast={vi.fn()} />,
    { seed: [[qk.tenant(), tenant]] },
  );
}

describe('club fixtures empty state', () => {
  it('cricket keeps the club/union wording and the built-in season label', () => {
    renderFixtures({});
    expect(screen.getByText(byText('Club Portal · Alpha / Fixtures'))).toBeTruthy();
    expect(
      screen.getByText(
        (_, el) =>
          !!el?.classList.contains('club-fix-empty-sub') &&
          (el.textContent ?? '').startsWith(
            `Once the union office signs off on the ${currentSeasonLabel()} fixture list`,
          ),
      ),
    ).toBeTruthy();
  });

  it('a football (school) tenant says School / league and its own season label', () => {
    renderFixtures({ sport: 'football', seasonLabel: '2027' });
    expect(screen.getByText(byText('School Portal · Alpha / Fixtures'))).toBeTruthy();
    expect(
      screen.getByText(
        (_, el) =>
          !!el?.classList.contains('club-fix-empty-sub') &&
          (el.textContent ?? '').startsWith(
            'Once the league office signs off on the 2027 fixture list',
          ),
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/union office/i)).toBeNull();
  });
});

describe('ChairContactModal', () => {
  it('cricket keeps "chairperson"', () => {
    renderChairModal({});
    expect(screen.getByText(byText('Edit chairperson · Alpha'))).toBeTruthy();
    expect(screen.getByPlaceholderText('Chairperson name')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save chairperson' })).toBeTruthy();
  });

  it('a football (school) tenant says "principal"', () => {
    renderChairModal({ sport: 'football' });
    expect(screen.getByText(byText('Edit principal · Alpha'))).toBeTruthy();
    expect(screen.getByPlaceholderText('Principal name')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save principal' })).toBeTruthy();
    expect(screen.getByText(byText('School details'))).toBeTruthy();
  });
});
