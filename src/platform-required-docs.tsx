/**
 * Operator console — per-tenant compliance-doc catalogue (ADR 0009).
 *
 * The documents a club must supply to be marked compliant, and how each one behaves —
 * single file, multi-file (one certificate per person), an on-platform form (the exco
 * pattern), or one of the escape hatches (meeting-booked, course-booked, unavailable).
 * `PUT /tenant/config` validates the whole array server-side (≤30 entries, unique keys,
 * a key regex, kind:'form' restricted to key 'exco', etc.) and 409s a REMOVE while a
 * club still has data under that key — "archive it instead". Absent ⇒ the frontend and
 * backend both fall back to the shared DEFAULT_REQUIRED_DOCS (data.ts).
 *
 * Same draft/dirty/Save shape as DistrictsCard: `draft` is seeded from the FULL effective
 * list (defaults included) on mount, so a tenant running on defaults that only tweaks one
 * row still PUTs the complete list — a save can never silently drop the rest of the
 * defaults. Unlike LeaguesCard/StructuresCard there's no rebuild-against-server's-latest
 * dance on every action: this catalogue isn't edited by club admins concurrently, only
 * operators, so DistrictsCard's simpler one-shot draft is the right level of caution.
 *
 * Lives outside platform.tsx (already ~3,500 lines), matching the CalendarsCard/
 * StructuresCard/TutorialsCard sibling-file pattern.
 */
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BoundedNumber, Btn, Card, Choice, EmptyState, Icon, Pill, useEscapeClose } from './atoms';
import { ApiError } from './api';
import { DEFAULT_REQUIRED_DOCS, docMinFiles } from './data';
import type { DocFormat, RequiredDoc, TenantConfig } from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '8px 0 0' };
const MONO: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
const CHECK_ROW: CSSProperties = {
  fontSize: 12.5,
  display: 'inline-flex',
  gap: 6,
  alignItems: 'center',
};

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const MAX_DOCS = 30;

const FORMAT_OPTIONS: Array<{ value: DocFormat; label: string }> = [
  { value: 'pdf', label: 'PDF' },
  { value: 'doc', label: 'Word (.doc)' },
  { value: 'docx', label: 'Word (.docx)' },
  { value: 'xls', label: 'Excel (.xls)' },
  { value: 'xlsx', label: 'Excel (.xlsx)' },
  { value: 'ods', label: 'OpenDocument (.ods)' },
];
const DEFAULT_ACCEPTS: DocFormat[] = ['pdf', 'doc', 'docx'];

function sameFormatSet(a: DocFormat[], b: DocFormat[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}

/**
 * "Club Constitution" → "club-constitution" — local mirror of leagues.ts's
 * slugifyLeagueKey, tailored to the doc-key regex: it must START with a letter (a
 * name like "3rd Team Waivers" would otherwise slug to a leading-digit key the
 * server 400s on), so any leading digits/hyphens are stripped after the slug.
 */
function slugifyDocKey(name: string): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '');
  return s.slice(0, 40);
}

/** Short accepted-format summary for a row, e.g. "PDF, Word" / "PDF, Word, Excel". */
function formatSummary(accepts?: DocFormat[]): string {
  const list = accepts && accepts.length ? accepts : DEFAULT_ACCEPTS;
  const parts: string[] = [];
  if (list.includes('pdf')) parts.push('PDF');
  if (list.includes('doc') || list.includes('docx')) parts.push('Word');
  if (list.includes('xls') || list.includes('xlsx') || list.includes('ods')) parts.push('Excel');
  return parts.join(', ') || '—';
}

