/* ─── Captain's report on umpires ───
 *
 * The union's Captain's Report on Umpires: rate each on-field umpire on five criteria
 * (1–5), note areas of concern, comment, and sign the declaration. Reports open
 * automatically when medicoach reports a result (one per side, addressed to the match
 * captain or the club chair); the club fills them here or through the submit-once link
 * (`/r/<token>`, CaptainsReportLinkPage). A club can also file one by hand for a fixture
 * that has no report. The first submit wins.
 *
 * The umpire cards follow the appointment snapshotted when the report opened: one
 * appointed → one autofilled card; two → each card limited to the pair; none → two
 * registry pickers. Every card can switch to "A different umpire stood".
 *
 * Only an UNSENT draft lives in localStorage; submitted reports live on the server.
 */

import { useState, useMemo, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon, Btn, Pill } from './atoms';
import { ownRoster } from './captainsReportRoster';
import { teamIdsForClub, resolveTeam } from './data';
import {
  ApiError,
  createClubCaptainsReport,
  getClubCaptainsReports,
  getLinkedCaptainsReport,
  putClubCaptainsReport,
  putLinkedCaptainsReport,
} from './api';
import { applyTheme } from './config';
import { qk } from './query';
import {
  CONCERN_AREAS,
  RATING_CRITERIA,
  RATING_GUIDE,
  appointedChoices,
  avgRating,
  emptyUmpireEntry,
  initialUmpireCards,
  pickAppointed,
  pickSubstitute,
  reportDeadline,
  submissionProblems,
  umpireCardMode,
  umpireEntryComplete,
  type AppointedUmpire,
  type ReportUmpireEntry,
} from '../packages/engine/src/captainsReport';
import type { CaptainsReport, CaptainsReportFields } from './types';

const SUBSTITUTE = '__substitute';

