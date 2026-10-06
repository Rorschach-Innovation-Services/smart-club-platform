/**
 * The confirmation shown when a regenerate or rebase would orphan medicoach-synced fixtures
 * (409 `sync_resync_required`) — instead of the raw refusal toast.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from './api';
import { ResyncDialog, isResyncRequired, resyncFixtures } from './ResyncDialog';
import { renderWithProviders } from './test-utils';

const refusal = new ApiError(409, 'raw server text', 'sync_resync_required', {
  seriesIds: ['s1'],
  orphanedRefs: ['smartclub:dolphins:fixture:s1:f1', 'smartclub:dolphins:fixture:s1:f2'],
  orphaned: [
    {
      ref: 'smartclub:dolphins:fixture:s1:f1',
      seriesId: 's1',
      seriesName: 'Premier T20 · Pool A',
      fixtureId: 'f1',
      home: 'UKZN CC',
      away: 'Crusaders CC',
      date: '2026-10-16',
      time: '09:00',
    },
    {
      ref: 'smartclub:dolphins:fixture:s1:f2',
      seriesId: 's1',
      seriesName: 'Premier T20 · Pool A',
      fixtureId: 'f2',
      home: 'Clares CC',
      away: 'Chatsworth CC',
      date: '2026-10-23',
    },
  ],
});

describe('ResyncDialog', () => {
  it('recognises the refusal and reads its fixtures', () => {
    expect(isResyncRequired(refusal)).toBe(true);
    expect(isResyncRequired(new ApiError(409, 'x', 'venue_clash'))).toBe(false);
    expect(resyncFixtures(refusal).map((f) => f.fixtureId)).toEqual(['f1', 'f2']);
    // An older server without the list still names how many.
    const bare = new ApiError(409, 'x', 'sync_resync_required', { orphanedRefs: ['a', 'b', 'c'] });
    expect(resyncFixtures(bare)).toHaveLength(3);
  });

  it('lists every fixture that loses its medicoach link, explains the top-up, and confirms', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderWithProviders(
      <ResyncDialog
        error={refusal}
        action="regenerate"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: /lose their medicoach link/ });
    const rows = within(dialog).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('UKZN CC v Crusaders CC');
    expect(rows[0]).toHaveTextContent('2026-10-16 09:00');
    expect(dialog).toHaveTextContent(/bundle top-up/);
    expect(dialog).not.toHaveTextContent('raw server text');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Regenerate anyway' }));
    expect(onConfirm).toHaveBeenCalled();
  });
});
