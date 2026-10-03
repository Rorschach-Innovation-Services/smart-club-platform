/* ─── Union office: Captain's reports ───
 *
 * Every report in the tenant: status (pending / submitted / void), whether its notice actually
 * reached anyone (per-channel chips: "Email sent", "WhatsApp read", "Not sent — no contact on
 * file"…), the appointed umpires, and a low-ratings filter (any criterion ≤ 2). There is no
 * due date. A banner lists clubs a notice cannot reach (no chair contact). A row opens the
 * read-only, printable report, where a free-text umpire can be added to the registry or
 * linked to an existing umpire so its ratings count for them.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Btn, Icon, Pill } from './atoms';
import {
  CaptainsReportReadOnly,
  CaptainsReportStatusPill,
  fmtDate,
  matchLine,
} from './CaptainsReport';
import { avgRating, hasLowRating } from '../packages/engine/src/captainsReport';
import { getCaptainsReportContactGaps } from './api';
import { qk } from './query';
import type { CaptainsReport, CaptainsReportDelivery, ReportUmpireEntry } from './types';

type StatusFilter = 'all' | 'pending' | 'submitted' | 'void';

const STATUS_CHIPS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'void', label: 'Void' },
];

const matchesStatus = (r: CaptainsReport, f: StatusFilter) => (f === 'all' ? true : r.status === f);

const RECIPIENT_LINE: Record<CaptainsReport['recipient']['kind'], string> = {
  captain: 'to the captain',
  chair: 'to the chair',
  portal: 'filed in the club portal',
};

/** The latest delivery per channel (the most recent notice's outcome on each channel). */
function latestByChannel(r: CaptainsReport): CaptainsReportDelivery[] {
  const out = new Map<string, CaptainsReportDelivery>();
  for (const d of r.deliveries ?? []) {
    const prev = out.get(d.channel);
    if (!prev || d.at >= prev.at) out.set(d.channel, d);
  }
  return [...out.values()].sort((a, b) => a.channel.localeCompare(b.channel));
}

/** A report whose notice went to someone but reached nobody on any channel. */
export function noticeUndelivered(r: CaptainsReport): boolean {
  if (r.recipient.kind === 'portal' || !r.deliveries?.length) return false;
  return !latestByChannel(r).some((d) => d.status === 'sent');
}

const CHANNEL = { email: 'Email', whatsapp: 'WhatsApp' } as const;

const SKIP_LABEL: Record<NonNullable<CaptainsReportDelivery['reason']>, string> = {
  'no-contact': 'Not sent — no contact on file',
  'no-email': 'no email on file',
  'no-cell': 'no cell on file',
  'dry-run': 'not sent (dry run)',
  'template-pending': 'template pending',
  'send-failed': 'failed',
};

function chipFor(d: CaptainsReportDelivery): { label: string; tone: string } {
  const ch = CHANNEL[d.channel];
  if (d.status === 'sent') {
    if (d.providerStatus === 'failed')
      return { label: `${ch} failed (${d.providerError ?? 'failed'})`, tone: 'coral' };
    if (d.providerStatus === 'read') return { label: `${ch} read`, tone: 'teal' };
    if (d.providerStatus === 'delivered') return { label: `${ch} delivered`, tone: 'teal' };
    return { label: `${ch} sent`, tone: 'teal' };
  }
  if (d.status === 'failed') return { label: `${ch} failed`, tone: 'coral' };
  return { label: `${ch}: ${d.reason ? SKIP_LABEL[d.reason] : 'not sent'}`, tone: 'muted' };
}

function NoticeChips({ report }: { report: CaptainsReport }) {
  const latest = latestByChannel(report);
  const who =
    RECIPIENT_LINE[report.recipient.kind] +
    (report.recipient.forwardedBy ? ' (sent on by the chair)' : '');
  let chips: Array<{ label: string; tone: string }>;
  if (!latest.length) chips = [];
  else if (latest.every((d) => d.status === 'skipped' && d.reason === 'no-contact'))
    chips = [{ label: SKIP_LABEL['no-contact'], tone: 'coral' }];
  else chips = latest.map(chipFor);
  return (
    <div>
      {chips.length > 0 && (
        <div className="cr-delivery">
          {chips.map((c) => (
            <Pill key={c.label} tone={c.tone}>
              {c.label}
            </Pill>
          ))}
        </div>
      )}
      <div className="ump-sub">{who}</div>
    </div>
  );
}

interface RegistryOption {
  id: string;
  displayName: string;
  active?: boolean;
  mergedInto?: string;
}