/** Behavior pills for one row — mirrors the flags RequiredDoc declares (ADR 0009). */
function behaviorPills(doc: RequiredDoc): ReactNode[] {
  const pills: ReactNode[] = [];
  if (doc.kind === 'form')
    pills.push(
      <Pill key="form" tone="muted">
        On-platform form
      </Pill>,
    );
  if (doc.multiFile) {
    // The runtime cap when `maxFiles` is absent lives on the server
    // (multiFileLimits in packages/api/src/catalogue.ts) and is deliberately not
    // duplicated here as a literal — it can change independently of this badge. Render
    // honestly for that case ("×N+") rather than asserting a number we don't own; when
    // maxFiles IS set, show the real range. `docMinFiles` mirrors the client's own
    // effective-minimum fallback so the badge matches what club.tsx actually enforces.
    const min = docMinFiles(doc);
    const range = doc.maxFiles != null ? `×${min}–${doc.maxFiles}` : `×${min}+`;
    pills.push(
      <Pill key="multi" tone="muted">
        {`Multi-file ${range}`}
      </Pill>,
    );
  }
  if (doc.allowMeetingBooked)
    pills.push(
      <Pill key="meeting" tone="muted">
        Meeting-booked OK
      </Pill>,
    );
  if (doc.allowCourseBooked)
    pills.push(
      <Pill key="course" tone="muted">
        Course-booked OK
      </Pill>,
    );
  if (doc.allowUnavailable)
    pills.push(
      <Pill key="unavail" tone="muted">
        May be unavailable
      </Pill>,
    );
  if (doc.archived)
    pills.push(
      <Pill key="archived" tone="coral">
        Archived
      </Pill>,
    );
  return pills;
}

