/**
 * "Competition defaults" — a tenant's own answers to the questions the platform used to
 * answer with sport- and union-specific constants (ADR 0014): match formats, match days,
 * double-header start times, travel cost and venue aliases.
 *
 * One card, two homes: the operator's client settings page (everything editable) and the
 * tenant admin's league catalogue page (venue aliases read-only — they steer the clash
 * gate, which is the operator's to tune). Saves follow the LeaguesCard idiom: refetch the
 * latest config, rebuild `competitionDefaults` with only the sections edited here, PUT the
 * whole object. A section someone else changed in another tab survives this save.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Btn, FieldGuide, Icon } from './atoms';
import { ApiError } from './api';
import { HelpLink } from './help/HelpDrawer';
import { WEEKDAY_LABELS } from '../packages/engine/src/calendar';
import {
  FALLBACK_MATCH_DAYS,
  FALLBACK_MATCH_FORMATS,
  FALLBACK_TIME_SLOTS,
  FALLBACK_TRAVEL,
} from '../packages/engine/src/defaults';
import { DEFAULT_VENUE_ALIASES } from '../packages/engine/src/venue-aliases';
import type { CompetitionDefaults, TenantConfig, Weekday } from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '6px 0 0' };
const ROW: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

interface FormatRow {
  label: string;
  overs: string;
  ballType: string;
}
interface SlotRow {
  label: string;
  start: string;
}
interface AliasRow {
  from: string;
  to: string;
}

/** Every section's editable state. Strings where the input is free text. */
interface Draft {
  matchFormats: FormatRow[];
  matchDays: Weekday[];
  timeSlots: SlotRow[];
  travel: { costPerKm: string; carsPerAwayTrip: string };
  venueAliases: AliasRow[];
}

type SectionKey = keyof Draft;
const SECTIONS: SectionKey[] = ['matchFormats', 'matchDays', 'timeSlots', 'travel', 'venueAliases'];

/** The draft a stored config opens with: its own values, else the built-in fallbacks. */
function draftFrom(d: CompetitionDefaults | undefined): Draft {
  return {
    matchFormats: (d?.matchFormats?.length ? d.matchFormats : FALLBACK_MATCH_FORMATS).map((f) => ({
      label: f.label,
      overs: f.overs === undefined ? '' : String(f.overs),
      ballType: f.ballType ?? '',
    })),
    matchDays: [...(d?.matchDays?.length ? d.matchDays : FALLBACK_MATCH_DAYS)],
    timeSlots: (d?.timeSlots?.length ? d.timeSlots : FALLBACK_TIME_SLOTS).map((s) => ({ ...s })),
    travel: {
      costPerKm: String((d?.travel ?? FALLBACK_TRAVEL).costPerKm),
      carsPerAwayTrip: String((d?.travel ?? FALLBACK_TRAVEL).carsPerAwayTrip),
    },
    venueAliases: Object.entries(d?.venueAliases ?? {}).map(([from, to]) => ({ from, to })),
  };
}

/**
 * One section as stored. An empty list stores as absent (`undefined`), which the resolver
 * reads as "use the built-in value" — so clearing a list resets it. Aliases are the
 * exception: an empty map is a deliberate "no aliases", not a reset.
 */
function sectionValue(
  draft: Draft,
  key: SectionKey,
): CompetitionDefaults[keyof CompetitionDefaults] {
  switch (key) {
    case 'matchFormats': {
      const rows = draft.matchFormats.filter((f) => f.label.trim());
      return rows.length
        ? rows.map((f) => ({
            label: f.label.trim(),
            ...(f.overs.trim() ? { overs: Number(f.overs) } : {}),
            ...(f.ballType.trim() ? { ballType: f.ballType.trim() } : {}),
          }))
        : undefined;
    }
    case 'matchDays':
      return draft.matchDays.length ? [...draft.matchDays].sort((a, b) => a - b) : undefined;
    case 'timeSlots': {
      const rows = draft.timeSlots.filter((s) => s.label.trim() || s.start.trim());
      return rows.length ? rows.map((s) => ({ label: s.label.trim(), start: s.start })) : undefined;
    }
    case 'travel':
      return {
        costPerKm: Number(draft.travel.costPerKm),
        carsPerAwayTrip: Number(draft.travel.carsPerAwayTrip),
      };
    case 'venueAliases':
      return Object.fromEntries(
        draft.venueAliases
          .filter((a) => a.from.trim() && a.to.trim())
          .map((a) => [a.from.trim(), a.to.trim()]),
      );
  }
}

