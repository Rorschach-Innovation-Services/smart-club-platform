/**
 * TransferWindowCard: the operator's editor for per-tenant transfer windows. A save sends the
 * WHOLE list (trimmed, sorted the way the server stores it); invalid rows are refused before any
 * request goes out; Save stays disabled until something changes.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TransferWindowCard, normaliseTransferWindows } from './platform-transfer-windows';
import type { TenantConfig, TransferWindow } from './types';

function setup(transferWindows?: TransferWindow[]) {
  const save = vi.fn().mockResolvedValue({});
  const toast = vi.fn();
  const user = userEvent.setup();
  const config = { tenant: 'acme', transferWindows } as unknown as TenantConfig;
  render(<TransferWindowCard config={config} save={save} toast={toast} />);
  return { user, save, toast };
}

const saveBtn = () => screen.getByRole('button', { name: /save transfer windows/i });
const row = (n: number) => within(screen.getByRole('group', { name: `Window ${n}` }));
const setDate = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('TransferWindowCard', () => {
  it('starts empty ("open all year") with Save disabled until a window is added', async () => {
    const { user } = setup();
    expect(screen.getByText(/transfers are open all year/i)).toBeInTheDocument();
    expect(saveBtn()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /add window/i }));
    expect(saveBtn()).toBeEnabled();
  });

  it('saves the whole list, labels trimmed and sorted by start', async () => {
    const { user, save, toast } = setup([
      { label: 'Winter', start: '2026-11-01', end: '2026-11-30' },
    ]);
    await user.click(screen.getByRole('button', { name: /add window/i }));
    await user.type(row(2).getByLabelText('Name'), '  Pre-season  ');
    setDate(row(2).getByLabelText('Opens'), '2026-08-01');
    setDate(row(2).getByLabelText('Closes'), '2026-09-30');
    await user.click(saveBtn());
    expect(save).toHaveBeenCalledWith({
      transferWindows: [
        { label: 'Pre-season', start: '2026-08-01', end: '2026-09-30' },
        { label: 'Winter', start: '2026-11-01', end: '2026-11-30' },
      ],
    });
    expect(toast).toHaveBeenCalledWith('Transfer windows saved');
  });

  it('removing every window saves an empty list (no restriction)', async () => {
    const { user, save } = setup([{ label: 'Winter', start: '2026-11-01', end: '2026-11-30' }]);
    await user.click(row(1).getByRole('button', { name: /remove/i }));
    await user.click(saveBtn());
    expect(save).toHaveBeenCalledWith({ transferWindows: [] });
  });

  it('refuses a window whose start is after its end without calling the API', async () => {
    const { user, save } = setup([{ label: 'Winter', start: '2026-11-01', end: '2026-11-30' }]);
    setDate(row(1).getByLabelText('Opens'), '2026-12-01');
    await user.click(saveBtn());
    expect(screen.getByText(/start must be on or before the end/i)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses an unnamed window', async () => {
    const { user, save } = setup();
    await user.click(screen.getByRole('button', { name: /add window/i }));
    setDate(row(1).getByLabelText('Opens'), '2026-08-01');
    setDate(row(1).getByLabelText('Closes'), '2026-08-02');
    await user.click(saveBtn());
    expect(screen.getByText(/give it a name/i)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('shows the server error when the save is rejected', async () => {
    const { ApiError } = await import('./api');
    const { user, save } = setup();
    save.mockRejectedValueOnce(new ApiError(400, 'transferWindows may have at most 12 entries'));
    await user.click(screen.getByRole('button', { name: /add window/i }));
    await user.type(row(1).getByLabelText('Name'), 'X');
    setDate(row(1).getByLabelText('Opens'), '2026-08-01');
    setDate(row(1).getByLabelText('Closes'), '2026-08-02');
    await user.click(saveBtn());
    expect(await screen.findByText(/at most 12 entries/i)).toBeInTheDocument();
  });
});

describe('normaliseTransferWindows', () => {
  const one = (label: string, start: string, end: string) =>
    normaliseTransferWindows([{ label, start, end }]);

  it('mirrors the server rules', () => {
    expect(one(' ', '2026-01-01', '2026-01-02')).toHaveProperty('error');
    expect(one('A', '2026-02-30', '2026-03-02')).toHaveProperty('error');
    expect(one('A', '', '2026-03-02')).toHaveProperty('error');
    expect(one('x'.repeat(61), '2026-01-01', '2026-01-02')).toHaveProperty('error');
    expect(
      normaliseTransferWindows(
        Array.from({ length: 13 }, () => ({ label: 'A', start: '2026-01-01', end: '2026-01-02' })),
      ),
    ).toEqual({ error: 'At most 12 windows' });
    expect(one('A', '2026-01-01', '2026-01-01')).toEqual({
      windows: [{ label: 'A', start: '2026-01-01', end: '2026-01-01' }],
    });
  });
});
