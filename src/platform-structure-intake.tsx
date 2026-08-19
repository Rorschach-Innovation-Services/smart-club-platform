/**
 * Operator console — structure-intake wizard (self-serve onboarding, ADR 0010, plan
 * §2.2): turns a client's league-structure workbook into per-club team plans without
 * an engineer running the Titans-style import CLI.
 *
 * Parsing is entirely server-side (`structure-intake/parse` reads the uploaded
 * workbook with exceljs and returns bare sections — sheet/header/rows, NO league
 * mapping, NO club resolution). Everything from there — which league a section maps
 * to, which club a team row resolves to, what gets committed — is an operator
 * decision made here, driven by the pure functions in structure-review.ts (mirroring
 * intake-match.ts's split for the doc-intake wizard: this file is strictly the
 * DOM/network shell).
 *
 * FIVE STEPS: upload → sections → teams → plan → commit. Unlike doc-intake's two-in-one
 * screen, these are genuinely sequential — a team row can't resolve to anything until
 * its section has a league, and a plan can't be previewed until every row is settled.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { queryClient, qk } from './query';
import * as api from './api';
import { ApiError } from './api';
import { Btn, Card, EmptyState, Icon, Pill } from './atoms';
import { DISTRICTS } from './data';
import { OVERARCHING_DISTRICT, optionsGroupedByGroup, slugifyLeagueKey } from './leagues';
import { buildClubIndex } from './intake-match';
import {
  applyRowEdits,
  buildClubPlans,
  buildCommitPayload,
  buildTeamRows,
  clubHasExistingPlan,
  divisionWarning,
  draftKeyCollides,
  initialSectionAssignments,
  makeDraftLeague,
  sectionsReady,
  teamRowNeedsAttention,
  type SectionAssignment,
  type TeamRow,
} from './structure-review';
import {
  BulkActionBar,
  CreateClubModal,
  ERR,
  HINT,
  InfoTip,
  ReviewCounters,
  StepIntro,
  useRowSelection,
} from './platform-wizard';
import type {
  InsightsClub,
  League,
  StructureClubPlan,
  StructureIntakeCommitClubResult,
  StructureSection,
} from './types';

type Toast = (m: string, t?: string) => void;
type Step = 'upload' | 'sections' | 'teams' | 'plan' | 'commit';

/* ─── Guidance copy — named consts, greppable/testable per the plan's guidance rule ─── */

const UPLOAD_INTRO =
  'Upload the client’s league-structure workbook (the sheet listing every club’s ' +
  'teams per league/division). Nothing is written yet — this only reads the file and shows ' +
  'you what it found.';
const SECTIONS_INTRO =
  'Each block the workbook parser found is shown below as a section. Point every section at ' +
  'one of this client’s leagues, or Ignore it if it isn’t team data (a title row, a notes ' +
  'block). Several sections can point at the SAME league — divisions of one league map to ' +
  'the same league key here; division placement happens at season setup, not in this wizard.';
const TEAMS_INTRO =
  'Every team row from your assigned sections, matched to a club automatically where possible. ' +
  'Fix any row that needs a human — pick the right club, or exclude a corrupted row. Venue is ' +
  'the only text you can edit directly; everything else comes from the workbook.';
const PLAN_INTRO =
  'Nothing is written yet. This is exactly what committing will create for each club — check ' +
  'the counts and sides look right before continuing. A club that already has a team plan is ' +
  'excluded by default so you don’t silently overwrite it.';
const COMMIT_INTRO =
  'Writing club by club. A club’s new leagues are appended to this client’s league list ' +
  'first — if that fails, nothing else runs. Each club’s result is shown below; a failed ' +
  'club can be retried on its own without resubmitting the whole batch.';
const DEAD_END_TITLE = "This workbook layout isn't supported yet";
const DEAD_END_SUB =
  'No section-shaped blocks were found in any sheet. Send the pack to support — the ' +
  'engineer import CLI can still bring this client’s structure in while the parser learns ' +
  'this layout.';
