/**
 * Operator console — rep invites (self-serve onboarding, 2.3).
 *
 * A coverage table (GET reps ⋈ overview) — which clubs have a rep, which are only
 * invited-but-not-signed-in, and which have none at all — with two ways to get an
 * email into the invite form: read it off the club's stored committee document
 * (parsed server-side, never re-uploaded) or type it by hand. The committee
 * extractor is deliberately treated as a HINT, not an oracle: every candidate still
 * goes through the same review-and-confirm invite modal a manual entry would, and an
 * unparseable document (a scanned PDF, most of the time) is a designed first-class
 * path — "view the document, type what you read" — never an error state.
 *
 * ── WHY THE INVITE MODAL NEVER SENDS A `link` ──
 * The tenant-console invite flow (admin.tsx InviteUserModal) defaults `link` to
 * `window.location.origin` because that origin genuinely IS the tenant's login page.
 * The operator console runs on a DIFFERENT host — the platform dashboard, not any
 * tenant's login page — so that default would ship the wrong URL. `link` is left
 * unset here on purpose: the server resolves the tenant's canonical web origin
 * (`resolveLoginUrl`) and only falls back to the request Origin (reporting it via
 * the `warning` field) for a tenant that hasn't gone live yet.
 *
 * ── WHY EXTRACT IS ONE CLUB AT A TIME EVEN IN "EXTRACT ALL" ──
 * `platformCommitteeExtract` is a per-club POST with no batch endpoint (1.3) — bulk
 * extraction is a client-side loop, sequential rather than pooled: committee docs
 * are read rarely (once per club, ever, in the common case) so there's no throughput
 * pressure that would justify the added complexity a concurrency pool bought the
 * roster wizard's per-club parses.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { queryClient, qk } from './query';
import * as api from './api';
import { ApiError, EMAIL_RE } from './api';
import { Btn, Card, Icon, Pill, useEscapeClose } from './atoms';
import { ERR, HINT, InfoTip, ReviewCounters, StepIntro } from './platform-wizard';
import type {
  Channel,
  CommitteeExtractCandidate,
  CommitteeExtractResponse,
  InsightsClub,
  InviteRepResponse,
  RequiredDoc,
  TenantRepSummary,
} from './types';

type Toast = (m: string, t?: string) => void;

/* ─── Guidance copy (named consts — greppable, testable) ─── */

const INTRO_REPS =
  'Every club needs at least one rep so its chair can manage documents, players and ' +
  'clearances. Extract a name from the club’s stored committee document to prefill ' +
  'the invite, or type the details in by hand — either way nothing is sent until you ' +
  'confirm the invite below.';

const CONFIDENCE_TIP =
  'How sure the extractor is that this row is the right contact: high for a chair, ' +
  'medium for a vice/deputy chair, low for any other officer with an email address. ' +
  'Always double-check before inviting — the extractor guesses from row wording, it ' +
  'doesn’t understand the document.';

const CHANNELS_TIP =
  'Pick how the rep is notified. Email and WhatsApp can both be on — the invite goes ' +
  'out on every channel selected.';

const LINK_ONLY_TIP =
  'No channel selected — the account is still created and you can copy the login link ' +
  'below and share it yourself (WhatsApp, a phone call, however works). Nothing is sent ' +
  'automatically.';

const UNPARSEABLE_HINT =
  'This club’s committee document couldn’t be read automatically (usually a scanned ' +
  'PDF or photo). View it alongside this form and type in the contact’s details.';

const NO_COMMITTEE_DOC_HINT = 'No committee document on file for this club yet.';

const NO_COMMITTEE_ROLE_HINT =
  'Extraction isn’t available yet — no document in the catalogue is marked as the ' +
  'committee list. Assign the role in Required documents, or type the contact’s ' +
  'details in below.';

/* ─── docKeyForRole (client-side mirror) ───
 * Mirrors packages/api/src/catalogue.ts docKeyForRole (not exported from api.ts/
 * types.ts — out of scope for this change). The wizard gates on InsightsClub.intake
 * (already role-resolved server-side); this is only needed to get the literal doc
 * key for the platform view-url call. See the same mirror in
 * platform-roster-intake.tsx. */
