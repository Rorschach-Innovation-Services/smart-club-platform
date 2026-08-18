/**
 * Guidance primitives (InfoTip, StepIntro) — the plumbing every self-serve wizard
 * step leans on so an operator never needs an engineer to understand a screen.
 * Covers rendering, the popover's open/close lifecycle, and its aria wiring.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InfoTip, StepIntro } from './platform-wizard';

describe('StepIntro', () => {
  it('renders a title and body, always visible', () => {
    render(<StepIntro title="Review the parsed players">Nothing is written yet.</StepIntro>);
    expect(screen.getByText('Review the parsed players')).toBeInTheDocument();
    expect(screen.getByText('Nothing is written yet.')).toBeInTheDocument();
  });
});

describe('InfoTip', () => {
  it('is closed by default and opens the popover on click, with aria wiring', async () => {
    const user = userEvent.setup();
    render(
      <InfoTip label="What does this do?">
        <p>Players without an ID number are harder to match later.</p>
      </InfoTip>,
    );

    const btn = screen.getByRole('button', { name: 'What does this do?' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.click(btn);

    const pop = await screen.findByRole('tooltip');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn.getAttribute('aria-describedby')).toBe(pop.id);
    expect(screen.getByText(/harder to match later/i)).toBeInTheDocument();

    // Clicking the button again closes it.
    await user.click(btn);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <InfoTip label="Info">
        <p>Explanation</p>
      </InfoTip>,
    );
    await user.click(screen.getByRole('button', { name: 'Info' }));
    await screen.findByRole('tooltip');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('closes on an outside click', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InfoTip label="Info">
          <p>Explanation</p>
        </InfoTip>
        <button>Elsewhere</button>
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'Info' }));
    await screen.findByRole('tooltip');

    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('closes when focus leaves the trigger and the popover', async () => {
    render(
      <div>
        <InfoTip label="Info">
          <p>Explanation</p>
        </InfoTip>
        <button>Elsewhere</button>
      </div>,
    );
    const btn = screen.getByRole('button', { name: 'Info' });
    fireEvent.click(btn);
    await screen.findByRole('tooltip');

    fireEvent.blur(btn, { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) });
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });
});
