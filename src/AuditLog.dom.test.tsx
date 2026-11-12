/**
 * Audit trail screens: the admin Activity page, the per-record History modal, and the operator
 * portal's per-client feed. Rendered for real through the app's providers; only the HTTP client
 * is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    getAuditFeed: vi.fn(),
    getAuditEntity: vi.fn(),
    getAuditEntry: vi.fn(),
    platformGetAuditFeed: vi.fn(),
    platformGetAuditEntry: vi.fn(),
    platformGetPlatformAuditFeed: vi.fn(),
    platformGetPlatformAuditEntry: vi.fn(),
  };
});

import * as api from './api';
import { ApiError } from './api';
import { AuditActivityView, HistoryButton } from './AuditLog';
import { renderWithProviders } from './test-utils';
import type { AuditEntry, TenantUser } from './types';

const AT = '2026-11-12T08:00:00.000Z';

const edit: AuditEntry = {
  id: 'e1',
  at: AT,
  tenant: 'dolphins',
  actor: { kind: 'user', key: 'sub-ann', sub: 'sub-ann', email: 'ann@kzncu.org', via: 'console' },
  action: 'umpire.update',
  status: 200,
  outcome: 'ok',
  visibility: 'tenant',
  targets: [{ type: 'umpire', id: 'u1', label: 'Jooma', op: 'update', changeCount: 2 }],
  expiresAt: 0,
};
const operatorSave: AuditEntry = {
  ...edit,
  id: 'e2',
  at: '2026-11-11T08:00:00.000Z',
  actor: {
    kind: 'user',
    key: 'sub-op',
    email: 'op@medicoach.co.za',
    operator: true,
    via: 'console',
  },
  action: 'tenant-config.update',
  targets: [{ type: 'tenant-config', id: 'dolphins', op: 'update', changeCount: 0 }],
};
const captainSave: AuditEntry = {
  ...edit,
  id: 'e3',
  at: '2026-11-10T08:00:00.000Z',
  actor: {
    kind: 'link',
    key: 'link:captains-report:m9',
    via: 'captains-report',
    recipientKind: 'captain',
    recipientId: 'm9',
  },
  action: 'captains-report.save',
  outcome: 'failed',
  status: 500,
  targets: [{ type: 'captains-report', id: 'cr1', op: 'save', changeCount: 0 }],
};

const USERS: TenantUser[] = [
  { sub: 'sub-ann', email: 'ann@kzncu.org', role: 'admin', clubIds: [], status: 'active' },
  { sub: 'sub-bob', email: 'bob@kzncu.org', role: 'admin', clubIds: [], status: 'active' },
];

beforeEach(() => {
  vi.mocked(api.getAuditFeed).mockReset();
  vi.mocked(api.getAuditEntity).mockReset();
  vi.mocked(api.getAuditEntry).mockReset();
  vi.mocked(api.platformGetAuditFeed).mockReset();
  vi.mocked(api.platformGetAuditEntry).mockReset();
  vi.mocked(api.platformGetPlatformAuditFeed).mockReset();
  vi.mocked(api.platformGetPlatformAuditEntry).mockReset();
});

function renderActivity() {
  renderWithProviders(<AuditActivityView users={USERS} />);
  return userEvent.setup();
}

const rows = () => screen.getAllByTestId('audit-row');

describe('AuditActivityView', () => {
  it('lists who did what to which record, newest first', async () => {
    vi.mocked(api.getAuditFeed).mockResolvedValue({ items: [edit, operatorSave, captainSave] });
    renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const [first, second, third] = rows();
    expect(within(first).getByText('ann@kzncu.org')).toBeTruthy();
    expect(within(first).getByText('Edited umpire')).toBeTruthy();
    expect(within(first).getByText('Jooma')).toBeTruthy();
    // An operator acting inside the union's console is flagged.
    expect(within(second).getByText('op@medicoach.co.za')).toBeTruthy();
    expect(within(second).getByText('Platform operator')).toBeTruthy();
    expect(within(second).getByText('Changed settings')).toBeTruthy();
    // A link actor, and a failed change.
    expect(within(third).getByText("Captain via captain's report link")).toBeTruthy();
    expect(within(third).getByText('Failed')).toBeTruthy();
    expect(api.getAuditFeed).toHaveBeenCalledWith({});
    expect(screen.getByText(/Automated jobs, the Match Centre sync and scripts/)).toBeTruthy();
  });

  it('filters by record type, person and dates', async () => {
    vi.mocked(api.getAuditFeed).mockResolvedValue({ items: [edit] });
    const user = renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(1));

    await user.selectOptions(screen.getByLabelText('Record'), 'umpire');
    await waitFor(() => expect(api.getAuditFeed).toHaveBeenLastCalledWith({ type: 'umpire' }));

    // Picking a team member filters by their user id, not their email.
    await user.type(screen.getByLabelText('Changed by'), 'bob@kzncu.org');
    await waitFor(() =>
      expect(api.getAuditFeed).toHaveBeenLastCalledWith({ type: 'umpire', actor: 'sub-bob' }),
    );

    // Dates are the viewer's local days ("when" renders local), sent as instants.
    await user.type(screen.getByLabelText('From'), '2026-11-01');
    await user.type(screen.getByLabelText('To'), '2026-11-03');
    await user.tab();
    await waitFor(() =>
      expect(api.getAuditFeed).toHaveBeenLastCalledWith({
        type: 'umpire',
        actor: 'sub-bob',
        from: new Date(2026, 10, 1).toISOString(),
        to: new Date(2026, 10, 3, 23, 59, 59, 999).toISOString(),
      }),
    );

    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    await waitFor(() => expect(api.getAuditFeed).toHaveBeenLastCalledWith({}));
  });

  it('filters by someone seen in the feed who is not on the team, by their key', async () => {
    vi.mocked(api.getAuditFeed).mockImplementation(async (q = {}) =>
      q.actor ? { items: [] } : { items: [edit, operatorSave] },
    );
    const user = renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await user.type(screen.getByLabelText('Changed by'), 'op@medicoach.co.za{Enter}');
    await waitFor(() => expect(api.getAuditFeed).toHaveBeenLastCalledWith({ actor: 'sub-op' }));
    // The empty filtered page must not turn the picked person back into raw text.
    expect(api.getAuditFeed).not.toHaveBeenCalledWith({ actor: 'op@medicoach.co.za' });
  });

  it('sends a typed email nobody in the list matches as-is, for the API to resolve', async () => {
    const gone = {
      ...edit,
      id: 'g1',
      actor: { ...edit.actor, key: 'sub-gone', sub: 'sub-gone', email: 'gone@kzncu.org' },
    };
    vi.mocked(api.getAuditFeed).mockImplementation(async (q = {}) => ({
      items: q.actor ? [gone] : [edit],
    }));
    const user = renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.type(screen.getByLabelText('Changed by'), ' Gone@KZNCU.org {Enter}');
    await waitFor(() =>
      expect(api.getAuditFeed).toHaveBeenLastCalledWith({ actor: 'Gone@KZNCU.org' }),
    );
    expect(await screen.findByText('gone@kzncu.org')).toBeTruthy();
    // Leaving the box (e.g. to open a row) keeps the filter as applied: the person the results
    // revealed must not swap the email for their key and reload the feed.
    const calls = vi.mocked(api.getAuditFeed).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /Show changes/ }));
    expect(api.getAuditFeed).toHaveBeenCalledTimes(calls);
    expect(api.getAuditFeed).not.toHaveBeenCalledWith({ actor: 'sub-gone' });
    expect(screen.getByRole('button', { name: /Hide changes/ })).toBeTruthy();
  });

  it('expands a row to its before and after values, loaded on demand', async () => {
    vi.mocked(api.getAuditFeed).mockResolvedValue({ items: [edit] });
    vi.mocked(api.getAuditEntry).mockResolvedValue({
      entry: edit,
      detail: {
        targets: [
          {
            type: 'umpire',
            id: 'u1',
            changes: [
              { field: 'displayName', from: 'Dende', to: 'Jooma' },
              { field: 'phone', masked: true },
            ],
          },
        ],
        mentions: [],
      },
    });
    const user = renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(api.getAuditEntry).not.toHaveBeenCalled();

    const toggle = screen.getByRole('button', { name: /Show changes: Edited umpire/ });
    await user.click(toggle);
    expect(api.getAuditEntry).toHaveBeenCalledWith(AT, 'e1');
    const changes = await screen.findByRole('table', { name: /Changes to Umpire Jooma/ });
    const nameRow = within(changes).getByText('Name').closest('tr') as HTMLElement;
    expect(within(nameRow).getByText('Dende')).toBeTruthy();
    expect(within(nameRow).getByText('Jooma')).toBeTruthy();
    expect(within(changes).getByText('Changed (hidden)')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Hide changes/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('loads older entries with the cursor', async () => {
    vi.mocked(api.getAuditFeed)
      .mockResolvedValueOnce({ items: [edit], cursor: 'c-1' })
      .mockResolvedValueOnce({ items: [captainSave] });
    const user = renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(api.getAuditFeed).toHaveBeenLastCalledWith({ cursor: 'c-1' });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('keeps offering older entries when a page comes back empty', async () => {
    vi.mocked(api.getAuditFeed).mockResolvedValue({ items: [], cursor: 'c-2' });
    renderActivity();
    expect(await screen.findByText('Nothing matches in the most recent changes.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });

  it('says so when there is nothing yet', async () => {
    vi.mocked(api.getAuditFeed).mockResolvedValue({ items: [] });
    renderActivity();
    expect(await screen.findByText('No activity yet')).toBeTruthy();
  });

  it('shows an error with a retry', async () => {
    vi.mocked(api.getAuditFeed)
      .mockRejectedValueOnce(new ApiError(500, 'boom'))
      .mockResolvedValueOnce({ items: [edit] });
    const user = renderActivity();
    expect(await screen.findByText('Could not load activity.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('reads one client from the operator portal', async () => {
    vi.mocked(api.platformGetAuditFeed).mockResolvedValue({
      items: [
        {
          ...operatorSave,
          visibility: 'operator',
          actor: { ...operatorSave.actor, via: 'platform' },
        },
      ],
    });
    renderWithProviders(<AuditActivityView source={{ kind: 'tenant', slug: 'titans' }} />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(api.platformGetAuditFeed).toHaveBeenCalledWith('titans', {});
    expect(api.getAuditFeed).not.toHaveBeenCalled();
    expect(screen.getByText('Operators only')).toBeTruthy();
    expect(screen.getByText('Operator portal')).toBeTruthy();
  });

  it('reads a platform-level entry through the platform entry route', async () => {
    // What still lands in the platform partition: an action tied to no client, e.g. a client
    // creation that failed before the client existed (a successful one lands in the new
    // client's own feed).
    const opAdded: AuditEntry = {
      ...operatorSave,
      id: 'p1',
      tenant: '*',
      action: 'tenant.create',
      outcome: 'failed',
      status: 500,
      targets: [],
    };
    vi.mocked(api.platformGetPlatformAuditFeed).mockResolvedValue({ items: [opAdded] });
    vi.mocked(api.platformGetPlatformAuditEntry).mockResolvedValue({
      entry: opAdded,
      detail: null,
    });
    renderWithProviders(<AuditActivityView source={{ kind: 'platform' }} />);
    const user = userEvent.setup();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /Show changes/ }));
    await waitFor(() =>
      expect(api.platformGetPlatformAuditEntry).toHaveBeenCalledWith(opAdded.at, 'p1'),
    );
    expect(api.platformGetAuditEntry).not.toHaveBeenCalled();
    expect(await screen.findByText(/No field details were recorded/)).toBeTruthy();
  });

  it('offers only people with an email in the person list, one per account', async () => {
    const captain2 = {
      ...captainSave,
      id: 'e4',
      actor: { ...captainSave.actor, key: 'link:captains-report:m10', recipientId: 'm10' },
    };
    const unnamed = {
      ...edit,
      id: 'e5',
      actor: { kind: 'user' as const, key: 'sub-noemail', sub: 'sub-noemail', via: 'console' },
    };
    // The same email on a second account (e.g. re-invited): a distinct actor key.
    const reinvited = {
      ...edit,
      id: 'e6',
      actor: { ...edit.actor, key: 'sub-ann-2', sub: 'sub-ann-2' },
    };
    vi.mocked(api.getAuditFeed).mockImplementation(async (q = {}) =>
      q.actor ? { items: [] } : { items: [edit, captainSave, captain2, unnamed, reinvited] },
    );
    const user = renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(5));
    const options = [...document.querySelectorAll('datalist option')].map((o) =>
      o.getAttribute('value'),
    );
    expect(options).toEqual(['ann@kzncu.org', 'bob@kzncu.org']);
    // Two accounts behind one email: the email itself goes to the API, not one of the keys.
    await user.type(screen.getByLabelText('Changed by'), 'ann@kzncu.org{Enter}');
    await waitFor(() =>
      expect(api.getAuditFeed).toHaveBeenLastCalledWith({ actor: 'ann@kzncu.org' }),
    );
  });

  it('reads "Removed" for an erased record, never its id', async () => {
    const erased: AuditEntry = {
      ...edit,
      id: 'x1',
      action: 'umpire.delete',
      targets: [{ type: 'umpire', id: 'u-q-xylo', op: 'erase', changeCount: 0, scrubbed: true }],
    };
    vi.mocked(api.getAuditFeed).mockResolvedValue({ items: [erased] });
    renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]).getByText('Removed')).toBeTruthy();
    expect(screen.queryByText(/u-q-xylo/)).toBeNull();
  });

  it('shows a change that never finished, a truncated change and who else was involved', async () => {
    const stale: AuditEntry = {
      ...edit,
      id: 's1',
      at: '2026-11-01T08:00:00.000Z',
      action: 'umpire.merge',
      outcome: 'started',
      status: 0,
      truncated: { changes: 3 },
      targets: [
        { type: 'umpire', id: 'u1', label: 'Jooma', op: 'merge', changeCount: 1 },
        { type: 'umpire', id: '', op: 'merge', changeCount: 1 },
        { type: 'umpire', id: '', op: 'merge', changeCount: 1 },
      ],
    };
    vi.mocked(api.getAuditFeed).mockResolvedValue({ items: [stale] });
    vi.mocked(api.getAuditEntry).mockResolvedValue({
      entry: stale,
      detail: {
        targets: [
          { type: 'umpire', id: '', changes: [{ field: 'active', scrubbed: true }] },
          { type: 'umpire', id: '', changes: [{ field: 'phone', scrubbed: true }] },
        ],
        mentions: [{ type: 'umpire', id: 'u2', label: 'R.Dupe' }],
      },
    });
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      const user = renderActivity();
      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(within(rows()[0]).getByText('Did not finish')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: /Show changes/ }));
      expect(await screen.findByText(/This change was started but did not finish/)).toBeTruthy();
      expect(
        screen.getByText(/Some details were left out because the change was large/),
      ).toBeTruthy();
      expect(screen.getByText(/Also involved: Umpire · R\.Dupe/)).toBeTruthy();
      expect(screen.getAllByRole('table', { name: /Changes to Umpire/ })).toHaveLength(2);
    } finally {
      console.error = orig;
    }
    // Two blank-id targets of one type must not share a React key.
    expect(errors.map(String).join('\n')).not.toMatch(/same key/);
  });

  it('says when a row’s changes could not load, with a retry', async () => {
    vi.mocked(api.getAuditFeed).mockResolvedValue({ items: [edit] });
    vi.mocked(api.getAuditEntry)
      .mockRejectedValueOnce(new ApiError(500, 'boom'))
      .mockResolvedValueOnce({ entry: edit, detail: null });
    const user = renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /Show changes/ }));
    // The query client retries once before it reports the error.
    expect(
      await screen.findByText('Could not load these changes.', {}, { timeout: 4000 }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No field details were recorded/)).toBeTruthy();
  });

  it('keeps the loaded rows and says so when an older page fails', async () => {
    vi.mocked(api.getAuditFeed)
      .mockResolvedValueOnce({ items: [edit], cursor: 'c-1' })
      .mockRejectedValue(new ApiError(500, 'boom'));
    const user = renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(
      await screen.findByText('Could not load more activity.', {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });

  it('applies a date once it is chosen, not on every keystroke', async () => {
    vi.mocked(api.getAuditFeed).mockResolvedValue({ items: [edit] });
    const user = renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const calls = vi.mocked(api.getAuditFeed).mock.calls.length;
    await user.type(screen.getByLabelText('From'), '2026-11-01');
    await user.tab();
    await waitFor(() =>
      expect(api.getAuditFeed).toHaveBeenLastCalledWith({
        from: new Date(2026, 10, 1).toISOString(),
      }),
    );
    expect(vi.mocked(api.getAuditFeed).mock.calls.length).toBe(calls + 1);
  });
});

describe('HistoryButton', () => {
  it("opens the record's history on demand", async () => {
    vi.mocked(api.getAuditEntity).mockResolvedValue({ items: [edit] });
    renderWithProviders(<HistoryButton type="umpire" id="u1" title="Jooma" />);
    const user = userEvent.setup();
    expect(api.getAuditEntity).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'History: Jooma' }));
    const dialog = await screen.findByRole('dialog');
    expect(api.getAuditEntity).toHaveBeenCalledWith('umpire', 'u1', {});
    await waitFor(() => expect(within(dialog).getByText('Edited umpire')).toBeTruthy());
    expect(within(dialog).getByText('ann@kzncu.org')).toBeTruthy();
    // The record is the dialog's subject, so there is no Record column.
    expect(within(dialog).queryByRole('columnheader', { name: 'Record' })).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says when a record has no history yet', async () => {
    vi.mocked(api.getAuditEntity).mockResolvedValue({ items: [] });
    renderWithProviders(<HistoryButton type="club" id="c1" title="Crusaders" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'History: Crusaders' }));
    expect(await screen.findByText('No changes recorded for this record yet.')).toBeTruthy();
  });
});