function docKeyForRole(
  requiredDocs: RequiredDoc[],
  role: 'memberDatabase' | 'committee',
): string | null {
  const hit = requiredDocs.find((d) => d.role === role && !d.archived);
  return hit?.key ?? null;
}

/* ─── Rep coverage status ─── */

type RepStatusKind = 'has-rep' | 'invited' | 'none';

function repStatusFor(clubId: string, reps: TenantRepSummary[]): RepStatusKind {
  const covering = reps.filter((r) => r.clubIds.includes(clubId));
  if (covering.some((r) => r.status === 'active')) return 'has-rep';
  if (covering.length > 0) return 'invited';
  return 'none';
}

const STATUS_META: Record<RepStatusKind, { label: string; tone: string }> = {
  'has-rep': { label: 'Has rep', tone: 'teal' },
  invited: { label: 'Invited', tone: 'gold' },
  none: { label: 'None', tone: 'coral' },
};

const CONFIDENCE_META: Record<
  CommitteeExtractCandidate['confidence'],
  { label: string; tone: string }
> = {
  high: { label: 'High confidence', tone: 'teal' },
  medium: { label: 'Medium confidence', tone: 'gold' },
  low: { label: 'Low confidence', tone: 'muted' },
};

/* ─── Committee document preview ───
 * Lean adaptation of DocPreviewModal's ready/loading/error shape, but hitting the
 * OPERATOR route (platformDocViewUrl) instead of the tenant-scoped getDocViewUrl —
 * an operator viewing another tenant's file can't use the club-console endpoint.
 * No contentType is returned by the platform view-url route, so this always offers
 * "Open in new tab" as the primary path rather than guessing whether the iframe
 * will render (a scanned PDF usually will; a Word/Excel committee sheet won't). */
