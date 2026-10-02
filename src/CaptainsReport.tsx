/* ─── Captain's post-match report (UI only — no API wiring yet) ─── */

import { useState, useMemo, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Icon, Btn, Choice } from './atoms';
import { ownRoster } from './captainsReportRoster';
import { clubFixtures, localISO } from './season';

// Part One guidance from the union's Captain's Report on Umpires form.
const RATING_GUIDE = [
  { score: 5, text: 'Accurate decisions, excellent performance, management & communication' },
  {
    score: 4,
    text: 'Some error(s) in decisions but good recovery; good management & communication',
  },
  {
    score: 3,
    text: 'Evident errors in decisions; average performance, management & communication',
  },
  {
    score: 2,
    text: 'Inaccurate decisions; below-standard performance, management & communication',
  },
  { score: 1, text: 'Poor umpiring and management; negative impact on the match environment' },
];

const RATING_CRITERIA = [
  { key: 'decisions', label: 'Correct decisions' },
  { key: 'pressure', label: 'Coping with pressure' },
  { key: 'behaviour', label: 'Management of player behaviour' },
  { key: 'communication', label: 'Player / management communication' },
  { key: 'regulations', label: 'Application of regulations' },
];

const CONCERN_AREAS = [
  { key: 'lbw', label: 'LBW decisions' },
  { key: 'wkCatches', label: 'Catches by wicket-keeper' },
  { key: 'batPad', label: 'Bat / pad catches' },
  { key: 'noBallWide', label: 'No balls / wides' },
  { key: 'conditions', label: 'Ground / weather / light' },
  { key: 'other', label: 'Other' },
];

// Umpire panel from the union's Captain's Report workbook (Criteria sheet) — offered as
// suggestions alongside umpires this club has rated before.
const UMPIRE_PANEL = [
  'Abdoellaah Steenkamp',
  'Abongile Sodumo',
  'Adrian Holdstock',
  'Allaudien Paleker',
  'Arno Jacobs',
  'Andre Olivier',
  'Babs Gcuma',
  'Bongani Jele',
  'Bongani Ntshebe',
  'Brad White',
  'Dennis Smith',
  'Evan vd Merwe',
  'Gladman Gaseba',
  'Godwin von Willingh',
  'Jannie Erasmus',
  'Jurie Sadler',
  'Kerrin Klaaste',
  'Khuwalani Ntuli',
  'Lauren Agenbag',
  'Marais Erasmus',
  'Mazizi Gampu',
  'Mtokozizi Shezi',
  'Muhammed Jooma',
  'Philip Vosloo',
  'Roger Burne',
  'Siphelele Gasa',
  'Stacey Lackay',
  'Stephen Harris',
  'Tom Mokorosi',
  'Waldo Lategan',
  'Warren Wyngaard',
  'Wimpie Nell',
];

// Per-club memory of the last report (captain, competition, recent umpires) so the
// next one starts prefilled, plus the fixtures filed from this browser (`filed`), which
// the season dashboard reads to show which matches still need a report. Browser-local and best-effort: storage can be unavailable.
const memoryKey = (clubId) => `captains-report:${clubId}`;
function recall(clubId) {
  try {
    return JSON.parse(localStorage.getItem(memoryKey(clubId)) || '{}') || {};
  } catch {
    return {};
  }
}
/** Fixture keys a report was filed for on this device (best-effort, browser-local). */
export const filedFixtureKeys = (clubId: string): string[] => recall(clubId).filed || [];

function remember(clubId, data) {
  try {
    localStorage.setItem(memoryKey(clubId), JSON.stringify(data));
  } catch {
    /* storage unavailable — prefill just won't carry over */
  }
}

interface UmpireReport {
  name: string;
  ratings: Record<string, number | undefined>;
  concerns: Record<string, boolean>;
  otherConcern: string;
  comments: string;
}
const emptyUmpire = (): UmpireReport => ({
  name: '',
  ratings: {},
  concerns: {},
  otherConcern: '',
  comments: '',
});
const fmtDate = (iso) =>
  iso
    ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';

