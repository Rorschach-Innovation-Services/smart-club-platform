import { formatTime, formatWeekdayDay } from './dates';
import type { Clash } from './types';

/**
 * One clash rendered in the same words as the server's formatClashForHumans (ADR 0011
 * addendum): the ground/day/time this fixture wants, then the OTHER fixture already
 * holding it. `with.home/away` are display names the server resolved; falling back to the
 * raw ref keeps a `win:fN` bracket side legible rather than blank.
 */
export function clashLine(c: Clash): string {
  // `formatTime` returns null for a non-strict HH:mm; importer-era rows carry '9:00', so
  // fall back to the raw value rather than rendering the literal "null".
  const time = c.time ? ` ${formatTime(c.time) ?? c.time}` : '';
  const opp =
    c.with.home && c.with.away
      ? `${c.with.home} v ${c.with.away}`
      : c.with.home || c.with.away || c.with.fixtureId;
  const oppRound = c.with.round != null ? ` R${c.with.round}` : '';
  return `${c.ground} on ${formatWeekdayDay(c.date)}${time} is already booked by ${
    c.with.seriesName ?? 'another series'
  }${oppRound} · ${opp}`;
}

/**
 * Inline clash feedback for the fixture editor — shown both from the admin-only pre-check
 * while a venue is being chosen and from a save 409 (ADR 0011 addendum). Named grounds
 * plus a fixed "how to fix" list. `field-error` is the same semantic hook ReleaseDialog's
 * error box uses (styled by one shared rule in index.html's inline stylesheet); the
 * spacing/type here is inline, matching that component. The clash gate returns actionable
 * copy, not a stack trace.
 */
export function ClashPanel({ heading, clashes }: { heading: string; clashes: Clash[] }) {
  return (
    <div
      className="field-error"
      role="alert"
      style={{ marginTop: 6, whiteSpace: 'normal', lineHeight: 1.45 }}
    >
      <strong>{heading}</strong>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {clashes.map((c, i) => (
          <li key={i}>{clashLine(c)}</li>
        ))}
      </ul>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
        How to fix: pick another ground · change the date or start time · edit the other fixture
        instead
      </div>
    </div>
  );
}
