/**
 * Admin console — running a season (ADR 0008).
 *
 * The operator designs a structure; the admin plays it out. This is that surface: start a
 * season for a league's competition, confirm which teams are in which group at each
 * stage, and generate that stage's fixtures.
 *
 * ── WHY A HUMAN CONFIRMS ──
 * The platform has no results or ladder model, so a stage whose teams depend on earlier
 * standings cannot resolve itself. Rather than pretend, the stage says exactly what the
 * rule is — in the operator's own words, from the structure's DerivationNote — proposes
 * the best grouping it honestly can, and asks. What the admin chose, what was proposed,
 * and whether they took it are all recorded: relegation and points carry ride on these
 * decisions.
 *
 * One stage-group becomes one Series, so everything downstream (approval, release, the
 * player broadcast, travel cost) is the existing, tested path.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Btn, Card, EmptyState, Icon, Pill, useEscapeClose } from './atoms';
import { ApiError } from './api';
import { findBlock, formatIsoDate, todayIso } from './competition/calendar';
import { formatStampDay } from './dates';
import {
  crossPoolQualifiersFor,
  feedsCrossPool,
  materialiseStage,
  type StageMaterialisation,
} from './competition/structure';
import { clubTeamsForLeague, findByKey } from './leagues';
import { currentSeasonLabel } from './data';
import type {
  Club,
  Competition,
  CompetitionStructure,
  League,
  SeasonCalendar,
  SeasonRun,
  Series,
  StageRun,
  StageSpec,
  TenantConfig,
} from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '6px 0 0' };

function Modal({
  title,
  wide,
  onClose,
  children,
}: {
  title: ReactNode;
  wide?: boolean;
  onClose: () => void;
  children?: ReactNode;
}) {
  useEscapeClose(onClose);
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" style={wide ? { maxWidth: 900 } : undefined}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Fixtures · Season</div>
            <div className="task-modal-head-title">{title}</div>
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

/** Every side registered for a league, in a stable order — the pool a season draws on. */
export function leagueParticipants(clubs: Club[], leagueKey: string) {
  return (clubs || [])
    .filter((c) => Array.isArray(c.leagues) && c.leagues.includes(leagueKey))
    .flatMap((c) => clubTeamsForLeague(c, leagueKey).map((p) => ({ ...p, club: c })));
}

/** A league is season-capable only once the operator has bound a competition to it. */
export function seasonCapableLeagues(allLeagues: League[]): League[] {
  return (allLeagues || []).filter((l) => (l.competitions?.length ?? 0) > 0);
}

/* ─── Start a season ─── */

