/**
 * Operator console — roster intake wizard (self-serve onboarding, 2.1).
 *
 * Turns a club's already-stored member database (parsed server-side from S3 — no
 * re-upload) into reviewed, committable player rows. Steps: clubs → review → commit,
 * mirroring the doc-intake wizard's shell (platform-intake.tsx) and leaning on the
 * same shared primitives (platform-wizard.tsx).
 *
 * ── WHY EVERY NUMBER COMES FROM roster-review.ts ──
 * Parse responses carry no client-computable "is this row committable" flag by
 * themselves — that depends on the operator's include/exclude decisions and the
 * cross-club duplicate resolution, both purely client-side state. `roster-review.ts`
 * (buildClubSummaries / detectCrossClubDuplicates / applyRosterDecision /
 * committableCounts) is the single source of truth for every count this file renders,
 * so the summary pills, the Continue-button count, and the commit batch never disagree.
 *
 * ── WHY allowMissingId/ageGroupMap EDITS RE-PARSE INSTEAD OF PROMOTING CLIENT-SIDE ──
 * `RosterIntakeException` carries no identity (no name/dob) by design (POPIA — an
 * exception a club excluded shouldn't leak PII into a client cache indefinitely), so
 * there is nothing to "promote" into a draft row client-side. Flipping the toggle or
 * remapping a band re-calls parse for that club with the new parse input; it's a few
 * seconds against one already-fetched workbook, not a re-upload.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { queryClient, qk } from './query';
import * as api from './api';
import { ApiError } from './api';
import { Btn, Card, EmptyState, Icon, Pill } from './atoms';
import { resolveDocMime } from './data';
import {
  BulkActionBar,
  ERR,
  HINT,
  InfoTip,
  ReviewCounters,
  StepIntro,
  formatBytes,
  useRowSelection,
} from './platform-wizard';
import {
  applyRosterDecision,
  buildClubSummaries,
  committableCounts,
  detectCrossClubDuplicates,
  isDuplicateGroupResolved,
  rosterRowKey,
  type ClubParseState,
  type ClubSummary,
  type CrossClubDuplicateGroup,
  type DuplicateCandidateRow,
  type RosterCommittableRow,
  type RosterDecisions,
} from './roster-review';
import type {
  AgeGroupRaw,
  InsightsClub,
  RequiredDoc,
  RosterDraftRow,
  RosterIntakeCommitItem,
  RosterIntakeCommitResponse,
  RosterIntakeParseResponse,
} from './types';
import { ROSTER_INTAKE_MAX_ITEMS } from './types';

type Toast = (m: string, t?: string) => void;

/* ─── Guidance copy (named consts — greppable, testable) ─── */

const INTRO_CLUBS =
  'Pick which clubs to parse. Only clubs with a member database on file can be parsed — ' +
  'the checkbox is disabled for the rest until one is added via document intake. Nothing ' +
  'is written yet; this step only reads each club’s stored file.';
const INTRO_REVIEW =
  'Nothing is written yet — check the parsed players below, resolve any cross-club ' +
  'duplicates, then commit on the next step.';
const INTRO_COMMIT =
  'Commits happen per club, in batches. A club that fails doesn’t block the others, ' +
  'and a failed batch can be retried without repeating the ones that already succeeded.';

const ALLOW_MISSING_ID_TIP =
  'Players without an ID number are harder to de-duplicate and to match in clearances ' +
  'later. Turn this on only when the club’s register genuinely has no ID column.';
const MASKED_ID_TIP =
  'ID numbers are shown masked by default. Reveal one only when you need to check it ' +
  'against the source document.';
const EXCLUDE_BOTH_TIP = 'Not sure? Exclude both — the player can register through the club later.';
const REPLACE_DB_TIP =
  'Uploads a new member database file for this club and replaces the one on record, ' +
  'then re-parses automatically. Use this when the review below shows the workbook needs ' +
  'a fix — edit the file locally, then replace it here instead of visiting document intake.';

const NOT_SUPPORTED_HINT = 'Add it via document intake →';

