/**
 * BoundedNumber — the shared remedy for the clamp-on-keystroke bug class.
 *
 * That bug was found FIVE times across three review rounds in three different files:
 * a number input that clamped on every keystroke, so typing "16" into a box with a max
 * of 19 worked, but typing "6" first (intending 16) snapped the model to the minimum and
 * ate the second digit. Every instance was fixed by hand until the class was named and
 * this component replaced them all.
 *
 * These tests are written per-KEYSTROKE on purpose. `fireEvent.change(el, '16')` sets the
 * whole value at once and passes even against the buggy implementation — which is exactly
 * how the bug survived a browser pass. userEvent.type() sends one key at a time.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BoundedNumber,
  FieldGuide,
  HowSeasonsWork,
  InfoDot,
  Modal,
  NextSteps,
  OptionCards,
  StatusTimeline,
  type OptionCard,
  type StatusStep,
} from './atoms';
import { InfoTip } from './platform-wizard';
import { FIELD_GUIDES } from './help/field-guides';

/** A realistic host: the component is controlled, so the parent owns the value. */
function Host({
  initial = 1,
  min = 1,
  max,
  onChange,
}: {
  initial?: number;
  min?: number;
  max?: number;
  onChange?: (n: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="n">Groups</label>
      <BoundedNumber
        value={value}
        min={min}
        max={max}
        onChange={(n) => {
          setValue(n);
          onChange?.(n);
        }}
      />
      <output>{value}</output>
    </>
  );
}

const box = () => screen.getByRole('spinbutton');

describe('BoundedNumber', () => {
  it('accepts a two-digit value whose first digit is below the minimum', async () => {
    // THE bug. min=10, typing "16": the "1" alone is below the minimum. Clamping on
    // that keystroke would rewrite the box to "10" and the "6" would land as "106".
    const user = userEvent.setup();
    render(<Host initial={10} min={10} max={20} />);

    await user.clear(box());
    await user.type(box(), '16');

    expect(box()).toHaveValue(16);
    // And the MODEL holds 16 — the box showing it isn't enough if the parent never heard.
    expect(screen.getByRole('status')).toHaveTextContent('16');
  });

  it('publishes the value once it is in range, not before', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={10} min={10} max={20} onChange={onChange} />);

    await user.clear(box());
    await user.type(box(), '16');

    // "1" is out of range and must never reach the model; "16" must.
    expect(onChange.mock.calls.map(([n]) => n)).toEqual([16]);
  });

  it('lets the box go empty while typing without pushing NaN to the model', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={5} min={1} max={20} onChange={onChange} />);

    await user.clear(box());

    expect(box()).toHaveValue(null);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clamps to the maximum on blur', async () => {
    const user = userEvent.setup();
    render(<Host initial={1} min={1} max={200} />);

    await user.clear(box());
    await user.type(box(), '999');
    await user.tab();

    expect(box()).toHaveValue(200);
  });

  it('clamps to the minimum on blur', async () => {
    const user = userEvent.setup();
    render(<Host initial={5} min={2} max={20} />);

    await user.clear(box());
    await user.type(box(), '1');
    await user.tab();

    expect(box()).toHaveValue(2);
  });

  it('restores the last good value when the box is left empty', async () => {
    const user = userEvent.setup();
    render(<Host initial={7} min={1} max={20} />);

    await user.clear(box());
    await user.tab();

    // Not 0, not blank, not NaN — the value the model still holds.
    expect(box()).toHaveValue(7);
  });

  it('does not fight the user when there is no maximum', async () => {
    const user = userEvent.setup();
    render(<Host initial={1} min={1} />);

    await user.clear(box());
    await user.type(box(), '5000');
    await user.tab();

    expect(box()).toHaveValue(5000);
  });

  it('re-seeds when the value changes from outside', async () => {
    function Swapper() {
      const [value, setValue] = useState(4);
      return (
        <>
          <BoundedNumber value={value} min={1} max={20} onChange={setValue} />
          <button onClick={() => setValue(12)}>Load template</button>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Swapper />);

    await user.click(screen.getByRole('button', { name: /load template/i }));

    // A template swap or reset must move the box; only our OWN keystrokes are exempt.
    expect(box()).toHaveValue(12);
  });

  it('keeps focus across a multi-digit entry', async () => {
    // The sibling bug: a component keyed on the value being edited remounts on every
    // keystroke and drops focus, so only the first character lands.
    const user = userEvent.setup();
    render(<Host initial={1} min={1} max={999} />);

    await user.clear(box());
    await user.type(box(), '123');

    expect(box()).toHaveFocus();
    expect(box()).toHaveValue(123);
  });
});

/* ─── Explainer components ─── */

type Cadence = 'weekly' | 'every-n' | 'spread';

const CADENCE_OPTIONS: OptionCard<Cadence>[] = [
  { value: 'weekly', title: 'Weekly', desc: 'One round a week.', eg: 'Every Sunday' },
  { value: 'every-n', title: 'Every N weeks', desc: 'One round every few weeks.' },
  {
    value: 'spread',
    title: 'Spread evenly',
    desc: 'Rounds spaced to the block end.',
    disabled: true,
    disabledReason: 'Needs a block end date first.',
  },
];

function CadenceHost({ onChange }: { onChange?: (v: Cadence) => void }) {
  const [value, setValue] = useState<Cadence>('weekly');
  return (
    <OptionCards
      name="cadence"
      label="Cadence"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      options={CADENCE_OPTIONS}
    />
  );
}