/** "Add to umpire registry" / "Link to existing umpire" for one free-text entry. */
function AttributeUmpire({
  entry,
  umpires,
  onLink,
  onRegister,
}: {
  entry: ReportUmpireEntry;
  umpires: RegistryOption[];
  onLink?: (umpireId: string) => Promise<unknown>;
  onRegister?: () => Promise<unknown>;
}) {
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn?: () => Promise<unknown>) => {
    if (!fn) return;
    setBusy(true);
    try {
      await fn();
    } catch {
      // The console already showed the failure (withToast); keep the controls usable.
    } finally {
      setBusy(false);
    }
  };
  const options = umpires
    .filter((u) => u.active !== false && !u.mergedInto)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return (
    <div className="cr-attribute" role="group" aria-label={`Attribute ${entry.name}`}>
      <span className="ump-sub">Not in the umpire registry.</span>
      {onRegister && (
        <Btn tone="outline" size="sm" disabled={busy} onClick={() => run(onRegister)}>
          Add to umpire registry
        </Btn>
      )}
      {onLink && (
        <>
          <select
            className="field-select"
            aria-label="Existing umpire"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            style={{ width: 'auto' }}
          >
            <option value="">Link to existing umpire…</option>
            {options.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
          <Btn
            tone="outline"
            size="sm"
            disabled={!pick || busy}
            onClick={() => run(() => onLink(pick))}
          >
            Link
          </Btn>
        </>
      )}
    </div>
  );
}