function CommitteeDocPreview({
  slug,
  clubId,
  docKey,
  clubName,
  onClose,
}: {
  slug: string;
  clubId: string;
  docKey: string;
  clubName: string;
  onClose: () => void;
}) {
  useEscapeClose(onClose);
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; src: string | null }>(
    {
      status: 'loading',
      src: null,
    },
  );

  useEffect(() => {
    let alive = true;
    api
      .platformDocViewUrl(slug, clubId, docKey)
      .then((r) => alive && setState({ status: 'ready', src: r.viewUrl }))
      .catch(() => alive && setState({ status: 'error', src: null }));
    return () => {
      alive = false;
    };
  }, [slug, clubId, docKey]);

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="task-modal"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 820, width: '92vw' }}
      >
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Committee document · {clubName}</div>
            <div className="task-modal-head-title">View document</div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          {state.status === 'loading' && (
            <div style={{ textAlign: 'center', padding: '40px 8px', color: 'var(--muted)' }}>
              Loading preview…
            </div>
          )}
          {state.status === 'error' && (
            <div style={{ textAlign: 'center', padding: '40px 8px', color: 'var(--muted)' }}>
              Couldn’t load this document right now.
            </div>
          )}
          {state.status === 'ready' && state.src && (
            <>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
                <Btn
                  tone="outline"
                  size="sm"
                  icon={Icon.Eye}
                  onClick={() => window.open(state.src!, '_blank', 'noopener,noreferrer')}
                >
                  Open in new tab
                </Btn>
              </div>
              <iframe
                title={`${clubName} committee document preview`}
                src={state.src}
                style={{
                  width: '100%',
                  height: '60vh',
                  border: '1px solid var(--line, rgba(10,15,20,0.12))',
                  borderRadius: 8,
                  background: '#fff',
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── Candidates modal — one club's extracted committee-doc rows ─── */
function CandidatesModal({
  clubName,
  candidates,
  onPick,
  onManual,
  onClose,
}: {
  clubName: string;
  candidates: CommitteeExtractCandidate[];
  onPick: (c: CommitteeExtractCandidate) => void;
  onManual: () => void;
  onClose: () => void;
}) {
  useEscapeClose(onClose);
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" role="dialog" aria-modal="true" style={{ maxWidth: 560 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Committee document · {clubName}</div>
            <div className="task-modal-head-title">
              Pick a <em>contact</em>
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <p style={HINT}>
            Extracted from the club’s stored committee document — review before inviting; the
            extractor guesses from row wording, it doesn’t verify anything.
          </p>
          {candidates.length === 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              No contacts with an email address were found in this document.
            </p>
          ) : (
            <div className="fix-table-wrap">
              <table className="fix-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>
                      Confidence <InfoTip label="About confidence">{CONFIDENCE_TIP}</InfoTip>
                    </th>
                    <th style={{ width: 90 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c, i) => {
                    const meta = CONFIDENCE_META[c.confidence];
                    return (
                      <tr key={`${c.sheet}-${c.rowNumber}-${i}`}>
                        <td style={{ fontSize: 12.5, fontWeight: 600 }}>{c.name}</td>
                        <td style={{ fontSize: 12.5 }}>{c.role}</td>
                        <td>
                          <Pill tone={meta.tone}>{meta.label}</Pill>
                        </td>
                        <td>
                          <Btn tone="outline" size="sm" onClick={() => onPick(c)}>
                            Use this contact
                          </Btn>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: 14 }}>
            <Btn tone="ghost" size="sm" onClick={onManual}>
              Enter details manually instead
            </Btn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── OperatorInviteModal ───
 * Lean, single-club invite modal for the operator console. Same UX contract as
 * admin.tsx's InviteUserModal (channels checkboxes, none-selected = link-only,
 * copyable loginUrl, per-channel results) but NOT imported from there — that
 * component is welded to tenant-console helpers (ClubMultiSelect, role picker) this
 * surface doesn't need: the club and role ('rep') are always fixed by the row the
 * operator clicked. */
export interface OperatorInviteModalProps {
  slug: string;
  club: { id: string; name: string };
  /** Prefilled from a committee-extract candidate; absent ⇒ blank manual form. */
  prefillCandidate?: CommitteeExtractCandidate;
  /** Present only on the unparseable-document path — lets the operator view the
   *  source file beside the form instead of typing blind. `reason`, when present, is
   *  the server's own explanation (e.g. the legacy-.xls or CSV parse-gate message) and
   *  is shown instead of the generic UNPARSEABLE_HINT. */
  viewDocument?: { slug: string; clubId: string; docKey: string; reason?: string };
  /** Set when the club has NO role-resolved committee doc key at all — extraction was
   *  never attempted because there's nothing to extract from. Distinct from
   *  `viewDocument` (a stored-but-unparseable file): there's no file to view here, just
   *  an explanation of why the extract button never fired. */
  noCommitteeRole?: boolean;
  onClose: () => void;
  /** Fired once the account is created, before the result screen — lets the page
   *  refresh coverage without waiting for the modal to close. */
  onInvited?: () => void;
  /** When set, the success screen offers "Next club without a rep →". */
  onNextClub?: () => void;
  toast: Toast;
}
export function OperatorInviteModal({
  slug,
  club,
  prefillCandidate,
  viewDocument,
  noCommitteeRole,
  onClose,
  onInvited,
  onNextClub,
  toast,
}: OperatorInviteModalProps) {
  useEscapeClose(onClose);
  const [email, setEmail] = useState(prefillCandidate?.email ?? '');
  const [channels, setChannels] = useState<Record<Channel, boolean>>({
    email: true,
    whatsapp: true,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<InviteRepResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [showDoc, setShowDoc] = useState(false);

  const cleanEmail = email.trim().toLowerCase();
  const emailValid = EMAIL_RE.test(cleanEmail);
  const chansSelected = channels.email || channels.whatsapp;
  const canSubmit = !busy && emailValid;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr('');
    try {
      const chans = (['email', 'whatsapp'] as Channel[]).filter((c) => channels[c]);
      const res = await api.platformInviteRep(slug, {
        email: cleanEmail,
        clubIds: [club.id],
        // Omit `channels` entirely when none are selected — the server rejects an
        // explicit empty array but skips sending (returning just the login link)
        // when the field is absent.
        ...(chans.length ? { channels: chans } : {}),
      });
      onInvited?.();
      setResult(res);
    } catch (e) {
      // The admin-membership 409 and every other guard the server raises here are
      // written for the operator to read as-is — no client-side rewrite.
      setErr(e instanceof ApiError ? e.message : 'Could not send the invite — try again');
    } finally {
      setBusy(false);
    }
  }

  function doCopy() {
    const url = result?.loginUrl;
    if (!url) return;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      toast('Login link copied to clipboard');
      setTimeout(() => setCopied(false), 2200);
    });
  }

  const chLabel = (ch: Channel) => (ch === 'email' ? 'email' : 'WhatsApp');

  return (
    <>
      {createPortal(
        <div
          className="task-modal-backdrop"
          onClick={(e) => e.target === e.currentTarget && onClose()}
        >
          <div
            className="task-modal narrow"
            role="dialog"
            aria-modal="true"
            style={{ maxWidth: 480 }}
          >
            <div className="task-modal-head">
              <div className="task-modal-head-text">
                <div className="task-modal-head-eyebrow">Reps · {club.name}</div>
                <div className="task-modal-head-title">
                  Invite a <em>rep</em>
                </div>
              </div>
              <button className="task-modal-close" onClick={onClose} title="Close">
                <Icon.X />
              </button>
            </div>
            <div className="task-modal-body">
              {result ? (
                <div className="stack" style={{ gap: 14 }}>
                  <div>
                    <p style={{ fontSize: 14, color: 'var(--ink)', margin: 0 }}>
                      Account created for <strong>{result.email}</strong>.
                    </p>
                    <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>
                      They sign in with their email — a one-time code is sent on first login.
                    </p>
                  </div>
                  {result.warning && (
                    <div style={{ ...HINT, color: 'var(--gold, #B8860B)' }}>{result.warning}</div>
                  )}
                  <div>
                    <div className="field-label" style={{ marginBottom: 4 }}>
                      Login link
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        className="field-input"
                        readOnly
                        value={result.loginUrl}
                        onFocus={(e) => e.target.select()}
                        style={{ flex: 1, fontSize: 13 }}
                      />
                      <Btn tone="outline" size="sm" icon={Icon.Doc} onClick={doCopy}>
                        {copied ? 'Copied' : 'Copy'}
                      </Btn>
                    </div>
                  </div>
                  {(result.results ?? []).length > 0 ? (
                    <div className="stack" style={{ gap: 6 }}>
                      {(result.results ?? []).map((r) => (
                        <div
                          key={r.channel}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}
                        >
                          <Pill tone={r.status === 'sent' ? 'teal' : 'gold'} dot>
                            {chLabel(r.channel)} {r.status}
                          </Pill>
                          {(r.summary || r.error) && (
                            <span style={{ color: 'var(--muted)' }}>{r.summary || r.error}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>
                      Share the link above to give them access.
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Btn tone="ink" size="sm" onClick={onClose}>
                      Done
                    </Btn>
                    {onNextClub && (
                      <Btn tone="outline" size="sm" onClick={onNextClub}>
                        Next club without a rep →
                      </Btn>
                    )}
                  </div>
                </div>
              ) : (
                <div className="stack" style={{ gap: 12 }}>
                  {prefillCandidate && (
                    <div
                      style={{
                        background: 'var(--paper)',
                        border: '1px solid var(--line2)',
                        borderRadius: 8,
                        padding: '8px 10px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{ fontSize: 12.5 }}>
                        From committee doc: <strong>{prefillCandidate.name}</strong> ·{' '}
                        {prefillCandidate.role}
                      </span>
                      <Pill tone={CONFIDENCE_META[prefillCandidate.confidence].tone}>
                        {CONFIDENCE_META[prefillCandidate.confidence].label}
                      </Pill>
                      <InfoTip label="About confidence">{CONFIDENCE_TIP}</InfoTip>
                    </div>
                  )}
                  {viewDocument && (
                    <div style={{ ...HINT, margin: 0 }}>
                      {viewDocument.reason || UNPARSEABLE_HINT}
                      <div style={{ marginTop: 8 }}>
                        <Btn
                          tone="outline"
                          size="sm"
                          icon={Icon.Eye}
                          onClick={() => setShowDoc(true)}
                        >
                          View document
                        </Btn>
                      </div>
                    </div>
                  )}
                  {!viewDocument && noCommitteeRole && (
                    <div style={{ ...HINT, margin: 0 }}>{NO_COMMITTEE_ROLE_HINT}</div>
                  )}
                  <label style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Email
                    <input
                      className="field-input"
                      type="email"
                      autoFocus
                      placeholder="rep@club.co.za"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      style={{ width: '100%', marginTop: 4, fontSize: 16 }}
                    />
                  </label>
                  <div>
                    <div
                      className="field-label"
                      style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      Notify by{' '}
                      <InfoTip label="About notification channels">{CHANNELS_TIP}</InfoTip>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {(['email', 'whatsapp'] as Channel[]).map((ch) => {
                        const on = channels[ch];
                        return (
                          <button
                            key={ch}
                            type="button"
                            onClick={() => setChannels((c) => ({ ...c, [ch]: !c[ch] }))}
                            className={`pill-toggle${on ? ' on' : ''}`}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '6px 12px',
                              borderRadius: 999,
                              fontSize: 12,
                              fontWeight: 700,
                              cursor: 'pointer',
                              border: '1px solid ' + (on ? 'var(--green)' : 'var(--line)'),
                              background: on ? 'var(--green-pale)' : 'var(--white)',
                              color: on ? 'var(--green)' : 'var(--muted-2)',
                            }}
                          >
                            {on && <Icon.Check />}
                            {ch === 'email' ? 'Email' : 'WhatsApp'}
                          </button>
                        );
                      })}
                    </div>
                    {!chansSelected && (
                      <div
                        style={{
                          fontSize: 11.5,
                          color: 'var(--muted)',
                          marginTop: 6,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        No channel selected — you’ll get a copyable login link instead.
                        <InfoTip label="About link-only invites">{LINK_ONLY_TIP}</InfoTip>
                      </div>
                    )}
                  </div>
                  {err && <div style={ERR}>{err}</div>}
                  <Btn tone="teal" icon={Icon.Mail} disabled={!canSubmit} onClick={submit}>
                    {busy
                      ? 'Creating…'
                      : chansSelected
                        ? 'Create account & send invite'
                        : 'Create account'}
                  </Btn>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
      {showDoc && viewDocument && (
        <CommitteeDocPreview
          slug={viewDocument.slug}
          clubId={viewDocument.clubId}
          docKey={viewDocument.docKey}
          clubName={club.name}
          onClose={() => setShowDoc(false)}
        />
      )}
    </>
  );
}

/* ─── The page ─── */

type ExtractState = 'idle' | 'loading' | 'error';

export function RepsPage({ toast }: { toast: Toast }) {
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

  const requiredDocs: RequiredDoc[] = configQ.data?.requiredDocs ?? [];
  const committeeDocKey = useMemo(() => docKeyForRole(requiredDocs, 'committee'), [requiredDocs]);

  const clubs: InsightsClub[] = overviewQ.data?.clubs ?? [];
  const sortedClubs = useMemo(
    () => [...clubs].sort((a, b) => a.name.localeCompare(b.name)),
    [clubs],
  );
  const reps: TenantRepSummary[] = repsQ.data?.reps ?? [];
  const coverage = repsQ.data?.coverage ?? [];
  const repCountFor = (clubId: string) => coverage.find((c) => c.clubId === clubId)?.repCount ?? 0;

  const [needsRepOnly, setNeedsRepOnly] = useState(false);
  const visibleClubs = needsRepOnly
    ? sortedClubs.filter((c) => repCountFor(c.id) === 0)
    : sortedClubs;

  const counters = useMemo(() => {
    let hasRep = 0;
    let invited = 0;
    let none = 0;
    for (const c of sortedClubs) {
      const status = repStatusFor(c.id, reps);
      if (status === 'has-rep') hasRep++;
      else if (status === 'invited') invited++;
      else none++;
    }
    return [
      { label: 'have a rep', count: hasRep, tone: 'teal' },
      { label: 'invited, not signed in yet', count: invited, tone: 'gold' },
      { label: 'need a rep', count: none, tone: 'coral' },
    ];
  }, [sortedClubs, reps]);

  // ── Committee-doc extraction ──
  const [extractStatus, setExtractStatus] = useState<Record<string, ExtractState>>({});
  const [extractResults, setExtractResults] = useState<Record<string, CommitteeExtractResponse>>(
    {},
  );
  const [candidatesFor, setCandidatesFor] = useState<InsightsClub | null>(null);
  const [inviteState, setInviteState] = useState<{
    club: InsightsClub;
    prefillCandidate?: CommitteeExtractCandidate;
    viewDocument?: { slug: string; clubId: string; docKey: string; reason?: string };
  } | null>(null);
  const [bulkExtracting, setBulkExtracting] = useState(false);

  function topCandidateFor(clubId: string): CommitteeExtractCandidate | null | undefined {
    const r = extractResults[clubId];
    if (!r) return undefined;
    if (r.status !== 'ok' || r.candidates.length === 0) return null;
    const rank = { high: 0, medium: 1, low: 2 } as const;
    return [...r.candidates].sort((a, b) => rank[a.confidence] - rank[b.confidence])[0];
  }

  async function extractClub(club: InsightsClub): Promise<CommitteeExtractResponse | undefined> {
    setExtractStatus((s) => ({ ...s, [club.id]: 'loading' }));
    try {
      const res = await api.platformCommitteeExtract(slug, club.id);
      setExtractStatus((s) => ({ ...s, [club.id]: 'idle' }));
      setExtractResults((s) => ({ ...s, [club.id]: res }));
      return res;
    } catch {
      setExtractStatus((s) => ({ ...s, [club.id]: 'error' }));
      toast('Could not read this club’s committee document — try again', 'error');
      return undefined;
    }
  }

  async function extractAndOpen(club: InsightsClub) {
    const res = await extractClub(club);
    if (!res) return;
    if (res.status === 'unparseable') {
      openInvite(
        club,
        undefined,
        committeeDocKey
          ? { slug, clubId: club.id, docKey: committeeDocKey, reason: res.reason }
          : undefined,
      );
      return;
    }
    if (res.candidates.length === 0) {
      openInvite(club);
      return;
    }
    setCandidatesFor(club);
  }

  async function extractAll() {
    setBulkExtracting(true);
    const eligible = sortedClubs.filter((c) => c.intake?.committee === 'parseable');
    for (const c of eligible) {
      // eslint-disable-next-line no-await-in-loop -- deliberately sequential; see file header
      await extractClub(c);
    }
    setBulkExtracting(false);
  }

  function openInvite(
    club: InsightsClub,
    prefillCandidate?: CommitteeExtractCandidate,
    viewDocument?: { slug: string; clubId: string; docKey: string; reason?: string },
  ) {
    setCandidatesFor(null);
    setInviteState({ club, prefillCandidate, viewDocument });
  }

  function nextNeedsRepClub(excludeId: string): InsightsClub | undefined {
    const idx = sortedClubs.findIndex((c) => c.id === excludeId);
    const ordered = [...sortedClubs.slice(idx + 1), ...sortedClubs.slice(0, idx + 1)];
    return ordered.find((c) => c.id !== excludeId && repCountFor(c.id) === 0);
  }

  function afterInvite() {
    queryClient.invalidateQueries({ queryKey: qk.platformTenantReps(slug) });
  }

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
            Platform / Clients / {configQ.data.branding?.name ?? slug} / Reps
          </div>
          <h1 className="ph-title">
            Rep <em>invites</em>
          </h1>
          <p className="ph-desc">Get a signed-in rep onto every club.</p>
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

      <Card title="Coverage" sub="Which clubs have a rep, and which still need one.">
        <StepIntro title="What this page does">{INTRO_REPS}</StepIntro>

        <ReviewCounters counters={counters} />

        <div
          style={{
            display: 'flex',
            gap: 10,
            marginTop: 14,
            marginBottom: 12,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={needsRepOnly}
              onChange={(e) => setNeedsRepOnly(e.target.checked)}
            />
            Needs-rep only
          </label>
          <Btn tone="outline" size="sm" onClick={extractAll} disabled={bulkExtracting}>
            {bulkExtracting ? 'Extracting…' : 'Extract all candidates'}
          </Btn>
        </div>

        <div className="fix-table-wrap">
          <table className="fix-table">
            <thead>
              <tr>
                <th>Club</th>
                <th style={{ width: 140 }}>Rep status</th>
                <th style={{ width: 160 }}>Committee doc</th>
                <th>Top candidate</th>
                <th style={{ width: 260 }}></th>
              </tr>
            </thead>
            <tbody>
              {visibleClubs.map((c) => {
                const status = repStatusFor(c.id, reps);
                const meta = STATUS_META[status];
                const covering = reps.filter((r) => r.clubIds.includes(c.id));
                const committee = c.intake?.committee ?? 'absent';
                const hasDoc = committee !== 'absent';
                const busy = extractStatus[c.id] === 'loading';
                const top = topCandidateFor(c.id);
                return (
                  <tr key={c.id}>
                    <td style={{ fontSize: 12.5, fontWeight: 600 }}>{c.name}</td>
                    <td>
                      <Pill tone={meta.tone}>{meta.label}</Pill>
                      {covering.length > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                          {covering.map((r) => r.email).join(', ')}
                        </div>
                      )}
                    </td>
                    <td>
                      {committee === 'parseable' && <Pill tone="teal">On file</Pill>}
                      {committee === 'unparseable' && <Pill tone="gold">Unreadable</Pill>}
                      {committee === 'absent' && (
                        <span title={NO_COMMITTEE_DOC_HINT}>
                          <Pill tone="muted">None</Pill>
                        </span>
                      )}
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {top === undefined && '—'}
                      {top === null && <span style={{ color: 'var(--muted)' }}>No candidates</span>}
                      {top && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          {top.name}
                          <Pill tone={CONFIDENCE_META[top.confidence].tone}>
                            {CONFIDENCE_META[top.confidence].label}
                          </Pill>
                        </span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Btn
                          tone="outline"
                          size="sm"
                          disabled={!hasDoc || busy}
                          title={!hasDoc ? NO_COMMITTEE_DOC_HINT : undefined}
                          onClick={() => extractAndOpen(c)}
                        >
                          {busy ? 'Extracting…' : 'Extract from committee doc'}
                        </Btn>
                        {top && (
                          <Btn tone="teal" size="sm" onClick={() => openInvite(c, top)}>
                            Invite
                          </Btn>
                        )}
                        <Btn tone="ghost" size="sm" onClick={() => openInvite(c)}>
                          Invite manually
                        </Btn>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visibleClubs.length === 0 && (
            <p style={{ fontSize: 12.5, color: 'var(--muted)', padding: '12px 0' }}>
              {needsRepOnly ? 'Every club has at least one rep.' : 'No clubs yet.'}
            </p>
          )}
        </div>
      </Card>

      {candidatesFor && (
        <CandidatesModal
          clubName={candidatesFor.name}
          candidates={(() => {
            const r = extractResults[candidatesFor.id];
            return r && r.status === 'ok' ? r.candidates : [];
          })()}
          onPick={(cand) => openInvite(candidatesFor, cand)}
          onManual={() => openInvite(candidatesFor)}
          onClose={() => setCandidatesFor(null)}
        />
      )}

      {inviteState && (
        <OperatorInviteModal
          // Remounts the modal on every club switch (and every candidate re-pick for
          // the SAME club) — without a key, "Next club without a rep →" only swaps the
          // `club` prop on an ALREADY-mounted component, so its internal `result`/
          // `email` state survives and the operator sees the PREVIOUS club's success
          // screen under the NEXT club's name. Composed with the prefill candidate's
          // own identity (sheet+rowNumber) so picking a different candidate for the
          // same club also resets the form, not just a club change.
          key={`${inviteState.club.id}:${
            inviteState.prefillCandidate
              ? `${inviteState.prefillCandidate.sheet}-${inviteState.prefillCandidate.rowNumber}`
              : 'manual'
          }`}
          slug={slug}
          club={inviteState.club}
          prefillCandidate={inviteState.prefillCandidate}
          viewDocument={inviteState.viewDocument}
          noCommitteeRole={!committeeDocKey}
          onClose={() => setInviteState(null)}
          onInvited={afterInvite}
          onNextClub={(() => {
            const next = nextNeedsRepClub(inviteState.club.id);
            return next ? () => openInvite(next) : undefined;
          })()}
          toast={toast}
        />
      )}
    </div>
  );
}
