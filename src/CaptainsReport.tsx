/* ─── Captain's post-match report (UI only — no API wiring yet) ─── */

import { useState, useMemo, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Icon, Btn, Pill, YN, Choice } from './atoms';
import { ownRoster, oppositionRoster } from './captainsReportRoster';
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

// Annexure A — Schedule of Offences and Mandatory Penalties (Code of Behaviour).
// `penalty` is playing days suspended for a 1st / 2nd / 3rd offence.
export const OFFENCE_LEVELS = [
  {
    level: 1,
    penalty: ['4 days', '6 days', '8 days'],
    offences: [
      {
        code: '1.1',
        text: "Disputing an umpire's decision or acting provocatively / in a disapproving manner",
      },
      { code: '1.2', text: 'Verbal abuse of a player' },
      { code: '1.3', text: 'Incitement of any person to verbally abuse' },
      { code: '1.4', text: 'Crude or abusive hand signals or gestures' },
      { code: '1.5', text: 'Excessive appealing after being warned by the umpires' },
      { code: '1.6', text: 'Aggressive pointing or gesturing towards the pavilion on a dismissal' },
      { code: '1.7', text: 'Abuse of cricket equipment or property' },
      {
        code: '1.8',
        text: 'Captain failing to control players after being requested to by an umpire / official',
      },
      {
        code: '1.9',
        text: 'Captain failing to control players where no official umpires are appointed',
      },
    ],
  },
  {
    level: 2,
    penalty: ['6 days', '8 days', '10 days'],
    offences: [
      {
        code: '2.1',
        text: 'Intimidation (e.g. throwing the ball at or near a player or official)',
      },
      { code: '2.2', text: 'Threat of assault or physical interference' },
      { code: '2.3', text: 'Incitement or provocation of any person to physical assault' },
      {
        code: '2.4',
        text: 'Public criticism of a match incident or official, including on social media',
      },
      { code: '2.5', text: 'Charging or advancing towards the umpire in an aggressive manner' },
      { code: '2.6', text: 'Deliberate and malicious distraction or obstruction on the field' },
      { code: '2.7', text: 'Public acts of misconduct or unruly behaviour' },
      { code: '2.8', text: 'Alcohol or narcotic use by a player while the match is in progress' },
    ],
  },
  {
    level: 3,
    penalty: ['6 days', '8 days', '10 days'],
    offences: [
      { code: '3.1', text: 'Verbal abuse of an umpire or official' },
      {
        code: '3.2',
        text: 'Intimidation of an umpire, or threat of assault / physical interference',
      },
      { code: '3.3', text: 'Physical interference (other than towards an umpire)' },
      { code: '3.4', text: 'Changing the condition of the ball or pitch' },
      { code: '3.5', text: 'Racial, religious, cultural or sexual remark or comment' },
      {
        code: '3.6',
        text: 'Ball / pitch tampering with no individual identified (captain held responsible)',
      },
    ],
  },
  {
    level: 4,
    penalty: ['20 days', '30 days', '40 days'],
    offences: [
      { code: '4.1', text: 'Assault — intentional infliction of minor physical harm or injury' },
    ],
  },
  {
    level: 5,
    penalty: ['40 days', 'Life ban', '—'],
    offences: [
      { code: '5.1', text: 'Physical assault with intent to do grievous bodily harm' },
      { code: '5.2', text: 'Collusion to contrive a result or match-fixing' },
    ],
  },
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

const OFFENDER_ROLES = ['Player', 'Captain', 'Coach', 'Team official', 'Spectator'];
const OTHER = '__other';
// Which roster list feeds the name picker for each offender role.
const ROSTER_FOR_ROLE = {
  Player: 'players',
  Captain: 'players',
  Coach: 'coaches',
  'Team official': 'officials',
};
const offenceLevel = (code) =>
  OFFENCE_LEVELS.find((l) => l.offences.some((o) => o.code === code))?.level ?? null;
// Clause 10.3 — captain's penalty is doubled, except for these two offences.
const CAPTAIN_EXEMPT = ['1.8', '3.6'];

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
const emptyIncident = (witnesses = '') => ({
  id: Math.random().toString(36).slice(2, 9),
  name: '',
  role: 'Player',
  level: null,
  offence: '',
  offenceOther: '',
  team: null, // null = follow the match opposition
  when: '',
  description: '',
  umpiresInformed: null,
  witnesses,
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
// Weekends are skipped; public holidays aren't modelled (flagged in the copy).
export function misconductDeadline(matchISO) {
  if (!matchISO) return null;
  const d = new Date(matchISO + 'T00:00:00');
  let added = 0;
  while (added < 3) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return localISO(d);
}

function avgRating(u) {
  const vals = RATING_CRITERIA.map((c) => u.ratings[c.key]).filter(Boolean);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
const umpireComplete = (u) => !!u.name.trim() && RATING_CRITERIA.every((c) => u.ratings[c.key]);
const incidentComplete = (i) =>
  !!i.name.trim() &&
  !!i.offence &&
  (i.offence !== OTHER || !!i.offenceOther.trim()) &&
  !!i.description.trim();

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

function IncidentCard({ index, incident, opposition, roster, onChange, onRemove, canRemove }) {
  const set = (patch) =>
    onChange((i) => ({ ...i, ...(typeof patch === 'function' ? patch(i) : patch) }));
  const lvl = OFFENCE_LEVELS.find((l) => l.level === incident.level);
  const isNonPlayer = !['Player', 'Captain'].includes(incident.role);
  const isOtherOffence = incident.offence === OTHER;
  const captainDoubled =
    incident.role === 'Captain' &&
    incident.offence &&
    !isOtherOffence &&
    !CAPTAIN_EXEMPT.includes(incident.offence);
  const nameOptions = roster?.[ROSTER_FOR_ROLE[incident.role]] || [];
  // Team follows the match's opposition until the user types their own.
  const team = incident.team ?? opposition ?? '';

  return (
    <div className="cr-incident">
      <div className="cr-incident-head">
        <div className="cr-incident-title">
          <span className="cr-incident-num">{index + 1}</span>
          Alleged offender
        </div>
        {canRemove && (
          <Btn tone="ghost" size="sm" icon={Icon.X} onClick={onRemove}>
            Remove
          </Btn>
        )}
      </div>

      <div className="field-grid-3">
        <div>
          <label className="field-label">Role</label>
          <select
            className="field-select"
            value={incident.role}
            onChange={(e) => set({ role: e.target.value })}
          >
            {OFFENDER_ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label">
            Name <span className="req">*</span>
          </label>
          <AutoField
            options={nameOptions}
            value={incident.name}
            onChange={(name) => set({ name })}
            placeholder="Full name"
            groupLabel={`${team || 'Opposition'} · ${incident.role.toLowerCase()}s${roster?.sample ? ' · sample names' : ''}`}
          />
        </div>
        <div>
          <label className="field-label">Team</label>
          <input
            className="field-input"
            value={team}
            onChange={(e) => set({ team: e.target.value })}
            placeholder="Opposition club"
          />
        </div>
      </div>

      <label className="field-label" style={{ marginTop: 16 }}>
        Offence level
      </label>
      <div className="cr-levels">
        {OFFENCE_LEVELS.map((l) => (
          <button
            key={l.level}
            type="button"
            className={`cr-level ${incident.level === l.level ? 'on' : ''} ${l.level >= 4 ? 'severe' : ''}`}
            // Narrows the offence list; choosing an offence sets the level itself.
            onClick={() =>
              set((i) =>
                i.level === l.level
                  ? { level: null }
                  : {
                      level: l.level,
                      offence: offenceLevel(i.offence) === l.level ? i.offence : '',
                    },
              )
            }
          >
            <span className="cr-level-n">Level {l.level}</span>
            <span className="cr-level-p">{l.penalty[0]}</span>
          </button>
        ))}
      </div>

      <label className="field-label" style={{ marginTop: 16 }}>
        Offence <span className="req">*</span>
      </label>
      <select
        className="field-select"
        value={incident.offence}
        onChange={(e) => {
          const code = e.target.value;
          set((i) => ({ offence: code, level: offenceLevel(code) ?? i.level }));
        }}
      >
        <option value="">Select the offence</option>
        {OFFENCE_LEVELS.filter((l) => !lvl || l.level === lvl.level).map((l) => (
          <optgroup key={l.level} label={`Level ${l.level} · ${l.penalty[0]} suspension`}>
            {l.offences.map((o) => (
              <option key={o.code} value={o.code}>
                {o.code} — {o.text}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={OTHER}>Other — not listed in the Code</option>
      </select>

      {(lvl || isOtherOffence) && (
        <>
          {isOtherOffence && (
            <input
              className="field-input"
              style={{ marginTop: 8 }}
              autoFocus
              value={incident.offenceOther}
              onChange={(e) => set({ offenceOther: e.target.value })}
              placeholder="Name the offence, e.g. bringing the game into disrepute"
            />
          )}

          {isOtherOffence ? (
            <div className="cr-penalty">
              <div>
                <div className="cr-penalty-l">Not listed in Annexure A</div>
                <div className="cr-penalty-v">
                  Charge and penalty set by the LLC / Disciplinary Committee —{' '}
                  <strong>4–40 playing days</strong> and/or a fine of up to <strong>R20,000</strong>
                  .
                </div>
              </div>
            </div>
          ) : (
            <div className="cr-penalty">
              <div>
                <div className="cr-penalty-l">Mandatory suspension · Level {lvl.level}</div>
                <div className="cr-penalty-v">
                  1st <strong>{lvl.penalty[0]}</strong>
                  <span className="cr-dot">·</span>2nd <strong>{lvl.penalty[1]}</strong>
                  {lvl.penalty[2] !== '—' && (
                    <>
                      <span className="cr-dot">·</span>3rd <strong>{lvl.penalty[2]}</strong>
                    </>
                  )}
                </div>
              </div>
              {captainDoubled && <Pill tone="coral">Captain · penalty doubled</Pill>}
            </div>
          )}
          {isNonPlayer && !isOtherOffence && (
            <div className="rp-hint">
              Non-players: 4–40 playing days and/or a fine of up to R20,000 at the Disciplinary
              Committee's discretion.
            </div>
          )}
        </>
      )}

      <div className="field-grid-2" style={{ marginTop: 16 }}>
        <div>
          <label className="field-label">When did it happen?</label>
          <input
            className="field-input"
            value={incident.when}
            onChange={(e) => set({ when: e.target.value })}
            placeholder="e.g. 2nd innings, over 34 · approx. 15:40"
          />
        </div>
        <div>
          <label className="field-label">Were the umpires informed?</label>
          <YN value={incident.umpiresInformed} onChange={(v) => set({ umpiresInformed: v })} />
        </div>
      </div>

      <label className="field-label" style={{ marginTop: 16 }}>
        Description of incident <span className="req">*</span>
      </label>
      <textarea
        className="field-textarea"
        value={incident.description}
        onChange={(e) => set({ description: e.target.value })}
        placeholder="Factual account: what was said or done, to whom, and what followed"
      />

      <label className="field-label" style={{ marginTop: 16 }}>
        Witnesses
      </label>
      <input
        className="field-input"
        value={incident.witnesses}
        onChange={(e) => set({ witnesses: e.target.value })}
        placeholder="Names of umpires, players or officials who saw the incident"
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
  const [misconduct, setMisconduct] = useState(false);
  const [incidents, setIncidents] = useState([emptyIncident()]);
  const [confirmed, setConfirmed] = useState(false);
  const [submitted, setSubmitted] = useState(null);
  // Guide starts collapsed on phones, where five stacked descriptions push the form down.
  const [guideOpen] = useState(() => !window.matchMedia?.('(max-width: 640px)').matches);

  const setM = (patch) => setMatch((m) => ({ ...m, ...patch }));
  const opposition = match.opponent;
  const home = match.side === 'Home' ? club.name : match.opponent;
  const away = match.side === 'Home' ? match.opponent : club.name;
  const oppRoster = useMemo(() => oppositionRoster(match.opponentId), [match.opponentId]);

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

  const umpireNames = umpires
    .map((u) => u.name.trim())
    .filter(Boolean)
    .join(', ');
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

  // Witnesses default to the match umpires — editable like everything else.
  function enableMisconduct() {
    setMisconduct(true);
    setIncidents((all) => all.map((i) => (i.witnesses ? i : { ...i, witnesses: umpireNames })));
  }

  function openMisconduct() {
    enableMisconduct();
    setTimeout(
      () =>
        document
          .getElementById('cr-misconduct')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      50,
    );
  }

  const matchDone = !!(match.opponent.trim() && match.date && match.captain.trim());
  const misconductDone = !misconduct || incidents.every(incidentComplete);
  const steps = [
    { label: 'Match details', done: matchDone },
    { label: 'Umpire 1 rated', done: umpireComplete(umpires[0]) },
    { label: 'Umpire 2 rated', done: umpireComplete(umpires[1]) },
    {
      label: misconduct
        ? `Misconduct · ${incidents.length} ${incidents.length === 1 ? 'person' : 'people'}`
        : 'No misconduct reported',
      done: misconductDone,
    },
    { label: 'Declaration', done: confirmed },
  ];
  const ready = steps.every((s) => s.done);
  const outstanding = steps.filter((s) => !s.done).length;
  const outstandingLabel = `${outstanding} section${outstanding === 1 ? '' : 's'} outstanding`;
  const progressLabel = `${steps.length - outstanding} of ${steps.length} complete`;
  const deadline = misconductDeadline(match.date);

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
    toast?.(
      misconduct
        ? `Report ${ref} submitted · misconduct referred to the union office`
        : `Report ${ref} submitted to the union office`,
    );
  }

  function reset() {
    setMatch(blank(recall(club.id)));
    setUmpires([emptyUmpire(), emptyUmpire()]);
    setGeneral('');
    setMisconduct(false);
    setIncidents([emptyIncident()]);
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
          Complete at the conclusion of each match. Rate the on-field umpires and, where necessary,
          report misconduct by the opposition under the Code of Behaviour.
        </p>
      </div>
      {!submitted && (
        <div className="ph-actions">
          <Btn
            tone={misconduct ? 'ink' : 'outline'}
            size="sm"
            icon={Icon.Alert}
            onClick={openMisconduct}
          >
            {misconduct ? 'Misconduct added' : 'Report misconduct'}
          </Btn>
        </div>
      )}
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
            {misconduct ? (
              incidents.map((inc, i) => (
                <div key={inc.id} className="cr-summary-row">
                  <span>{i === 0 ? 'Misconduct' : ''}</span>
                  <strong>
                    {inc.name} · {inc.offence === OTHER ? inc.offenceOther : inc.offence}
                  </strong>
                </div>
              ))
            ) : (
              <div className="cr-summary-row">
                <span>Misconduct</span>
                <strong>None reported</strong>
              </div>
            )}
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

          {/* Part 4 — Misconduct */}
          <div id="cr-misconduct" className={`rp-section ${misconduct ? 'cr-mis-on' : ''}`}>
            <SectionHead
              n={4}
              title="Misconduct"
              sub={
                misconduct
                  ? `Alleged breaches of the Code of Behaviour by ${opposition || 'the opposition'}.`
                  : 'Was there any misconduct by the opposition during this match?'
              }
              right={
                misconduct ? (
                  <Btn tone="ghost" size="sm" onClick={() => setMisconduct(false)}>
                    No misconduct
                  </Btn>
                ) : (
                  <Btn tone="ink" size="sm" icon={Icon.Alert} onClick={enableMisconduct}>
                    Report misconduct
                  </Btn>
                )
              }
            />

            {misconduct && (
              <>
                {deadline && (
                  <div className="cr-notice">
                    <Icon.Clock />
                    <div>
                      Misconduct reports must reach the union office by{' '}
                      <strong>18h00 on {fmtDate(deadline)}</strong> — the third business day after
                      the match (adjust for public holidays).
                    </div>
                  </div>
                )}
                <div className="cr-incidents">
                  {incidents.map((inc, i) => (
                    <IncidentCard
                      key={inc.id}
                      index={i}
                      incident={inc}
                      opposition={opposition}
                      roster={oppRoster}
                      canRemove={incidents.length > 1}
                      onRemove={() => setIncidents((all) => all.filter((x) => x.id !== inc.id))}
                      onChange={(fn) =>
                        setIncidents((all) => all.map((x) => (x.id === inc.id ? fn(x) : x)))
                      }
                    />
                  ))}
                </div>
                <Btn
                  tone="outline"
                  size="sm"
                  icon={Icon.Plus}
                  onClick={() => setIncidents((all) => [...all, emptyIncident(umpireNames)])}
                >
                  Add another player
                </Btn>
              </>
            )}
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
