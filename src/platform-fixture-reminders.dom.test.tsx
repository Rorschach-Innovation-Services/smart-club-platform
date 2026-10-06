/**
 * FixtureRemindersCard: the operator's switch for the FixtureReminders cron. Checks that a save
 * sends the whole `fixtureReminders` key (lead days normalised the same way the server does it),
 * that invalid input is refused before any request goes out, and that Save stays disabled until
 * something changes.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FixtureRemindersCard, parseLeadDays } from './platform-fixture-reminders';
import type { TenantConfig } from './types';

function setup(fixtureReminders?: TenantConfig['fixtureReminders']) {
  const save = vi.fn().mockResolvedValue({});
  const toast = vi.fn();
  const user = userEvent.setup();
  const config = { tenant: 'acme', fixtureReminders } as unknown as TenantConfig;
  render(<FixtureRemindersCard config={config} save={save} toast={toast} />);
  return { user, save, toast };
}

const saveBtn = () => screen.getByRole('button', { name: /save reminder settings/i });

describe('FixtureRemindersCard', () => {
  it('starts off with defaults and Save disabled until something changes', async () => {
    const { user } = setup();
    expect(screen.getByLabelText(/send fixture reminders/i)).not.toBeChecked();
    expect(screen.getByLabelText(/lead days/i)).toHaveValue('1');
    expect(screen.getByLabelText('Email')).toBeChecked();
    expect(screen.getByLabelText('WhatsApp')).not.toBeChecked();
    expect(saveBtn()).toBeDisabled();
    await user.click(screen.getByLabelText(/send fixture reminders/i));
    expect(saveBtn()).toBeEnabled();
  });

  it('saves the whole key with lead days deduped and sorted, channels in canonical order', async () => {
    const { user, save, toast } = setup();
    await user.click(screen.getByLabelText(/send fixture reminders/i));
    const lead = screen.getByLabelText(/lead days/i);
    await user.clear(lead);
    await user.type(lead, '7, 2, 7');
    await user.click(screen.getByLabelText('WhatsApp'));
    await user.click(saveBtn());

    expect(save).toHaveBeenCalledWith({
      fixtureReminders: { enabled: true, leadDays: [2, 7], channels: ['email', 'whatsapp'] },
    });
    expect(toast).toHaveBeenCalledWith('Fixture reminder settings saved');
  });

  it('refuses out-of-range lead days without calling the API', async () => {
    const { user, save } = setup({ enabled: true, leadDays: [1], channels: ['email'] });
    const lead = screen.getByLabelText(/lead days/i);
    await user.clear(lead);
    await user.type(lead, '31');
    await user.click(saveBtn());
    expect(screen.getByText(/whole numbers from 1 to 30/i)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses enabling with no channel', async () => {
    const { user, save } = setup({ enabled: true, leadDays: [1], channels: ['email'] });
    await user.click(screen.getByLabelText('Email'));
    await user.click(saveBtn());
    expect(screen.getByText(/pick at least one channel/i)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('shows the server error when the save is rejected', async () => {
    const { ApiError } = await import('./api');
    const { user, save } = setup();
    save.mockRejectedValueOnce(
      new ApiError(400, 'fixtureReminders.leadDays may have at most 4 entries'),
    );
    await user.click(screen.getByLabelText(/send fixture reminders/i));
    await user.click(saveBtn());
    expect(await screen.findByText(/at most 4 entries/i)).toBeInTheDocument();
  });
});

describe('parseLeadDays', () => {
  it('accepts commas or spaces, dedupes and sorts', () => {
    expect(parseLeadDays('3 1,1')).toEqual({ leadDays: [1, 3] });
    expect(parseLeadDays('')).toEqual({ leadDays: [] });
  });
  it('rejects non-integers, 0 and more than four entries', () => {
    expect(parseLeadDays('1.5')).toHaveProperty('error');
    expect(parseLeadDays('0')).toHaveProperty('error');
    expect(parseLeadDays('1,2,3,4,5')).toEqual({ error: 'At most 4 lead days' });
  });
});