/** What the server would refuse, caught here where the operator can see the row. */
function problemsOf(draft: Draft): string[] {
  const out: string[] = [];
  draft.matchFormats.forEach((f, i) => {
    if (!f.label.trim() && (f.overs.trim() || f.ballType.trim()))
      out.push(`Match format ${i + 1} needs a label.`);
    if (f.label.trim().length > 60)
      out.push(`Match format ${i + 1}: labels are 60 characters or fewer.`);
    if (f.overs.trim()) {
      const n = Number(f.overs);
      if (!Number.isInteger(n) || n < 1 || n > 200)
        out.push(`Match format ${i + 1}: overs must be a whole number from 1 to 200.`);
    }
    if (f.ballType.trim().length > 30)
      out.push(`Match format ${i + 1}: ball type is 30 characters or fewer.`);
  });
  draft.timeSlots.forEach((s, i) => {
    if (!s.label.trim() && !s.start.trim()) return;
    if (!s.label.trim()) out.push(`Start time ${i + 1} needs a label.`);
    if (!TIME_RE.test(s.start)) out.push(`Start time ${i + 1} needs a time like 08:00.`);
  });
  for (const [k, v] of Object.entries(draft.travel)) {
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n) || n < 0)
      out.push(
        k === 'costPerKm'
          ? 'Cost per km must be 0 or more.'
          : 'Cars per away trip must be 0 or more.',
      );
  }
  if (draft.venueAliases.some((a) => !a.from.trim() !== !a.to.trim()))
    out.push('Every venue alias needs both a ground name and the ground it means.');
  if (draft.venueAliases.length > 500) out.push('No more than 500 venue aliases.');
  return out;
}

function Section({
  title,
  guide,
  children,
}: {
  title: string;
  guide: Parameters<typeof FieldGuide>[0]['id'];
  children: ReactNode;
}) {
  return (
    <section style={{ padding: '14px 0', borderBottom: '1px solid var(--line2)' }}>
      <div className="field-label" style={{ marginBottom: 8 }}>
        {title}
      </div>
      {children}
      <FieldGuide id={guide} />
    </section>
  );
}

