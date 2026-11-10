/* ─── Officials register: the pieces the admin Umpires and Scorers pages share ───
   Erased stubs (hidden everywhere), the Pending queue (Approve / Merge into… / Reject),
   Delete behind a typed confirmation, and the self-registration link modal.
   Contract: docs/api/officials.md. */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Btn, Icon, Modal, ModalCancelBtn, Pill } from './atoms';
import {
  ApiError,
  type ContactChoice,
  type OfficialRole,
  type OfficialVacatedFixture,
  type PendingDuplicate,
  type PossibleMatch,
} from './api';
import { useCopyLink } from './copyLink';
import { formatDayYear, formatStamp, formatStampDay } from './dates';

/** What these helpers read of a register row (umpires and scorers both fit). */
export interface OfficialRow {
  id: string;
  displayName: string;
  fullName?: string;
  phone?: string;
  email?: string;
  active: boolean;
  mergedInto?: string;
  pending?: true;
  submittedAt?: string;
  /** Other pending registrations of this role with the same cell number. */
  pendingDuplicates?: PendingDuplicate[];
  erasedAt?: string;
  /** Admin list only: an erased stub (docs/api/officials.md). */
  erased?: true;
  possibleMatches?: PossibleMatch[];
}

export const isErased = (u: { erased?: true; erasedAt?: string }) => !!u.erased || !!u.erasedAt;
export const isPendingOfficial = (u: OfficialRow) => !!u.pending && !isErased(u);

export type OfficialFilter = 'active' | 'pending' | 'inactive' | 'all';

/**
 * The register split the way the page shows it. Erased stubs are in none of the lists (they
 * stay in the raw data for name lookups and rating roll-ups); pending is its own tab and never
 * counts as Inactive.
 */
export function partitionOfficials<T extends OfficialRow>(list: T[]) {
  const visible = list.filter((u) => !isErased(u));
  return {
    visible,
    active: visible.filter((u) => u.active),
    pending: visible.filter((u) => !u.active && !!u.pending),
    inactive: visible.filter((u) => !u.active && !u.pending),
  };
}

/** How many self-registrations wait for review (the sidebar indicator). */
export const pendingCount = (list: OfficialRow[]) =>
  list.filter((u) => isPendingOfficial(u) && !u.active).length;

export const MATCH_REASON: Record<PossibleMatch['reason'], string> = {
  phone: 'same phone',
  name: 'same name',
  'surname-initial': 'same surname and initial',
};

/** Text inputs inside the light admin dialogs (there is no shared input class). */
const DIALOG_INPUT: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--white)',
  color: 'var(--ink)',
  fontSize: 13,
};

const noun = (role: OfficialRole) => (role === 'umpire' ? 'umpire' : 'scorer');

/**
 * Toast copy for a refused PATCH or merge on an erased or pending record, or null for the
 * generic copy. Used through withToast's `errorMessage` (the 409 also refetches the list).
 */
export function officialWriteErrorMessage(role: OfficialRole, err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === `${role}_erased`)
    return `This ${noun(role)} has been deleted, so the entry can no longer be changed. The list has been refreshed.`;
  if (err.code === `${role}_pending`)
    return `This ${noun(role)} is still a pending registration. Approve it from the Pending tab instead.`;
  return null;
}

/** Inline copy for a refused merge of a pending record. */
export function mergeErrorMessageFor(role: OfficialRole, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'registration_changed') return REGISTRATION_CHANGED_NOTICE;
    if (err.code === 'umpire_alias_taken') {
      const name = err.details?.displayName;
      const who = typeof name === 'string' && name ? `“${name}”` : 'another umpire';
      return `This registration's sheet name is already used by ${who}, so it can't be merged into the entry you picked. Merge it into ${who} instead, or edit the sheet name first.`;
    }
    if (err.code === 'contact_choice_required')
      return 'The contact details could not be matched up. Refresh the page and try the merge again.';
    return officialWriteErrorMessage(role, err) ?? err.message;
  }
  return `Could not merge the ${noun(role)}.`;
}

/** Inline copy for a refused Approve. */
export function approveErrorMessage(role: OfficialRole, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'registration_changed') return REGISTRATION_CHANGED_NOTICE;
    if (err.code === 'umpire_alias_taken' || err.code === 'scorer_name_taken') {
      const name = err.details?.displayName;
      const who = typeof name === 'string' && name ? `“${name}”` : 'Another entry';
      return `${who} is already on the register under this name. Use Merge into… to add these details to that entry instead.`;
    }
    if (err.code === `${role}_not_pending`)
      return 'This registration has already been dealt with. The list has been refreshed.';
    if (err.code === `${role}_erased`)
      return `This ${noun(role)} has been deleted. The list has been refreshed.`;
    return err.message;
  }
  return `Could not approve the ${noun(role)}.`;
}