export const fmtDate = (iso?: string | null) =>
  iso
    ? new Date(iso.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';

export const fmtDeadline = (iso?: string | null) =>
  iso ? `18h00, ${fmtDate(iso.slice(0, 10))}` : '';

// Local YYYY-MM-DD (toISOString would shift SAST dates back a day via UTC).
const localISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** "Home v Away" for a report, from the club's side. */
export const matchLine = (r: Pick<CaptainsReport, 'side' | 'clubName' | 'opponentName'>) =>
  r.side === 'home' ? `${r.clubName} v ${r.opponentName}` : `${r.opponentName} v ${r.clubName}`;

// ── Unsent-draft memory (browser-local, best effort) ──
const draftKey = (id: string) => `captains-report-draft:${id}`;
function recallDraft(id: string): CaptainsReportFields | null {
  try {
    const raw = localStorage.getItem(draftKey(id));
    return raw ? (JSON.parse(raw) as CaptainsReportFields) : null;
  } catch {
    return null;
  }
}
function rememberDraft(id: string, fields: CaptainsReportFields | null) {
  try {
    if (fields) localStorage.setItem(draftKey(id), JSON.stringify(fields));
    else localStorage.removeItem(draftKey(id));
  } catch {
    /* storage unavailable — the draft just won't survive a reload */
  }
}

/**
 * Text field with suggestions: always freely editable, and focusing it (or the
 * chevron) lists matching names to tap.
 */
interface Suggestion {
  name: string;
  sub?: string;
}
interface AutoFieldProps {
  value: string;
  onChange: (value: string) => void;
  options?: Suggestion[];
  placeholder?: string;
  groupLabel?: string;
  ariaLabel?: string;
}
function AutoField({
  value,
  onChange,
  options = [],
  placeholder,
  groupLabel,
  ariaLabel,
}: AutoFieldProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const q = value.trim().toLowerCase();
  // An exact match means the field is "filled" — show the full list so it can be swapped.
  const exact = options.some((o) => o.name.toLowerCase() === q);
  const list = (
    q && !exact ? options.filter((o) => o.name.toLowerCase().includes(q)) : options
  ).slice(0, 50);
  const show = open && list.length > 0;

  function pick(o: Suggestion) {
    onChange(o.name);
    setOpen(false);
    setActive(-1);
  }
  function onKeyDown(e: React.KeyboardEvent) {
    if (!show) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(list.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(list[active]);
    } else if (e.key === 'Escape') setOpen(false);
  }

  return (
    <div className={`cr-ac ${options.length ? 'has-list' : ''}`}>
      <input
        className="field-input"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        role="combobox"
        aria-expanded={show}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(document.activeElement === e.target);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {options.length > 0 && (
        <button
          type="button"
          className="cr-ac-toggle"
          tabIndex={-1}
          aria-label="Show suggestions"
          // mousedown + preventDefault keeps focus in the input (fires on tap too).
          onMouseDown={(e) => {
            e.preventDefault();
            (e.currentTarget.previousSibling as HTMLInputElement | null)?.focus();
            setOpen((o) => !o);
          }}
        >
          <svg viewBox="0 0 10 6" fill="none">
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {show && (
        <ul className="cr-ac-list" role="listbox">
          {groupLabel && <li className="cr-ac-group">{groupLabel}</li>}
          {list.map((o, i) => (
            <li
              key={o.name}
              role="option"
              aria-selected={o.name === value}
              className={`${i === active ? 'active' : ''} ${o.name === value ? 'current' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
            >
              <span>{o.name}</span>
              {o.sub && <span className="cr-ac-sub">{o.sub}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface SectionHeadProps {
  n: number | string;
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}
function SectionHead({ n, title, sub, right }: SectionHeadProps) {
  return (
    <div className="cr-section-head">
      <div>
        <div className="rp-section-eyebrow">Part {n}</div>
        <div className="rp-section-title">{title}</div>
        {sub && <div className="cr-section-sub">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

function RatingRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <div className="cr-rate-row">
      <div className="cr-rate-label">{label}</div>
      <div className="cr-rate" role="radiogroup" aria-label={label}>
        {[5, 4, 3, 2, 1].map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={value === s}
            className={`cr-rate-btn ${value === s ? (s <= 2 ? 'on low' : 'on') : ''}`}
            title={RATING_GUIDE.find((g) => g.score === s)?.text}
            onClick={() => onChange(value === s ? undefined : s)}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface RegistryUmpire {
  id: string;
  displayName: string;
}

interface UmpireCardProps {
  n: number;
  umpire: ReportUmpireEntry;
  appointed: AppointedUmpire[];
  /** The appointed umpires this card may pick (the other card's pick removed). */
  choices: AppointedUmpire[];
  registry: RegistryUmpire[];
  /** Registry ids other cards already hold. */
  takenIds: string[];
  onChange: (update: (u: ReportUmpireEntry) => ReportUmpireEntry) => void;
}

/**
 * One umpire's ratings. With an appointment the umpire is a dropdown over the appointed
 * umpire(s) plus "A different umpire stood" (→ registry pick or free text, substitute);
 * without one it is a registry picker that also takes free text.
 */
export function UmpireCard({
  n,
  umpire,
  appointed,
  choices,
  registry,
  takenIds,
  onChange,
}: UmpireCardProps) {
  const set = (
    patch: Partial<ReportUmpireEntry> | ((u: ReportUmpireEntry) => Partial<ReportUmpireEntry>),
  ) => onChange((u) => ({ ...u, ...(typeof patch === 'function' ? patch(u) : patch) }));
  const avg = avgRating(umpire);
  const hasAppointment = appointed.length > 0;
  const registryOptions = registry
    .filter((r) => !takenIds.includes(r.id) && !appointed.some((a) => a.umpireId === r.id))
    .map((r) => ({ name: r.displayName, sub: 'Umpire panel' }));
  // A typed name that exactly matches a registry entry links to it; anything else is free text.
  const typeName = (name: string, substitute: boolean) => {
    const hit = registry.find((r) => r.displayName.toLowerCase() === name.trim().toLowerCase());
    onChange((u) =>
      substitute
        ? pickSubstitute(u, { ...(hit ? { umpireId: hit.id } : {}), name })
        : {
            ...u,
            name,
            ...(hit ? { umpireId: hit.id } : { umpireId: undefined }),
          },
    );
  };
  const selectValue = umpire.substitute ? SUBSTITUTE : (umpire.umpireId ?? '');

  return (
    <div className="rp-section" data-testid={`umpire-card-${n}`}>
      <SectionHead
        n={n === 1 ? '2A' : '2B'}
        title={`On-field umpire ${n}`}
        right={
          avg != null && (
            <div className="cr-avg">
              <span className="cr-avg-n">{avg.toFixed(1)}</span>
              <span className="cr-avg-l">avg / 5</span>
            </div>
          )
        }
      />
      <div style={{ maxWidth: 420 }}>
        <label className="field-label">
          Umpire <span className="req">*</span>
        </label>
        {hasAppointment ? (
          <>
            <select
              className="field-select"
              aria-label={`Umpire ${n}`}
              value={selectValue}
              onChange={(e) => {
                const v = e.target.value;
                if (v === SUBSTITUTE) onChange((u) => pickSubstitute(u, { name: '' }));
                else {
                  const a = appointed.find((x) => x.umpireId === v);
                  if (a) onChange((u) => pickAppointed(u, a));
                }
              }}
            >
              {!umpire.umpireId && !umpire.substitute && (
                <option value="">Choose the umpire</option>
              )}
              {choices.map((a) => (
                <option key={a.umpireId} value={a.umpireId}>
                  {a.name} (appointed)
                </option>
              ))}
              <option value={SUBSTITUTE}>A different umpire stood</option>
            </select>
            {umpire.substitute && (
              <div style={{ marginTop: 8 }}>
                <AutoField
                  ariaLabel={`Umpire ${n} who stood`}
                  options={registryOptions}
                  value={umpire.name}
                  onChange={(name) => typeName(name, true)}
                  placeholder="Who stood? Pick from the panel or type a name"
                  groupLabel="Umpire panel"
                />
              </div>
            )}
          </>
        ) : (
          <AutoField
            ariaLabel={`Umpire ${n}`}
            options={registryOptions}
            value={umpire.name}
            onChange={(name) => typeName(name, false)}
            placeholder="Start typing a name"
            groupLabel="Umpire panel"
          />
        )}
      </div>

      <div className="cr-rate-table">
        <div className="cr-rate-row cr-rate-headrow">
          <div className="cr-rate-label">Performance area</div>
          <div className="cr-rate cr-rate-scale">
            {[5, 4, 3, 2, 1].map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
        </div>
        {RATING_CRITERIA.map((c) => (
          <RatingRow
            key={c.key}
            label={c.label}
            value={umpire.ratings[c.key]}
            onChange={(v) => set((u) => ({ ratings: { ...u.ratings, [c.key]: v } }))}
          />
        ))}
      </div>

      <label className="field-label" style={{ marginTop: 18 }}>
        Areas of concern in this match
      </label>
      <div className="cr-chips">
        {CONCERN_AREAS.map((a) => {
          const on = !!umpire.concerns[a.key];
          return (
            <button
              key={a.key}
              type="button"
              className={`cr-chip ${on ? 'on' : ''}`}
              aria-pressed={on}
              onClick={() => set((u) => ({ concerns: { ...u.concerns, [a.key]: !on } }))}
            >
              {on && <Icon.Check />}
              {a.label}
            </button>
          );
        })}
      </div>
      {umpire.concerns.other && (
        <input
          className="field-input"
          style={{ marginTop: 10 }}
          value={umpire.otherConcern}
          onChange={(e) => set({ otherConcern: e.target.value })}
          placeholder="Describe the other area of concern"
        />
      )}

      <label className="field-label" style={{ marginTop: 18 }}>
        Comments
      </label>
      <textarea
        className="field-textarea"
        value={umpire.comments}
        onChange={(e) => set({ comments: e.target.value })}
        placeholder="Specific incidents or decisions that informed your ratings"
      />
    </div>
  );
}

/** The report's header facts (read-only: they come from the fixture and the result). */
function MatchFacts({ report }: { report: ReportShell }) {
  return (
    <div className="rp-section">
      <SectionHead n={1} title="Match details" sub="From the fixture list and the scorecard." />
      <div className="cr-fixture-line" style={{ marginTop: 0 }}>
        <strong>{matchLine(report)}</strong>
      </div>
      <dl className="cr-facts">
        <div>
          <dt>Date</dt>
          <dd>{fmtDate(report.matchDate)}</dd>
        </div>
        <div>
          <dt>Competition</dt>
          <dd>{report.competition || '—'}</dd>
        </div>
        {report.venue && (
          <div>
            <dt>Venue</dt>
            <dd>{report.venue}</dd>
          </div>
        )}
        {report.resultSummary && (
          <div>
            <dt>Result</dt>
            <dd>{report.resultSummary}</dd>
          </div>
        )}
        <div>
          <dt>Due</dt>
          <dd>
            {fmtDeadline(report.deadline)} {report.late && <Pill tone="coral">Late</Pill>}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** What the form needs of a report — a stored one, or a new manual one being drafted. */
export type ReportShell = Pick<
  CaptainsReport,
  | 'id'
  | 'matchDate'
  | 'deadline'
  | 'side'
  | 'clubName'
  | 'opponentName'
  | 'competition'
  | 'venue'
  | 'resultSummary'
  | 'umpiresSnapshot'
  | 'captainName'
  | 'umpires'
  | 'general'
  | 'declaration'
  | 'late'
>;

interface CaptainsReportFormProps {
  report: ReportShell;
  registry: RegistryUmpire[];
  captainOptions?: Suggestion[];
  captainGroupLabel?: string;
  onSaveDraft?: (fields: CaptainsReportFields) => Promise<unknown>;
  onSubmit: (fields: CaptainsReportFields) => Promise<unknown>;
  busy?: boolean;
}

/** The fillable report — shared by the club portal and the public link page. */
export function CaptainsReportForm({
  report,
  registry,
  captainOptions = [],
  captainGroupLabel,
  onSaveDraft,
  onSubmit,
  busy,
}: CaptainsReportFormProps) {
  const appointed = report.umpiresSnapshot ?? [];
  const mode = umpireCardMode(appointed);
  const [initial] = useState<CaptainsReportFields>(() => {
    const local = recallDraft(report.id);
    if (local) return local;
    return {
      captainName: report.captainName ?? '',
      umpires: report.umpires?.length ? report.umpires : initialUmpireCards(appointed),
      general: report.general ?? '',
      declaration: !!report.declaration,
    };
  });
  const [captainName, setCaptainName] = useState(initial.captainName);
  const [umpires, setUmpires] = useState<ReportUmpireEntry[]>(initial.umpires);
  const [general, setGeneral] = useState(initial.general);
  const [declaration, setDeclaration] = useState(initial.declaration);
  // Guide starts collapsed on phones, where five stacked descriptions push the form down.
  const [guideOpen] = useState(() => !window.matchMedia?.('(max-width: 640px)').matches);

  const fields: CaptainsReportFields = { captainName, umpires, general, declaration };
  // Keep an unsent draft in this browser only.
  useEffect(() => {
    rememberDraft(report.id, { captainName, umpires, general, declaration });
  }, [report.id, captainName, umpires, general, declaration]);

  const problems = submissionProblems(fields);
  const ready = problems.length === 0;
  const steps = [
    { label: "Captain's name", done: !!captainName.trim() },
    ...umpires.map((u, i) => ({ label: `Umpire ${i + 1} rated`, done: umpireEntryComplete(u) })),
    { label: 'Declaration', done: declaration },
  ];
  const outstanding = steps.filter((s) => !s.done).length;
  const progressLabel = `${steps.length - outstanding} of ${steps.length} complete`;

  async function submit() {
    if (!ready) return;
    await onSubmit(fields);
    rememberDraft(report.id, null);
  }

  return (
    <div className="cr-layout">
      <div className="rp-form">
        <MatchFacts report={report} />

        <details className="cr-guide" open={guideOpen}>
          <summary className="cr-guide-title">Rating guide</summary>
          <div className="cr-guide-grid">
            {RATING_GUIDE.map((g) => (
              <div key={g.score} className="cr-guide-item">
                <span className={`cr-guide-n ${g.score <= 2 ? 'low' : ''}`}>{g.score}</span>
                <span>{g.text}</span>
              </div>
            ))}
          </div>
        </details>

        {umpires.map((u, i) => (
          <UmpireCard
            key={i}
            n={i + 1}
            umpire={u}
            appointed={appointed}
            choices={appointedChoices(appointed, umpires, i)}
            registry={registry}
            takenIds={umpires
              .filter((_, j) => j !== i)
              .map((x) => x.umpireId)
              .filter((x): x is string => !!x)}
            onChange={(fn) => setUmpires((all) => all.map((x, j) => (j === i ? fn(x) : x)))}
          />
        ))}
        {mode === 'single' && umpires.length === 1 && (
          <div style={{ marginBottom: 16 }}>
            <Btn
              tone="outline"
              size="sm"
              icon={Icon.Plus}
              onClick={() => setUmpires((all) => [...all, emptyUmpireEntry({ substitute: true })])}
            >
              Rate a second umpire
            </Btn>
          </div>
        )}

        <div className="rp-section">
          <SectionHead
            n={3}
            title="General comments"
            sub="Any additional comments on the performance of the umpires in this match."
          />
          <textarea
            className="field-textarea"
            style={{ minHeight: 110 }}
            value={general}
            onChange={(e) => setGeneral(e.target.value)}
            placeholder="Optional"
          />
        </div>

        <div className="rp-section rp-consent">
          <div style={{ maxWidth: 420, marginBottom: 14 }}>
            <label className="field-label">
              Captain's name <span className="req">*</span>
            </label>
            <AutoField
              ariaLabel="Captain's name"
              options={captainOptions}
              value={captainName}
              onChange={setCaptainName}
              placeholder="Full name"
              groupLabel={captainGroupLabel}
            />
          </div>
          <label className="rp-check">
            <input
              type="checkbox"
              checked={declaration}
              onChange={(e) => setDeclaration(e.target.checked)}
            />
            <span>
              I, <strong>{captainName || 'the captain'}</strong>, confirm this report is a true and
              fair account of the match and will be submitted to the union office.
            </span>
          </label>
        </div>

        <div className="cr-footer">
          <span className="cr-footer-progress">{ready ? 'Ready to submit' : progressLabel}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {onSaveDraft && (
              <Btn tone="outline" onClick={() => onSaveDraft(fields)} disabled={busy}>
                Save draft
              </Btn>
            )}
            <Btn tone="teal" onClick={submit} disabled={!ready || busy}>
              Submit report
            </Btn>
          </div>
        </div>
      </div>

      <aside className="cr-aside">
        <div className="cr-aside-card">
          <div className="cr-aside-title">Report status</div>
          <div className="cr-aside-match">
            {matchLine(report)}
            <span>{fmtDate(report.matchDate)}</span>
          </div>
          <ul className="cr-steps">
            {steps.map((s) => (
              <li key={s.label} className={s.done ? 'done' : ''}>
                <span className="cr-step-dot">{s.done && <Icon.Check />}</span>
                {s.label}
              </li>
            ))}
          </ul>
          <Btn
            tone="teal"
            onClick={submit}
            disabled={!ready || busy}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            Submit report
          </Btn>
          {!ready && (
            <div className="rp-validation" style={{ textAlign: 'center' }}>
              {problems[0]}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/** A filed report, read-only and printable (portal, link confirmation, admin). */
export function CaptainsReportReadOnly({ report }: { report: CaptainsReport }) {
  return (
    <div className="cr-print">
      <div className="cr-print-head">
        <div>
          <div className="rp-section-eyebrow">Captain's report on umpires</div>
          <div className="rp-section-title">{matchLine(report)}</div>
          <div className="cr-section-sub">
            {fmtDate(report.matchDate)} · {report.competition}
            {report.venue ? ` · ${report.venue}` : ''}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {report.ref && <div className="cr-print-ref">{report.ref}</div>}
          <CaptainsReportStatusPill report={report} />
        </div>
      </div>
      {report.resultSummary && <p className="cr-section-sub">Result: {report.resultSummary}</p>}
      {report.umpires.map((u, i) => {
        const avg = avgRating(u);
        const concerns = CONCERN_AREAS.filter((a) => u.concerns?.[a.key]).map((a) =>
          a.key === 'other' && u.otherConcern ? `Other: ${u.otherConcern}` : a.label,
        );
        return (
          <div key={i} className="cr-print-umpire">
            <div className="cr-print-umpire-head">
              <strong>
                Umpire {i + 1}: {u.name || '—'}
              </strong>
              {u.substitute && <Pill tone="navy">Stood in</Pill>}
              {avg != null && <span className="cr-print-avg">{avg.toFixed(1)} / 5</span>}
            </div>
            <table className="cr-print-table">
              <tbody>
                {RATING_CRITERIA.map((c) => {
                  const v = u.ratings?.[c.key];
                  return (
                    <tr key={c.key}>
                      <td>{c.label}</td>
                      <td className={typeof v === 'number' && v <= 2 ? 'low' : ''}>{v ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {concerns.length > 0 && (
              <div className="cr-section-sub">Areas of concern: {concerns.join(', ')}</div>
            )}
            {u.comments && <p className="cr-print-text">{u.comments}</p>}
          </div>
        );
      })}
      {report.general && (
        <div className="cr-print-umpire">
          <strong>General comments</strong>
          <p className="cr-print-text">{report.general}</p>
        </div>
      )}
      <div className="cr-section-sub" style={{ marginTop: 12 }}>
        Captain: <strong>{report.captainName || '—'}</strong>
        {report.submittedAt &&
          ` · submitted ${new Date(report.submittedAt).toLocaleString('en-GB', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}${report.submittedVia === 'link' ? ' via link' : ''}`}
      </div>
    </div>
  );
}

export function CaptainsReportStatusPill({ report }: { report: CaptainsReport }) {
  if (report.status === 'void') return <Pill tone="muted">Void</Pill>;
  if (report.status === 'submitted')
    return (
      <>
        <Pill tone="teal" dot>
          Submitted
        </Pill>{' '}
        {report.late && <Pill tone="coral">Late</Pill>}{' '}
        {report.flagged && <Pill tone="coral">Result cleared</Pill>}
      </>
    );
  return report.late ? <Pill tone="coral">Late</Pill> : <Pill tone="gold">Pending</Pill>;
}

function SubmittedCard({ report, onBack }: { report: CaptainsReport; onBack?: () => void }) {
  return (
    <div className="cr-done">
      <div className="cr-done-icon">
        <Icon.Check />
      </div>
      <div className="cr-done-title">Report submitted</div>
      <div className="cr-done-sub">
        Reference <strong>{report.ref}</strong>
      </div>
      <div className="cr-summary">
        <div className="cr-summary-row">
          <span>Match</span>
          <strong>{matchLine(report)}</strong>
        </div>
        <div className="cr-summary-row">
          <span>Date</span>
          <strong>{fmtDate(report.matchDate)}</strong>
        </div>
        {report.umpires.map((u, i) => (
          <div key={i} className="cr-summary-row">
            <span>Umpire {i + 1}</span>
            <strong>
              {u.name} · {avgRating(u)?.toFixed(1) ?? '—'} / 5
            </strong>
          </div>
        ))}
      </div>
      <div className="cr-done-actions">
        <Btn tone="outline" size="sm" icon={Icon.Download} onClick={() => window.print()}>
          Print copy
        </Btn>
        {onBack && (
          <Btn tone="ink" size="sm" onClick={onBack}>
            Back to reports
          </Btn>
        )}
      </div>
    </div>
  );
}

const errText = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong — try again.';

/* ─── Club portal ─── */

interface CaptainsReportViewProps {
  club: { id: string; name: string; ground?: { venue?: string } };
  allSeries?: Array<Record<string, unknown>>;
  clubs?: Array<{ id: string; name: string }>;
  players?: Array<{ firstName?: string; lastName?: string }>;
  directory?: Array<{ id: string; name: string }>;
  umpires?: RegistryUmpire[];
  toast?: (msg: string, tone?: string) => void;
}

export function CaptainsReportView({
  club,
  allSeries = [],
  clubs = [],
  players = [],
  directory = [],
  umpires: registry = [],
  toast,
}: CaptainsReportViewProps) {
  const qc = useQueryClient();
  const reportsQuery = useQuery({
    queryKey: qk.clubCaptainsReports(club.id),
    queryFn: () => getClubCaptainsReports(club.id),
  });
  const reports = useMemo(() => reportsQuery.data ?? [], [reportsQuery.data]);
  const [selected, setSelected] = useState<string | null>(null);
  const [newFixture, setNewFixture] = useState<string>('');
  const [done, setDone] = useState<CaptainsReport | null>(null);
  const roster = useMemo(() => ownRoster(club, players), [club, players]);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.clubCaptainsReports(club.id) });

  // This club's played fixtures (released series) with no report yet — the manual path.
  const manualFixtures = useMemo(() => {
    const clubBy = (id: string) =>
      clubs.find((c) => c.id === id) || directory.find((c) => c.id === id);
    const today = localISO(new Date());
    const out: Array<ReportShell & { seriesId: string; fixtureId: string }> = [];
    for (const s of allSeries as Array<Record<string, any>>) {
      if (!s.released || !Array.isArray(s.fixtures)) continue;
      const mine = teamIdsForClub(s, club.id);
      s.fixtures.forEach((f: Record<string, any>) => {
        if (!f?.id || !f.date || f.date > today || f.dateTbc) return;
        const isHome = mine.includes(f.home);
        if (!isHome && !mine.includes(f.away)) return;
        if (reports.some((r) => r.seriesId === s.id && r.fixtureId === f.id)) return;
        const opp = resolveTeam(s, isHome ? f.away : f.home, clubBy);
        if (opp.pending) return; // knockout slot — no opponent yet
        const own = resolveTeam(s, isHome ? f.home : f.away, clubBy);
        out.push({
          id: `new:${s.id}:${f.id}`,
          seriesId: s.id,
          fixtureId: f.id,
          matchDate: f.date,
          deadline: reportDeadline(f.date) ?? '',
          side: isHome ? 'home' : 'away',
          clubName: own.name || club.name,
          opponentName: opp.name || 'TBC',
          competition: s.name ?? '',
          venue: f.venueOverride || f.venueName || (isHome ? own.ground?.venue : opp.ground?.venue),
          resultSummary: f.result?.summary ?? null,
          umpiresSnapshot: (f.officials?.umpires ?? []).map((u: AppointedUmpire) => ({
            umpireId: u.umpireId,
            name: u.name,
          })),
          captainName: '',
          umpires: [],
          general: '',
          declaration: false,
          late: false,
        });
      });
    }
    return out.sort((a, b) => b.matchDate.localeCompare(a.matchDate));
  }, [allSeries, club, clubs, directory, reports]);

  const save = useMutation({
    mutationFn: ({
      id,
      fields,
      submit,
    }: {
      id: string;
      fields: CaptainsReportFields;
      submit: boolean;
    }) => putClubCaptainsReport(id, { ...fields, submit }),
    onSuccess: (r, v) => {
      refresh();
      if (v.submit) {
        setDone(r);
        toast?.(`Report ${r.ref} submitted to the union office`);
      } else toast?.('Draft saved');
    },
    onError: (err) => {
      refresh();
      toast?.(errText(err), 'warn');
    },
  });
  const create = useMutation({
    mutationFn: (args: { seriesId: string; fixtureId: string; fields: CaptainsReportFields }) =>
      createClubCaptainsReport({
        ...args.fields,
        seriesId: args.seriesId,
        fixtureId: args.fixtureId,
        clubId: club.id,
      }),
    onSuccess: (r) => {
      refresh();
      setDone(r);
      toast?.(`Report ${r.ref} submitted to the union office`);
    },
    onError: (err) => {
      refresh();
      if (err instanceof ApiError && err.code === 'report_exists' && err.details?.id) {
        setNewFixture('');
        setSelected(String(err.details.id));
      }
      toast?.(errText(err), 'warn');
    },
  });

  const header = (
    <div className="page-head">
      <div className="ph-left">
        <div className="ph-crumb">Club Portal · {club.name} / Captain's Report</div>
        <h1 className="ph-title">
          Captain's <em>Report</em>
        </h1>
        <p className="ph-desc">
          Rate the on-field umpires after each match. Reports open here when the result is in; the
          captain also gets a link to fill it in. Due by 18h00 on the third business day after the
          match.
        </p>
      </div>
    </div>
  );

  const back = () => {
    setSelected(null);
    setNewFixture('');
    setDone(null);
  };

  if (done)
    return (
      <div>
        {header}
        <SubmittedCard report={done} onBack={back} />
      </div>
    );

  const current = selected ? reports.find((r) => r.id === selected) : null;
  if (current) {
    return (
      <div>
        {header}
        <div style={{ marginBottom: 12 }}>
          <Btn tone="ghost" size="sm" onClick={back}>
            ← All reports
          </Btn>
        </div>
        {current.status === 'pending' ? (
          <CaptainsReportForm
            key={current.id}
            report={current}
            registry={registry}
            captainOptions={roster.players}
            captainGroupLabel={club.name}
            busy={save.isPending}
            onSaveDraft={(fields) => save.mutateAsync({ id: current.id, fields, submit: false })}
            onSubmit={(fields) => save.mutateAsync({ id: current.id, fields, submit: true })}
          />
        ) : (
          <>
            <CaptainsReportReadOnly report={current} />
            <div style={{ marginTop: 12 }}>
              <Btn tone="outline" size="sm" icon={Icon.Download} onClick={() => window.print()}>
                Print copy
              </Btn>
            </div>
          </>
        )}
      </div>
    );
  }

  const manual = newFixture ? manualFixtures.find((f) => f.id === newFixture) : null;
  if (manual) {
    return (
      <div>
        {header}
        <div style={{ marginBottom: 12 }}>
          <Btn tone="ghost" size="sm" onClick={back}>
            ← All reports
          </Btn>
        </div>
        <CaptainsReportForm
          key={manual.id}
          report={manual}
          registry={registry}
          captainOptions={roster.players}
          captainGroupLabel={club.name}
          busy={create.isPending}
          onSubmit={(fields) =>
            create.mutateAsync({ seriesId: manual.seriesId, fixtureId: manual.fixtureId, fields })
          }
        />
      </div>
    );
  }

  const pending = reports.filter((r) => r.status === 'pending');
  const filed = reports.filter((r) => r.status !== 'pending');
  return (
    <div>
      {header}
      <div className="rp-section">
        <SectionHead n="A" title="Awaiting your report" />
        {reportsQuery.isLoading ? (
          <div className="cr-section-sub">Loading…</div>
        ) : pending.length ? (
          <ul className="cr-report-list">
            {pending.map((r) => (
              <li key={r.id}>
                <button type="button" className="cr-report-row" onClick={() => setSelected(r.id)}>
                  <span>
                    <strong>{matchLine(r)}</strong>
                    <span className="cr-section-sub">
                      {fmtDate(r.matchDate)} · {r.competition} · due {fmtDeadline(r.deadline)}
                    </span>
                  </span>
                  <CaptainsReportStatusPill report={r} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="cr-section-sub">
            Nothing waiting. A report opens here when a result comes in.
          </div>
        )}
      </div>

      <div className="rp-section">
        <SectionHead
          n="B"
          title="File a report by hand"
          sub="For a played fixture that has no report yet."
        />
        {manualFixtures.length ? (
          <select
            className="field-select"
            aria-label="Fixture"
            value=""
            onChange={(e) => setNewFixture(e.target.value)}
          >
            <option value="">Choose a fixture</option>
            {manualFixtures.map((f) => (
              <option key={f.id} value={f.id}>
                {fmtDate(f.matchDate)} · {matchLine(f)} · {f.competition}
              </option>
            ))}
          </select>
        ) : (
          <div className="cr-section-sub">Every played fixture already has a report.</div>
        )}
      </div>

      {filed.length > 0 && (
        <div className="rp-section">
          <SectionHead n="C" title="Filed reports" />
          <ul className="cr-report-list">
            {filed.map((r) => (
              <li key={r.id}>
                <button type="button" className="cr-report-row" onClick={() => setSelected(r.id)}>
                  <span>
                    <strong>{matchLine(r)}</strong>
                    <span className="cr-section-sub">
                      {fmtDate(r.matchDate)} · {r.ref ?? (r.status === 'void' ? 'withdrawn' : '')}
                    </span>
                  </span>
                  <CaptainsReportStatusPill report={r} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ─── Public submit-once link page: /r/:token ─── */

export function CaptainsReportLinkPage() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const [done, setDone] = useState<CaptainsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: qk.linkedCaptainsReport(token),
    queryFn: () => getLinkedCaptainsReport(token),
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    staleTime: Infinity,
  });
  const data = query.data;
  useEffect(() => {
    if (!data) return;
    applyTheme({
      colors: data.tenantBranding.colors,
      logoUrl: data.tenantBranding.logoUrl,
      title: `${data.tenantBranding.name} · Captain's report`,
    });
  }, [data]);
  const put = useMutation({
    mutationFn: ({ fields, submit }: { fields: CaptainsReportFields; submit: boolean }) =>
      putLinkedCaptainsReport(token, { ...fields, submit }),
    onSuccess: (res, v) => {
      setError(null);
      if (v.submit) setDone(res.report);
      else qc.setQueryData(qk.linkedCaptainsReport(token), res);
    },
    onError: (err) => setError(errText(err)),
  });

  const status = query.error instanceof ApiError ? query.error.status : null;
  let body: ReactNode;
  if (done) body = <SubmittedCard report={done} />;
  else if (query.isLoading) body = <div className="cr-section-sub">Loading the report…</div>;
  else if (status === 410)
    body = (
      <div className="cr-done">
        <div className="cr-done-title">This report is closed</div>
        <div className="cr-done-sub">{query.error instanceof ApiError && query.error.message}.</div>
      </div>
    );
  else if (!data)
    body = (
      <div className="cr-done">
        <div className="cr-done-title">This link isn't valid</div>
        <div className="cr-done-sub">Check you opened the full link from the message.</div>
      </div>
    );
  else
    body = (
      <>
        <div className="page-head">
          <div className="ph-left">
            <div className="ph-crumb">{data.report.clubName} / Captain's Report</div>
            <h1 className="ph-title">
              Captain's <em>Report</em>
            </h1>
            <p className="ph-desc">
              Rate the on-field umpires for this match. You can save a draft and come back; the link
              closes once the report is submitted.
            </p>
          </div>
        </div>
        {error && (
          <div className="rp-validation" role="alert" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        <CaptainsReportForm
          report={data.report}
          registry={data.registry}
          busy={put.isPending}
          onSaveDraft={(fields) => put.mutateAsync({ fields, submit: false })}
          onSubmit={(fields) => put.mutateAsync({ fields, submit: true })}
        />
      </>
    );

  return (
    <div className="cr-link-shell">
      <header className="cr-link-header">
        {data?.tenantBranding.logoUrl && <img src={data.tenantBranding.logoUrl} alt="" />}
        <strong>{data?.tenantBranding.name ?? "Captain's report"}</strong>
      </header>
      <main className="cr-link-main">{body}</main>
    </div>
  );
}
