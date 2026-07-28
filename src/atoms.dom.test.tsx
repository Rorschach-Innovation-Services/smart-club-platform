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
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoundedNumber } from './atoms';

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
