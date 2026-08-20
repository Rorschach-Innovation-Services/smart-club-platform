/**
 * Operator console — onboarding checklist (self-serve onboarding, 2.4).
 *
 * Supersedes SetupCard for the JOURNEY: an ordered list of every step a client needs
 * before it's fully live, each with a real done/partial/todo state (never a flat
 * checkbox — a step with 12 of 21 clubs done reads as "partial", not "todo"), the
 * first non-done step called out as "Up next", and a link straight to the surface
 * that moves it forward. SetupCard itself stays on the settings page as the
 * go-live/mark-complete panel — this page is the map that gets a client there.
 *
 * Order mirrors how the pieces actually depend on each other: the document catalogue
 * (ADR 0010) has to carry structural doc roles before documents can be classified
 * through them — but only the ROSTER step is genuinely blocked on its role (it parses
 * from the stored member-database file and has no other path in); the REPS step's
 * manual invite works without the committee role ever being set, so it only waits on
 * clubs existing, with a standing hint to assign the role for extraction from committee
 * documents. Districts/leagues and clubs exist before anything attaches to them;
 * documents come in before rosters, because rosters parse from the stored member
 * database rather than a fresh upload.
 */
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { qk } from './query';
import * as api from './api';
import { Btn, Card, Pill, ProgressBar } from './atoms';
import { StepIntro } from './platform-wizard';
import { DISTRICTS, roleAssigned } from './data';
import type { InsightsClub, TenantConfig, TenantOverview, TenantRepsResponse } from './types';

type Toast = (m: string, t?: string) => void;

const INTRO =
  'The order clients get onboarded in, start to finish. Work down the list — each step ' +
  'names what it needs and links straight to where you do it. The catalogue step assigns ' +
  'the member-database and committee ROLES that downstream steps read documents through, ' +
  'not by file name. Rosters stay locked without the member-database role; reps only need ' +
  'clubs to exist — the committee role just enables extraction from committee documents ' +
  'instead of inviting reps by hand.';

type StepState = 'done' | 'partial' | 'todo';

interface OnboardingStep {
  key: string;
  title: string;
  description: string;
  state: StepState;
  progress?: { label: string; pct: number };
  guidance?: string;
  locked?: boolean;
  actionLabel: string;
  onAction: () => void;
}

function pct(n: number, of: number): number {
  return of > 0 ? Math.round((n / of) * 100) : 0;
}

/**
 * Pure step-state derivation — kept outside the component so it's directly testable
 * and so the "Up next" pick (first non-done step, in this exact order) is unambiguous.
 */