export interface ContactConflict {
  field: 'phone' | 'email';
  source: string;
  target: string;
}

/** The conflicts carried by a 409 `contact_choice_required`, or null for any other error. */
export function contactConflicts(err: unknown): ContactConflict[] | null {
  if (!(err instanceof ApiError) || err.code !== 'contact_choice_required') return null;
  const raw = err.details?.conflicts;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is ContactConflict =>
      !!c && (c.field === 'phone' || c.field === 'email') && typeof c.field === 'string',
  );
}

export type MergePendingResult = {
  target: { displayName: string; phone?: string; email?: string };
  previous: { phone: string | null; email: string | null };
};

/** "Merged into X" plus each contact field the merge changed, with its previous value. */
export function mergedNotice(res: MergePendingResult): string {
  const changes = (['phone', 'email'] as const)
    .map((k) => {
      const before = res.previous?.[k] ?? null;
      const after = res.target?.[k] ?? null;
      if ((before ?? '') === (after ?? '')) return null;
      const label = k === 'phone' ? 'Phone' : 'Email';
      return before
        ? `${label} replaced: was ${before}, now ${after ?? 'blank'}.`
        : `${label} added: ${after}.`;
    })
    .filter((x): x is string => !!x);
  return [
    `Merged into ${res.target?.displayName ?? 'the existing entry'}.`,
    ...(changes.length ? changes : ['No contact details changed.']),
  ].join(' ');
}

export type Notice = { tone: 'ok' | 'warn'; text: string } | null;