// Clause 4.1 — report due by 18h00 on the third business day after the match.
function avgRating(u) {
  const vals = RATING_CRITERIA.map((c) => u.ratings[c.key]).filter(Boolean);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
const umpireComplete = (u) => !!u.name.trim() && RATING_CRITERIA.every((c) => u.ratings[c.key]);

/**
 * Text field with suggestions: always freely editable, and focusing it (or the
 * chevron) lists matching names to tap. Used for every autofilled name so a prefilled
 * value can be kept, swapped for a suggestion, or overtyped.
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
}
function AutoField({ value, onChange, options = [], placeholder, groupLabel }: AutoFieldProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const q = value.trim().toLowerCase();
  // An exact match means the field is "filled" — show the full list so it can be swapped.
  const exact = options.some((o) => o.name.toLowerCase() === q);
  const list = (
    q && !exact ? options.filter((o) => o.name.toLowerCase().includes(q)) : options
  ).slice(0, 50);
  const show = open && list.length > 0;

  function pick(o) {
    onChange(o.name);
    setOpen(false);
    setActive(-1);
  }
  function onKeyDown(e) {
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

function RatingRow({ label, value, onChange }) {
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
            title={RATING_GUIDE.find((g) => g.score === s).text}
            onClick={() => onChange(value === s ? undefined : s)}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

interface UmpireCardProps {
  n: number;
  umpire: UmpireReport;
  options: Suggestion[];
  onChange: (update: (u: UmpireReport) => UmpireReport) => void;
}
function UmpireCard({ n, umpire, options, onChange }: UmpireCardProps) {
  // onChange takes an updater so rapid edits never merge over a stale copy.
  const set = (patch) =>
    onChange((u) => ({ ...u, ...(typeof patch === 'function' ? patch(u) : patch) }));
  const avg = avgRating(umpire);
  return (
    <div className="rp-section">
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
          Umpire name <span className="req">*</span>
        </label>
        <AutoField
          options={options}
          value={umpire.name}
          onChange={(name) => set({ name })}
          placeholder="Start typing a name"
        />
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

export function CaptainsReportView({
  club,
  allSeries = [],
  clubs = [],
  players = [],
  directory = [],
  allLeagues = [],
  toast,
}) {
  // Reps only hold their own club record; the directory ({id, name}) covers the rest.
  const clubName = (id) =>
    clubs.find((c) => c.id === id)?.name || directory.find((c) => c.id === id)?.name;
  const opponents = useMemo(
    () => directory.filter((c) => c.id !== club.id).sort((a, b) => a.name.localeCompare(b.name)),
    [directory, club.id],
  );
  const myRoster = useMemo(() => ownRoster(club, players), [club, players]);
  const [memory, setMemory] = useState(() => recall(club.id));

  // This club's fixtures from released series — most recent first, so the match
  // just played is at the top of the picker.
  // Shared with the season dashboards (team-id aware, same venue rules as Fixtures).
  const fixtures = useMemo(
    () =>
      clubFixtures(
        allSeries,
        club.id,
        (id) => clubs.find((c) => c.id === id) || directory.find((c) => c.id === id),
      ),
    [allSeries, club.id, clubs, directory],
  );

  const clubLeagues = (club.leagues || [])
    .map((k) => allLeagues.find((l) => l.key === k)?.label)
    .filter(Boolean);

  // Fields a fixture determines — shared by the initial autofill and the picker.
  function fixtureFields(f) {
    return {
      fixtureKey: f.key,
      side: f.isHome ? 'Home' : 'Away',
      opponentId: f.oppClubId,
      opponent: f.oppName || clubName(f.oppClubId) || '',
      competition: f.series,
      venue: f.venue || (f.isHome ? club.ground?.venue || '' : ''),
      date: f.date,
    };
  }

  // Autofill: the latest fixture played (or the next one, pre-season), the last
  // report's captain/competition, then the club profile. Every field stays editable.
  const blank = (mem = memory) => {
    const today = localISO(new Date());
    // A dashboard "File report" link names the fixture (?fixture=…); otherwise take the
    // latest one played (or the next one, pre-season).
    const asked = new URLSearchParams(window.location.search).get('fixture');
    const latest =
      fixtures.find((f) => f.key === asked) ||
      fixtures.find((f) => f.date <= today) ||
      fixtures[fixtures.length - 1];
    const base = {
      fixtureKey: '',
      side: 'Home',
      opponentId: '',
      opponent: '',
      competition: mem.competition || clubLeagues[0] || '',
      venue: club.ground?.venue || '',
      date: today,
      captain: mem.captain || '',
    };
    return latest ? { ...base, ...fixtureFields(latest) } : base;
  };

  const [match, setMatch] = useState(blank);
  const [umpires, setUmpires] = useState([emptyUmpire(), emptyUmpire()]);
  const [general, setGeneral] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [submitted, setSubmitted] = useState(null);
  // Guide starts collapsed on phones, where five stacked descriptions push the form down.
  const [guideOpen] = useState(() => !window.matchMedia?.('(max-width: 640px)').matches);

  const setM = (patch) => setMatch((m) => ({ ...m, ...patch }));
  const home = match.side === 'Home' ? club.name : match.opponent;
  const away = match.side === 'Home' ? match.opponent : club.name;

  function pickFixture(key) {
    const f = fixtures.find((x) => x.key === key);
    setM(f ? fixtureFields(f) : { fixtureKey: '' });
  }

  function pickSide(side) {
    const own = club.ground?.venue || '';
    setMatch((m) => ({
      ...m,
      side,
      // Prefill our ground when at home; clear it if we switch to away.
      venue: side === 'Home' ? m.venue || own : m.venue === own ? '' : m.venue,
    }));
  }

  // The directory can land after the fixture autofill ran — name the opponent then.
  useEffect(() => {
    if (match.opponentId && !match.opponent) {
      const name = clubName(match.opponentId);
      if (name) setM({ opponent: name });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, match.opponentId]);

  // Free text; linking to a directory club (exact name) unlocks its name suggestions.
  function typeOpponent(name) {
    const hit = opponents.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    setM({ opponent: name, opponentId: hit?.id || '', fixtureKey: '' });
  }

  const umpireOptions = useMemo(() => {
    const recent = (memory.umpires || []).map((name) => ({ name, sub: 'Rated before' }));
    const panel = UMPIRE_PANEL.filter((n) => !memory.umpires?.includes(n)).map((name) => ({
      name,
      sub: 'Umpire panel',
    }));
    return [...recent, ...panel];
  }, [memory]);
  const competitionOptions = [...new Set([...fixtures.map((f) => f.series), ...clubLeagues])].map(
    (name) => ({ name }),
  );

  const matchDone = !!(match.opponent.trim() && match.date && match.captain.trim());
  const steps = [
    { label: 'Match details', done: matchDone },
    { label: 'Umpire 1 rated', done: umpireComplete(umpires[0]) },
    { label: 'Umpire 2 rated', done: umpireComplete(umpires[1]) },
    { label: 'Declaration', done: confirmed },
  ];
  const ready = steps.every((s) => s.done);
  const outstanding = steps.filter((s) => !s.done).length;
  const outstandingLabel = `${outstanding} section${outstanding === 1 ? '' : 's'} outstanding`;
  const progressLabel = `${steps.length - outstanding} of ${steps.length} complete`;

  function submit() {
    if (!ready) return toast?.('Complete the outstanding sections first', 'warn');
    const ref = `CR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const names = umpires.map((u) => u.name.trim()).filter(Boolean);
    const nextMemory = {
      captain: match.captain.trim(),
      competition: match.competition.trim(),
      umpires: [...new Set([...names, ...(memory.umpires || [])])].slice(0, 12),
      filed: [
        ...new Set([...(match.fixtureKey ? [match.fixtureKey] : []), ...(memory.filed || [])]),
      ].slice(0, 200),
    };
    remember(club.id, nextMemory);
    setMemory(nextMemory);
    setSubmitted({ ref, at: new Date() });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast?.(`Report ${ref} submitted to the union office`);
  }

  function reset() {
    setMatch(blank(recall(club.id)));
    setUmpires([emptyUmpire(), emptyUmpire()]);
    setGeneral('');
    setConfirmed(false);
    setSubmitted(null);
  }

  const header = (
    <div className="page-head">
      <div className="ph-left">
        <div className="ph-crumb">Club Portal · {club.name} / Captain's Report</div>
        <h1 className="ph-title">
          Captain's <em>Report</em>
        </h1>
        <p className="ph-desc">
          Complete at the conclusion of each match: match details, ratings for both on-field umpires
          and any general comments.
        </p>
      </div>
    </div>
  );

  if (submitted) {
    return (
      <div>
        {header}
        <div className="cr-done">
          <div className="cr-done-icon">
            <Icon.Check />
          </div>
          <div className="cr-done-title">Report submitted</div>
          <div className="cr-done-sub">
            Reference <strong>{submitted.ref}</strong> ·{' '}
            {submitted.at.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
          </div>
          <div className="cr-summary">
            <div className="cr-summary-row">
              <span>Match</span>
              <strong>
                {home} v {away}
              </strong>
            </div>
            <div className="cr-summary-row">
              <span>Date</span>
              <strong>{fmtDate(match.date)}</strong>
            </div>
            {umpires.map((u, i) => (
              <div key={i} className="cr-summary-row">
                <span>Umpire {i + 1}</span>
                <strong>
                  {u.name} · {avgRating(u).toFixed(1)} / 5
                </strong>
              </div>
            ))}
          </div>
          <div className="cr-done-actions">
            <Btn tone="outline" size="sm" icon={Icon.Download} onClick={() => window.print()}>
              Print copy
            </Btn>
            <Btn tone="ink" size="sm" icon={Icon.Plus} onClick={reset}>
              New report
            </Btn>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {header}
      <div className="cr-layout">
        <div className="rp-form">
          {/* Part 1 — Match details */}
          <div className="rp-section">
            <SectionHead
              n={1}
              title="Match details"
              sub="Prefilled from your fixtures and last report — change anything that's different."
            />
            {fixtures.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <label className="field-label">Fixture</label>
                <select
                  className="field-select"
                  value={match.fixtureKey}
                  onChange={(e) => pickFixture(e.target.value)}
                >
                  <option value="">Not on the fixture list</option>
                  {fixtures.map((f) => (
                    <option key={f.key} value={f.key}>
                      {fmtDate(f.date)} · {f.isHome ? 'vs' : '@'} {f.oppName || 'TBA'} · {f.series}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="cr-teams">
              <div>
                <label className="field-label">{club.name} played</label>
                <Choice value={match.side} onChange={pickSide} options={['Home', 'Away']} />
              </div>
              <div>
                <label className="field-label">
                  {match.side === 'Home' ? 'Visiting team' : 'Home team'}{' '}
                  <span className="req">*</span>
                </label>
                <AutoField
                  options={opponents}
                  value={match.opponent}
                  onChange={typeOpponent}
                  placeholder="Opposition club"
                  groupLabel="Union clubs"
                />
              </div>
            </div>
            {match.opponent && (
              <div className="cr-fixture-line">
                <strong>{home}</strong> <span>(home)</span> v <strong>{away}</strong>{' '}
                <span>(away)</span>
              </div>
            )}
            <div className="field-grid-2" style={{ marginTop: 12 }}>
              <div>
                <label className="field-label">
                  Match date <span className="req">*</span>
                </label>
                <input
                  className="field-input"
                  type="date"
                  value={match.date}
                  onChange={(e) => setM({ date: e.target.value })}
                />
              </div>
              <div>
                <label className="field-label">Competition</label>
                <AutoField
                  options={competitionOptions}
                  value={match.competition}
                  onChange={(competition) => setM({ competition })}
                  placeholder="e.g. Premier League"
                />
              </div>
            </div>
            <div className="field-grid-2" style={{ marginTop: 12 }}>
              <div>
                <label className="field-label">Venue</label>
                <input
                  className="field-input"
                  value={match.venue}
                  onChange={(e) => setM({ venue: e.target.value })}
                  placeholder="Ground name"
                />
              </div>
              <div>
                <label className="field-label">
                  Captain's name <span className="req">*</span>
                </label>
                <AutoField
                  options={myRoster.players}
                  value={match.captain}
                  onChange={(captain) => setM({ captain })}
                  placeholder="Full name"
                  groupLabel={`${club.name}${myRoster.sample ? ' · sample names' : ''}`}
                />
              </div>
            </div>
          </div>

          {/* Rating guide */}
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

          {/* Part 2 — Umpires */}
          {umpires.map((u, i) => (
            <UmpireCard
              key={i}
              n={i + 1}
              umpire={u}
              // Don't offer the name already used for the other umpire.
              options={umpireOptions.filter((o) => o.name !== umpires[1 - i].name)}
              onChange={(fn) => setUmpires((all) => all.map((x, j) => (j === i ? fn(x) : x)))}
            />
          ))}

          {/* Part 3 — General comments */}
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

          {/* Declaration */}
          <div className="rp-section rp-consent">
            <label className="rp-check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                I, <strong>{match.captain || 'the captain'}</strong>, confirm this report is a true
                and fair account of the match and will be submitted to the union office.
              </span>
            </label>
          </div>

          <div className="cr-footer">
            <span className="cr-footer-progress">{ready ? 'Ready to submit' : progressLabel}</span>
            <Btn tone="teal" onClick={submit} disabled={!ready}>
              Submit report
            </Btn>
          </div>
        </div>

        {/* Sticky summary */}
        <aside className="cr-aside">
          <div className="cr-aside-card">
            <div className="cr-aside-title">Report status</div>
            <div className="cr-aside-match">
              {match.opponent ? `${home} v ${away}` : 'Match not set'}
              <span>{fmtDate(match.date)}</span>
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
              disabled={!ready}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              Submit report
            </Btn>
            {!ready && (
              <div className="rp-validation" style={{ textAlign: 'center' }}>
                {outstandingLabel}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