export function buildOnboardingSteps(
  slug: string,
  config: TenantConfig,
  overview: TenantOverview,
  reps: TenantRepsResponse,
  navigate: (path: string) => void,
): OnboardingStep[] {
  const requiredDocs = config.requiredDocs ?? [];
  const activeDocsCount = requiredDocs.filter((d) => !d.archived).length;
  const memberDbAssigned = roleAssigned(requiredDocs, 'memberDatabase');
  const committeeAssigned = roleAssigned(requiredDocs, 'committee');
  const rolesAssigned = memberDbAssigned && committeeAssigned;
  const catalogueDone = activeDocsCount > 0 && rolesAssigned;
  const catalogueState: StepState =
    activeDocsCount === 0 ? 'todo' : catalogueDone ? 'done' : 'partial';

  // Effective districts: the explicit config value when present (including a deliberate
  // [] on a freshly created client), else the shared defaults — same fallback the rest
  // of the app (and the API's resolveDistricts) uses, so this step never reports "0
  // districts" while the settings editor is showing the platform defaults in effect.
  // Leagues have no such shared-default fallback — they're purely per-tenant config.
  const districtsCount = (config.districts ?? DISTRICTS).length;
  const leaguesCount = config.leagues?.length ?? 0;
  const districtsLeaguesState: StepState =
    districtsCount > 0 && leaguesCount > 0
      ? 'done'
      : districtsCount > 0 || leaguesCount > 0
        ? 'partial'
        : 'todo';

  const clubs: InsightsClub[] = overview.clubs ?? [];
  const clubsState: StepState = clubs.length > 0 ? 'done' : 'todo';

  const clubsWithMemberDb = clubs.filter((c) => c.intake && c.intake.memberDatabase !== 'absent');
  const docsState: StepState =
    clubs.length === 0
      ? 'todo'
      : clubsWithMemberDb.length === clubs.length
        ? 'done'
        : clubsWithMemberDb.length > 0
          ? 'partial'
          : 'todo';

  const clubsWithTeams = clubs.filter((c) => Object.values(c.leagueTeams ?? {}).some((n) => n > 0));
  const structureState: StepState =
    clubs.length === 0
      ? 'todo'
      : clubsWithTeams.length === clubs.length
        ? 'done'
        : clubsWithTeams.length > 0
          ? 'partial'
          : 'todo';

  // "N of M DATABASE-HOLDING clubs have players" — the honest denominator. A club with
  // no member database on file yet was never going to have parsed players; counting it
  // against the total would make this step look stuck when documents is really the gap.
  const dbHoldingClubs = clubsWithMemberDb;
  const dbHoldingWithPlayers = dbHoldingClubs.filter((c) => c.players > 0);
  const rostersState: StepState =
    dbHoldingClubs.length === 0
      ? 'todo'
      : dbHoldingWithPlayers.length === dbHoldingClubs.length
        ? 'done'
        : dbHoldingWithPlayers.length > 0
          ? 'partial'
          : 'todo';

  // A club is COVERED as soon as it has any rep at all — invited (pending first sign-in)
  // or already signed in. `coverage` (repCount per club, from GET reps) already counts
  // both statuses; deriving from `reps.reps` directly with the same "any status" rule
  // keeps this in sync even if a club id is missing from `coverage` for some reason.
  const repsList = reps.reps ?? [];
  const coverageByClub = new Map((reps.coverage ?? []).map((cv) => [cv.clubId, cv.repCount]));
  const hasAnyRep = (clubId: string) =>
    (coverageByClub.get(clubId) ?? 0) > 0 || repsList.some((r) => r.clubIds.includes(clubId));
  const clubsWithAnyRep = clubs.filter((c) => hasAnyRep(c.id));
  const clubsAwaitingFirstSignIn = clubsWithAnyRep.filter(
    (c) => !repsList.some((r) => r.clubIds.includes(c.id) && r.status === 'active'),
  );
  const repsState: StepState =
    clubs.length === 0
      ? 'todo'
      : clubsWithAnyRep.length === clubs.length
        ? 'done'
        : clubsWithAnyRep.length > 0
          ? 'partial'
          : 'todo';
  const repsLabel =
    `${clubsWithAnyRep.length} of ${clubs.length} clubs have a rep` +
    (clubsAwaitingFirstSignIn.length > 0
      ? ` (${clubsAwaitingFirstSignIn.length} awaiting first sign-in)`
      : '');

  const completeState: StepState = config.setupCompletedAt ? 'done' : 'todo';

  const rolesGuidance = !catalogueDone
    ? activeDocsCount === 0
      ? config.requiredDocs === undefined
        ? 'Shared defaults are in effect — save the catalogue (customising if needed) and ' +
          'assign the member-database and committee roles.'
        : 'Nothing in the catalogue yet — add at least one document before assigning roles.'
      : !memberDbAssigned && !committeeAssigned
        ? 'No document in the catalogue is marked as the member database or the committee ' +
          'document — assign both roles in Required documents.'
        : !memberDbAssigned
          ? 'No document in the catalogue is marked as the member database — assign the role ' +
            'in Required documents.'
          : 'No document in the catalogue is marked as the committee document — assign the ' +
            'role in Required documents.'
    : undefined;

  return [
    {
      key: 'catalogue',
      title: 'Document catalogue',
      description:
        'Decide what this client collects, and mark which document is the member ' +
        'database and which is the committee list — everything downstream reads those two roles.',
      state: catalogueState,
      guidance: rolesGuidance,
      actionLabel: 'Open Required documents',
      onAction: () => navigate(`/platform/tenants/${slug}`),
    },
    {
      key: 'districts-leagues',
      title: 'Districts & leagues',
      description:
        'Set up the client’s districts and leagues — every club and team plan is built against these.',
      state: districtsLeaguesState,
      progress: {
        label: `${districtsCount} districts · ${leaguesCount} leagues`,
        pct: pct((districtsCount > 0 ? 1 : 0) + (leaguesCount > 0 ? 1 : 0), 2),
      },
      actionLabel: 'Open settings',
      onAction: () => navigate(`/platform/tenants/${slug}`),
    },
    {
      key: 'clubs',
      title: 'Clubs exist',
      description:
        'The client’s clubs need a record here before anything else — documents, rosters and reps all attach to a club.',
      state: clubsState,
      progress: { label: `${clubs.length} clubs on record`, pct: clubs.length > 0 ? 100 : 0 },
      actionLabel: 'Open settings',
      onAction: () => navigate(`/platform/tenants/${slug}`),
    },
    {
      key: 'documents',
      title: 'Documents in',
      description:
        'Get every club’s compliance pack uploaded. Rosters parse from the stored member ' +
        'database — this comes before structure and rosters, not after.',
      state: docsState,
      progress: {
        label: `${clubsWithMemberDb.length} of ${clubs.length} clubs have a member database`,
        pct: pct(clubsWithMemberDb.length, clubs.length),
      },
      // Per-club member-database counts only populate once the member-database ROLE is
      // assigned in the catalogue step — without it the server classifies every club's
      // intake as 'absent', so this bar reads 0 even after documents are uploaded.
      guidance: !memberDbAssigned
        ? 'Per-club member-database counts appear only once the member-database role is ' +
          'assigned in the catalogue step above — until then every club reads as absent here.'
        : undefined,
      actionLabel: 'Open document intake',
      onAction: () => navigate(`/platform/tenants/${slug}/doc-intake`),
    },
    {
      key: 'structure',
      title: 'Structure & teams in',
      description: 'Turn the client’s league-structure workbook into per-club team plans.',
      state: structureState,
      progress: {
        label: `${clubsWithTeams.length} of ${clubs.length} clubs have a team plan`,
        pct: pct(clubsWithTeams.length, clubs.length),
      },
      actionLabel: 'Open structure intake',
      onAction: () => navigate(`/platform/tenants/${slug}/structure-intake`),
    },
    {
      key: 'rosters',
      title: 'Rosters in',
      description: 'Parse each club’s stored member database into reviewed, committable players.',
      state: rostersState,
      progress: {
        label:
          dbHoldingClubs.length > 0
            ? `${dbHoldingWithPlayers.length} of ${dbHoldingClubs.length} database-holding clubs have players`
            : 'No clubs have a stored member database yet',
        pct: pct(dbHoldingWithPlayers.length, dbHoldingClubs.length),
      },
      locked: !memberDbAssigned,
      guidance: !memberDbAssigned
        ? 'Assign the member-database role in the catalogue step above first — rosters parse ' +
          'from that stored file.'
        : undefined,
      actionLabel: 'Open roster intake',
      onAction: () => navigate(`/platform/tenants/${slug}/roster-intake`),
    },
    {
      key: 'reps',
      title: 'Reps invited',
      description:
        'Get a signed-in rep onto every club so its chair can manage documents, players and clearances.',
      state: repsState,
      progress: {
        label: repsLabel,
        pct: pct(clubsWithAnyRep.length, clubs.length),
      },
      // Committee role is NOT required to unlock this step — the reps page's manual
      // invite path works without it. It stays locked only for the same reason the
      // clubs step itself would be: nothing exists yet to invite a rep onto.
      locked: clubs.length === 0,
      guidance: !committeeAssigned
        ? 'Assign the committee role in the catalogue step to enable extraction from ' +
          'committee documents.'
        : undefined,
      actionLabel: 'Open reps',
      onAction: () => navigate(`/platform/tenants/${slug}/reps`),
    },
    {
      key: 'complete',
      title: 'Setup complete',
      description: 'Mark this client’s onboarding done and share the go-live links.',
      state: completeState,
      actionLabel: 'Open settings',
      onAction: () => navigate(`/platform/tenants/${slug}`),
    },
  ];
}

