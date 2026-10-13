import { describe, it, expect, vi } from 'vitest';
import { qk } from './query';
import { refreshSeasonSetup, seasonSetupQueryKeys } from './season-setup-refresh';

describe('refreshSeasonSetup', () => {
  // The stale-setup bug: leagues (with their operator-set setup) and calendars come from
  // the public GET /tenant, which the old refresh never refetched — so an operator's fresh
  // setup still read "not set up" in the Start a season modal.
  it('refetches the public tenant as well as the runs and the authenticated config', async () => {
    const invalidate = vi.fn().mockResolvedValue(undefined);
    await refreshSeasonSetup(invalidate);
    const keys = invalidate.mock.calls.map(([k]) => JSON.stringify(k));
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify(qk.tenant()),
        JSON.stringify(qk.tenantConfig()),
        JSON.stringify(qk.seasonRuns()),
      ]),
    );
    expect(invalidate).toHaveBeenCalledTimes(seasonSetupQueryKeys().length);
  });

  it('rejects when a refetch fails, so the caller can decide to carry on', async () => {
    const invalidate = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(refreshSeasonSetup(invalidate)).rejects.toThrow('offline');
  });
});