/** Modal host, same task-modal classes/shape as LeagueModal / platform-structures's Modal. */
function DocModal({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}) {
  useEscapeClose(onClose);
  const titleId = useId();
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Platform · Compliance docs</div>
            <div className="task-modal-head-title" id={titleId}>
              {title}
            </div>
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

/**
 * Add/edit form for one document. `doc` null ⇒ create; `locked` ⇒ this key already exists
 * on the tenant's PERSISTED (saved) catalogue, so the key field is read-only — it's the
 * matching token stored on club docMeta and must never move once clubs upload against it.
 * A brand-new, not-yet-saved row stays editable so a typo in the auto-derived key can
 * still be fixed before the first save.
 */
function DocForm({
  doc,
  locked,
  existingKeys,
  onSave,
  onClose,
}: {
  doc: RequiredDoc | null;
  locked: boolean;
  existingKeys: string[];
  onSave: (doc: RequiredDoc) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(doc?.name ?? '');
  // Editing an existing row: the key is whatever it already is — never re-derive it from
  // name edits. A brand-new row auto-slugs from the name until the operator types in the
  // key box directly (mirrors LeagueForm's key-from-label pattern).
  const [keyTouched, setKeyTouched] = useState(!!doc);
  const [key, setKey] = useState(doc?.key ?? '');
  const [desc, setDesc] = useState(doc?.desc ?? '');
  const [kind, setKind] = useState<'file' | 'form'>(doc?.kind ?? 'file');
  const [multiFile, setMultiFile] = useState(!!doc?.multiFile);
  const [minFiles, setMinFiles] = useState(doc?.minFiles ?? 1);
  const [maxFiles, setMaxFiles] = useState(doc?.maxFiles ?? Math.max(doc?.minFiles ?? 1, 2));
  const [allowMeetingBooked, setAllowMeetingBooked] = useState(!!doc?.allowMeetingBooked);
  const [allowCourseBooked, setAllowCourseBooked] = useState(!!doc?.allowCourseBooked);
  const [allowUnavailable, setAllowUnavailable] = useState(!!doc?.allowUnavailable);
  const [accepts, setAccepts] = useState<DocFormat[]>(doc?.accepts ?? DEFAULT_ACCEPTS);
  const [matchHints, setMatchHints] = useState<string[]>(doc?.matchHints ?? []);
  const [hintText, setHintText] = useState('');
  const [err, setErr] = useState('');

  // 'form' is restricted server-side to key 'exco' — the picker only appears for that key,
  // so a key edit that moves away from 'exco' must fall the draft back to 'file' too.
  function setKeySafe(v: string) {
    setKey(v);
    if (v !== 'exco' && kind === 'form') setKind('file');
  }
  function onNameChange(v: string) {
    setName(v);
    if (!keyTouched) setKeySafe(slugifyDocKey(v));
  }
  function onKeyChange(v: string) {
    setKeyTouched(true);
    setKeySafe(v);
  }
  function toggleMultiFile(on: boolean) {
    setMultiFile(on);
    // The two escape hatches are mutually exclusive by file-count (server-enforced): flip
    // off whichever one no longer applies rather than leaving a stale, now-invalid flag set.
    if (on) setAllowMeetingBooked(false);
    else setAllowCourseBooked(false);
  }
  function toggleAccept(f: DocFormat, on: boolean) {
    setAccepts((prev) => (on ? [...prev, f] : prev.filter((x) => x !== f)));
  }
  function addHint() {
    const h = hintText.trim();
    setErr('');
    if (!h) return;
    if (h.length > 40) {
      setErr('Hints must be 40 characters or fewer');
      return;
    }
    if (matchHints.length >= 10) {
      setErr('Up to 10 hints');
      return;
    }
    if (matchHints.includes(h)) {
      setHintText('');
      return;
    }
    setMatchHints([...matchHints, h]);
    setHintText('');
  }

  function submit() {
    setErr('');
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErr('Name is required');
      return;
    }
    if (trimmedName.length > 80) {
      setErr('Name must be 80 characters or fewer');
      return;
    }
    if (!KEY_RE.test(key)) {
      setErr(
        'Key must start with a letter and contain only letters, digits, "_" or "-" (max 40 characters)',
      );
      return;
    }
    if (existingKeys.includes(key)) {
      setErr(`"${key}" is already used by another document`);
      return;
    }
    if (desc.trim().length > 300) {
      setErr('Description must be 300 characters or fewer');
      return;
    }
    if (kind === 'form' && key !== 'exco') {
      setErr('The on-platform form kind is reserved for the "exco" document');
      return;
    }
    if (multiFile && (minFiles < 1 || maxFiles > 20 || minFiles > maxFiles)) {
      setErr('Multi-file min/max must be between 1 and 20, with min ≤ max');
      return;
    }
    if (kind !== 'form' && accepts.length === 0) {
      setErr('Pick at least one accepted file format');
      return;
    }

    const next: RequiredDoc = {
      key,
      name: trimmedName,
      ...(desc.trim() ? { desc: desc.trim() } : {}),
      ...(kind === 'form' ? { kind: 'form' as const } : {}),
      ...(kind !== 'form' && multiFile ? { multiFile: true, minFiles, maxFiles } : {}),
      ...(kind !== 'form' && allowUnavailable ? { allowUnavailable: true } : {}),
      ...(kind !== 'form' && !multiFile && allowMeetingBooked ? { allowMeetingBooked: true } : {}),
      ...(kind !== 'form' && multiFile && allowCourseBooked ? { allowCourseBooked: true } : {}),
      ...(kind !== 'form' && !sameFormatSet(accepts, DEFAULT_ACCEPTS) ? { accepts } : {}),
      ...(matchHints.length ? { matchHints } : {}),
      ...(doc?.archived ? { archived: true } : {}),
    };
    onSave(next);
  }

  return (
    <div>
      <div className="field-label">
        Name <span className="req">*</span>
      </div>
      <input
        className="field-input"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="e.g. Club Constitution"
        maxLength={80}
      />

      <div className="field-label" style={{ marginTop: 12 }}>
        Key
        {locked && (
          <span style={{ fontWeight: 400, color: 'var(--muted-2)' }}> · locked once saved</span>
        )}
      </div>
      <input
        className="field-input"
        style={MONO}
        value={key}
        onChange={(e) => onKeyChange(e.target.value)}
        disabled={locked}
        placeholder="auto-derived from the name"
        maxLength={40}
      />
      <p style={HINT}>
        The token stored on a club's document record — immutable once a club has uploaded against
        it.
      </p>

      <div className="field-label" style={{ marginTop: 12 }}>
        Description
      </div>
      <textarea
        className="field-textarea"
        rows={2}
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        maxLength={300}
        placeholder="Shown to the chair on the upload screen"
      />

      {key === 'exco' && (
        <div style={{ marginTop: 12 }}>
          <div className="field-label">Kind</div>
          <Choice
            value={kind}
            onChange={(v) => setKind(v as 'file' | 'form')}
            options={['file', 'form']}
          />
          <p style={HINT}>
            "form" is satisfied on-platform (the exco reps list) instead of an uploaded file.
          </p>
        </div>
      )}

      {kind !== 'form' && (
        <>
          <div style={{ marginTop: 14 }}>
            <label style={CHECK_ROW}>
              <input
                type="checkbox"
                checked={multiFile}
                onChange={(e) => toggleMultiFile(e.target.checked)}
              />
              Multiple files (e.g. one certificate per person)
            </label>
            {multiFile && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Min</span>
                <BoundedNumber
                  min={1}
                  max={20}
                  value={minFiles}
                  onChange={setMinFiles}
                  style={{ width: 70 }}
                  ariaLabel="Minimum files"
                />
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Max</span>
                <BoundedNumber
                  min={1}
                  max={20}
                  value={maxFiles}
                  onChange={setMaxFiles}
                  style={{ width: 70 }}
                  ariaLabel="Maximum files"
                />
              </div>
            )}
          </div>

          <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
            <label style={CHECK_ROW}>
              <input
                type="checkbox"
                checked={allowUnavailable}
                onChange={(e) => setAllowUnavailable(e.target.checked)}
              />
              "We don't have this" escape hatch
            </label>
            <label style={{ ...CHECK_ROW, opacity: multiFile ? 0.5 : 1 }}>
              <input
                type="checkbox"
                checked={allowMeetingBooked}
                disabled={multiFile}
                onChange={(e) => setAllowMeetingBooked(e.target.checked)}
              />
              "Meeting booked for &lt;date&gt;" escape hatch (single-file only)
            </label>
            <label style={{ ...CHECK_ROW, opacity: multiFile ? 1 : 0.5 }}>
              <input
                type="checkbox"
                checked={allowCourseBooked}
                disabled={!multiFile}
                onChange={(e) => setAllowCourseBooked(e.target.checked)}
              />
              "Course booked for &lt;date&gt;" escape hatch (multi-file only)
            </label>
          </div>

          <div style={{ marginTop: 12 }}>
            <div className="field-label">Accepted formats</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {FORMAT_OPTIONS.map((f) => (
                <label key={f.value} style={CHECK_ROW}>
                  <input
                    type="checkbox"
                    checked={accepts.includes(f.value)}
                    onChange={(e) => toggleAccept(f.value, e.target.checked)}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </div>
        </>
      )}

      <div style={{ marginTop: 12 }}>
        <div className="field-label">Intake-classifier hints</div>
        <p style={HINT}>
          Short phrases that help the upload flow guess which slot a scanned file belongs to.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <input
            className="field-input"
            style={{ flex: 1 }}
            value={hintText}
            maxLength={40}
            onChange={(e) => setHintText(e.target.value)}
            placeholder="e.g. constitution"
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addHint())}
          />
          <Btn
            tone="outline"
            size="sm"
            onClick={addHint}
            disabled={!hintText.trim() || matchHints.length >= 10}
          >
            Add
          </Btn>
        </div>
        {matchHints.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {matchHints.map((h) => (
              <span
                key={h}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11.5,
                  border: '1px solid var(--line2)',
                  borderRadius: 999,
                  padding: '2px 4px 2px 10px',
                }}
              >
                {h}
                <button
                  type="button"
                  onClick={() => setMatchHints(matchHints.filter((x) => x !== h))}
                  style={{
                    border: 'none',
                    background: 'none',
                    cursor: 'pointer',
                    color: 'var(--muted-2)',
                    fontSize: 13,
                    lineHeight: 1,
                    padding: '0 4px',
                  }}
                  title="Remove"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {err && <div style={{ ...ERR, marginTop: 12 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Btn tone="teal" size="sm" onClick={submit}>
          {doc ? 'Save changes' : 'Add document'}
        </Btn>
        <Btn tone="outline" size="sm" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

export function RequiredDocsCard({
  config,
  save,
  toast,
}: {
  config: TenantConfig;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig>;
  toast: Toast;
}) {
  // undefined ⇒ tenant running on the shared defaults (shown with a pill); the first save
  // materializes an explicit array on the config row — same drift-guard as DistrictsCard.
  const configured = config.requiredDocs;
  const effective = configured ?? DEFAULT_REQUIRED_DOCS;
  const [draft, setDraft] = useState<RequiredDoc[]>([...effective]);
  const [editing, setEditing] = useState<RequiredDoc | 'new' | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(effective);

  // A key in the draft that isn't on the tenant's last-saved catalogue — only meaningful
  // once the tenant HAS a saved catalogue (a brand-new client on shared defaults has no
  // "existing compliant clubs" to warn about yet).
  const newDocs =
    configured !== undefined ? draft.filter((d) => !effective.some((e) => e.key === d.key)) : [];

  function move(i: number, dir: -1 | 1) {
    setDraft((rows) => {
      const j = i + dir;
      if (j < 0 || j >= rows.length) return rows;
      const next = [...rows];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function toggleArchived(key: string) {
    setDraft((rows) => rows.map((d) => (d.key === key ? { ...d, archived: !d.archived } : d)));
  }
  function removeDoc(key: string) {
    setDraft((rows) => rows.filter((d) => d.key !== key));
  }
  function upsert(next: RequiredDoc, originalKey: string | null) {
    setDraft((rows) =>
      originalKey == null ? [...rows, next] : rows.map((d) => (d.key === originalKey ? next : d)),
    );
    setEditing(null);
  }

  async function saveIt() {
    setErr('');
    setBusy(true);
    try {
      await save({ requiredDocs: draft });
      toast('Compliance-doc catalogue saved');
    } catch (e) {
      // The referrer guard's 409 names the key and points at archiving instead of removing.
      const msg = e instanceof ApiError ? e.message : 'Could not save — try again';
      setErr(msg);
      toast(msg, 'warn');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          Compliance documents
          {configured === undefined && (
            <span
              style={{
                fontSize: 10.5,
                color: 'var(--muted-2)',
                border: '1px solid var(--line2)',
                borderRadius: 999,
                padding: '1px 7px',
                fontWeight: 400,
              }}
            >
              Using shared defaults
            </span>
          )}
        </span>
      }
      sub="The documents a club must supply to be marked compliant (ADR 0009). Removing a key a club still has data under is blocked — archive it instead so its stored files stay viewable."
    >
      {draft.length === 0 ? (
        <EmptyState
          icon={Icon.Doc}
          title="No documents configured"
          sub="Add at least one document before this client can mark clubs compliant."
          action={
            <Btn tone="teal" icon={Icon.Plus} onClick={() => setEditing('new')}>
              Add document
            </Btn>
          }
        />
      ) : (
        <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
          {draft.map((d, i) => (
            <div
              key={d.key}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
                padding: '10px 12px',
                border: '1px solid var(--line)',
                borderRadius: 10,
                opacity: d.archived ? 0.65 : 1,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{d.name}</span>
                  <span style={{ ...MONO, fontSize: 11, color: 'var(--muted-2)' }}>{d.key}</span>
                </div>
                {d.desc && <p style={{ ...HINT, margin: '4px 0 0' }}>{d.desc}</p>}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {behaviorPills(d)}
                  {d.kind !== 'form' && <Pill tone="muted">{formatSummary(d.accepts)}</Pill>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <Btn tone="ghost" size="sm" onClick={() => move(i, -1)} disabled={i === 0}>
                  ↑
                </Btn>
                <Btn
                  tone="ghost"
                  size="sm"
                  onClick={() => move(i, 1)}
                  disabled={i === draft.length - 1}
                >
                  ↓
                </Btn>
                <Btn tone="outline" size="sm" onClick={() => setEditing(d)}>
                  Edit
                </Btn>
                <Btn tone="outline" size="sm" onClick={() => toggleArchived(d.key)}>
                  {d.archived ? 'Unarchive' : 'Archive'}
                </Btn>
                <Btn tone="ghost" size="sm" onClick={() => removeDoc(d.key)}>
                  Remove
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {draft.length < MAX_DOCS ? (
        <Btn tone="teal" size="sm" icon={Icon.Plus} onClick={() => setEditing('new')}>
          Add document
        </Btn>
      ) : (
        <p style={HINT}>Maximum of {MAX_DOCS} documents reached.</p>
      )}

      {newDocs.length > 0 && (
        <p style={{ ...HINT, marginTop: 10 }}>
          {`New: ${newDocs.map((d) => d.name).join(', ')} — clubs already marked compliant will show ${newDocs.length === 1 ? 'it' : 'these'} as missing until they upload once this saves.`}
        </p>
      )}

      {err && <div style={{ ...ERR, marginTop: 12 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Btn tone="teal" size="sm" onClick={saveIt} disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save catalogue'}
        </Btn>
        {dirty && (
          <Btn tone="outline" size="sm" onClick={() => setDraft([...effective])} disabled={busy}>
            Discard
          </Btn>
        )}
      </div>

      {editing && (
        <DocModal
          title={
            editing !== 'new' ? (
              <>
                Edit <em>{editing.name}</em>
              </>
            ) : (
              <>
                Add a <em>document</em>
              </>
            )
          }
          onClose={() => setEditing(null)}
        >
          <DocForm
            doc={editing !== 'new' ? editing : null}
            locked={editing !== 'new' && effective.some((e) => e.key === editing.key)}
            existingKeys={draft
              .filter((d) => d.key !== (editing !== 'new' ? editing.key : ''))
              .map((d) => d.key)}
            onSave={(next) => upsert(next, editing !== 'new' ? editing.key : null)}
            onClose={() => setEditing(null)}
          />
        </DocModal>
      )}
    </Card>
  );
}