const STATE_DOT: Record<StepState, string> = { done: 'teal', partial: 'gold', todo: 'muted' };
const STATE_LABEL: Record<StepState, string> = {
  done: 'Done',
  partial: 'In progress',
  todo: 'Not started',
};

export function OnboardingPage({ toast: _toast }: { toast: Toast }) {
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
  const repsQ = useQuery({
    queryKey: qk.platformTenantReps(slug),
    queryFn: () => api.platformTenantReps(slug),
    retry: 0,
  });

  const steps = useMemo(() => {
    if (!configQ.data || !overviewQ.data || !repsQ.data) return [];
    return buildOnboardingSteps(slug, configQ.data, overviewQ.data, repsQ.data, navigate);
  }, [slug, configQ.data, overviewQ.data, repsQ.data, navigate]);
  const upNextKey = steps.find((s) => s.state !== 'done')?.key;

  if (configQ.isLoading || overviewQ.isLoading || repsQ.isLoading)
    return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading client…</p>;
  if (
    configQ.isError ||
    overviewQ.isError ||
    repsQ.isError ||
    !configQ.data ||
    !overviewQ.data ||
    !repsQ.data
  )
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
            Platform / Clients / {configQ.data.branding?.name ?? slug} / Onboarding
          </div>
          <h1 className="ph-title">
            Client <em>onboarding</em>
          </h1>
          <p className="ph-desc">
            The step-by-step path to get this client fully live — from an empty catalogue to a
            signed-in rep on every club.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" size="sm" onClick={() => navigate(`/platform/tenants/${slug}`)}>
            Back to settings
          </Btn>
        </div>
      </div>

      <StepIntro title="How this works">{INTRO}</StepIntro>

      <div className="settings-layout">
        {steps.map((s) => (
          <Card
            key={s.key}
            title={
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className={`sdot ${STATE_DOT[s.state]}`} aria-hidden="true" />
                {s.title}
                <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted-2)' }}>
                  {STATE_LABEL[s.state]}
                </span>
                {s.key === upNextKey && <Pill tone="gold">Up next</Pill>}
              </span>
            }
            sub={s.description}
            action={
              <Btn
                tone={s.state === 'done' ? 'outline' : 'teal'}
                size="sm"
                disabled={s.locked}
                onClick={s.onAction}
              >
                {s.actionLabel}
              </Btn>
            }
          >
            {s.progress && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, maxWidth: 320 }}>
                  <ProgressBar
                    value={s.progress.pct}
                    tone={s.state === 'done' ? undefined : 'gold'}
                  />
                </div>
                <span style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>{s.progress.label}</span>
              </div>
            )}
            {s.guidance && (
              <p
                style={{
                  fontSize: 12,
                  color: s.locked ? 'var(--coral, #C0392B)' : 'var(--muted-2)',
                  margin: '10px 0 0',
                }}
              >
                {s.guidance}
              </p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