describe('OptionCards', () => {
  it('selects a card when it is clicked anywhere', async () => {
    const user = userEvent.setup();
    render(<CadenceHost />);

    await user.click(screen.getByText('One round every few weeks.'));

    expect(screen.getByRole('radio', { name: /every n weeks/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^weekly/i })).not.toBeChecked();
  });

  it('moves the selection with the arrow keys, as native radios do', async () => {
    const user = userEvent.setup();
    render(<CadenceHost />);

    await user.tab();
    expect(screen.getByRole('radio', { name: /^weekly/i })).toHaveFocus();
    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('radio', { name: /every n weeks/i })).toBeChecked();
  });

  it('shows the example and the reason a card is unavailable', () => {
    render(<CadenceHost />);
    expect(screen.getByText('e.g. Every Sunday')).toBeInTheDocument();
    expect(screen.getByText('Needs a block end date first.')).toBeInTheDocument();
  });

  it('does not select a disabled card', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<CadenceHost onChange={onChange} />);

    await user.click(screen.getByText('Spread evenly'));

    expect(screen.getByRole('radio', { name: /spread evenly/i })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /spread evenly/i })).not.toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('StatusTimeline', () => {
  const steps: StatusStep[] = [
    { label: 'Draft', state: 'done' },
    { label: 'Approved', state: 'current', hint: 'Release when grounds are settled' },
    { label: 'Released', state: 'todo', hint: 'Never shown' },
  ];

  it('names every step and its state for assistive tech', () => {
    render(<StatusTimeline steps={steps} />);
    expect(
      screen.getByRole('list', {
        name: 'Draft: done, Approved: current, Released: not started',
      }),
    ).toBeInTheDocument();
  });

  it('marks the current step and shows only its hint', () => {
    render(<StatusTimeline steps={steps} />);
    const current = screen.getByText('Approved').closest('li');
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Release when grounds are settled')).toBeInTheDocument();
    expect(screen.queryByText('Never shown')).not.toBeInTheDocument();
  });
});

describe('NextSteps', () => {
  it('numbers the steps in order', () => {
    render(
      <NextSteps
        steps={[
          { title: 'Confirm teams', desc: 'Check the sides in each group.' },
          { title: 'Generate', desc: 'Make the fixtures.' },
          { title: 'Release', desc: 'Clubs see them.' },
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      '1Confirm teamsCheck the sides in each group.',
      '2GenerateMake the fixtures.',
      '3ReleaseClubs see them.',
    ]);
  });
});

describe('FieldGuide', () => {
  it('renders the meaning, use, example and convention for a field', () => {
    render(<FieldGuide id="block-dates" />);
    expect(screen.getByText(FIELD_GUIDES['block-dates'].meaning)).toBeInTheDocument();
    expect(screen.getByText(/Every stage in the block plans its rounds/)).toBeInTheDocument();
    expect(screen.getByText('e.g. Block 1: 2026-09-13 to 2026-12-13.')).toBeInTheDocument();
    expect(screen.getByText(/Dates are YYYY-MM-DD/)).toBeInTheDocument();
  });
});

describe('HowSeasonsWork', () => {
  it('shows the pipeline and the four ideas', () => {
    render(<HowSeasonsWork />);
    const nodes = within(screen.getByRole('list', { name: /how a season is put together/i }))
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(nodes).toEqual(['Competition', 'Season', 'Stage', 'Group', 'Fixtures']);
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(4);
    expect(screen.getByText(/The operator builds the shape once/)).toBeInTheDocument();
  });

  it('compact mode links to the blocks-and-stages explainer', () => {
    render(<HowSeasonsWork compact />);
    expect(screen.queryAllByRole('heading', { level: 4 })).toHaveLength(0);
    expect(screen.getByRole('link', { name: /how does this work/i })).toBeInTheDocument();
  });
});

describe('InfoTip is InfoDot', () => {
  it('is the same component', () => {
    expect(InfoTip).toBe(InfoDot);
  });

  it('keeps only one popover open at a time across both names', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InfoDot title="Cadence">How often rounds are played.</InfoDot>
        <InfoTip label="About seeding">Strongest side first.</InfoTip>
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Cadence' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('How often rounds are played.');

    await user.click(screen.getByRole('button', { name: 'About seeding' }));
    const pops = screen.getAllByRole('tooltip');
    expect(pops).toHaveLength(1);
    expect(pops[0]).toHaveTextContent('Strongest side first.');
    expect(screen.getByRole('button', { name: 'Cadence' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

describe('Modal — the one dialog shell', () => {
  /** An opener button toggling a modal, so focus return can be observed. */
  function Opener({ dismissable }: { dismissable?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        {open && (
          <Modal
            eyebrow="Fixtures · Season"
            title="Delete this season?"
            onClose={() => setOpen(false)}
            dismissable={dismissable}
            footer={<button>Confirm</button>}
          >
            <p>Body</p>
          </Modal>
        )}
      </>
    );
  }

  it('is a labelled modal dialog with eyebrow, body and footer', async () => {
    render(<Opener />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this season?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Fixtures · Season')).toBeInTheDocument();
    expect(within(dialog).getByText('Body')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('moves focus in on open and back to the opener when Escape closes it', async () => {
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(opener);
    expect(screen.getByRole('dialog')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('keeps Tab and Shift+Tab cycling inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog');
    const close = within(dialog).getByTitle('Close');
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });

    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    // Past the last control it wraps to the first — never out to the page behind.
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it('closes on a backdrop click unless dismissable is false', async () => {
    const { unmount } = render(<Opener />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await userEvent.click(document.querySelector('.task-modal-backdrop') as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    render(<Opener dismissable={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await userEvent.click(document.querySelector('.task-modal-backdrop') as HTMLElement);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
