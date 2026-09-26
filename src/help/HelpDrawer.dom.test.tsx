/**
 * The help drawer: a HelpLink opens a topic from HELP_TOPICS in a modal side panel,
 * Escape hands focus back to the link, and an unknown or anchorless topic degrades
 * gracefully instead of throwing or linking nowhere.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelpLink, HelpProvider, GUIDE_URL } from './HelpDrawer';
import { HELP_TOPICS, type HelpTopicId } from './topics';

const originalAnchor = HELP_TOPICS['home-and-away'].guideAnchor;
afterEach(() => {
  HELP_TOPICS['home-and-away'].guideAnchor = originalAnchor;
});

function renderLink(topic: HelpTopicId, label?: string) {
  return render(
    <HelpProvider>
      <p>
        Cadence <HelpLink topic={topic}>{label}</HelpLink>
      </p>
    </HelpProvider>,
  );
}

describe('HelpDrawer', () => {
  it('opens the topic from a HelpLink', async () => {
    const user = userEvent.setup();
    renderLink('how-dates-are-planned');

    await user.click(screen.getByRole('button', { name: /how does this work/i }));

    const dialog = screen.getByRole('dialog', { name: 'How fixture dates are planned' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent(HELP_TOPICS['how-dates-are-planned'].summary);
    expect(dialog).toHaveTextContent('Example');
    expect(dialog).toHaveTextContent(/Block 1 runs 13 Sep/);
  });

  it('closes on Escape and returns focus to the link', async () => {
    const user = userEvent.setup();
    renderLink('home-and-away', 'Who plays at home?');
    const link = screen.getByRole('button', { name: 'Who plays at home?' });

    await user.click(link);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close help' })).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(link).toHaveFocus());
  });

  it('keeps Tab inside the drawer', async () => {
    const user = userEvent.setup();
    renderLink('home-and-away');
    await user.click(screen.getByRole('button', { name: /how does this work/i }));

    await user.tab();
    await user.tab();

    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
  });

  it('closes when the backdrop is clicked', async () => {
    const user = userEvent.setup();
    renderLink('home-and-away');
    await user.click(screen.getByRole('button', { name: /how does this work/i }));

    await user.click(document.querySelector('.help-drawer-backdrop') as HTMLElement);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a fallback for a topic with no explainer, and warns in development', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const user = userEvent.setup();
    renderLink('no-such-topic' as HelpTopicId);

    await user.click(screen.getByRole('button', { name: /how does this work/i }));

    expect(
      screen.getByRole('dialog', { name: 'No help written for this yet' }),
    ).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith('HelpDrawer: no help topic "no-such-topic"');
    warn.mockRestore();
  });

  it('always links the guide — with the topic anchor when it has one', async () => {
    const user = userEvent.setup();
    // Every shipped topic has an anchor now; clear one to exercise the no-anchor path,
    // which falls back to the guide's front page (the drawer is many users' only visible
    // door to the full walkthrough).
    HELP_TOPICS['home-and-away'].guideAnchor = undefined;
    const { unmount } = renderLink('home-and-away');
    await user.click(screen.getByRole('button', { name: /how does this work/i }));
    expect(screen.getByRole('link', { name: /read more in the guide/i })).toHaveAttribute(
      'href',
      GUIDE_URL,
    );
    unmount();

    HELP_TOPICS['home-and-away'].guideAnchor = 'home-and-away';
    renderLink('home-and-away');
    await user.click(screen.getByRole('button', { name: /how does this work/i }));

    const more = screen.getByRole('link', { name: /read more in the guide/i });
    expect(more).toHaveAttribute('href', `${GUIDE_URL}#home-and-away`);
    expect(more).toHaveAttribute('target', '_blank');
  });
});