const SUGGESTION_TIP =
  'The league picker prefilled its best guess from the section header. It stays flagged — ' +
  'and is NOT sent anywhere — until you’ve looked at it and either kept the choice or ' +
  'picked a different league.';
const IGNORE_SECTION_TIP =
  'Use this for a block that isn’t actually team data — a title row, a notes block, or a ' +
  'sub-header the parser picked up by mistake. Ignored sections are dropped entirely; none of ' +
  'their rows reach the teams step.';
const CREATE_LEAGUE_TIP =
  'Adds a league that doesn’t exist for this client yet. It stays a draft — nothing is ' +
  'saved to the client’s league list until you commit — but once committed, removing an ' +
  'unused league later is a manual clean-up in the league editor, not something this wizard undoes.';
const CONFIDENCE_TIP =
  'How sure the automatic matcher is that this is the right club. Anything under a perfect match ' +
  'is worth a second look — pick the right club from the list, or Create club… if it ' +
  'genuinely doesn’t exist yet.';
const OVERWRITE_TIP =
  'This club already has a team plan on record. Including it here REPLACES that plan wholesale ' +
  'with what you see below — leagues/teams not in this workbook are dropped for this club. ' +
  'Excluded by default so an existing plan is never silently overwritten.';

const STATUS_TONE: Record<'ready' | 'check' | 'excluded', string> = {
  ready: 'teal',
  check: 'gold',
  excluded: 'muted',
};

/* ─── Draft-league creation ─── */