/* ─── docKeyForRole (client-side mirror) ───
 * The wizard gates on InsightsClub.intake (already role-resolved server-side), but the
 * "Replace member database" affordance needs the literal docKey to presign/commit
 * against — the operator's catalogue may have renamed/slugified it. Small, local
 * mirror of the server's docKeyForRole (catalogue.ts); not exported from api.ts/
 * types.ts (out of scope for this change) so it lives here. */
function docKeyForRole(
  requiredDocs: RequiredDoc[],
  role: 'memberDatabase' | 'committee',
): string | null {
  const hit = requiredDocs.find((d) => d.role === role && !d.archived);
  return hit?.key ?? null;
}

/* ─── Parse pool (3-concurrent) ─── */

type ClubParseStatus = 'idle' | 'queued' | 'parsing' | 'done' | 'error';

const PARSE_CONCURRENCY = 3;

/* ─── The wizard itself ─── */

export function RosterIntakeWizard({ toast }: { toast: Toast }) {
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

  const requiredDocs: RequiredDoc[] = configQ.data?.requiredDocs ?? [];
  const memberDbKey = useMemo(() => docKeyForRole(requiredDocs, 'memberDatabase'), [requiredDocs]);
  const juniorLeagueKeys = useMemo(
    () => (configQ.data?.leagues ?? []).map((l) => l.key).filter((k) => /^u\d+$/.test(k)),
    [configQ.data?.leagues],
  );

  const clubs: InsightsClub[] = overviewQ.data?.clubs ?? [];
  const sortedClubs = useMemo(
    () => [...clubs].sort((a, b) => a.name.localeCompare(b.name)),
    [clubs],
  );

  type Step = 'clubs' | 'review' | 'commit';
  const [step, setStep] = useState<Step>('clubs');

  // ── Clubs step ──
  const eligibleIds = useMemo(
    () =>
      new Set(sortedClubs.filter((c) => c.intake?.memberDatabase === 'parseable').map((c) => c.id)),
    [sortedClubs],
  );
  const [picked, setPicked] = useState<Set<string>>(new Set());
  function togglePick(id: string, on: boolean) {
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function selectAllEligible() {
    setPicked(new Set(eligibleIds));
  }

  // ── Per-club parse state (also drives the review step) ──
  const [parseStatus, setParseStatus] = useState<Record<string, ClubParseStatus>>({});
  const [parseError, setParseError] = useState<Record<string, string>>({});
  const [parseResult, setParseResult] = useState<Record<string, RosterIntakeParseResponse>>({});
  const [allowMissingId, setAllowMissingId] = useState<Record<string, boolean>>({});
  const [ageGroupMap, setAgeGroupMap] = useState<Record<string, Record<string, string>>>({});
  const autoSuggested = useRef<Set<string>>(new Set());

  const parseClub = useCallback(
    async (
      clubId: string,
      overrides?: { allowMissingId?: boolean; ageGroupMap?: Record<string, string> },
    ) => {
      setParseStatus((s) => ({ ...s, [clubId]: 'parsing' }));
      setParseError((s) => ({ ...s, [clubId]: '' }));
      try {
        const res = await api.platformRosterIntakeParse(slug, {
          clubId,
          allowMissingId: overrides?.allowMissingId ?? allowMissingId[clubId] ?? false,
          ageGroupMap: overrides?.ageGroupMap ?? ageGroupMap[clubId],
        });
        setParseResult((s) => ({ ...s, [clubId]: res }));
        setParseStatus((s) => ({ ...s, [clubId]: 'done' }));
        if (res.parseable) {
          const dobVariant =
            res.sheets.filter((sh) => !sh.skipped && sh.totalDataRows > 0).length > 0 &&
            res.sheets
              .filter((sh) => !sh.skipped && sh.totalDataRows > 0)
              .every((sh) => !sh.hasIdColumn);
          if (dobVariant && !autoSuggested.current.has(clubId)) {
            autoSuggested.current.add(clubId);
            setAllowMissingId((s) => (s[clubId] === undefined ? { ...s, [clubId]: true } : s));
          }
        }
      } catch (e) {
        setParseStatus((s) => ({ ...s, [clubId]: 'error' }));
        setParseError((s) => ({
          ...s,
          [clubId]: e instanceof ApiError ? e.message : 'Parse failed',
        }));
      }
    },
    [slug, allowMissingId, ageGroupMap],
  );

  async function runParsePool(ids: string[]) {
    setParseStatus((s) => {
      const next = { ...s };
      for (const id of ids) next[id] = 'queued';
      return next;
    });
    const queue = [...ids];
    async function worker() {
      let next: string | undefined;
      while ((next = queue.shift())) await parseClub(next);
    }
    await Promise.all(Array.from({ length: Math.min(PARSE_CONCURRENCY, queue.length) }, worker));
  }

  function reparseClub(clubId: string) {
    void parseClub(clubId);
  }

  function setClubAllowMissingId(clubId: string, on: boolean) {
    setAllowMissingId((s) => ({ ...s, [clubId]: on }));
    autoSuggested.current.add(clubId); // an explicit choice overrides future auto-suggest
    // Re-parse with the new input — exceptions carry no identity to promote client-side.
    // Pass the value explicitly rather than reading state: React batches the setState
    // above, so a same-tick reparse using the current closure's `allowMissingId` would
    // send the STALE value.
    void parseClub(clubId, { allowMissingId: on, ageGroupMap: ageGroupMap[clubId] });
  }
  function setClubAgeGroupMap(clubId: string, raw: string, leagueKey: string) {
    const nextMap = { ...(ageGroupMap[clubId] ?? {}), [raw]: leagueKey };
    setAgeGroupMap((s) => ({ ...s, [clubId]: nextMap }));
    void parseClub(clubId, {
      allowMissingId: allowMissingId[clubId] ?? false,
      ageGroupMap: nextMap,
    });
  }

  // ── Replace member database (per-club, launched from clubs/review hints) ──
  const [replacingClub, setReplacingClub] = useState<string | null>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [replaceBusy, setReplaceBusy] = useState<Record<string, boolean>>({});

  async function replaceMemberDatabase(clubId: string, file: File) {
    if (!memberDbKey) {
      toast('No document in the catalogue is marked as the member database', 'error');
      return;
    }
    setReplaceBusy((s) => ({ ...s, [clubId]: true }));
    try {
      const mime = resolveDocMime(file) || 'application/octet-stream';
      const presign = await api.platformDocIntakePresign(slug, [
        { clubId, docKey: memberDbKey, contentType: mime, size: file.size },
      ]);
      const item = presign.items[0];
      if (!item.ok) throw new ApiError(0, (item as { ok: false; error: string }).error);
      await api.uploadToPresigned(item.uploadUrl, file, item.contentType);
      const commit = await api.platformDocIntakeCommit(slug, [
        {
          clubId,
          docKey: memberDbKey,
          objectKey: item.objectKey,
          size: file.size,
          contentType: mime,
          sourceName: file.name,
        },
      ]);
      const mine = commit.clubs.find((c) => c.clubId === clubId);
      if (mine && !mine.ok) throw new ApiError(0, (mine as { ok: false; error: string }).error);
      queryClient.invalidateQueries({ queryKey: qk.platformTenantOverview(slug) });
      toast('Member database replaced — re-parsing');
      await parseClub(clubId);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not replace the file', 'error');
    } finally {
      setReplaceBusy((s) => ({ ...s, [clubId]: false }));
      setReplacingClub(null);
    }
  }

  // ── Review step derived data ──
  const clubParseStates: ClubParseState[] = useMemo(
    () =>
      sortedClubs
        .filter((c) => picked.has(c.id))
        .map((c) => ({
          clubId: c.id,
          clubName: c.name,
          parse: parseResult[c.id],
          allowMissingId: allowMissingId[c.id] ?? false,
        })),
    [sortedClubs, picked, parseResult, allowMissingId],
  );
  const summaries: ClubSummary[] = useMemo(
    () => buildClubSummaries(clubParseStates),
    [clubParseStates],
  );

  type FlatRow = RosterCommittableRow & DuplicateCandidateRow & { row: RosterDraftRow };
  const flatRows: FlatRow[] = useMemo(() => {
    const out: FlatRow[] = [];
    for (const c of clubParseStates) {
      if (!c.parse || !c.parse.parseable) continue;
      for (const sheet of c.parse.sheets) {
        for (const row of sheet.rows) {
          out.push({
            clubId: c.clubId,
            clubName: c.clubName,
            sheet: sheet.name,
            rowNumber: row.rowNumber,
            firstName: row.firstName,
            lastName: row.lastName,
            dob: row.dob,
            idNumber: row.idNumber,
            row,
          });
        }
      }
    }
    return out;
  }, [clubParseStates]);

  const duplicateGroups: CrossClubDuplicateGroup<FlatRow>[] = useMemo(
    () => detectCrossClubDuplicates(flatRows),
    [flatRows],
  );

  const [decisions, setDecisions] = useState<RosterDecisions>({});
  function decide(action: Parameters<typeof applyRosterDecision>[1]) {
    setDecisions((d) => applyRosterDecision(d, action));
  }
  const counts = useMemo(
    () => committableCounts(flatRows, decisions, duplicateGroups),
    [flatRows, decisions, duplicateGroups],
  );
  const allDuplicatesResolved = counts.unresolvedDuplicateGroups === 0;

  // Union of ageGroupRaws across selected clubs (attention-flagged where null).
  const ageGroupRaws: Array<AgeGroupRaw & { clubIds: string[] }> = useMemo(() => {
    const byRaw = new Map<string, { raw: string; leagueKey: string | null; clubIds: string[] }>();
    for (const c of clubParseStates) {
      if (!c.parse || !c.parse.parseable) continue;
      for (const ag of c.parse.ageGroupRaws) {
        const existing = byRaw.get(ag.raw);
        if (existing) existing.clubIds.push(c.clubId);
        else byRaw.set(ag.raw, { raw: ag.raw, leagueKey: ag.leagueKey, clubIds: [c.clubId] });
      }
    }
    return [...byRaw.values()];
  }, [clubParseStates]);

  const [maskReveal, setMaskReveal] = useState<Record<string, boolean>>({});
  const [expandedClub, setExpandedClub] = useState<string | null>(null);

  // ── Commit step ──
  type ClubCommitState = {
    status: 'pending' | 'committing' | 'done' | 'error';
    error?: string;
    result?: RosterIntakeCommitResponse;
  };
  const [commitState, setCommitState] = useState<Record<string, ClubCommitState>>({});
  const [committing, setCommitting] = useState(false);

  function afterServerWrite() {
    queryClient.invalidateQueries({ queryKey: qk.platformTenant(slug) });
    queryClient.invalidateQueries({ queryKey: qk.platformTenantOverview(slug) });
  }

  function itemsForClub(clubId: string): RosterIntakeCommitItem[] {
    return flatRows
      .filter((r) => r.clubId === clubId)
      .filter(
        (r) => (decisions[rosterRowKey(r.clubId, r.sheet, r.rowNumber)] ?? 'include') === 'include',
      )
      .map((r) => ({
        clubId: r.clubId,
        rowNumber: r.rowNumber,
        firstName: r.row.firstName,
        lastName: r.row.lastName,
        dob: r.row.dob,
        idNumber: r.row.idNumber,
        gender: r.row.gender,
        race: r.row.race,
        team: r.row.team,
      }));
  }

  async function commitClub(clubId: string) {
    const items = itemsForClub(clubId);
    if (!items.length) {
      setCommitState((s) => ({ ...s, [clubId]: { status: 'done', result: undefined } }));
      return;
    }
    setCommitState((s) => ({ ...s, [clubId]: { status: 'committing' } }));
    try {
      let merged: RosterIntakeCommitResponse | null = null;
      for (let i = 0; i < items.length; i += ROSTER_INTAKE_MAX_ITEMS) {
        const batch = items.slice(i, i + ROSTER_INTAKE_MAX_ITEMS);
        const res = await api.platformRosterIntakeCommit(slug, batch);
        merged = merged
          ? {
              batchId: res.batchId,
              created: merged.created + res.created,
              alreadyPresent: merged.alreadyPresent + res.alreadyPresent,
              crossClubConflicts: [...merged.crossClubConflicts, ...res.crossClubConflicts],
              playerCount: { ...merged.playerCount, ...res.playerCount },
            }
          : res;
      }
      setCommitState((s) => ({ ...s, [clubId]: { status: 'done', result: merged ?? undefined } }));
      afterServerWrite();
    } catch (e) {
      setCommitState((s) => ({
        ...s,
        [clubId]: { status: 'error', error: e instanceof ApiError ? e.message : 'Commit failed' },
      }));
    }
  }

  async function runCommitAll() {
    setCommitting(true);
    const clubIds = clubParseStates
      .map((c) => c.clubId)
      .filter((id) => itemsForClub(id).length > 0);
    for (const id of clubIds) await commitClub(id);
    setCommitting(false);
  }

  const allCommitConflicts = useMemo(
    () => Object.values(commitState).flatMap((s) => s.result?.crossClubConflicts ?? []),
    [commitState],
  );

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
            Platform / Clients / {configQ.data.branding?.name ?? slug} / Roster intake
          </div>
          <h1 className="ph-title">
            Roster <em>intake</em>
          </h1>
          <p className="ph-desc">
            Parse each club's stored member database into reviewed, committable players.
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

      {step === 'clubs' && (
        <Card title="1. Clubs" sub="Select which clubs to parse.">
          <StepIntro title="What this step does">{INTRO_CLUBS}</StepIntro>

          <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <Btn tone="outline" size="sm" onClick={selectAllEligible}>
              Select all with a stored database
            </Btn>
          </div>

          <div className="fix-table-wrap">
            <table className="fix-table">
              <thead>
                <tr>
                  <th style={{ width: 30 }}></th>
                  <th>Club</th>
                  <th style={{ width: 160 }}>Member database</th>
                  <th style={{ width: 130 }}>Status</th>
                  <th style={{ width: 90 }}></th>
                </tr>
              </thead>
              <tbody>
                {sortedClubs.map((c) => {
                  const eligible = c.intake?.memberDatabase === 'parseable';
                  const stale = c.intake?.memberDatabase === 'unparseable';
                  const absent = !c.intake || c.intake.memberDatabase === 'absent';
                  const status = parseStatus[c.id] ?? 'idle';
                  return (
                    <tr key={c.id}>
                      <td>
                        <input
                          type="checkbox"
                          disabled={!eligible}
                          checked={picked.has(c.id)}
                          onChange={(e) => togglePick(c.id, e.target.checked)}
                          aria-label={`Select ${c.name}`}
                        />
                      </td>
                      <td style={{ fontSize: 12.5, fontWeight: 600 }}>{c.name}</td>
                      <td>
                        {eligible && <Pill tone="teal">On file</Pill>}
                        {stale && <Pill tone="coral">Unparseable</Pill>}
                        {absent && (
                          <>
                            <Pill tone="muted">Absent</Pill>
                            <div style={{ marginTop: 4 }}>
                              <a
                                href={`/platform/tenants/${slug}/doc-intake`}
                                style={{ fontSize: 11.5 }}
                              >
                                {NOT_SUPPORTED_HINT}
                              </a>
                            </div>
                          </>
                        )}
                        {(stale || absent) && (
                          <div style={{ marginTop: 4 }}>
                            <Btn
                              tone="ghost"
                              size="sm"
                              disabled={replaceBusy[c.id]}
                              onClick={() => setReplacingClub(c.id)}
                            >
                              Replace member database
                            </Btn>
                            <InfoTip label="About replacing the member database">
                              {REPLACE_DB_TIP}
                            </InfoTip>
                          </div>
                        )}
                      </td>
                      <td>
                        {status === 'idle' && <Pill tone="muted">—</Pill>}
                        {(status === 'queued' || status === 'parsing') && (
                          <Pill tone="gold">{status === 'queued' ? 'Queued' : 'Parsing…'}</Pill>
                        )}
                        {status === 'done' && <Pill tone="teal">Parsed</Pill>}
                        {status === 'error' && (
                          <Pill tone="coral">{parseError[c.id] || 'Failed'}</Pill>
                        )}
                      </td>
                      <td>
                        {status === 'error' && (
                          <Btn tone="ghost" size="sm" onClick={() => reparseClub(c.id)}>
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

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <Btn
              tone="teal"
              size="sm"
              disabled={picked.size === 0}
              onClick={async () => {
                await runParsePool([...picked]);
                setStep('review');
              }}
            >
              Parse {picked.size} club{picked.size === 1 ? '' : 's'}
            </Btn>
          </div>
        </Card>
      )}

      {step === 'review' && (
        <>
          <Card title="2. Review" sub="Confirm parsed players, resolve duplicates.">
            <StepIntro title="What this step does">{INTRO_REVIEW}</StepIntro>

            <ReviewCounters
              counters={[
                { label: 'included', count: counts.includedRows, tone: 'teal' },
                { label: 'excluded', count: counts.excludedRows, tone: 'muted' },
                {
                  label: 'unresolved duplicates',
                  count: counts.unresolvedDuplicateGroups,
                  tone: counts.unresolvedDuplicateGroups > 0 ? 'coral' : 'muted',
                },
              ]}
            />

            <div style={{ marginTop: 16 }}>
              {summaries.map((s) => (
                <div
                  key={s.clubId}
                  style={{
                    border: '1px solid var(--line2)',
                    borderRadius: 8,
                    padding: 12,
                    marginBottom: 10,
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{s.clubName}</strong>
                    {!s.parseable && <Pill tone="coral">{s.reason ?? 'Not parsed'}</Pill>}
                    {s.parseable && (
                      <>
                        <Pill tone="muted">{s.validRowCount} parsed</Pill>
                        {s.template === 'dob-variant' && (
                          <Pill tone="gold">No ID column — DOB variant</Pill>
                        )}
                        {Object.entries(s.exceptionsByReason).map(([reason, n]) => (
                          <Pill key={reason} tone="coral">
                            {reason}: {n}
                          </Pill>
                        ))}
                        {s.unknownGenderRaw.map((g) => (
                          <Pill key={`g-${g}`} tone="gold">
                            unknown gender: {g}
                          </Pill>
                        ))}
                        {s.unknownRaceRaw.map((r) => (
                          <Pill key={`r-${r}`} tone="gold">
                            unknown race: {r}
                          </Pill>
                        ))}
                        <Btn
                          tone="ghost"
                          size="sm"
                          onClick={() =>
                            setExpandedClub(expandedClub === s.clubId ? null : s.clubId)
                          }
                        >
                          {expandedClub === s.clubId ? 'Hide detail' : 'Show detail'}
                        </Btn>
                        <Btn
                          tone="ghost"
                          size="sm"
                          disabled={replaceBusy[s.clubId]}
                          onClick={() => setReplacingClub(s.clubId)}
                        >
                          Replace member database
                        </Btn>
                      </>
                    )}
                  </div>

                  {s.parseable && (
                    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label
                        style={{
                          fontSize: 12,
                          display: 'inline-flex',
                          gap: 6,
                          alignItems: 'center',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={s.allowMissingId}
                          onChange={(e) => setClubAllowMissingId(s.clubId, e.target.checked)}
                        />
                        Allow players without an ID number
                      </label>
                      <InfoTip label="About allowing missing IDs">{ALLOW_MISSING_ID_TIP}</InfoTip>
                      <span style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>
                        {s.missingIdExceptionCount} missing-id row
                        {s.missingIdExceptionCount === 1 ? '' : 's'}
                      </span>
                    </div>
                  )}

                  {s.parseable && expandedClub === s.clubId && (
                    <div className="fix-table-wrap" style={{ marginTop: 10 }}>
                      <table className="fix-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>DOB</th>
                            <th>
                              ID <InfoTip label="About masked IDs">{MASKED_ID_TIP}</InfoTip>
                            </th>
                            <th>Team</th>
                            <th style={{ width: 90 }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {flatRows
                            .filter((r) => r.clubId === s.clubId)
                            .map((r) => {
                              const key = rosterRowKey(r.clubId, r.sheet, r.rowNumber);
                              const included = (decisions[key] ?? 'include') === 'include';
                              const revealed = !!maskReveal[key];
                              return (
                                <tr key={key}>
                                  <td style={{ fontSize: 12.5 }}>
                                    {r.row.firstName} {r.row.lastName}
                                  </td>
                                  <td style={{ fontSize: 12.5 }}>{r.row.dob}</td>
                                  <td style={{ fontSize: 12.5 }}>
                                    {r.row.idNumber ? (
                                      <>
                                        {revealed
                                          ? r.row.idNumber
                                          : `${r.row.idNumber.slice(0, 2)}${'*'.repeat(Math.max(0, r.row.idNumber.length - 4))}${r.row.idNumber.slice(-2)}`}
                                        <Btn
                                          tone="ghost"
                                          size="sm"
                                          onClick={() =>
                                            setMaskReveal((m) => ({ ...m, [key]: !m[key] }))
                                          }
                                        >
                                          {revealed ? 'Hide' : 'Reveal'}
                                        </Btn>
                                      </>
                                    ) : (
                                      <Pill tone="gold">No ID</Pill>
                                    )}
                                  </td>
                                  <td style={{ fontSize: 12.5 }}>{r.row.team ?? '—'}</td>
                                  <td>
                                    <Btn
                                      tone="ghost"
                                      size="sm"
                                      onClick={() =>
                                        decide({ type: included ? 'exclude' : 'include', key })
                                      }
                                    >
                                      {included ? 'Exclude' : 'Include'}
                                    </Btn>
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {ageGroupRaws.length > 0 && (
              <Card title="Junior age bands" sub="Confirm the league each raw age band maps to.">
                <div className="fix-table-wrap">
                  <table className="fix-table">
                    <thead>
                      <tr>
                        <th>Raw band</th>
                        <th style={{ width: 200 }}>League</th>
                        <th style={{ width: 80 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {ageGroupRaws.map((ag) => (
                        <tr key={ag.raw}>
                          <td style={{ fontSize: 12.5 }}>{ag.raw}</td>
                          <td>
                            <select
                              className="field-select"
                              value={ag.leagueKey ?? ''}
                              onChange={(e) => {
                                for (const clubId of ag.clubIds)
                                  setClubAgeGroupMap(clubId, ag.raw, e.target.value);
                              }}
                            >
                              <option value="">— pick a league —</option>
                              {juniorLeagueKeys.map((k) => (
                                <option key={k} value={k}>
                                  {k}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>{ag.leagueKey === null && <Pill tone="coral">Unmapped</Pill>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {duplicateGroups.length > 0 && (
              <Card
                title="Cross-club duplicates"
                sub="The same player appears to be claimed by more than one club — resolve before continuing."
              >
                {duplicateGroups.map((g) => {
                  const groupKeys = g.rows.map((r) => rosterRowKey(r.clubId, r.sheet, r.rowNumber));
                  const resolved = isDuplicateGroupResolved(g, decisions);
                  return (
                    <div
                      key={g.identityKey}
                      style={{
                        border: '1px solid var(--line2)',
                        borderRadius: 8,
                        padding: 12,
                        marginBottom: 10,
                        display: 'flex',
                        gap: 12,
                        flexWrap: 'wrap',
                        alignItems: 'center',
                      }}
                    >
                      {g.rows.map((r) => (
                        <div
                          key={rosterRowKey(r.clubId, r.sheet, r.rowNumber)}
                          style={{ fontSize: 12.5 }}
                        >
                          <strong>{r.clubName}</strong>: {r.firstName} {r.lastName} ({r.dob})
                          <Btn
                            tone="ghost"
                            size="sm"
                            onClick={() =>
                              decide({
                                type: 'keep-only',
                                groupKeys,
                                keep: rosterRowKey(r.clubId, r.sheet, r.rowNumber),
                              })
                            }
                          >
                            Keep in {r.clubName}
                          </Btn>
                        </div>
                      ))}
                      <Btn
                        tone="ghost"
                        size="sm"
                        onClick={() => decide({ type: 'exclude-group', groupKeys })}
                      >
                        Exclude both
                      </Btn>
                      <InfoTip label="Not sure what to do?">{EXCLUDE_BOTH_TIP}</InfoTip>
                      <Pill tone={resolved ? 'teal' : 'coral'}>
                        {resolved ? 'Resolved' : 'Unresolved'}
                      </Pill>
                    </div>
                  );
                })}
              </Card>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <Btn tone="outline" size="sm" onClick={() => setStep('clubs')}>
                Back
              </Btn>
              <Btn
                tone="teal"
                size="sm"
                disabled={!allDuplicatesResolved || counts.committable === 0}
                onClick={() => setStep('commit')}
              >
                Continue to commit ({counts.committable} player{counts.committable === 1 ? '' : 's'}
                )
              </Btn>
            </div>
          </Card>
        </>
      )}

      {step === 'commit' && (
        <Card title="3. Commit" sub="Writes players per club, in batches.">
          <StepIntro title="What this step does">{INTRO_COMMIT}</StepIntro>

          {allCommitConflicts.length > 0 && (
            <div
              style={{
                background: 'var(--coral-bg, #FDECEA)',
                border: '1px solid var(--coral, #C0392B)',
                borderRadius: 8,
                padding: 12,
                marginBottom: 12,
              }}
            >
              <strong style={{ fontSize: 12.5 }}>
                {allCommitConflicts.length} player{allCommitConflicts.length === 1 ? '' : 's'}{' '}
                excluded — already registered elsewhere
              </strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
                {allCommitConflicts.map((c, i) => (
                  <li key={i}>
                    Row {c.rowNumber} ({c.clubId}) — claimed by {c.claimedBy}
                    {c.alreadyRegisteredAt
                      ? ` (already registered at ${c.alreadyRegisteredAt})`
                      : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {Object.keys(commitState).length === 0 && !committing && (
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn tone="outline" size="sm" onClick={() => setStep('review')}>
                Back
              </Btn>
              <Btn tone="teal" size="sm" onClick={() => void runCommitAll()}>
                Start commit ({counts.committable} player{counts.committable === 1 ? '' : 's'})
              </Btn>
            </div>
          )}

          {Object.keys(commitState).length > 0 && (
            <div className="fix-table-wrap">
              <table className="fix-table">
                <thead>
                  <tr>
                    <th>Club</th>
                    <th style={{ width: 100 }}>Created</th>
                    <th style={{ width: 130 }}>Already present</th>
                    <th style={{ width: 130 }}>Player count</th>
                    <th style={{ width: 130 }}>Status</th>
                    <th style={{ width: 90 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(commitState).map(([clubId, cs]) => {
                    const club = clubs.find((c) => c.id === clubId);
                    return (
                      <tr key={clubId}>
                        <td style={{ fontSize: 12.5 }}>{club?.name ?? clubId}</td>
                        <td style={{ fontSize: 12.5 }}>{cs.result?.created ?? '—'}</td>
                        <td style={{ fontSize: 12.5 }}>{cs.result?.alreadyPresent ?? '—'}</td>
                        <td style={{ fontSize: 12.5 }}>{cs.result?.playerCount[clubId] ?? '—'}</td>
                        <td>
                          {cs.status === 'committing' && <Pill tone="gold">Committing…</Pill>}
                          {cs.status === 'done' && <Pill tone="teal">Done</Pill>}
                          {cs.status === 'error' && <Pill tone="coral">{cs.error}</Pill>}
                        </td>
                        <td>
                          {cs.status === 'error' && (
                            <Btn tone="ghost" size="sm" onClick={() => void commitClub(clubId)}>
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
          )}

          {Object.keys(commitState).length > 0 &&
            !committing &&
            Object.values(commitState).every(
              (s) => s.status === 'done' || s.status === 'error',
            ) && (
              <div style={{ marginTop: 16 }}>
                <Btn
                  tone="teal"
                  size="sm"
                  onClick={() => {
                    toast('Roster intake complete');
                    navigate(`/platform/tenants/${slug}/overview`);
                  }}
                >
                  Done — view overview
                </Btn>
              </div>
            )}
        </Card>
      )}

      {replacingClub && (
        <input
          ref={(el) => {
            replaceInputRef.current = el;
            el?.click();
          }}
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: 'none' }}
          aria-label="Replace member database file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            const clubId = replacingClub;
            if (file && clubId) void replaceMemberDatabase(clubId, file);
            else setReplacingClub(null);
          }}
        />
      )}
    </div>
  );
}