export function AdminCaptainsReportsView({
  reports,
  loading,
  umpires = [],
  onOpenClub,
  onAttribute,
  onCreateUmpire,
}: {
  reports: CaptainsReport[];
  loading?: boolean;
  /** The umpire registry (for linking a free-text umpire). */
  umpires?: RegistryOption[];
  /** Open a club's page (to add the chair's contact). */
  onOpenClub?: (clubId: string) => void;
  onAttribute?: (
    reportId: string,
    index: number,
    umpireId: string,
    action: 'registered' | 'linked',
  ) => Promise<CaptainsReport | undefined>;
  /** Resolves undefined when the add failed (the caller already said why). */
  onCreateUmpire?: (
    displayName: string,
  ) => Promise<{ id: string; displayName: string } | undefined>;
}) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [lowOnly, setLowOnly] = useState(false);
  const [undeliveredOnly, setUndeliveredOnly] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  // An attributed report replaces the list copy until the list refetches.
  const [patched, setPatched] = useState<Record<string, CaptainsReport>>({});
  const gaps = useQuery({
    queryKey: qk.captainsReportContactGaps(),
    queryFn: getCaptainsReportContactGaps,
  });

  const all = useMemo(() => reports.map((r) => patched[r.id] ?? r), [reports, patched]);
  const inRange = useMemo(
    () => all.filter((r) => (!from || r.matchDate >= from) && (!to || r.matchDate <= to)),
    [all, from, to],
  );
  const list = inRange
    .filter((r) => matchesStatus(r, status))
    .filter((r) => !lowOnly || r.umpires.some(hasLowRating))
    .filter((r) => !undeliveredOnly || noticeUndelivered(r));
  const open = openId ? all.find((r) => r.id === openId) : null;
  const gapClubs = gaps.data?.enabled ? gaps.data.clubs : [];

  async function attribute(index: number, umpireId: string, action: 'registered' | 'linked') {
    if (!open || !onAttribute) return;
    const saved = await onAttribute(open.id, index, umpireId, action);
    if (saved?.id) setPatched((p) => ({ ...p, [saved.id]: saved }));
  }

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Union office / Captain's reports</div>
          <h1 className="ph-title">
            Captain's <em>reports</em>
          </h1>
          <p className="ph-desc">
            Umpire ratings from each side's captain. Reports open when medicoach reports a result;
            the emailed link works for at least 7 days after the match, and clubs can file from
            their portal at any time.
          </p>
        </div>
      </div>

      {gapClubs.length > 0 && !open && (
        <div className="rp-validation cr-gaps" role="note" aria-label="Clubs with no chair contact">
          <strong>
            {gapClubs.length === 1
              ? '1 club has no chair contact'
              : `${gapClubs.length} clubs have no chair contact`}
          </strong>
          , so their report notices cannot be sent. Add the chair's email or cell:
          <ul>
            {gapClubs.map((c) => (
              <li key={c.id}>
                {c.name}{' '}
                {onOpenClub && (
                  <Btn
                    tone="ghost"
                    size="sm"
                    aria-label={`Edit ${c.name}`}
                    onClick={() => onOpenClub(c.id)}
                  >
                    Edit club
                  </Btn>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {open ? (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <Btn tone="ghost" size="sm" onClick={() => setOpenId(null)}>
              ← All reports
            </Btn>
            <Btn tone="outline" size="sm" icon={Icon.Download} onClick={() => window.print()}>
              Print
            </Btn>
          </div>
          {open.flagged && (
            <div className="rp-validation" role="note" style={{ marginBottom: 12 }}>
              The result behind this report was cleared in medicoach after it was submitted.
            </div>
          )}
          <CaptainsReportReadOnly
            report={open}
            umpireAction={(u, i) =>
              !u.umpireId && u.name && open.status === 'submitted' && onAttribute ? (
                <AttributeUmpire
                  entry={u}
                  umpires={umpires}
                  onLink={(umpireId) => attribute(i, umpireId, 'linked')}
                  onRegister={
                    onCreateUmpire
                      ? async () => {
                          const created = await onCreateUmpire(u.name);
                          if (created?.id) await attribute(i, created.id, 'registered');
                        }
                      : undefined
                  }
                />
              ) : null
            }
          />
        </div>
      ) : (
        <>
          <div className="cr-filters">
            <div className="cr-chips" role="group" aria-label="Status">
              {STATUS_CHIPS.map((c) => {
                const n = inRange.filter((r) => matchesStatus(r, c.key)).length;
                return (
                  <button
                    key={c.key}
                    type="button"
                    className={`cr-chip ${status === c.key ? 'on' : ''}`}
                    aria-pressed={status === c.key}
                    onClick={() => setStatus(c.key)}
                  >
                    {c.label} <span className="cr-chip-n">{n}</span>
                  </button>
                );
              })}
              <button
                type="button"
                className={`cr-chip ${lowOnly ? 'on' : ''}`}
                aria-pressed={lowOnly}
                onClick={() => setLowOnly((v) => !v)}
              >
                Low ratings (≤ 2)
              </button>
              <button
                type="button"
                className={`cr-chip ${undeliveredOnly ? 'on' : ''}`}
                aria-pressed={undeliveredOnly}
                onClick={() => setUndeliveredOnly((v) => !v)}
              >
                Notice not delivered{' '}
                <span className="cr-chip-n">{inRange.filter(noticeUndelivered).length}</span>
              </button>
            </div>
            <div className="cr-range">
              <label>
                From{' '}
                <input
                  type="date"
                  className="field-input"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                To{' '}
                <input
                  type="date"
                  className="field-input"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </div>
          </div>

          {loading ? (
            <div className="cr-section-sub">Loading…</div>
          ) : !list.length ? (
            <div className="cr-section-sub" style={{ padding: '24px 0' }}>
              {reports.length ? 'No reports match these filters.' : 'No captain’s reports yet.'}
            </div>
          ) : (
            <div className="tbl-w" style={{ marginTop: 14 }}>
              <table className="tbl cr-admin-table">
                <thead>
                  <tr>
                    <th>Match</th>
                    <th>Report from</th>
                    <th>Notice</th>
                    <th>Appointed umpires</th>
                    <th>Status</th>
                    <th>Ratings</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const avgs = r.umpires
                      .map((u) => avgRating(u))
                      .filter((x): x is number => x != null);
                    const low = r.umpires.some(hasLowRating);
                    return (
                      <tr key={r.id}>
                        <td data-label="Match">
                          <div style={{ fontWeight: 700 }}>{matchLine(r)}</div>
                          <div className="ump-sub">
                            {fmtDate(r.matchDate)} · {r.competition}
                          </div>
                          {r.source === 'manual-unlisted' && (
                            <Pill tone="navy">Not in the fixture list</Pill>
                          )}
                        </td>
                        <td data-label="Report from">{r.clubName}</td>
                        <td data-label="Notice">
                          <NoticeChips report={r} />
                        </td>
                        <td data-label="Umpires">
                          {r.umpiresSnapshot.length ? (
                            r.umpiresSnapshot.map((u) => u.name).join(', ')
                          ) : (
                            <span className="ump-none">None appointed</span>
                          )}
                        </td>
                        <td data-label="Status">
                          <CaptainsReportStatusPill report={r} />
                          {r.ref && <div className="ump-sub">{r.ref}</div>}
                        </td>
                        <td data-label="Ratings">
                          {avgs.length ? avgs.map((a) => a.toFixed(1)).join(' · ') : '—'}{' '}
                          {low && <Pill tone="coral">Low</Pill>}
                        </td>
                        <td className="cr-admin-actions">
                          {r.status === 'submitted' && (
                            <Btn tone="outline" size="sm" onClick={() => setOpenId(r.id)}>
                              View
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
        </>
      )}
    </div>
  );
}