function DraftLeagueModal({
  leagues,
  onClose,
  onCreated,
}: {
  leagues: League[];
  onClose: () => void;
  onCreated: (league: League) => void;
}) {
  const [label, setLabel] = useState('');
  const [group, setGroup] = useState('');
  const [district, setDistrict] = useState(OVERARCHING_DISTRICT);
  const [confirmedWarning, setConfirmedWarning] = useState(false);
  const [err, setErr] = useState('');

  const key = slugifyLeagueKey(label);
  const warning = label.trim() ? divisionWarning(label, leagues) : null;
  const collides = key ? draftKeyCollides(key, leagues) : false;

  function submit() {
    setErr('');
    if (!label.trim()) return setErr('League name is required');
    if (!group.trim()) return setErr('Group is required (used to organise the league picker)');
    if (collides) return setErr('A league with this name already exists for this client');
    if (warning && !confirmedWarning) return; // the warning banner's own checkbox gates this
    onCreated(makeDraftLeague(label, group, district));
  }

  return (
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" role="dialog" aria-modal="true" aria-label="Create league">
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Structure intake · New league</div>
            <div className="task-modal-head-title">
              Create <em>{label || 'league'}</em>
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <p style={HINT}>
            A draft, client-side only — nothing is saved until you commit the whole wizard.
          </p>
          <div className="field-label" style={{ marginTop: 12 }}>
            League name <span className="req">*</span>
          </div>
          <input
            className="field-input"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              setConfirmedWarning(false);
            }}
            maxLength={80}
          />
          <div className="field-label" style={{ marginTop: 12 }}>
            Group <span className="req">*</span>
          </div>
          <input
            className="field-input"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="e.g. Overarching Leagues"
            maxLength={60}
          />
          <div className="field-label" style={{ marginTop: 12 }}>
            District
          </div>
          <select
            className="field-select"
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
          >
            <option value={OVERARCHING_DISTRICT}>{OVERARCHING_DISTRICT}</option>
            {DISTRICTS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>

          {warning && (
            <div
              style={{
                ...ERR,
                background: 'var(--paper)',
                border: '1px solid var(--coral, #C0392B)',
                borderRadius: 8,
                padding: 10,
                marginTop: 12,
              }}
            >
              <p style={{ margin: 0 }}>
                "{label}" looks like a division of the existing league "{warning.label}" — divisions
                of one league should map to that SAME league in the sections step, not a new one.
              </p>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={confirmedWarning}
                  onChange={(e) => setConfirmedWarning(e.target.checked)}
                />
                Create it anyway — this is genuinely a separate league
              </label>
            </div>
          )}
          {err && <div style={{ ...ERR, marginTop: 12 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <Btn
              tone="teal"
              size="sm"
              onClick={submit}
              disabled={
                !label.trim() || !group.trim() || collides || (!!warning && !confirmedWarning)
              }
            >
              Create league
            </Btn>
            <Btn tone="outline" size="sm" onClick={onClose}>
              Cancel
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── The wizard itself ─── */

export function StructureIntakeWizard({ toast }: { toast: Toast }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();

  const configQ = useQuery({
    queryKey: qk.platformTenant(slug),
    queryFn: () => api.platformGetTenant(slug),
    retry: 0,
  });
  const overviewQ = useQuery({
    queryKey: qk.platformTenantOverview(slug),
    queryFn: () => api.platformTenantOverview(slug),
    retry: 0,
  });

  const [clubs, setClubs] = useState<InsightsClub[]>([]);
  useMemo(() => {
    if (overviewQ.data) setClubs(overviewQ.data.clubs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overviewQ.data]);
  const clubsById = useMemo(() => new Map(clubs.map((c) => [c.id, c])), [clubs]);
  const clubIndex = useMemo(() => buildClubIndex(clubs), [clubs]);
  const sortedClubs = useMemo(
    () => [...clubs].sort((a, b) => a.name.localeCompare(b.name)),
    [clubs],
  );

  const tenantLeagues = configQ.data?.leagues ?? [];
  const [draftLeagues, setDraftLeagues] = useState<League[]>([]);
  const allLeagues = useMemo(
    () => [...tenantLeagues, ...draftLeagues],
    [tenantLeagues, draftLeagues],
  );
  const leagueGroups = useMemo(() => optionsGroupedByGroup(allLeagues), [allLeagues]);

  const [step, setStep] = useState<Step>('upload');

  // ── Upload ──
  const [parsing, setParsing] = useState(false);
  const [parseErr, setParseErr] = useState('');
  const [sections, setSections] = useState<StructureSection[] | null>(null);
  const [assignments, setAssignments] = useState<SectionAssignment[]>([]);

  async function onUpload(file: File) {
    setParseErr('');
    setParsing(true);
    try {
      const res = await api.platformStructureIntakeParse(slug, file);
      setSections(res.sections);
      setAssignments(initialSectionAssignments(res.sections, allLeagues));
      if (res.sections.length > 0) setStep('sections');
    } catch (e) {
      setParseErr(e instanceof ApiError ? e.message : 'Could not read that workbook — try again');
    } finally {
      setParsing(false);
    }
  }

  // ── Sections ──
  const [createLeagueFor, setCreateLeagueFor] = useState<number | null>(null);
  function setSectionLeague(i: number, leagueKey: string | null) {
    setAssignments((a) =>
      a.map((x, idx) => (idx === i ? { ...x, leagueKey, confirmed: true } : x)),
    );
  }
  function setSectionIgnored(i: number, ignored: boolean) {
    setAssignments((a) => a.map((x, idx) => (idx === i ? { ...x, ignored } : x)));
  }

  // ── Teams ──
  const teamRowsBase = useMemo<TeamRow[]>(
    () => (sections ? buildTeamRows(sections, assignments, clubIndex) : []),
    [sections, assignments, clubIndex],
  );
  const [clubEdits, setClubEdits] = useState<Record<string, string | null>>({});
  const [excludedRows, setExcludedRows] = useState<Set<string>>(new Set());
  const [venueEdits, setVenueEdits] = useState<Record<string, string>>({});
  const teamRows = useMemo<TeamRow[]>(() => {
    const applied = applyRowEdits(teamRowsBase, clubEdits, excludedRows);
    return applied.map((r) =>
      venueEdits[r.id] !== undefined ? { ...r, venue: venueEdits[r.id] } : r,
    );
  }, [teamRowsBase, clubEdits, excludedRows, venueEdits]);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [createClubFor, setCreateClubFor] = useState<TeamRow | null>(null);
  const visibleRows = attentionOnly ? teamRows.filter(teamRowNeedsAttention) : teamRows;
  const selection = useRowSelection(visibleRows.map((r) => r.id));
  const [bulkClub, setBulkClub] = useState('');

  function setRowClub(id: string, clubId: string | null) {
    setClubEdits((e) => ({ ...e, [id]: clubId }));
  }
  function setRowExcluded(id: string, on: boolean) {
    setExcludedRows((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function applyBulkClub() {
    if (!bulkClub) return;
    for (const id of selection.selected) setRowClub(id, bulkClub);
  }

  const includedRows = teamRows.filter((r) => !r.excluded);
  const matchedCount = includedRows.filter((r) => r.clubId).length;
  const attentionCount = teamRows.filter(teamRowNeedsAttention).length;
  const excludedCount = teamRows.filter((r) => r.excluded).length;

  // ── Plan ──
  const clubPlans = useMemo<Record<string, StructureClubPlan>>(
    () => (sections ? buildClubPlans(teamRows, assignments) : {}),
    [teamRows, assignments, sections],
  );
  const [planIncludedOverride, setPlanIncludedOverride] = useState<Record<string, boolean>>({});
  function planIncluded(clubId: string): boolean {
    const override = planIncludedOverride[clubId];
    if (override !== undefined) return override;
    const club = clubsById.get(clubId);
    return !club || !clubHasExistingPlan(club);
  }
  const overwriteByClub = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const clubId of Object.keys(clubPlans)) {
      const club = clubsById.get(clubId);
      if (club && clubHasExistingPlan(club) && planIncluded(clubId)) out[clubId] = true;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubPlans, clubsById, planIncludedOverride]);
  const plannedClubIds = Object.keys(clubPlans);
  const includedClubIds = plannedClubIds.filter(planIncluded);
  const commitPayload = useMemo(() => {
    const includedPlans: Record<string, StructureClubPlan> = {};
    for (const id of includedClubIds) includedPlans[id] = clubPlans[id];
    return buildCommitPayload(includedPlans, overwriteByClub, draftLeagues);
  }, [includedClubIds, clubPlans, overwriteByClub, draftLeagues]);

  // ── Commit ──
  const [committing, setCommitting] = useState(false);
  const [commitErr, setCommitErr] = useState('');
  const [batchId, setBatchId] = useState('');
  const [leaguesAppended, setLeaguesAppended] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, StructureIntakeCommitClubResult>>({});

  function afterServerWrite() {
    queryClient.invalidateQueries({ queryKey: qk.platformTenant(slug) });
    queryClient.invalidateQueries({ queryKey: qk.platformTenantOverview(slug) });
  }

  async function runCommit() {
    setCommitting(true);
    setCommitErr('');
    try {
      const res = await api.platformStructureIntakeCommit(slug, commitPayload);
      setBatchId(res.batchId);
      setLeaguesAppended(res.leaguesAppended);
      setResults(Object.fromEntries(res.clubs.map((c) => [c.clubId, c])));
      afterServerWrite();
    } catch (e) {
      setCommitErr(e instanceof ApiError ? e.message : 'Commit failed — nothing was written');
    } finally {
      setCommitting(false);
    }
  }

  async function retryClub(clubId: string) {
    const plan = clubPlans[clubId];
    if (!plan) return;
    try {
      // Leagues were already appended by the first attempt (if any) — never resend
      // newLeagues on a single-club retry.
      const res = await api.platformStructureIntakeCommit(slug, {
        clubs: [{ clubId, ...(overwriteByClub[clubId] ? { overwrite: true as const } : {}), plan }],
      });
      const mine = res.clubs.find((c) => c.clubId === clubId);
      if (mine) setResults((r) => ({ ...r, [clubId]: mine }));
      afterServerWrite();
      toast(`${clubsById.get(clubId)?.name ?? clubId} retried`);
    } catch (e) {
      setResults((r) => ({
        ...r,
        [clubId]: {
          clubId,
          ok: false,
          error: e instanceof ApiError ? e.message : 'Retry failed',
        },
      }));
    }
  }

  const commitDone = Object.keys(results).length > 0 && !committing;
  const okCount = Object.values(results).filter((r) => r.ok).length;
  const failCount = Object.values(results).filter((r) => !r.ok).length;

  if (configQ.isLoading || overviewQ.isLoading)
    return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading client…</p>;
  if (configQ.isError || overviewQ.isError || !configQ.data || !overviewQ.data)
    return (
      <div>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 14 }}>
          Could not load this client — refresh to retry.
        </p>
        <Btn tone="outline" size="sm" onClick={() => navigate(`/platform/tenants/${slug}`)}>
          Back to settings
        </Btn>
      </div>
    );

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">
            Platform / Clients / {configQ.data.branding?.name ?? slug} / Structure intake
          </div>
          <h1 className="ph-title">
            League structure <em>intake</em>
          </h1>
          <p className="ph-desc">
            Turn a client's league-structure workbook into per-club team plans without an engineer
            running the import script.
          </p>
        </div>
        <div className="ph-actions">
          <Btn
            tone="outline"
            size="sm"
            onClick={() => navigate(`/platform/tenants/${slug}/onboarding`)}
          >
            Back to onboarding
          </Btn>
          <Btn tone="outline" size="sm" onClick={() => navigate(`/platform/tenants/${slug}`)}>
            Back to settings
          </Btn>
        </div>
      </div>

      {step === 'upload' && (
        <Card title="1. Upload the workbook">
          <StepIntro title="What this step does">{UPLOAD_INTRO}</StepIntro>
          <input
            type="file"
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            disabled={parsing}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onUpload(f);
            }}
          />
          {parsing && <p style={HINT}>Reading workbook…</p>}
          {parseErr && <div style={{ ...ERR, marginTop: 12 }}>{parseErr}</div>}

          {sections && sections.length === 0 && (
            <div style={{ marginTop: 16 }}>
              <EmptyState icon={Icon.Alert} title={DEAD_END_TITLE} sub={DEAD_END_SUB} />
            </div>
          )}
        </Card>
      )}

      {step === 'sections' && sections && (
        <Card title="2. Sections">
          <StepIntro title="What this step does">{SECTIONS_INTRO}</StepIntro>
          <div className="fix-table-wrap">
            <table className="fix-table">
              <thead>
                <tr>
                  <th>Section</th>
                  <th style={{ width: 70, textAlign: 'right' }}>Rows</th>
                  <th style={{ width: 260 }}>League</th>
                  <th style={{ width: 110 }}></th>
                </tr>
              </thead>
              <tbody>
                {sections.map((s, i) => {
                  const a = assignments[i];
                  const showCheck = !!a?.leagueKey && !a.confirmed;
                  return (
                    <tr key={`${s.sheet}:${s.header}:${i}`}>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 12.5 }}>{s.header}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>{s.sheet}</div>
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12 }}>{s.rows.length}</td>
                      <td>
                        {a?.ignored ? (
                          <Pill tone="muted">Ignored</Pill>
                        ) : (
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <select
                              className="field-select"
                              style={{ width: '100%' }}
                              value={a?.leagueKey ?? ''}
                              onChange={(e) => setSectionLeague(i, e.target.value || null)}
                            >
                              <option value="">— pick a league —</option>
                              {Object.entries(leagueGroups).map(([group, opts]) => (
                                <optgroup key={group} label={group}>
                                  {opts.map((l: League) => (
                                    <option key={l.key} value={l.key}>
                                      {l.label}
                                    </option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                            {showCheck && (
                              <span
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
                              >
                                <Pill tone="gold">Check</Pill>
                                <InfoTip label="What does the Check pill mean?">
                                  {SUGGESTION_TIP}
                                </InfoTip>
                              </span>
                            )}
                          </div>
                        )}
                        <Btn tone="ghost" size="sm" onClick={() => setCreateLeagueFor(i)}>
                          Create league…
                        </Btn>
                        <InfoTip label="What does Create league do?">{CREATE_LEAGUE_TIP}</InfoTip>
                      </td>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Btn
                            tone="ghost"
                            size="sm"
                            onClick={() => setSectionIgnored(i, !a?.ignored)}
                          >
                            {a?.ignored ? 'Un-ignore' : 'Ignore'}
                          </Btn>
                          <InfoTip label="What does Ignore do?">{IGNORE_SECTION_TIP}</InfoTip>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p style={HINT}>
            Divisions of one league map to the SAME league here — division placement happens at
            season setup, not in this wizard.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <Btn tone="outline" size="sm" onClick={() => setStep('upload')}>
              Back
            </Btn>
            <Btn
              tone="teal"
              size="sm"
              disabled={!sectionsReady(assignments)}
              onClick={() => setStep('teams')}
            >
              Continue to teams
            </Btn>
          </div>
        </Card>
      )}

      {step === 'teams' && (
        <Card title="3. Teams">
          <StepIntro title="What this step does">{TEAMS_INTRO}</StepIntro>
          <div
            style={{
              display: 'flex',
              gap: 10,
              flexWrap: 'wrap',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <ReviewCounters
              counters={[
                { label: 'matched', count: matchedCount, tone: 'teal' },
                { label: 'need attention', count: attentionCount, tone: 'gold' },
                { label: 'excluded', count: excludedCount, tone: 'muted' },
              ]}
            />
            <label
              style={{
                fontSize: 12,
                display: 'inline-flex',
                gap: 6,
                alignItems: 'center',
                marginLeft: 'auto',
              }}
            >
              <input
                type="checkbox"
                checked={attentionOnly}
                onChange={(e) => setAttentionOnly(e.target.checked)}
              />
              Show only rows needing attention
            </label>
          </div>

          <BulkActionBar count={selection.selected.size}>
            <select
              className="field-select"
              style={{ width: 200 }}
              value={bulkClub}
              onChange={(e) => setBulkClub(e.target.value)}
            >
              <option value="">— pick a club —</option>
              {sortedClubs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Btn tone="outline" size="sm" disabled={!bulkClub} onClick={applyBulkClub}>
              Assign club to selected
            </Btn>
            <Btn
              tone="ghost"
              size="sm"
              onClick={() => selection.selected.forEach((id) => setRowExcluded(id, true))}
            >
              Exclude selected
            </Btn>
            <Btn
              tone="ghost"
              size="sm"
              onClick={() => selection.selected.forEach((id) => setRowExcluded(id, false))}
            >
              Include selected
            </Btn>
          </BulkActionBar>

          {visibleRows.length === 0 ? (
            <EmptyState
              icon={Icon.Check}
              title="Nothing to show"
              sub="No rows match the current filter."
            />
          ) : (
            <div className="fix-table-wrap">
              <table className="fix-table">
                <thead>
                  <tr>
                    <th style={{ width: 30 }}>
                      <input
                        type="checkbox"
                        checked={selection.allSelected}
                        onChange={(e) => selection.toggleAll(e.target.checked)}
                      />
                    </th>
                    <th>Team (workbook)</th>
                    <th style={{ width: 220 }}>
                      Club <InfoTip label="How is Club decided?">{CONFIDENCE_TIP}</InfoTip>
                    </th>
                    <th style={{ width: 180 }}>Venue</th>
                    <th style={{ width: 110 }}></th>
                    <th style={{ width: 70 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const club = row.clubId ? clubsById.get(row.clubId) : undefined;
                    const flagged = !!row.clubId && row.clubConfidence < 1;
                    return (
                      <tr key={row.id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selection.selected.has(row.id)}
                            onChange={(e) => selection.toggle(row.id, e.target.checked)}
                          />
                        </td>
                        <td style={{ fontSize: 12.5 }}>{row.raw}</td>
                        <td>
                          <select
                            className="field-select"
                            style={{ width: '100%' }}
                            value={row.clubId ?? ''}
                            onChange={(e) => setRowClub(row.id, e.target.value || null)}
                          >
                            <option value="">— pick a club —</option>
                            {sortedClubs.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          {!row.clubId && (
                            <Btn tone="ghost" size="sm" onClick={() => setCreateClubFor(row)}>
                              Create club…
                            </Btn>
                          )}
                        </td>
                        <td>
                          <input
                            className="field-input"
                            value={row.venue ?? ''}
                            onChange={(e) =>
                              setVenueEdits((v) => ({ ...v, [row.id]: e.target.value }))
                            }
                            placeholder="Venue"
                          />
                        </td>
                        <td>
                          {row.excluded ? (
                            <Pill tone="muted">Excluded</Pill>
                          ) : !row.clubId ? (
                            <Pill tone="gold">Pick a club</Pill>
                          ) : flagged ? (
                            <Pill tone="gold">Check this</Pill>
                          ) : (
                            <Pill tone="teal">Matched — {club?.name ?? row.clubId}</Pill>
                          )}
                        </td>
                        <td>
                          <Btn
                            tone="ghost"
                            size="sm"
                            onClick={() => setRowExcluded(row.id, !row.excluded)}
                          >
                            {row.excluded ? 'Include' : 'Exclude'}
                          </Btn>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <Btn tone="outline" size="sm" onClick={() => setStep('sections')}>
              Back
            </Btn>
            <Btn
              tone="teal"
              size="sm"
              disabled={includedRows.length === 0}
              onClick={() => setStep('plan')}
            >
              Continue to plan
            </Btn>
          </div>
        </Card>
      )}

      {step === 'plan' && (
        <Card title="4. Plan preview">
          <StepIntro title="What this step does">{PLAN_INTRO}</StepIntro>
          {plannedClubIds.length === 0 ? (
            <EmptyState
              icon={Icon.Alert}
              title="Nothing to commit"
              sub="No matched, included team rows resolved to a club plan — go back and fix the teams step."
            />
          ) : (
            <div className="fix-table-wrap">
              <table className="fix-table">
                <thead>
                  <tr>
                    <th>Club</th>
                    <th style={{ width: 80, textAlign: 'right' }}>Teams</th>
                    <th style={{ width: 80, textAlign: 'right' }}>Women</th>
                    <th style={{ width: 80, textAlign: 'right' }}>Juniors</th>
                    <th style={{ width: 160 }}>Leagues</th>
                    <th style={{ width: 200 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {plannedClubIds.map((clubId) => {
                    const plan = clubPlans[clubId];
                    const club = clubsById.get(clubId);
                    const existing = club ? clubHasExistingPlan(club) : false;
                    const included = planIncluded(clubId);
                    const teams = Object.values(plan.leagueTeams).reduce((n, c) => n + c, 0);
                    const women = Object.entries(plan.leagueTeams)
                      .filter(([k]) => k.startsWith('womens-'))
                      .reduce((n, [, c]) => n + c, 0);
                    const juniors = Object.entries(plan.leagueTeams)
                      .filter(([k]) => /^u\d+$/.test(k))
                      .reduce((n, [, c]) => n + c, 0);
                    return (
                      <tr key={clubId}>
                        <td style={{ fontSize: 12.5, fontWeight: 600 }}>{club?.name ?? clubId}</td>
                        <td style={{ textAlign: 'right', fontSize: 12 }}>{teams}</td>
                        <td style={{ textAlign: 'right', fontSize: 12 }}>{women}</td>
                        <td style={{ textAlign: 'right', fontSize: 12 }}>{juniors}</td>
                        <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                          {plan.leagues.join(', ')}
                        </td>
                        <td>
                          {existing && (
                            <div
                              style={{
                                display: 'flex',
                                gap: 4,
                                alignItems: 'center',
                                flexWrap: 'wrap',
                              }}
                            >
                              <Pill tone={included ? 'coral' : 'muted'}>
                                {included
                                  ? 'Replaces existing plan'
                                  : 'Excluded — has existing plan'}
                              </Pill>
                              <InfoTip label="What does replacing mean?">{OVERWRITE_TIP}</InfoTip>
                              <Btn
                                tone="ghost"
                                size="sm"
                                onClick={() =>
                                  setPlanIncludedOverride((o) => ({ ...o, [clubId]: !included }))
                                }
                              >
                                {included ? 'Exclude' : 'Include anyway'}
                              </Btn>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <Btn tone="outline" size="sm" onClick={() => setStep('teams')}>
              Back
            </Btn>
            <Btn
              tone="teal"
              size="sm"
              disabled={includedClubIds.length === 0}
              onClick={() => setStep('commit')}
            >
              Continue to commit ({includedClubIds.length} club
              {includedClubIds.length === 1 ? '' : 's'})
            </Btn>
          </div>
        </Card>
      )}

      {step === 'commit' && (
        <Card title="5. Commit">
          <StepIntro title="What this step does">{COMMIT_INTRO}</StepIntro>
          {Object.keys(results).length === 0 && !committing && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Btn tone="outline" size="sm" onClick={() => setStep('plan')}>
                Back
              </Btn>
              <Btn tone="teal" size="sm" onClick={() => void runCommit()}>
                Commit ({includedClubIds.length} club{includedClubIds.length === 1 ? '' : 's'})
              </Btn>
            </div>
          )}
          {committing && <p style={HINT}>Writing…</p>}
          {commitErr && <div style={{ ...ERR, marginTop: 12 }}>{commitErr}</div>}

          {Object.keys(results).length > 0 && (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <Pill tone="teal">{okCount} committed</Pill>
                <Pill tone="coral">{failCount} failed</Pill>
                {leaguesAppended.length > 0 && (
                  <Pill tone="muted">{leaguesAppended.length} league(s) appended</Pill>
                )}
                {batchId && <Pill tone="muted">batch {batchId}</Pill>}
              </div>
              <div className="fix-table-wrap">
                <table className="fix-table">
                  <thead>
                    <tr>
                      <th>Club</th>
                      <th style={{ width: 90, textAlign: 'right' }}>Teams</th>
                      <th style={{ width: 200 }}>Result</th>
                      <th style={{ width: 70 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {includedClubIds.map((clubId) => {
                      const r = results[clubId];
                      const club = clubsById.get(clubId);
                      return (
                        <tr key={clubId}>
                          <td style={{ fontSize: 12.5 }}>{club?.name ?? clubId}</td>
                          <td style={{ textAlign: 'right', fontSize: 12 }}>{r?.teams ?? '—'}</td>
                          <td>
                            {r ? (
                              <Pill tone={r.ok ? 'teal' : 'coral'}>
                                {r.ok ? 'Committed' : r.error || 'Failed'}
                              </Pill>
                            ) : (
                              <Pill tone="muted">—</Pill>
                            )}
                          </td>
                          <td>
                            {r && !r.ok && (
                              <Btn tone="ghost" size="sm" onClick={() => void retryClub(clubId)}>
                                Retry
                              </Btn>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {commitDone && (
                <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line2)' }}>
                  <Btn
                    tone="teal"
                    size="sm"
                    onClick={() => {
                      toast('Structure intake complete');
                      navigate(`/platform/tenants/${slug}/overview`);
                    }}
                  >
                    Done — view overview
                  </Btn>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {createLeagueFor !== null && (
        <DraftLeagueModal
          leagues={allLeagues}
          onClose={() => setCreateLeagueFor(null)}
          onCreated={(league) => {
            setDraftLeagues((ls) => [...ls, league]);
            setSectionLeague(createLeagueFor, league.key);
            setCreateLeagueFor(null);
            toast(`${league.label} created — assigned to this section`);
          }}
        />
      )}

      {createClubFor &&
        (() => {
          const target = createClubFor;
          return (
            <CreateClubModal
              slug={slug}
              initialName={target.raw}
              districts={configQ.data?.districts?.length ? configQ.data.districts : DISTRICTS}
              eyebrow="Structure intake · New club"
              onClose={() => setCreateClubFor(null)}
              onCreated={(club) => {
                setClubs((cs) => [...cs, club as unknown as InsightsClub]);
                setRowClub(target.id, club.id);
                setCreateClubFor(null);
                toast(`${club.name} created — row re-matched`);
              }}
            />
          );
        })()}
    </div>
  );
}