function StartSeasonForm({
  clubs,
  allLeagues,
  config,
  existingRuns,
  onCreate,
  onClose,
  toast,
}: {
  clubs: Club[];
  allLeagues: League[];
  config: TenantConfig;
  existingRuns: SeasonRun[];
  onCreate: (run: SeasonRun) => Promise<void>;
  onClose: () => void;
  toast: Toast;
}) {
  const capable = seasonCapableLeagues(allLeagues);
  const [leagueKey, setLeagueKey] = useState(capable[0]?.key ?? '');
  const league = capable.find((l) => l.key === leagueKey);
  const [competitionId, setCompetitionId] = useState(league?.competitions?.[0]?.id ?? '');
  const [seasonLabel, setSeasonLabel] = useState(currentSeasonLabel());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const competition = league?.competitions?.find((c) => c.id === competitionId);
  const structure = (config.structures ?? []).find((s) => s.id === competition?.structureId);
  const calendar = (config.calendars ?? []).find((c) => c.id === competition?.calendarId);
  const teams = league ? leagueParticipants(clubs, league.key) : [];
  const duplicate = existingRuns.some(
    (r) =>
      r.leagueKey === leagueKey &&
      r.competitionId === competitionId &&
      r.seasonLabel === seasonLabel.trim(),
  );

  const problems: string[] = [];
  if (!league) problems.push('Pick a league.');
  if (!competition) problems.push('Pick a competition.');
  if (!structure) problems.push('That competition points at a structure that no longer exists.');
  if (!calendar) problems.push('That competition points at a calendar that no longer exists.');
  if (!seasonLabel.trim()) problems.push('Give the season a label.');
  if (teams.length < 2) problems.push('At least two sides must be registered for this league.');
  if (duplicate) problems.push('That season is already running for this competition.');

  async function submit() {
    if (problems.length || busy || !league || !competition || !structure || !calendar) return;
    setErr('');
    setBusy(true);
    try {
      await onCreate({
        id: 'run-' + Date.now(),
        leagueKey: league.key,
        competitionId: competition.id,
        seasonLabel: seasonLabel.trim(),
        // Frozen at start: a later structure edit must never reshape a season in flight.
        structureSnapshot: structure,
        calendarSnapshot: calendar,
        stages: structure.stages.map((s) => ({
          specId: s.id,
          status: 'awaiting-entrants' as const,
          groups: [],
        })),
        version: 1,
      });
      toast(`${league.label} · ${competition.label} · ${seasonLabel.trim()} started`);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not start the season — try again');
    } finally {
      setBusy(false);
    }
  }

  if (capable.length === 0) {
    return (
      <div>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          No league has a competition bound to it yet. A season runs a league&apos;s{' '}
          <strong>competition</strong> — a format stream with a structure and a calendar — and those
          are configured by your platform operator. Ask them to set one up, then start the season
          here.
        </p>
        <p style={{ ...HINT }}>
          In the meantime, the existing <em>Create series</em> flow still works for a simple league.
        </p>
        <div style={{ marginTop: 16 }}>
          <Btn tone="outline" onClick={onClose}>
            Close
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="field">
        <div className="field-label">
          League <span className="req">*</span>
        </div>
        <select
          className="field-select"
          value={leagueKey}
          onChange={(e) => {
            const next = capable.find((l) => l.key === e.target.value);
            setLeagueKey(e.target.value);
            setCompetitionId(next?.competitions?.[0]?.id ?? '');
          }}
        >
          {capable.map((l) => (
            <option key={l.key} value={l.key}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <div className="field-label">
          Competition <span className="req">*</span>
        </div>
        <select
          className="field-select"
          value={competitionId}
          onChange={(e) => setCompetitionId(e.target.value)}
        >
          {(league?.competitions ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <div className="field-label">
          Season <span className="req">*</span>
        </div>
        <input
          className="field-input"
          value={seasonLabel}
          onChange={(e) => setSeasonLabel(e.target.value)}
          placeholder="2026/27"
          style={{ maxWidth: 200 }}
        />
      </div>

      {structure && calendar && (
        <div
          style={{
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: 12,
            fontSize: 12.5,
            color: 'var(--muted)',
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: 'var(--ink)' }}>{structure.name}</strong> (v{structure.version}) ·{' '}
          {calendar.label}
          <br />
          {structure.stages.map((s) => s.name).join(' → ')}
          <br />
          {teams.length} side{teams.length === 1 ? '' : 's'} registered for {league?.label}
        </div>
      )}

      {problems.map((p) => (
        <div key={p} style={ERR}>
          {p}
        </div>
      ))}
      {err && <div style={ERR}>{err}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <Btn tone="teal" onClick={submit} disabled={!!problems.length || busy}>
          {busy ? 'Starting…' : 'Start season'}
        </Btn>
        <Btn tone="outline" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/* ─── Entrant confirmation ─── */

/**
 * Assign each side to a group.
 *
 * A dropdown per team rather than drag-and-drop: a Promotion stream is twenty sides, and
 * a scannable table where every row states its group is faster and less error-prone than
 * shuffling chips. Live counts against the structure's expected sizes catch a miscount
 * before it becomes a fixture list.
 */
function EntrantConfirmForm({
  stage,
  stageRun,
  materialisation,
  participants,
  ranked,
  onConfirm,
  onCancel,
}: {
  stage: StageSpec;
  stageRun: StageRun | undefined;
  materialisation: StageMaterialisation;
  participants: Array<{ teamId: string; name: string }>;
  /**
   * Ask for a finishing position within each group, not just membership.
   *
   * Set when a LATER stage draws cross-pool qualifiers from this one: that bracket pairs
   * "the winner of pool A against the runner-up of pool B", so the order inside each
   * group is load-bearing rather than incidental. Without it the order is however the
   * clubs happen to be registered, which is not a ranking of anything — and the bracket
   * would be confidently wrong while the console said "cross-pool".
   */
  ranked?: boolean;
  onConfirm: (groups: string[][], carriedPoints: Record<string, number>) => Promise<void>;
  onCancel: () => void;
}) {
  /**
   * The groups to seed the form from, whatever state the stage is in.
   *
   * An `awaiting-entrants` stage offers its prefill; a `ready` one (seeded-split or
   * all-registered) has already RESOLVED its groups, and those are the suggestion. Using
   * only the prefill left "Edit entrants" on a resolved stage showing a blank form with
   * every side unassigned, no "Use the suggestion" button, and — because the labels fell
   * back to `['Group A']` — a single-group dropdown that couldn't express the split at all.
   */
  const suggested =
    materialisation.status === 'awaiting-entrants'
      ? materialisation.prefill
      : materialisation.groups.map((g) => ({ id: g.id, label: g.label, entrants: g.entrants }));
  const labels = stage.groupLabels?.length
    ? stage.groupLabels
    : suggested.length
      ? suggested.map((g) => g.label)
      : ['Group A'];
  const expected =
    stage.entrants.kind !== 'all-registered' && stage.entrants.groups?.kind === 'sizes'
      ? stage.entrants.groups.sizes
      : null;

  /** The groups to seed from — the stored confirmation if there is one, else the suggestion. */
  const seedGroups = () =>
    stageRun?.groups?.length
      ? stageRun.groups.map((g) => g.entrants)
      : suggested.map((g) => g.entrants);

  /** teamId → group index. Seeded from the prefill so "accept the suggestion" is one click. */
  const seed = () => {
    const map: Record<string, number> = {};
    seedGroups().forEach((entrants, gi) => entrants.forEach((t) => (map[t] = gi)));
    return map;
  };
  /** teamId → 1-based position within its group, seeded from the stored/suggested order. */
  const seedRanks = () => {
    const map: Record<string, number> = {};
    seedGroups().forEach((entrants) => entrants.forEach((t, i) => (map[t] = i + 1)));
    return map;
  };
  const [assignment, setAssignment] = useState<Record<string, number>>(seed);
  const [ranks, setRanks] = useState<Record<string, number>>(seedRanks);
  const [points, setPoints] = useState<Record<string, number>>(stageRun?.carriedPoints ?? {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const note = stage.entrants.kind === 'manual' ? stage.entrants.derivedFrom : undefined;
  const wantsPoints = !!note?.carryPoints;

  // Sorted by the admin's position when the order matters downstream, otherwise left in
  // participant order — which is what it always was, and fine for a round robin.
  const groups: string[][] = labels.map((_, gi) => {
    const inGroup = participants.filter((p) => assignment[p.teamId] === gi);
    if (!ranked) return inGroup.map((p) => p.teamId);
    return [...inGroup]
      .sort(
        (a, b) =>
          (ranks[a.teamId] ?? Number.MAX_SAFE_INTEGER) -
          (ranks[b.teamId] ?? Number.MAX_SAFE_INTEGER),
      )
      .map((p) => p.teamId);
  });
  const unassigned = participants.filter((p) => assignment[p.teamId] === undefined);

  // "Not playing" is a legitimate answer — a side registered for the league but sitting
  // this competition out. Blocking on it made the option a trap: choosing it disabled
  // Confirm permanently with no way back except reassigning. It is surfaced as a count
  // the admin can see and accept instead.
  const problems: string[] = [];
  groups.forEach((g, i) => {
    // A group with NO sides isn't the same as a side sitting the competition out — the
    // structure asked for this group and nobody is in it, so it would generate zero
    // fixtures and a series with no dates.
    if (g.length === 0) problems.push(`${labels[i]} has no sides.`);
    if (g.length === 1) problems.push(`${labels[i]} has one side — it would play nobody.`);
    if (expected && expected[i] !== undefined && g.length !== expected[i])
      problems.push(`${labels[i]} has ${g.length} sides; the structure expects ${expected[i]}.`);
    if (ranked && g.length > 1) {
      // A side moved in from "Not playing" was never seeded with a rank. Unasked, it
      // sorts silently last — and two of them collide on `undefined`, which the tie check
      // below would report as "two sides in the same position", describing something that
      // didn't happen.
      if (g.some((t) => ranks[t] === undefined))
        problems.push(`Give every side in ${labels[i]} a finishing position.`);
      // A tie makes the bracket depend on participant order again — exactly what asking
      // for a ranking was meant to remove.
      const positions = g.map((t) => ranks[t]).filter((n) => n !== undefined);
      if (new Set(positions).size !== positions.length)
        problems.push(`${labels[i]} has two sides in the same position.`);
    }
  });

  async function submit() {
    if (problems.length || busy) return;
    setErr('');
    setBusy(true);
    try {
      await onConfirm(groups, wantsPoints ? points : {});
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not confirm — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {note && (
        <div
          style={{
            border: '1px solid var(--line)',
            borderLeft: '3px solid var(--brand-primary, #16332B)',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 14,
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <strong>The rule:</strong> {note.detail}
          {note.carryPoints && (
            <div style={{ ...HINT, marginTop: 6 }}>
              Points move with the position, not the team — enter the points each side takes on.
            </div>
          )}
        </div>
      )}

      {ranked && (
        <div
          style={{
            border: '1px solid var(--line)',
            borderLeft: '3px solid var(--accent, #C9A227)',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 14,
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <strong>Order matters here.</strong> A later stage pairs these groups across each other —
          the pool winner against another pool&apos;s runner-up — so set each side&apos;s finishing
          position, not just which group it was in.
        </div>
      )}

      <div className="tbl-w" style={{ maxHeight: 420, overflowY: 'auto' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Side</th>
              <th style={{ width: 200 }}>Group</th>
              {ranked && <th style={{ width: 90 }}>Position</th>}
              {wantsPoints && <th style={{ width: 130 }}>Carried points</th>}
            </tr>
          </thead>
          <tbody>
            {participants.map((p) => (
              <tr key={p.teamId}>
                <td>{p.name}</td>
                <td>
                  <select
                    className="field-select"
                    value={assignment[p.teamId] ?? ''}
                    onChange={(e) =>
                      setAssignment((a) => {
                        const next = { ...a };
                        if (e.target.value === '') delete next[p.teamId];
                        else next[p.teamId] = Number(e.target.value);
                        return next;
                      })
                    }
                  >
                    <option value="">Not playing</option>
                    {labels.map((l, i) => (
                      <option key={l} value={i}>
                        {l}
                      </option>
                    ))}
                  </select>
                </td>
                {ranked && (
                  <td>
                    <input
                      className="field-input"
                      type="number"
                      min={1}
                      style={{ width: 70 }}
                      // Meaningless for a side that isn't in a group.
                      disabled={assignment[p.teamId] === undefined}
                      value={assignment[p.teamId] === undefined ? '' : (ranks[p.teamId] ?? '')}
                      onChange={(e) =>
                        setRanks((r) => ({ ...r, [p.teamId]: Math.max(1, +e.target.value || 1) }))
                      }
                    />
                  </td>
                )}
                {wantsPoints && (
                  <td>
                    <input
                      className="field-input"
                      type="number"
                      style={{ width: 100 }}
                      value={points[p.teamId] ?? ''}
                      onChange={(e) =>
                        setPoints((pt) => ({ ...pt, [p.teamId]: Number(e.target.value) || 0 }))
                      }
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        {unassigned.length > 0 && <Pill tone="muted">{unassigned.length} not playing</Pill>}
        {labels.map((l, i) => {
          const n = groups[i].length;
          const want = expected?.[i];
          const okCount = want === undefined ? n >= 2 : n === want;
          return (
            <Pill key={l} tone={okCount ? 'teal' : 'muted'}>
              {l}: {n}
              {want !== undefined ? ` of ${want}` : ''} {okCount ? '✓' : ''}
            </Pill>
          );
        })}
        {suggested.length > 0 && (
          <Btn
            tone="ghost"
            size="sm"
            onClick={() => {
              setAssignment(seed());
              setRanks(seedRanks());
            }}
          >
            Use the suggestion
          </Btn>
        )}
      </div>

      {problems.map((p) => (
        <div key={p} style={ERR}>
          {p}
        </div>
      ))}
      {err && <div style={ERR}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Btn tone="teal" onClick={submit} disabled={!!problems.length || busy}>
          {busy ? 'Confirming…' : 'Confirm entrants'}
        </Btn>
        <Btn tone="outline" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/* ─── Stage card ─── */

function StageCard({
  stage,
  index,
  stageRun,
  materialisation,
  seriesById,
  registered,
  onConfirm,
  onGenerate,
  busy,
}: {
  stage: StageSpec;
  index: number;
  stageRun: StageRun | undefined;
  materialisation: StageMaterialisation;
  seriesById: (id: string) => Series | undefined;
  /** Every side currently registered for the league — for the drift check below. */
  registered: string[];
  onConfirm: () => void;
  onGenerate: () => void;
  busy: boolean;
}) {
  const [confirmRegen, setConfirmRegen] = useState(false);
  const generated = stageRun?.status === 'generated';
  const ready = materialisation.status === 'ready';
  const fits = ready && materialisation.fits;
  // Entrants were re-confirmed after generation, so the linked series still hold the old
  // groups. Say so rather than showing the new counts beside a "Released" pill.
  const staleEntrants =
    stageRun?.status === 'ready' && stageRun.groups.some((g) => g.seriesId !== undefined);

  // …and the same question asked of the FIXTURES, which catches what the entrants check
  // structurally cannot: re-confirming the POOL stage's finishing positions changes this
  // stage's cross-pool bracket without touching its own entrants. The stage stays
  // 'generated', so without this there is no "Needs regenerating" pill and no Generate
  // button — the admin's only escape was to remove a side, confirm, re-add it, confirm
  // again. Which is the workflow the Position column exists to serve.
  const fixtureKey = (fx: Array<{ round?: number; home?: string; away?: string; date?: string }>) =>
    JSON.stringify((fx ?? []).map((f) => [f?.round, f?.home, f?.away, f?.date]));
  const diverged =
    ready &&
    materialisation.groups.some((g) => {
      const sid = stageRun?.groups.find((x) => x.id === g.id)?.seriesId;
      const linked = sid ? seriesById(sid) : undefined;
      return !!linked && fixtureKey(g.fixtures) !== fixtureKey(linked.fixtures as never);
    });
  const stale = staleEntrants || diverged;

  // A confirmed grouping is frozen — deliberately, it is a human decision about this
  // season — so it stops tracking the league's registration list. A club that joins
  // afterwards is silently in no group; one that leaves is still in a group, reaches
  // `series.teams` but not `series.participants`, and renders as "Unknown team". Neither
  // is wrong to allow, but both have to be VISIBLE, with Edit entrants as the way out.
  const grouped = new Set((stageRun?.groups ?? []).flatMap((g) => g.entrants));
  const drift = stageRun?.groups.length
    ? {
        missing: registered.filter((t) => !grouped.has(t)).length,
        departed: [...grouped].filter((t) => !registered.includes(t)).length,
      }
    : null;

  // Regenerating rewrites the linked series IN PLACE, and `released` is deliberately not
  // reset — so a published schedule would change under clubs and players with no prompt.
  // Every comparable action in the console asks first; this one must too.
  const releasedLinked = (stageRun?.groups ?? [])
    .map((g) => (g.seriesId ? seriesById(g.seriesId) : undefined))
    .filter((s): s is Series => !!s?.released);
  const totalFixtures = materialisation.status === 'ready' ? materialisation.totalFixtures : 0;

  function requestGenerate() {
    if (stale && releasedLinked.length) setConfirmRegen(true);
    else onGenerate();
  }

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: 14,
        marginBottom: 10,
        background: 'var(--white, #fff)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--muted-2)', fontWeight: 700 }}>
          STAGE {index + 1}
        </span>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{stage.name}</span>
        {generated ? (
          <Pill tone="teal">Generated</Pill>
        ) : stale ? (
          <Pill tone="coral">Needs regenerating</Pill>
        ) : ready && fits ? (
          <Pill tone="muted">Ready to generate</Pill>
        ) : ready ? (
          <Pill tone="coral">Doesn’t fit</Pill>
        ) : (
          <Pill tone="muted">Awaiting entrants</Pill>
        )}
      </div>

      {materialisation.status === 'awaiting-entrants' ? (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
            {materialisation.reason}
          </div>
          <div style={{ marginTop: 10 }}>
            <Btn tone="teal" size="sm" onClick={onConfirm}>
              Confirm entrants
            </Btn>
          </div>
        </>
      ) : (
        <>
          {/* Why it doesn't fit. `g.plan.summary` below covers a block overrun, but a
              group too small to play anyone plans zero rounds — which "fits" any block —
              so without this the operator gets a bare "Doesn't fit" pill and no reason. */}
          {!fits && <div style={{ ...ERR, marginTop: 4 }}>{materialisation.summary}</div>}
          {materialisation.status === 'ready' && materialisation.crossPoolFallback && (
            <div style={{ ...HINT, color: 'var(--coral)', marginTop: 4 }}>
              {materialisation.crossPoolFallback}
            </div>
          )}
          {drift && (drift.missing > 0 || drift.departed > 0) && (
            <div style={{ ...HINT, color: 'var(--coral)', marginTop: 4 }}>
              {[
                drift.missing > 0 &&
                  `${drift.missing} registered side${drift.missing === 1 ? ' is' : 's are'} in no group`,
                drift.departed > 0 &&
                  `${drift.departed} side${drift.departed === 1 ? '' : 's'} in a group ${drift.departed === 1 ? 'is' : 'are'} no longer registered`,
              ]
                .filter(Boolean)
                .join(' · ')}{' '}
              — edit the entrants to bring this stage into line.
            </div>
          )}
          <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
            {materialisation.groups.map((g) => {
              const series = g.id && stageRun?.groups.find((x) => x.id === g.id)?.seriesId;
              const linked = series ? seriesById(series) : undefined;
              return (
                <div key={g.id} style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
                  <strong style={{ color: 'var(--ink)' }}>{g.label}</strong> · {g.entrants.length}{' '}
                  sides · {g.fixtures.length} fixture{g.fixtures.length === 1 ? '' : 's'}
                  {g.plan.dates.length > 0 && (
                    <>
                      {' '}
                      · {formatIsoDate(g.plan.dates[0])} →{' '}
                      {formatIsoDate(g.plan.dates[g.plan.dates.length - 1])}
                    </>
                  )}
                  {linked && (
                    <>
                      {' '}
                      ·{' '}
                      <Pill tone={linked.released ? 'teal' : 'muted'}>
                        {linked.released ? 'Released' : 'Draft'}
                      </Pill>
                    </>
                  )}
                  {!g.plan.fits && <div style={ERR}>{g.plan.summary}</div>}
                </div>
              );
            })}
          </div>
          {stale && (
            <p style={{ ...HINT, color: 'var(--coral)' }}>
              The entrants changed after these fixtures were generated — regenerate to bring the
              series into line.
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            {/* A GENERATED stage still offers Regenerate when its fixtures have drifted
                from the series they produced — otherwise an upstream change leaves the
                card showing one bracket and the clubs holding another, with no way back.
                The released-schedule confirmation covers the danger. */}
            {(!generated || diverged) && (
              <Btn tone="teal" size="sm" onClick={requestGenerate} disabled={!fits || busy}>
                {busy
                  ? 'Generating…'
                  : `${stale ? 'Regenerate' : 'Generate'} ${materialisation.totalFixtures} fixtures`}
              </Btn>
            )}
            <Btn tone="outline" size="sm" onClick={onConfirm}>
              {generated ? 'Change entrants' : 'Edit entrants'}
            </Btn>
          </div>
          {generated && (
            <p style={HINT}>
              Fixtures live as {materialisation.groups.length} series — approve and release them
              from the list above.
            </p>
          )}
        </>
      )}

      {(() => {
        const last = stageRun?.audit?.[stageRun.audit.length - 1];
        // `by`/`at` are stamped server-side, so both are blank on the optimistic entry
        // this client just pushed — showing "confirmed by  on " until the round trip
        // lands is worse than showing nothing.
        if (!last?.by || !last.at) return null;
        return (
          <p style={{ ...HINT, marginTop: 10 }}>
            {/* An INSTANT, so the local calendar day — slicing to its UTC day would
                report a 01:00 SAST confirmation as the day before. */}
            Entrants confirmed by {last.by} on {formatStampDay(last.at)}
            {last.accepted ? ' (accepted the suggestion)' : ' (overrode the suggestion)'}
          </p>
        );
      })()}

      {confirmRegen && (
        <Modal title="Regenerate a released schedule?" onClose={() => setConfirmRegen(false)}>
          <p style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 10px' }}>
            {releasedLinked.length === 1
              ? `“${releasedLinked[0].name}” has been RELEASED`
              : `${releasedLinked.length} of this stage's series have been RELEASED`}{' '}
            — clubs and players have already been sent those fixtures. Regenerating replaces them
            with {totalFixtures} new ones and there is no undo.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn tone="outline" size="sm" onClick={() => setConfirmRegen(false)}>
              Cancel
            </Btn>
            <Btn
              tone="coral"
              size="sm"
              onClick={() => {
                setConfirmRegen(false);
                onGenerate();
              }}
            >
              Replace the fixtures
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ─── Season run view ─── */

export interface GenerateGroupPayload {
  run: SeasonRun;
  stage: StageSpec;
  groupId: string;
  groupLabel: string;
  entrants: string[];
  fixtures: unknown[];
  startDate: string;
  league: League | undefined;
  competition: Competition | undefined;
}

export function SeasonRunsPanel({
  clubs,
  allLeagues,
  allSeries,
  runs,
  config,
  onCreateRun,
  onPatchRun,
  onGenerate,
  onDeleteRun,
  toast,
}: {
  clubs: Club[];
  allLeagues: League[];
  allSeries: Series[];
  runs: SeasonRun[];
  config: TenantConfig;
  onCreateRun: (run: SeasonRun) => Promise<void>;
  onPatchRun: (id: string, patch: Partial<SeasonRun>) => Promise<void>;
  onGenerate: (payloads: GenerateGroupPayload[], run: SeasonRun, stage: StageSpec) => Promise<void>;
  onDeleteRun: (id: string) => void;
  toast: Toast;
}) {
  const [starting, setStarting] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ run: SeasonRun; stage: StageSpec } | null>(null);
  const [busyStage, setBusyStage] = useState<string | null>(null);

  const active = runs.find((r) => r.id === activeId) ?? runs[0];
  const seriesById = (id: string) => allSeries.find((s) => s.id === id);

  const runContext = useMemo(() => {
    if (!active) return null;
    const league = findByKey(allLeagues, active.leagueKey) as League | undefined;
    const competition = league?.competitions?.find((c) => c.id === active.competitionId);
    const participants = leagueParticipants(clubs, active.leagueKey);
    const structure: CompetitionStructure = active.structureSnapshot;
    const calendar: SeasonCalendar = active.calendarSnapshot;
    const materialisations = structure.stages.map((stage, i) => {
      const stageRun = active.stages.find((s) => s.specId === stage.id);
      return materialiseStage({
        stage,
        calendar,
        context: {
          registered: participants.map((p) => p.teamId),
          seedOrder: participants.map((p) => p.teamId),
          confirmed: stageRun?.groups.length ? stageRun.groups.map((g) => g.entrants) : undefined,
        },
        crossPoolQualifiers: crossPoolQualifiersFor(stage, structure.stages[i - 1], active),
      });
    });
    return { league, competition, participants, structure, calendar, materialisations };
  }, [active, allLeagues, clubs]);

  async function confirmEntrants(
    run: SeasonRun,
    stage: StageSpec,
    groups: string[][],
    carriedPoints: Record<string, number>,
    prefill: string[][],
  ) {
    const labels = stage.groupLabels?.length
      ? stage.groupLabels
      : groups.map((_, i) => `Group ${i + 1}`);
    const accepted = JSON.stringify(prefill) === JSON.stringify(groups);
    const nextStages: StageRun[] = run.structureSnapshot.stages.map((s) => {
      const existing = run.stages.find((x) => x.specId === s.id);
      if (s.id !== stage.id)
        return existing ?? { specId: s.id, status: 'awaiting-entrants', groups: [] };
      // MEMBERSHIP changed, not order. Who plays whom is what makes generated fixtures
      // stale; a pure reorder is the admin supplying finishing positions for the
      // cross-pool draw, which the console explicitly asks them to do. Comparing the
      // ordered arrays turned that request into a coral "Needs regenerating" pill and
      // routed them into the "there is no undo" prompt for a released schedule that
      // hadn't changed at all.
      const asSets = (gs: string[][]) => JSON.stringify(gs.map((g) => [...g].sort()));
      const changed = asSets(existing?.groups?.map((g) => g.entrants) ?? []) !== asSets(groups);
      return {
        specId: s.id,
        // Re-confirming DIFFERENT entrants makes the generated fixtures stale, so the
        // stage drops back to 'ready' and the Generate button returns. Leaving it
        // 'generated' stranded the admin: the card showed the new groups next to a
        // released series still holding the old ones, with no way to regenerate.
        status: existing?.status === 'generated' && !changed ? 'generated' : 'ready',
        groups: groups.map((entrants, i) => ({
          id: `g${i + 1}`,
          label: labels[i] ?? `Group ${i + 1}`,
          entrants,
          seriesId: existing?.groups?.[i]?.seriesId,
        })),
        ...(Object.keys(carriedPoints).length ? { carriedPoints } : {}),
        // `by` and `at` are OVERWRITTEN server-side from the authenticated caller — a
        // client-supplied actor is worthless as a governance record. Only `prefill` and
        // `accepted` are genuinely ours to report: the server never saw the suggestion.
        audit: [...(existing?.audit ?? []), { at: '', by: '', prefill, accepted }],
      };
    });
    await onPatchRun(run.id, { stages: nextStages, version: run.version });
    setConfirming(null);
  }

  if (runs.length === 0) {
    return (
      <>
        <Card
          title="Seasons"
          sub="Run a league's competition through its stages — confirm who plays in each group, then generate that stage's fixtures."
        >
          <EmptyState
            icon={Icon.Shield}
            title="No season running"
            sub="Start a season to work through a structured competition stage by stage. A simple league can still use Create series."
            action={
              <Btn tone="teal" icon={Icon.Plus} onClick={() => setStarting(true)}>
                Start a season
              </Btn>
            }
          />
        </Card>
        {starting && (
          <Modal
            title={
              <>
                Start a <em>season</em>
              </>
            }
            onClose={() => setStarting(false)}
          >
            <StartSeasonForm
              clubs={clubs}
              allLeagues={allLeagues}
              config={config}
              existingRuns={runs}
              onCreate={onCreateRun}
              onClose={() => setStarting(false)}
              toast={toast}
            />
          </Modal>
        )}
      </>
    );
  }

  return (
    <>
      <Card
        title="Seasons"
        sub="Each stage confirms who plays, then generates its fixtures. A stage whose teams depend on earlier results waits for you."
        action={
          <Btn tone="teal" size="sm" icon={Icon.Plus} onClick={() => setStarting(true)}>
            Start a season
          </Btn>
        }
      >
        {runs.length > 1 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {runs.map((r) => {
              const lg = findByKey(allLeagues, r.leagueKey) as League | undefined;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setActiveId(r.id)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 999,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: '1px solid var(--line)',
                    background:
                      r.id === active?.id ? 'var(--brand-primary, #16332B)' : 'var(--paper)',
                    color: r.id === active?.id ? '#fff' : 'var(--muted)',
                  }}
                >
                  {lg?.label ?? r.leagueKey} · {r.seasonLabel}
                </button>
              );
            })}
          </div>
        )}

        {active && runContext && (
          <>
            <div
              style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}
            >
              <strong style={{ color: 'var(--ink)' }}>
                {runContext.league?.label ?? active.leagueKey} ·{' '}
                {runContext.competition?.label ?? ''}
              </strong>{' '}
              · {active.seasonLabel} · {runContext.structure.name} (v{runContext.structure.version})
              · {runContext.participants.length} sides registered
            </div>

            {runContext.structure.stages.map((stage, i) => (
              <StageCard
                key={stage.id}
                stage={stage}
                index={i}
                stageRun={active.stages.find((s) => s.specId === stage.id)}
                materialisation={runContext.materialisations[i]}
                seriesById={seriesById}
                registered={runContext.participants.map((p) => p.teamId)}
                busy={busyStage === stage.id}
                onConfirm={() => setConfirming({ run: active, stage })}
                onGenerate={async () => {
                  const m = runContext.materialisations[i];
                  // `fits` covers the empty-group case (see materialiseStage); re-check
                  // it here so a stale render can't push a dateless series through.
                  if (m.status !== 'ready' || !m.fits) return;
                  setBusyStage(stage.id);
                  try {
                    // withToast in the caller has already surfaced the failure; swallow
                    // the rejection here so it doesn't reach the console as unhandled.
                    await onGenerate(
                      m.groups.map((g) => ({
                        run: active,
                        stage,
                        groupId: g.id,
                        groupLabel: g.label,
                        entrants: g.entrants,
                        fixtures: g.fixtures,
                        // A `manual` stage plans no rounds by design, so it has no first
                        // date — fall back to the block it plays in rather than sending
                        // '', which becomes an empty `gsi1sk` that real DynamoDB rejects
                        // (dynalite accepts it, so no test would catch it) part-way
                        // through a loop that has already written the earlier groups.
                        startDate:
                          g.plan.dates[0] ??
                          findBlock(active.calendarSnapshot, stage.schedule.blockId)?.start ??
                          todayIso(),
                        league: runContext.league,
                        competition: runContext.competition,
                      })),
                      active,
                      stage,
                    ).catch(() => {});
                  } finally {
                    setBusyStage(null);
                  }
                }}
              />
            ))}

            <div style={{ marginTop: 12 }}>
              <Btn tone="ghost" size="sm" onClick={() => onDeleteRun(active.id)}>
                Delete this season
              </Btn>
              <p style={HINT}>
                Fixtures already generated are kept — deleting a season only removes the
                stage-by-stage tracking.
              </p>
            </div>
          </>
        )}
      </Card>

      {starting && (
        <Modal
          title={
            <>
              Start a <em>season</em>
            </>
          }
          onClose={() => setStarting(false)}
        >
          <StartSeasonForm
            clubs={clubs}
            allLeagues={allLeagues}
            config={config}
            existingRuns={runs}
            onCreate={onCreateRun}
            onClose={() => setStarting(false)}
            toast={toast}
          />
        </Modal>
      )}

      {confirming && runContext && (
        <Modal
          wide
          title={
            <>
              Confirm entrants · <em>{confirming.stage.name}</em>
            </>
          }
          onClose={() => setConfirming(null)}
        >
          <EntrantConfirmForm
            stage={confirming.stage}
            stageRun={confirming.run.stages.find((s) => s.specId === confirming.stage.id)}
            materialisation={
              runContext.materialisations[
                runContext.structure.stages.findIndex((s) => s.id === confirming.stage.id)
              ]
            }
            participants={runContext.participants}
            // Ask for finishing positions when the stage AFTER this one draws a
            // cross-pool bracket from it — then, and only then, the order inside each
            // group decides who plays whom.
            ranked={feedsCrossPool(confirming.stage, runContext.structure.stages)}
            onCancel={() => setConfirming(null)}
            onConfirm={(groups, carriedPoints) => {
              const m =
                runContext.materialisations[
                  runContext.structure.stages.findIndex((s) => s.id === confirming.stage.id)
                ];
              // The SAME expression the form shows as its suggestion. Reading only the
              // `awaiting-entrants` prefill recorded `prefill: []` and `accepted: false`
              // for every confirmation on a resolved stage — including every RE-confirm
              // of a manual one — so the audit trail said "overrode the suggestion"
              // about a suggestion it never stored. That trail is the whole reason this
              // flow asks a human.
              const prefill =
                m.status === 'awaiting-entrants'
                  ? m.prefill.map((g) => g.entrants)
                  : m.groups.map((g) => g.entrants);
              return confirmEntrants(
                confirming.run,
                confirming.stage,
                groups,
                carriedPoints,
                prefill,
              );
            }}
          />
        </Modal>
      )}
    </>
  );
}
