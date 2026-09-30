/**
 * Operator ↔ client navigation: the Clients-table "Open console" action, the portal
 * sidebar's return-to-console link, and the admin-shell client switcher. The /platform
 * registry is mocked at the api layer; openTenantConsole is spied because it performs a
 * full page load (jsdom can't navigate) — its URL building is covered in config.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query';
import { PlatformPortal } from './platform';
import { ClientSwitcher } from './client-switcher';
import * as api from './api';
import * as config from './config';
import type { TenantSummary } from './types';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, platformListTenants: vi.fn() };
});
vi.mock('./config', async () => {
  const actual = await vi.importActual<typeof import('./config')>('./config');
  // tenantConsoleUrl keeps its real behaviour unless a test overrides it (unreachable case).
  return {
    ...actual,
    openTenantConsole: vi.fn(),
    tenantConsoleUrl: vi.fn(actual.tenantConsoleUrl),
  };
});

const actualConfig = await vi.importActual<typeof import('./config')>('./config');

const tenant = (slug: string, name: string): TenantSummary => ({
  tenant: slug,
  name,
  title: '',
  logoUrl: '',
  submissionDeadline: '',
  adminCount: 1,
  features: {},
});
const TENANTS = [
  tenant('titans', 'Titans Cricket'),
  tenant('dolphins', 'Dolphins Pipeline'),
  tenant('acme', 'Acme Union'),
];

beforeEach(() => {
  queryClient.clear();
  vi.mocked(api.platformListTenants).mockReset();
  vi.mocked(api.platformListTenants).mockResolvedValue(TENANTS);
  vi.mocked(config.openTenantConsole).mockReset();
  // Back to the REAL function (on Vitest 2, mockReset alone leaves it returning undefined).
  vi.mocked(config.tenantConsoleUrl).mockReset();
  vi.mocked(config.tenantConsoleUrl).mockImplementation(actualConfig.tenantConsoleUrl);
  window.sessionStorage.clear();
});

const renderPortal = (path = '/platform', hasTenantConsole = true) =>
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <PlatformPortal
          userEmail="op@acme.test"
          signOutUser={vi.fn()}
          hasTenantConsole={hasTenantConsole}
          hostSlug="dolphins"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('Clients table — Open console', () => {
  it('opens the chosen client’s console without also opening its settings', async () => {
    const user = userEvent.setup();
    renderPortal();

    const row = (await screen.findByText('Titans Cricket')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /open console/i }));

    expect(config.openTenantConsole).toHaveBeenCalledWith('titans');
    // The row's own click (→ settings) must not fire.
    expect(screen.getByRole('heading', { name: /client unions/i })).toBeInTheDocument();
  });

  it('disables Open console for a client with no reachable console', async () => {
    vi.mocked(config.tenantConsoleUrl).mockImplementation((slug) =>
      slug === 'titans' ? null : `/?tenant=${slug}`,
    );
    renderPortal();
    const row = (await screen.findByText('Titans Cricket')).closest('tr') as HTMLElement;
    const btn = within(row).getByRole('button', { name: /open console/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'No web address yet');
  });

  it('keeps Overview in every row next to the new action', async () => {
    renderPortal();
    await screen.findByText('Acme Union');
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(within(row).getByRole('button', { name: /open console/i })).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    }
  });
});

describe('Portal sidebar — back to this host’s console', () => {
  it('names the host tenant and opens its console with a page load', async () => {
    const user = userEvent.setup();
    renderPortal();
    const link = await screen.findByRole('button', { name: 'Dolphins Pipeline console' });
    await user.click(link);
    expect(config.openTenantConsole).toHaveBeenCalledWith('dolphins');
  });

  it('is hidden when the operator has no console on this host', async () => {
    renderPortal('/platform', false);
    await screen.findByText('Titans Cricket');
    expect(screen.queryByRole('button', { name: /console$/ })).not.toBeInTheDocument();
  });
});

describe('Admin shell — ClientSwitcher', () => {
  const renderSwitcher = (enabled = true) =>
    render(
      <QueryClientProvider client={queryClient}>
        <ClientSwitcher currentSlug="dolphins" enabled={enabled} />
      </QueryClientProvider>,
    );

  it('lists every client, marks the current one inert, and opens another', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: 'Switch client' }));

    const menu = await screen.findByRole('menu', { name: 'Switch client' });
    const items = await within(menu).findAllByRole('menuitem');
    // Sorted by display name, slug shown alongside.
    expect(items.map((i) => i.textContent)).toEqual([
      'Acme Unionacme',
      'Dolphins PipelinedolphinsCurrent',
      'Titans Crickettitans',
    ]);

    const current = items[1];
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(current).toBeDisabled();
    await user.click(current);
    expect(config.openTenantConsole).not.toHaveBeenCalled();

    await user.click(items[2]);
    expect(config.openTenantConsole).toHaveBeenCalledWith('titans');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: 'Switch client' }));
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows a muted one-liner when the registry fails, instead of crashing', async () => {
    vi.mocked(api.platformListTenants).mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: 'Switch client' }));
    expect(await screen.findByText(/could not load clients/i)).toBeInTheDocument();
  });

  it('does not fetch the registry when disabled', async () => {
    renderSwitcher(false);
    // Let react-query run any pending fetch before asserting it never happened.
    await act(async () => {});
    expect(api.platformListTenants).not.toHaveBeenCalled();
  });

  it('is keyboard-operable: focus moves in, arrows skip the current item, Enter opens', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: 'Switch client' });
    trigger.focus();
    await user.keyboard('{Enter}');

    const menu = await screen.findByRole('menu', { name: 'Switch client' });
    const items = await within(menu).findAllByRole('menuitem');
    // Opening focuses the first enabled item (Acme); Dolphins is current → skipped.
    await vi.waitFor(() => expect(items[0]).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(items[2]).toHaveFocus();
    await user.keyboard('{ArrowDown}'); // wraps
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}'); // wraps back
    expect(items[2]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items[2]).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(config.openTenantConsole).toHaveBeenCalledWith('titans');
  });

  it('ArrowDown on the trigger opens the menu on the first enabled item', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    screen.getByRole('button', { name: 'Switch client' }).focus();
    await user.keyboard('{ArrowDown}');
    const items = await within(await screen.findByRole('menu')).findAllByRole('menuitem');
    await vi.waitFor(() => expect(items[0]).toHaveFocus());
    expect(items[0]).toHaveTextContent('Acme Union');
  });

  it('ArrowUp on the trigger opens the menu on the last enabled item', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    screen.getByRole('button', { name: 'Switch client' }).focus();
    await user.keyboard('{ArrowUp}');
    const items = await within(await screen.findByRole('menu')).findAllByRole('menuitem');
    await vi.waitFor(() => expect(items[2]).toHaveFocus());
    expect(items[2]).toHaveTextContent('Titans Cricket');
  });

  it('Escape and Tab close the menu and return focus to the trigger', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: 'Switch client' });

    await user.click(trigger);
    const items = await within(await screen.findByRole('menu')).findAllByRole('menuitem');
    await vi.waitFor(() => expect(items[0]).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    const again = await within(await screen.findByRole('menu')).findAllByRole('menuitem');
    await vi.waitFor(() => expect(again[0]).toHaveFocus());
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('lists a client with no reachable console as inert, tagged "No address"', async () => {
    vi.mocked(config.tenantConsoleUrl).mockImplementation((slug) =>
      slug === 'titans' ? null : `/?tenant=${slug}`,
    );
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: 'Switch client' }));
    const menu = await screen.findByRole('menu');
    const titans = await within(menu).findByRole('menuitem', { name: /Titans Cricket/ });
    expect(titans).toBeDisabled();
    expect(titans).toHaveAttribute('title', 'No web address yet');
    expect(titans).toHaveTextContent('No address');
    await user.click(titans);
    expect(config.openTenantConsole).not.toHaveBeenCalled();
  });
});
