/**
 * Admin console — the master venue list (ADR 0008, phase 2).
 *
 * Admin-managed rather than operator-only, unlike calendars and structures: a ground
 * going out for maintenance is a week-to-week fact the union office learns first, and
 * routing that through the platform operator would make the schedule permanently stale.
 *
 * The coverage banner is load-bearing. There is no geocoder — coordinates are pinned by
 * hand — so a half-pinned registry is the normal state, and the allocator silently drops
 * distance ranking below a threshold. Saying so here is the difference between "the
 * allocator ignored travel" and "the allocator seems to pick odd grounds".
 */
import { useState, useId, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  BoundedNumber,
  Btn,
  Card,
  EmptyState,
  Field,
  Icon,
  InfoDot,
  Pill,
  useEscapeClose,
} from './atoms';
import { ApiError } from './api';
import { WEEKDAY_LABELS, isValidIsoDate } from './competition/calendar';
import { MIN_GEO_COVERAGE, geoCoverage } from './competition/venues';
import type { Club, Venue, VenueUnavailable, Weekday } from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '6px 0 0' };
const SECTION: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.05em',
  textTransform: 'uppercase',
  color: 'var(--muted-2)',
  margin: '16px 0 6px',
};

function venueId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 6)
      : Math.random().toString(36).slice(2, 8);
  return `${slug || 'venue'}-${rand}`;
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}) {
  useEscapeClose(onClose);
  // A dialog with no role is, to assistive tech, an ordinary div: nothing announces that
  // a modal opened, nothing scopes the reading order to it, and Escape is the only thing
  // that behaves. `aria-labelledby` points at the visible heading so it gets a name too.
  const titleId = useId();
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Fixtures · Venues</div>
            <div className="task-modal-head-title" id={titleId}>
              {title}
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function VenueForm({
  venue,
  clubs,
  onSave,
  onClose,
  toast,
}: {
  venue: Venue | null;
  clubs: Club[];
  onSave: (v: Venue) => Promise<void>;
  onClose: () => void;
  toast: Toast;
}) {
  const [draft, setDraft] = useState<Venue>(
    () => venue ?? { id: '', name: '', surfaces: 1, homeClubIds: [], unavailable: [] },
  );
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<Venue>) => setDraft((d) => ({ ...d, ...p }));

  // Coordinates are held as RAW STRINGS while typing and parsed once, on submit.
  //
  // Parsing per keystroke makes the field impossible to use: `Number('-')` is NaN, and
  // NaN survives `?? ''`, so the box fills with the literal text "NaN" on the first
  // character of any southern-hemisphere latitude. `Number('-29.')` is -29, so the
  // decimal point is deleted the moment it is typed. Since there is no geocoder, this
  // form is the only way a ground ever gets pinned.
  const [latText, setLatText] = useState(() => (venue?.lat ?? '').toString());
  const [lonText, setLonText] = useState(() => (venue?.lon ?? '').toString());
  const parseCoord = (s: string): number | undefined => {
    const t = s.trim();
    if (!t) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : Number.NaN; // NaN ⇒ typed but unparseable
  };
  const lat = parseCoord(latText);
  const lon = parseCoord(lonText);

  const problems: string[] = [];
  if (!draft.name.trim()) problems.push('Give the ground a name.');
  const pinned = Number.isFinite(lat) && Number.isFinite(lon);
  const halfPinned = (lat === undefined) !== (lon === undefined);
  if (Number.isNaN(lat) || Number.isNaN(lon))
    problems.push('A latitude and longitude must each be a number, e.g. -29.85 and 31.03.');
  else if (halfPinned) problems.push('A pin needs both a latitude and a longitude.');
  else if (pinned) {
    if (lat! < -90 || lat! > 90) problems.push('Latitude must be between -90 and 90.');
    if (lon! < -180 || lon! > 180) problems.push('Longitude must be between -180 and 180.');
  }
  for (const w of draft.unavailable ?? []) {
    if (!w.reason.trim()) problems.push('Every unavailable window needs a reason.');
    if (!isValidIsoDate(w.start) || !isValidIsoDate(w.end))
      problems.push(`"${w.reason || 'A window'}" needs valid dates.`);
    else if (w.end < w.start) problems.push(`"${w.reason}" ends before it starts.`);
  }

  async function submit() {
    if (problems.length || busy) return;
    setErr('');
    setBusy(true);
    try {
      await onSave({
        ...draft,
        id: draft.id || venueId(draft.name),
        name: draft.name.trim(),
        // Cleared boxes must send `undefined`, not a stale coordinate off `draft` —
        // unpinning a ground is how an operator says "don't distance-rank this one".
        lat,
        lon,
        unavailable: (draft.unavailable ?? []).map((w) => ({ ...w, reason: w.reason.trim() })),
      });
      toast(`${draft.name.trim()} · saved`);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Field label="Ground name" required>
        {(id) => (
          <input
            id={id}
            className="field-input"
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="e.g. Kingsmead"
            autoFocus
          />
        )}
      </Field>

      <div className="field-grid-2">
        <Field label="Suburb">
          {(id) => (
            <input
              id={id}
              className="field-input"
              value={draft.suburb ?? ''}
              onChange={(e) => patch({ suburb: e.target.value })}
            />
          )}
        </Field>
        <div className="field">
          <div className="field-label">Matches per day</div>
          <BoundedNumber
            min={1}
            max={6}
            value={draft.surfaces ?? 1}
            onChange={(surfaces) => patch({ surfaces })}
            ariaLabel="Matches per day"
          />
          <p style={HINT}>Grounds with two pitches can host two matches on one day.</p>
        </div>
      </div>

      <Field label="Address">
        {(id) => (
          <input
            id={id}
            className="field-input"
            value={draft.address ?? ''}
            onChange={(e) => patch({ address: e.target.value })}
          />
        )}
      </Field>

      <div style={SECTION}>Location</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="field-input"
          style={{ width: 150 }}
          placeholder="Latitude"
          aria-label="Latitude"
          inputMode="decimal"
          value={latText}
          onChange={(e) => setLatText(e.target.value)}
        />
        <input
          className="field-input"
          style={{ width: 150 }}
          placeholder="Longitude"
          aria-label="Longitude"
          inputMode="decimal"
          value={lonText}
          onChange={(e) => setLonText(e.target.value)}
        />
        {pinned ? <Pill tone="teal">Pinned</Pill> : <Pill tone="muted">Not pinned</Pill>}
      </div>
      <p style={HINT}>
        Optional, but a ground without a pin can&apos;t be ranked by travel distance — the allocator
        falls back to home-ground preference alone.
      </p>

      <div style={SECTION}>Home clubs</div>
      <p style={{ ...HINT, marginTop: 0 }}>
        Clubs that call this ground home. More than one is normal — ground-sharing is why
        &ldquo;home preference&rdquo; sometimes has to give way.
      </p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {clubs.map((c) => {
          const on = (draft.homeClubIds ?? []).includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              onClick={() =>
                patch({
                  homeClubIds: on
                    ? (draft.homeClubIds ?? []).filter((x) => x !== c.id)
                    : [...(draft.homeClubIds ?? []), c.id],
                })
              }
              style={{
                padding: '4px 10px',
                borderRadius: 999,
                fontSize: 11.5,
                fontWeight: 600,
                cursor: 'pointer',
                border: '1px solid var(--line)',
                background: on ? 'var(--green-pale)' : 'var(--paper)',
                color: on ? 'var(--green)' : 'var(--muted-2)',
              }}
            >
              {c.name}
            </button>
          );
        })}
      </div>

      <div style={{ ...SECTION, display: 'flex', alignItems: 'center', gap: 2 }}>
        Never available on
        <InfoDot title="Never available on">
          <p>
            A <strong>recurring</strong> weekday blackout — pick the days this ground is never free
            (e.g. a school ground used on Fridays). No fixture will land on those weekdays.
          </p>
          <p>For a one-off date range instead, use Unavailable windows below.</p>
        </InfoDot>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {WEEKDAY_LABELS.map((label, day) => {
          const on = (draft.unavailableWeekdays ?? []).includes(day as Weekday);
          return (
            <button
              key={label}
              type="button"
              onClick={() =>
                patch({
                  unavailableWeekdays: on
                    ? (draft.unavailableWeekdays ?? []).filter((d) => d !== day)
                    : [...(draft.unavailableWeekdays ?? []), day as Weekday].sort((a, b) => a - b),
                })
              }
              style={{
                padding: '4px 10px',
                borderRadius: 999,
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
                border: '1px solid var(--line)',
                background: on ? 'var(--coral-pale, #FDECEA)' : 'var(--paper)',
                color: on ? 'var(--coral)' : 'var(--muted-2)',
              }}
            >
              {label.slice(0, 3)}
            </button>
          );
        })}
      </div>

      <div style={{ ...SECTION, display: 'flex', alignItems: 'center', gap: 2 }}>
        Unavailable windows
        <InfoDot title="Unavailable windows">
          <p>
            <strong>One-off</strong> date ranges the ground is closed — a re-lay, a festival, exam
            weeks. Give each a reason and a start/end date. Fixtures skip these dates.
          </p>
        </InfoDot>
      </div>
      {(draft.unavailable ?? []).map((w, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(120px, 1.4fr) 130px 130px auto',
            gap: 8,
            alignItems: 'center',
            padding: '6px 0',
            borderBottom: '1px solid var(--line2)',
          }}
        >
          <input
            className="field-input"
            placeholder="Outfield relaid"
            value={w.reason}
            onChange={(e) =>
              patch({
                unavailable: (draft.unavailable ?? []).map((x, j) =>
                  i === j ? { ...x, reason: e.target.value } : x,
                ),
              })
            }
          />
          <input
            className="field-input"
            type="date"
            value={w.start}
            onChange={(e) =>
              patch({
                unavailable: (draft.unavailable ?? []).map((x, j) =>
                  i === j ? { ...x, start: e.target.value } : x,
                ),
              })
            }
          />
          <input
            className="field-input"
            type="date"
            value={w.end}
            min={w.start || undefined}
            onChange={(e) =>
              patch({
                unavailable: (draft.unavailable ?? []).map((x, j) =>
                  i === j ? { ...x, end: e.target.value } : x,
                ),
              })
            }
          />
          <Btn
            tone="ghost"
            size="sm"
            onClick={() =>
              patch({ unavailable: (draft.unavailable ?? []).filter((_, j) => j !== i) })
            }
          >
            Remove
          </Btn>
        </div>
      ))}
      <div style={{ marginTop: 10 }}>
        <Btn
          tone="outline"
          size="sm"
          icon={Icon.Plus}
          onClick={() =>
            patch({
              unavailable: [
                ...(draft.unavailable ?? []),
                { reason: '', start: '', end: '' } as VenueUnavailable,
              ],
            })
          }
        >
          Add window
        </Btn>
      </div>

      {problems.map((p, i) => (
        <div key={i} style={ERR}>
          {p}
        </div>
      ))}
      {err && <div style={ERR}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <Btn tone="teal" onClick={submit} disabled={!!problems.length || busy}>
          {busy ? 'Saving…' : 'Save ground'}
        </Btn>
        <Btn tone="outline" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/**
 * Derive venues from the grounds already recorded on club affiliation forms.
 *
 * Every club has pinned its own ground during affiliation, so the registry starts
 * populated rather than empty — and those pins are the only coordinates the platform has,
 * since there is no geocoder. Secondary venues come across too, but WITHOUT coordinates:
 * `ground.secondaryAddress` has no lat/lon field, which is exactly why coverage starts
 * below 100% and the banner matters.
 */
export function venuesFromClubGrounds(clubs: Club[], existing: Venue[]): Venue[] {
  // CLONES of the existing rows, never the rows themselves. The previous version wrote
  // `homeClubIds` straight onto objects owned by the venues query cache and then excluded
  // them from the returned list, so a ground-share link appeared in the UI (and in the
  // allocator's club→ground map) without ever being saved — meaning allocation output
  // depended on whether the operator had opened this card, and reverted on reload.
  const seen = new Map(existing.map((v) => [v.name.trim().toLowerCase(), { ...v }]));
  const out: Venue[] = [];
  const push = (v: Venue) => {
    if (!out.includes(v)) out.push(v);
  };
  for (const c of clubs ?? []) {
    const g = c.ground ?? {};
    const primary = g.venue?.trim();
    if (primary && !seen.has(primary.toLowerCase())) {
      const v: Venue = {
        id: venueId(primary),
        name: primary,
        address: g.address,
        suburb: g.suburb,
        ...(Number.isFinite(g.lat) && Number.isFinite(g.lon) ? { lat: g.lat, lon: g.lon } : {}),
        homeClubIds: [c.id],
        surfaces: 1,
      };
      seen.set(primary.toLowerCase(), v);
      push(v);
    } else if (primary) {
      // Ground-sharing: a second club naming the same ground joins its home list. An
      // EXISTING venue gaining a club is a real change, so it goes into the list to be
      // saved rather than being silently dropped.
      const v = seen.get(primary.toLowerCase())!;
      if (!v.homeClubIds?.includes(c.id)) {
        v.homeClubIds = [...(v.homeClubIds ?? []), c.id];
        push(v);
      }
    }
    const secondary = g.secondaryVenue?.trim();
    if (secondary && !seen.has(secondary.toLowerCase())) {
      const v: Venue = {
        id: venueId(secondary),
        name: secondary,
        address: g.secondaryAddress,
        // No coordinates: ClubGround has no secondaryLat/secondaryLon.
        homeClubIds: [c.id],
        surfaces: 1,
      };
      seen.set(secondary.toLowerCase(), v);
      push(v);
    } else if (secondary) {
      // Same ground-share rule as the primary branch. Without it, whether a club counts
      // as home to a shared ground depended on which club the loop reached first — and
      // `homeClubIds` is what the allocator reads for `isHome`.
      const v = seen.get(secondary.toLowerCase())!;
      if (!v.homeClubIds?.includes(c.id)) {
        v.homeClubIds = [...(v.homeClubIds ?? []), c.id];
        push(v);
      }
    }
  }
  return out;
}

export function VenuesCard({
  clubs,
  venues,
  loadFailed = false,
  onSave,
  onDelete,
  toast,
}: {
  clubs: Club[];
  venues: Venue[];
  /**
   * The registry couldn't be fetched. Distinct from "there are none", because the two
   * look identical here and the consequences are not: an empty list makes every club
   * ground look new, so the sync CTA would mint a duplicate of every existing ground —
   * fresh ids, same names — and hand the allocator twice the real capacity.
   */
  loadFailed?: boolean;
  onSave: (v: Venue) => Promise<void>;
  onDelete: (id: string) => void;
  toast: Toast;
}) {
  const [form, setForm] = useState<Venue | 'new' | null>(null);
  const [confirm, setConfirm] = useState<Venue | null>(null);
  const [importing, setImporting] = useState(false);
  const coverage = geoCoverage(venues);
  // Nothing to derive from a list we don't trust — this is what hides the sync CTA.
  const derived = loadFailed ? [] : venuesFromClubGrounds(clubs, venues);

  async function runBackfill() {
    setImporting(true);
    try {
      for (const v of derived) await onSave(v);
      // "synced", not "added" — the list also carries existing grounds that gained a
      // ground-sharing club, which is a real change that has to be saved.
      toast(`${derived.length} ground${derived.length === 1 ? '' : 's'} synced from club records`);
    } catch {
      /* onSave toasts its own failure */
    } finally {
      setImporting(false);
    }
  }

  const clubName = (id: string) => clubs.find((c) => c.id === id)?.name ?? id;

  return (
    <Card
      title="Venues"
      sub="The master ground list fixtures are allocated to. Availability windows here are what stop a fixture landing on a closed ground."
      action={
        venues.length > 0 ? (
          <Btn tone="teal" size="sm" icon={Icon.Plus} onClick={() => setForm('new')}>
            Add ground
          </Btn>
        ) : undefined
      }
    >
      {venues.length > 0 && coverage < MIN_GEO_COVERAGE && (
        <div
          style={{
            border: '1px solid var(--line)',
            background: 'var(--coral-pale, #FDECEA)',
            color: 'var(--coral)',
            borderRadius: 8,
            padding: '10px 12px',
            fontSize: 12.5,
            lineHeight: 1.5,
            marginBottom: 14,
          }}
        >
          Only {Math.round(coverage * 100)}% of grounds have a pinned location, so allocation
          ignores travel distance and uses home-ground preference alone. Pin the rest to rank
          grounds by travel.
        </div>
      )}

      {loadFailed ? (
        <EmptyState
          icon={Icon.Shield}
          title="Couldn’t load the ground list"
          sub="This is a loading problem, not an empty registry — so nothing is offered here that would add to it. Refresh; if it persists, the grounds are still safely stored."
        />
      ) : venues.length === 0 ? (
        <EmptyState
          icon={Icon.Shield}
          title="No grounds yet"
          sub="Fixtures need somewhere to be played. Start from the grounds clubs already recorded on their affiliation forms, then add any neutral venues."
          action={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              {derived.length > 0 && (
                <Btn tone="teal" onClick={runBackfill} disabled={importing}>
                  {importing ? 'Syncing…' : `Sync ${derived.length} from club records`}
                </Btn>
              )}
              <Btn tone="outline" icon={Icon.Plus} onClick={() => setForm('new')}>
                Add a ground
              </Btn>
            </div>
          }
        />
      ) : (
        <>
          <div className="tbl-w">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Ground</th>
                  <th title="The club(s) this is a home ground for. 'Neutral' means no home club.">
                    Home to
                  </th>
                  <th title="Matches this ground can host in a single day.">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      Per day
                      <InfoDot title="Per day">
                        <p>
                          How many matches this ground can host in one day. A ground with two
                          pitches can host <strong>two</strong>. Drives how tightly the allocator
                          can pack a round.
                        </p>
                      </InfoDot>
                    </span>
                  </th>
                  <th title="Whether the ground has hand-entered map coordinates.">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      Pinned
                      <InfoDot title="Pinned">
                        <p>
                          Whether the ground has hand-entered map coordinates. Only pinned grounds
                          can be ranked by <strong>travel distance</strong> — unpinned ones fall
                          back to home-ground preference alone.
                        </p>
                      </InfoDot>
                    </span>
                  </th>
                  <th title="Dates and weekdays the ground is unavailable.">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      Closures
                      <InfoDot title="Closures">
                        <p>
                          How many unavailability windows (plus a weekday blackout, if set) block
                          this ground. A fixture will never be placed on a closed date. Not related
                          to player clearances.
                        </p>
                      </InfoDot>
                    </span>
                  </th>
                  <th style={{ width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {venues.map((v) => {
                  const closures =
                    (v.unavailable?.length ?? 0) + (v.unavailableWeekdays?.length ? 1 : 0);
                  return (
                    <tr key={v.id}>
                      <td>
                        <div style={{ fontWeight: 700 }}>{v.name}</div>
                        {v.suburb && (
                          <div style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>{v.suburb}</div>
                        )}
                      </td>
                      <td>
                        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                          {v.homeClubIds?.length
                            ? v.homeClubIds.map(clubName).join(', ')
                            : 'Neutral'}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                          {v.surfaces ?? 1}
                        </span>
                      </td>
                      <td>
                        {Number.isFinite(v.lat) && Number.isFinite(v.lon) ? (
                          <Pill tone="teal">Yes</Pill>
                        ) : (
                          <Pill tone="muted">No</Pill>
                        )}
                      </td>
                      <td>
                        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                          {closures || '—'}
                        </span>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          <Btn tone="outline" size="sm" onClick={() => setForm(v)}>
                            Edit
                          </Btn>
                          <Btn tone="ghost" size="sm" onClick={() => setConfirm(v)}>
                            Delete
                          </Btn>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {derived.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Btn tone="outline" size="sm" onClick={runBackfill} disabled={importing}>
                {/* "Sync", not "Add" — the list also carries existing grounds that
                    gained a ground-sharing club. */}
                {importing ? 'Syncing…' : `Sync ${derived.length} from club records`}
              </Btn>
            </div>
          )}
        </>
      )}

      {form && (
        <Modal
          title={
            form !== 'new' ? (
              <>
                Edit <em>ground</em>
              </>
            ) : (
              <>
                Add a <em>ground</em>
              </>
            )
          }
          onClose={() => setForm(null)}
        >
          <VenueForm
            venue={form !== 'new' ? form : null}
            clubs={clubs}
            onSave={onSave}
            onClose={() => setForm(null)}
            toast={toast}
          />
        </Modal>
      )}

      {confirm &&
        createPortal(
          <div
            className="fix-confirm"
            onClick={(e) => e.target === e.currentTarget && setConfirm(null)}
          >
            <div className="fix-confirm-box">
              <div className="fix-confirm-icon danger">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 2L22 21H2L12 2z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 9v5M12 17v.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div className="fix-confirm-title">Delete “{confirm.name}”?</div>
              <div className="fix-confirm-body">
                Fixtures already allocated to it keep the ground name, so published schedules still
                read correctly — but it won&apos;t be offered again until you re-add it.
              </div>
              <div className="fix-confirm-actions">
                <Btn tone="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Btn>
                <Btn
                  tone="ink"
                  onClick={() => {
                    onDelete(confirm.id);
                    setConfirm(null);
                  }}
                >
                  Yes, delete
                </Btn>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </Card>
  );
}