export function CompetitionDefaultsCard({
  config,
  fetchLatest,
  save,
  toast,
  aliasesReadOnly = false,
}: {
  config: TenantConfig;
  /** The tenant's config as the server has it now — rebuilt against, never this tab's copy. */
  fetchLatest: () => Promise<TenantConfig>;
  save: (patch: Partial<TenantConfig>) => Promise<unknown>;
  toast: Toast;
  /** The tenant admin's view: aliases steer the clash gate and are the operator's to edit. */
  aliasesReadOnly?: boolean;
}) {
  const [saved, setSaved] = useState<Draft>(() => draftFrom(config.competitionDefaults));
  const [draft, setDraft] = useState<Draft>(saved);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const dirtyKeys = SECTIONS.filter(
    (k) =>
      (!aliasesReadOnly || k !== 'venueAliases') &&
      JSON.stringify(sectionValue(draft, k)) !== JSON.stringify(sectionValue(saved, k)),
  );
  const problems = problemsOf(draft);
  const patch = <K extends SectionKey>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function saveIt() {
    if (!dirtyKeys.length || problems.length || busy) return;
    setErr('');
    setBusy(true);
    try {
      const fresh = await fetchLatest();
      const next: CompetitionDefaults = { ...(fresh.competitionDefaults ?? {}) };
      for (const k of dirtyKeys)
        (next as Record<string, unknown>)[k] = sectionValue(draft, k) as unknown;
      // An absent section is dropped by JSON, which is how a cleared list goes back to the
      // built-in value.
      await save({ competitionDefaults: next });
      setSaved(draft);
      toast('Competition defaults saved');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Could not save — try again';
      setErr(msg);
      toast(msg, 'warn');
    } finally {
      setBusy(false);
    }
  }

  function importCodeDefaults() {
    const have = new Set(draft.venueAliases.map((a) => a.from.trim()));
    const added = Object.entries(DEFAULT_VENUE_ALIASES)
      .filter(([from]) => !have.has(from))
      .map(([from, to]) => ({ from, to }));
    patch('venueAliases', [...draft.venueAliases, ...added]);
    toast(
      added.length
        ? `${added.length} alias${added.length === 1 ? '' : 'es'} added — save to keep them`
        : 'Every code default is already listed',
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Competition defaults</div>
          <div className="card-sub">
            The formats, days, start times, travel cost and ground spellings this union uses.
            Anything left empty uses the built-in value.
          </div>
        </div>
        <HelpLink topic="competition-defaults" />
      </div>
      <div className="card-body">
        <Section title="Match formats" guide="match-formats">
          {draft.matchFormats.map((f, i) => (
            <div key={i} style={ROW}>
              <input
                className="field-input"
                aria-label={`Format ${i + 1} label`}
                placeholder="50 Over (Red Ball)"
                value={f.label}
                maxLength={60}
                onChange={(e) =>
                  patch(
                    'matchFormats',
                    draft.matchFormats.map((x, j) =>
                      j === i ? { ...x, label: e.target.value } : x,
                    ),
                  )
                }
                style={{ flex: 2 }}
              />
              <input
                className="field-input"
                type="number"
                aria-label={`Format ${i + 1} overs`}
                placeholder="Overs"
                min={1}
                max={200}
                value={f.overs}
                onChange={(e) =>
                  patch(
                    'matchFormats',
                    draft.matchFormats.map((x, j) =>
                      j === i ? { ...x, overs: e.target.value } : x,
                    ),
                  )
                }
                style={{ width: 90 }}
              />
              <input
                className="field-input"
                aria-label={`Format ${i + 1} ball type`}
                placeholder="Ball type"
                maxLength={30}
                value={f.ballType}
                onChange={(e) =>
                  patch(
                    'matchFormats',
                    draft.matchFormats.map((x, j) =>
                      j === i ? { ...x, ballType: e.target.value } : x,
                    ),
                  )
                }
                style={{ flex: 1 }}
              />
              <Btn
                tone="ghost"
                size="sm"
                aria-label={`Remove format ${i + 1}`}
                onClick={() =>
                  patch(
                    'matchFormats',
                    draft.matchFormats.filter((_, j) => j !== i),
                  )
                }
              >
                Remove
              </Btn>
            </div>
          ))}
          <Btn
            tone="outline"
            size="sm"
            icon={Icon.Plus}
            onClick={() =>
              patch('matchFormats', [...draft.matchFormats, { label: '', overs: '', ballType: '' }])
            }
          >
            Add format
          </Btn>
        </Section>

        <Section title="Match days" guide="match-days">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {WEEKDAY_LABELS.map((label, day) => {
              const on = draft.matchDays.includes(day as Weekday);
              return (
                <button
                  key={label}
                  type="button"
                  aria-label={label}
                  aria-pressed={on}
                  onClick={() =>
                    patch(
                      'matchDays',
                      on
                        ? draft.matchDays.filter((d) => d !== day)
                        : [...draft.matchDays, day as Weekday].sort((a, b) => a - b),
                    )
                  }
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    fontSize: 11.5,
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: '1px solid var(--line)',
                    background: on ? 'var(--green-pale)' : 'var(--paper)',
                    color: on ? 'var(--green)' : 'var(--muted-2)',
                  }}
                >
                  {label.slice(0, 3)}
                </button>
              );
            })}
          </div>
        </Section>

        <Section title="Default start times" guide="default-time-slots">
          {draft.timeSlots.map((s, i) => (
            <div key={i} style={ROW}>
              <input
                className="field-input"
                aria-label={`Start time ${i + 1} label`}
                placeholder="Morning"
                value={s.label}
                onChange={(e) =>
                  patch(
                    'timeSlots',
                    draft.timeSlots.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                  )
                }
                style={{ flex: 1 }}
              />
              <input
                className="field-input"
                type="time"
                aria-label={`Start time ${i + 1}`}
                value={s.start}
                onChange={(e) =>
                  patch(
                    'timeSlots',
                    draft.timeSlots.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)),
                  )
                }
                style={{ width: 130 }}
              />
              <Btn
                tone="ghost"
                size="sm"
                aria-label={`Remove start time ${i + 1}`}
                onClick={() =>
                  patch(
                    'timeSlots',
                    draft.timeSlots.filter((_, j) => j !== i),
                  )
                }
              >
                Remove
              </Btn>
            </div>
          ))}
          <Btn
            tone="outline"
            size="sm"
            icon={Icon.Plus}
            onClick={() => patch('timeSlots', [...draft.timeSlots, { label: '', start: '' }])}
          >
            Add start time
          </Btn>
        </Section>

        <Section title="Travel cost" guide="travel-cost">
          <div style={ROW}>
            <span style={{ fontSize: 12.5 }}>R</span>
            <input
              className="field-input"
              type="number"
              aria-label="Cost per km"
              min={0}
              step={0.01}
              value={draft.travel.costPerKm}
              onChange={(e) => patch('travel', { ...draft.travel, costPerKm: e.target.value })}
              style={{ width: 100 }}
            />
            <span style={{ fontSize: 12.5 }}>per km ×</span>
            <input
              className="field-input"
              type="number"
              aria-label="Cars per away trip"
              min={0}
              step={1}
              value={draft.travel.carsPerAwayTrip}
              onChange={(e) =>
                patch('travel', { ...draft.travel, carsPerAwayTrip: e.target.value })
              }
              style={{ width: 80 }}
            />
            <span style={{ fontSize: 12.5 }}>cars per away trip</span>
          </div>
        </Section>

        <Section title="Venue aliases" guide="venue-aliases">
          {draft.venueAliases.length === 0 ? (
            <p style={{ ...HINT, marginBottom: 8 }}>No aliases yet.</p>
          ) : (
            <div className="tbl-w" style={{ maxHeight: 320, overflowY: 'auto', marginBottom: 8 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Ground name</th>
                    <th>Means</th>
                    {!aliasesReadOnly && <th style={{ width: 90 }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {draft.venueAliases.map((a, i) =>
                    aliasesReadOnly ? (
                      <tr key={i}>
                        <td>{a.from}</td>
                        <td>{a.to}</td>
                      </tr>
                    ) : (
                      <tr key={i}>
                        <td>
                          <input
                            className="field-input"
                            aria-label={`Alias ${i + 1} ground name`}
                            placeholder="Toti Oval"
                            value={a.from}
                            onChange={(e) =>
                              patch(
                                'venueAliases',
                                draft.venueAliases.map((x, j) =>
                                  j === i ? { ...x, from: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="field-input"
                            aria-label={`Alias ${i + 1} means`}
                            placeholder="Toti 1"
                            value={a.to}
                            onChange={(e) =>
                              patch(
                                'venueAliases',
                                draft.venueAliases.map((x, j) =>
                                  j === i ? { ...x, to: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        </td>
                        <td>
                          <Btn
                            tone="ghost"
                            size="sm"
                            aria-label={`Remove alias ${i + 1}`}
                            onClick={() =>
                              patch(
                                'venueAliases',
                                draft.venueAliases.filter((_, j) => j !== i),
                              )
                            }
                          >
                            Remove
                          </Btn>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
          {aliasesReadOnly ? (
            <p style={HINT}>Your platform operator manages venue aliases.</p>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn
                tone="outline"
                size="sm"
                icon={Icon.Plus}
                onClick={() => patch('venueAliases', [...draft.venueAliases, { from: '', to: '' }])}
              >
                Add alias
              </Btn>
              <Btn tone="ghost" size="sm" onClick={importCodeDefaults}>
                Import from code defaults
              </Btn>
            </div>
          )}
        </Section>

        {problems.map((p) => (
          <div key={p} style={ERR}>
            {p}
          </div>
        ))}
        {err && <div style={ERR}>{err}</div>}
        <div style={{ marginTop: 14 }}>
          <Btn
            tone="teal"
            size="sm"
            onClick={saveIt}
            disabled={!dirtyKeys.length || !!problems.length || busy}
          >
            {busy ? 'Saving…' : 'Save defaults'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