export function NoticeBar({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  if (!notice) return null;
  return (
    <div
      className={`insights-callout ${notice.tone === 'warn' ? 'warn' : 'good'}`}
      role={notice.tone === 'warn' ? 'alert' : 'status'}
      data-testid="officials-notice"
      style={{ marginTop: 14, display: 'flex', gap: 12, alignItems: 'flex-start' }}
    >
      <span style={{ flex: 1 }}>{notice.text}</span>
      <button type="button" className="task-modal-close" aria-label="Dismiss" onClick={onDismiss}>
        <Icon.X />
      </button>
    </div>
  );
}

/* ─── Pending row ─── */

/** Submitted date, a same-cell duplicate caution and the ranked candidates, under the pending row's name. */
export function PendingDetails({ official }: { official: OfficialRow }) {
  const matches = official.possibleMatches ?? [];
  const dups = official.pendingDuplicates ?? [];
  return (
    <div className="ump-sub" data-testid="pending-details">
      {official.submittedAt && <div>Submitted {formatStamp(official.submittedAt)}</div>}
      {dups.length > 0 && (
        <div
          className="insights-callout warn"
          role="note"
          data-testid="pending-duplicates"
          style={{ margin: '6px 0', padding: '6px 10px' }}
        >
          {dups.map((d) => (
            <div key={d.id}>
              Another pending registration uses this cell number: {d.displayName}
              {d.submittedAt ? ` (submitted ${formatStamp(d.submittedAt)})` : ''}. Check which one
              is genuine and reject the other.
            </div>
          ))}
        </div>
      )}
      {matches.length > 0 ? (
        <div>
          Possibly already on the register:
          <ul
            aria-label={`Possible matches for ${official.displayName}`}
            style={{ margin: '2px 0 0', paddingLeft: 18 }}
          >
            {matches.map((m) => (
              <li key={m.id}>
                {m.displayName}{' '}
                <span className="ump-none">({MATCH_REASON[m.reason] ?? m.reason})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div>No likely match on the register.</div>
      )}
    </div>
  );
}

/** Shown when the registrant resubmitted while the admin was reviewing (409 registration_changed). */
export const REGISTRATION_CHANGED_NOTICE =
  'This registration was updated by the applicant while you were reviewing it. Check the details again before approving.';

export interface PendingHandlers {
  /** `submittedAt` is the pending record's as shown; a change since answers 409. */
  onApprove?: (id: string, submittedAt: string) => Promise<unknown>;
  onMergePending?: (
    id: string,
    targetId: string,
    submittedAt: string,
    contact?: ContactChoice,
  ) => Promise<MergePendingResult>;
  /** Reject = DELETE on an unreferenced pending record (hard delete). */
  onErase?: (id: string) => Promise<unknown>;
}

/**
 * Approve / Merge into… / Reject / Edit for one pending row. Errors and successes go to the
 * page's notice bar; nothing is preselected in the merge picker.
 */
export function PendingActions({
  role,
  official,
  activeEntries,
  onApprove,
  onMergePending,
  onErase,
  onEdit,
  onNotice,
}: PendingHandlers & {
  role: OfficialRole;
  official: OfficialRow;
  /** Every active, unmerged, visible entry (the merge candidates beyond possibleMatches). */
  activeEntries: OfficialRow[];
  onEdit: () => void;
  onNotice: (n: Notice) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [merging, setMerging] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ContactConflict[] | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const name = official.displayName;
  const matchIds = new Set((official.possibleMatches ?? []).map((m) => m.id));
  const candidates = activeEntries.filter((t) => t.id !== official.id && !t.mergedInto);
  const matched = (official.possibleMatches ?? []).filter((m) =>
    candidates.some((c) => c.id === m.id),
  );
  const others = candidates
    .filter((c) => !matchIds.has(c.id))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const targetName = (id: string) =>
    candidates.find((c) => c.id === id)?.displayName ??
    matched.find((m) => m.id === id)?.displayName ??
    id;

  const submittedAt = official.submittedAt ?? '';
  async function approve() {
    if (!onApprove) return;
    setBusy(true);
    try {
      await onApprove(official.id, submittedAt);
      onNotice({ tone: 'ok', text: `${name} approved and now active.` });
    } catch (err) {
      onNotice({ tone: 'warn', text: approveErrorMessage(role, err) });
    } finally {
      setBusy(false);
    }
  }
  async function merge(targetId: string, contact?: ContactChoice) {
    if (!onMergePending) return;
    setBusy(true);
    try {
      const res = await onMergePending(official.id, targetId, submittedAt, contact);
      setMerging(null);
      setConflicts(null);
      onNotice({ tone: 'ok', text: mergedNotice(res) });
    } catch (err) {
      const c = contactConflicts(err);
      // Open the choice dialog only for a first attempt that named real conflicts; an empty
      // list, or a second ask after a choice was sent, is an error (never a dialog loop).
      if (c && c.length > 0 && !contact) {
        setConflicts(c);
        return;
      }
      setConflicts(null);
      if (err instanceof ApiError && err.code === 'registration_changed') setMerging(null);
      onNotice({ tone: 'warn', text: mergeErrorMessageFor(role, err) });
    } finally {
      setBusy(false);
    }
  }
  async function reject() {
    if (!onErase) return;
    setBusy(true);
    try {
      await onErase(official.id);
      setRejecting(false);
      onNotice({ tone: 'ok', text: `Registration from ${name} rejected and removed.` });
    } catch (err) {
      setRejecting(false);
      onNotice({
        tone: 'warn',
        text: err instanceof ApiError ? err.message : 'Could not reject the registration.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {merging !== null ? (
        <div className="ump-merge">
          <select
            aria-label={`Merge ${name} into`}
            data-testid="pending-merge-target"
            value={merging}
            onChange={(e) => setMerging(e.target.value)}
          >
            <option value="">Merge into…</option>
            {matched.length > 0 && (
              <optgroup label="Possible matches">
                {matched.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName} ({MATCH_REASON[m.reason] ?? m.reason})
                  </option>
                ))}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label={matched.length ? 'Everyone else' : 'Active entries'}>
                {others.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.displayName}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <Btn
            tone="ink"
            size="sm"
            disabled={busy || !merging}
            data-testid="pending-merge-confirm"
            onClick={() => merge(merging)}
          >
            Merge
          </Btn>
          <Btn tone="ghost" size="sm" onClick={() => setMerging(null)}>
            Cancel
          </Btn>
        </div>
      ) : (
        <div
          data-testid="pending-actions"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(2, max-content)', gap: 6 }}
        >
          {onApprove && (
            <Btn
              tone="teal"
              size="sm"
              disabled={busy}
              data-testid="pending-approve"
              onClick={approve}
            >
              Approve
            </Btn>
          )}
          {onMergePending && candidates.length > 0 && (
            <Btn
              tone="outline"
              size="sm"
              disabled={busy}
              data-testid="pending-merge"
              style={{ whiteSpace: 'nowrap', justifyContent: 'center' }}
              onClick={() => setMerging('')}
            >
              Merge into…
            </Btn>
          )}
          <Btn tone="outline" size="sm" onClick={onEdit}>
            Edit
          </Btn>
          {onErase && (
            <Btn
              tone="ghost"
              size="sm"
              disabled={busy}
              data-testid="pending-reject"
              onClick={() => setRejecting(true)}
            >
              Reject
            </Btn>
          )}
        </div>
      )}
      {conflicts && merging && (
        <ContactChoiceDialog
          role={role}
          targetName={targetName(merging)}
          conflicts={conflicts}
          busy={busy}
          onClose={() => setConflicts(null)}
          onConfirm={(choice) => merge(merging, choice)}
        />
      )}
      {rejecting && (
        <Modal
          eyebrow={`Pending ${noun(role)}`}
          title={`Reject ${name}?`}
          maxWidth={480}
          onClose={() => setRejecting(false)}
          footer={
            <>
              <ModalCancelBtn tone="outline" disabled={busy}>
                Cancel
              </ModalCancelBtn>
              <Btn tone="ink" disabled={busy} data-testid="pending-reject-confirm" onClick={reject}>
                {busy ? 'Rejecting…' : 'Reject registration'}
              </Btn>
            </>
          }
        >
          <p className="ph-desc">
            The registration and the details {name} submitted are deleted. They are not told. If
            they register again through the link, the new submission appears here.
          </p>
        </Modal>
      )}
    </>
  );
}

/**
 * The target already holds a different phone or email: show both values for each field and
 * require an explicit choice per field before the merge is retried. Nothing is preselected.
 */
export function ContactChoiceDialog({
  role,
  targetName,
  conflicts,
  busy,
  onClose,
  onConfirm,
}: {
  role: OfficialRole;
  targetName: string;
  conflicts: ContactConflict[];
  busy?: boolean;
  onClose: () => void;
  onConfirm: (choice: ContactChoice) => void;
}) {
  const [choice, setChoice] = useState<ContactChoice>({});
  const complete = conflicts.every((c) => choice[c.field]);
  return (
    <Modal
      eyebrow={`Merge ${noun(role)}`}
      title="Choose which contact details to keep"
      maxWidth={560}
      onClose={onClose}
      footer={
        <>
          <ModalCancelBtn tone="outline" disabled={busy}>
            Cancel
          </ModalCancelBtn>
          <Btn
            tone="ink"
            disabled={busy || !complete}
            data-testid="contact-choice-confirm"
            onClick={() => onConfirm(choice)}
          >
            {busy ? 'Merging…' : 'Merge with these details'}
          </Btn>
        </>
      }
    >
      <div data-testid="contact-choice-dialog">
        <p className="ph-desc">
          {targetName} already has different contact details on the register. Appointment notices go
          to whatever is kept, so check before replacing anything. Pick one value for each.
        </p>
        {conflicts.map((c) => {
          const label = c.field === 'phone' ? 'Phone' : 'Email';
          return (
            <fieldset
              key={c.field}
              aria-label={label}
              style={{
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: '10px 12px',
                marginTop: 10,
              }}
            >
              <legend style={{ fontWeight: 700, padding: '0 4px' }}>{label}</legend>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="radio"
                  name={`contact-${c.field}`}
                  value="target"
                  checked={choice[c.field] === 'target'}
                  onChange={() => setChoice((x) => ({ ...x, [c.field]: 'target' }))}
                />
                <span>
                  Keep current on the register ({targetName}): <strong>{c.target}</strong>
                </span>
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                <input
                  type="radio"
                  name={`contact-${c.field}`}
                  value="source"
                  checked={choice[c.field] === 'source'}
                  onChange={() => setChoice((x) => ({ ...x, [c.field]: 'source' }))}
                />
                <span>
                  Use submitted in the registration: <strong>{c.source}</strong>
                </span>
              </label>
            </fieldset>
          );
        })}
      </div>
    </Modal>
  );
}

/* ─── Delete (erase) ─── */

export interface ErasePreview {
  vacated: OfficialVacatedFixture[];
  counts: { today: number; upcoming: number; played: number };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The plain-words summary of what Delete does, from the preview counts. */
export function eraseSummary(role: OfficialRole, counts: ErasePreview['counts']): string[] {
  const placeholder = role === 'umpire' ? 'Removed umpire' : 'Removed scorer';
  const out = ['Their personal details will be permanently erased.'];
  const { upcoming, today, played } = counts;
  if (upcoming || today) {
    const parts = [
      upcoming ? `${plural(upcoming, 'upcoming fixture')}` : null,
      today ? `${today} today` : null,
    ].filter(Boolean);
    out.push(`They will be removed from ${parts.join(' and ')}.`);
  } else out.push('They are not appointed to any upcoming fixture.');
  if (played)
    out.push(
      `${plural(played, 'past appointment')}${role === 'umpire' ? ' and their ratings are' : played === 1 ? ' is' : ' are'} kept under “${placeholder}”.`,
    );
  return out;
}

export function DeleteOfficialDialog({
  role,
  official,
  loadPreview,
  onErase,
  onClose,
  onDone,
}: {
  role: OfficialRole;
  official: OfficialRow;
  loadPreview: (id: string) => Promise<ErasePreview>;
  onErase: (id: string) => Promise<unknown>;
  onClose: () => void;
  onDone: (n: Notice) => void;
}) {
  const [preview, setPreview] = useState<ErasePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The parent rebuilds `loadPreview` on every render: read it through a ref so the preview is
  // fetched once per opened official (and again only on Retry).
  const loadRef = useRef(loadPreview);
  loadRef.current = loadPreview;
  useEffect(() => {
    let live = true;
    setPreview(null);
    setLoadError(null);
    loadRef.current(official.id).then(
      (p) => live && setPreview(p),
      (err) =>
        live &&
        setLoadError(err instanceof ApiError ? err.message : 'Could not check their appointments.'),
    );
    return () => {
      live = false;
    };
  }, [official.id, attempt]);
  const name = official.displayName;
  const matchesName = typed.trim() === name.trim();
  async function erase() {
    setBusy(true);
    setError(null);
    try {
      await onErase(official.id);
      onDone({ tone: 'ok', text: `${name} deleted. Their personal details have been erased.` });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not delete the ${noun(role)}.`);
      setBusy(false);
    }
  }
  return (
    <Modal
      eyebrow={`Delete ${noun(role)}`}
      title={`Delete ${name}?`}
      maxWidth={560}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <ModalCancelBtn tone="outline" disabled={busy}>
            Cancel
          </ModalCancelBtn>
          <Btn
            tone="ink"
            disabled={busy || !preview || !!loadError || !matchesName}
            data-testid="official-delete-confirm"
            onClick={erase}
          >
            {busy ? 'Deleting…' : `Delete ${noun(role)}`}
          </Btn>
        </>
      }
    >
      <div data-testid="official-delete-dialog">
        {!preview && !loadError && <p className="ph-desc">Checking their appointments…</p>}
        {loadError && (
          <div className="insights-callout alert" role="alert">
            <p style={{ margin: '0 0 8px' }}>{loadError} Nothing has been deleted.</p>
            <Btn
              tone="outline"
              size="sm"
              data-testid="official-delete-retry"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Retry
            </Btn>
          </div>
        )}
        {preview && (
          <>
            <p className="ph-desc" data-testid="official-delete-summary">
              {eraseSummary(role, preview.counts).join(' ')}
            </p>
            {preview.vacated.length > 0 && (
              <>
                <div style={{ marginTop: 10, fontWeight: 700, color: 'var(--ink)', fontSize: 13 }}>
                  Fixtures that will be left without this {noun(role)}
                </div>
                <ul
                  aria-label="Fixtures losing this official"
                  style={{ margin: '4px 0 0', paddingLeft: 18 }}
                >
                  {preview.vacated.map((f) => (
                    <li key={`${f.seriesId}#${f.fixtureId}`}>
                      {f.label} · {f.date ? formatDayYear(f.date) : 'date TBC'}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="ph-desc" style={{ marginTop: 10 }}>
              <strong>This cannot be undone.</strong> Type <strong>{name}</strong> to confirm.
            </p>
            <input
              className="input"
              aria-label={`Type ${name} to confirm`}
              data-testid="official-delete-typed"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              style={DIALOG_INPUT}
            />
          </>
        )}
        {error && (
          <div className="insights-callout alert" role="alert" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ─── Self-registration link ─── */

export interface SignupLinkHandlers {
  load: () => Promise<{ url: string | null; createdAt?: string }>;
  create: () => Promise<{ url: string; createdAt: string }>;
  revoke: () => Promise<unknown>;
}

/** One link per role: create / copy / replace (old one dies) / turn off. */
export function SignupLinkModal({
  role,
  link: handlers,
  onClose,
}: {
  role: OfficialRole;
  link: SignupLinkHandlers;
  onClose: () => void;
}) {
  const [link, setLink] = useState<{ url: string | null; createdAt?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'replace' | 'revoke' | null>(null);
  const [confirm, setConfirm] = useState<'replace' | 'revoke' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    handlers.load().then(
      (r) => live && setLink(r),
      (err) => live && setError(err instanceof ApiError ? err.message : 'Could not load the link.'),
    );
    return () => {
      live = false;
    };
    // Load once on open; the handlers object is rebuilt on every parent render.
  }, []);
  const { copy, busyId, node } = useCopyLink(
    async () =>
      link?.url ? { url: link.url } : handlers.load().then((r) => ({ url: r.url ?? '' })),
    'Anyone with the link can register until you replace it or turn it off.',
  );
  const people = role === 'umpire' ? 'umpires' : 'scorers';
  async function run(kind: 'create' | 'replace' | 'revoke') {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'revoke') {
        await handlers.revoke();
        setLink({ url: null });
        setNote('Link turned off. Nobody can register with it any more.');
      } else {
        const r = await handlers.create();
        setLink(r);
        setNote(
          kind === 'replace'
            ? 'New link created. The previous link no longer works.'
            : 'Link created. Copy it and share it.',
        );
      }
      setConfirm(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  }
  const has = !!link?.url;
  let body: ReactNode;
  if (!link && !error) body = <p className="ph-desc">Loading…</p>;
  else if (link && !has)
    body = (
      <>
        <p className="ph-desc" data-testid="signup-link-state">
          No registration link yet. Create one and share it with your {people} (for example in a
          WhatsApp group). They fill in their own details, and each registration waits on the
          Pending tab until you approve it.
        </p>
        <Btn
          tone="teal"
          icon={Icon.Plus}
          disabled={!!busy}
          data-testid="signup-link-create"
          onClick={() => run('create')}
        >
          {busy === 'create' ? 'Creating…' : 'Create link'}
        </Btn>
      </>
    );
  else if (link && has)
    body = (
      <>
        <p className="ph-desc" data-testid="signup-link-state">
          Link active since {formatStampDay(link.createdAt)}. Registrations wait on the Pending tab
          until you approve them.
        </p>
        <input
          className="input"
          readOnly
          value={link.url ?? ''}
          aria-label="Link to share"
          data-testid="signup-link-url"
          style={{
            ...DIALOG_INPUT,
            margin: '10px 0 0',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
        {confirm === null ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <Btn
              tone="ink"
              icon={Icon.Form}
              disabled={busyId !== null || !!busy}
              data-testid="signup-link-copy"
              onClick={() => copy(role)}
            >
              Copy link
            </Btn>
            <Btn
              tone="outline"
              disabled={!!busy}
              data-testid="signup-link-replace"
              onClick={() => setConfirm('replace')}
            >
              Replace link
            </Btn>
            <Btn
              tone="ghost"
              disabled={!!busy}
              data-testid="signup-link-revoke"
              onClick={() => setConfirm('revoke')}
            >
              Turn off link
            </Btn>
          </div>
        ) : (
          <div className="insights-callout warn" role="note" style={{ marginTop: 12 }}>
            <p style={{ margin: '0 0 8px' }}>
              {confirm === 'replace'
                ? 'The current link stops working straight away. Anyone you sent it to will need the new one.'
                : 'The link stops working straight away. Nobody can register until you create a new one.'}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Btn tone="ghost" size="sm" disabled={!!busy} onClick={() => setConfirm(null)}>
                Cancel
              </Btn>
              <Btn
                tone="ink"
                size="sm"
                disabled={!!busy}
                data-testid="signup-link-confirm"
                onClick={() => run(confirm)}
              >
                {busy ? 'Working…' : confirm === 'replace' ? 'Replace link' : 'Turn off link'}
              </Btn>
            </div>
          </div>
        )}
      </>
    );
  return (
    <Modal
      eyebrow={`${role === 'umpire' ? 'Umpire' : 'Scorer'} self-registration`}
      title="Registration link"
      maxWidth={560}
      onClose={onClose}
    >
      <div data-testid="signup-link-modal">
        {body}
        {note && (
          <div className="insights-callout good" role="status" style={{ marginTop: 12 }}>
            {note}
          </div>
        )}
        {error && (
          <div className="insights-callout alert" role="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </div>
      {node}
    </Modal>
  );
}

/** The status cell for a pending row. */
export function PendingPill() {
  return <Pill tone="gold">Pending</Pill>;
}
