/**
 * Operator console — fixture amendments from the union's weekly "Reminder Fixtures" workbook.
 *
 * Upload → preview → confirm, modelled on the admin appointments upload
 * (UmpireAppointmentsUpload.tsx). The server parses and matches the sheet with the same code as
 * the `reminder-fixtures` CLI and answers a preview; nothing is written until Confirm. The preview
 * carries a hash of the COMPUTED plan, so:
 *
 * - every option that changes the plan (a per-row skip, the draft-relocation opt-in) re-previews
 *   at once, and Confirm stays disabled until the preview for the options on screen is back;
 * - a confirm against fixtures that moved since the preview is refused (409 `plan_changed`) with
 *   the fresh preview, which replaces the one shown.
 *
 * An INTRODUCED venue clash blocks the whole upload (no bypass); clashes already on the weekend
 * are reported but never block. Rows that cannot apply (unmatched, ambiguous, unknown ground or
 * competition, played) are listed with their reason and simply skipped.
 */
import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { qk } from './query';
import * as api from './api';
import { ApiError } from './api';
import { Btn, Card, Pill } from './atoms';

type Toast = (m: string, t?: string) => void;

const MAX_BYTES = 2 * 1024 * 1024;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const FIELD: Record<api.AmendmentRowChange['field'], string> = {
  date: 'Date',
  time: 'Time',
  venue: 'Venue',
  status: 'Status',
};

/** Why a row did not apply — chip label + tone per outcome (matched-change never shows here). */
const NOT_APPLIED: Partial<Record<api.AmendmentRowOutcome, { label: string; tone: string }>> = {
  unmatched: { label: 'Not matched', tone: 'coral' },
  ambiguous: { label: 'Ambiguous', tone: 'gold' },
  'venue-unknown': { label: 'Unknown ground', tone: 'gold' },
  'competition-unknown': { label: 'Unknown competition', tone: 'coral' },
  blocked: { label: 'Blocked', tone: 'coral' },
};

const optionsKey = (o: api.AmendmentOptions) =>
  JSON.stringify({ s: [...o.skipRowIds].sort(), r: o.relocateDraftClashes });

const clashLine = (c: api.AmendmentClash) =>
  `${c.date}${c.time ? ` ${c.time}` : ''} at ${c.ground}: ${c.fixture} and ${c.with}`;

function ChangeChips({ changes }: { changes: api.AmendmentRowChange[] }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {changes.map((ch) => (
        <Pill key={ch.field} tone={ch.field === 'status' ? 'coral' : 'gold'}>
          {FIELD[ch.field]}: {ch.before || '—'} → {ch.after || '—'}
        </Pill>
      ))}
    </div>
  );
}

export function FixtureAmendmentsPage({ toast }: { toast: Toast }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const configQ = useQuery({
    queryKey: qk.platformTenant(slug),
    queryFn: () => api.platformGetTenant(slug),
    retry: 0,
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [skipRowIds, setSkipRowIds] = useState<string[]>([]);
  const [relocate, setRelocate] = useState(false);
  const [preview, setPreview] = useState<api.AmendmentPreview | null>(null);
  /** The options the shown preview was computed for (Confirm needs it to match the screen). */
  const [previewKey, setPreviewKey] = useState('');
  const [busy, setBusy] = useState<'reading' | 'writing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    out: api.AmendmentConfirmResult;
    preview: api.AmendmentPreview;
  } | null>(null);

  const opts: api.AmendmentOptions = { skipRowIds, relocateDraftClashes: relocate };
  const currentKey = optionsKey(opts);

  async function load(f: File, o: api.AmendmentOptions) {
    const mine = ++seq.current;
    setBusy('reading');
    setError(null);
    try {
      const p = await api.platformFixtureAmendmentsPreview(slug, f, o);
      if (mine !== seq.current) return;
      setPreview(p);
      setPreviewKey(optionsKey(o));
    } catch (err) {
      if (mine !== seq.current) return;
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't read the workbook. Check your connection.",
      );
    } finally {
      if (mine === seq.current) setBusy(null);
    }
  }

  function choose(f: File | undefined) {
    seq.current++;
    setResult(null);
    setPreview(null);
    setPreviewKey('');
    setSkipRowIds([]);
    setRelocate(false);
    setError(null);
    setBusy(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (!/\.xlsx$/i.test(f.name)) {
      setFile(null);
      setError('Choose the reminder fixtures sheet as an Excel .xlsx file.');
      return;
    }
    if (f.size > MAX_BYTES) {
      setFile(null);
      setError(
        'That file is larger than 2 MB. The reminder fixtures sheet is usually far smaller.',
      );
      return;
    }
    setFile(f);
    void load(f, { skipRowIds: [], relocateDraftClashes: false });
  }

  function toggleSkip(rowId: string, apply: boolean) {
    const next = apply ? skipRowIds.filter((id) => id !== rowId) : [...skipRowIds, rowId];
    setSkipRowIds(next);
    if (file) void load(file, { skipRowIds: next, relocateDraftClashes: relocate });
  }

  function toggleRelocate(on: boolean) {
    setRelocate(on);
    if (file) void load(file, { skipRowIds, relocateDraftClashes: on });
  }

  async function confirm() {
    if (!file || !preview) return;
    const shown = preview;
    setBusy('writing');
    setError(null);
    try {
      const out = await api.platformFixtureAmendmentsConfirm(slug, file, opts, shown.planHash);
      setResult({ out, preview: shown });
      setPreview(null);
      toast(`Amended ${plural(out.fixturesAmended, 'fixture')}`);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setError("Couldn't apply the amendments. Check your connection.");
        return;
      }
      const d = err.details ?? {};
      if (err.code === 'plan_changed' && d.preview) {
        setPreview(d.preview as api.AmendmentPreview);
        setPreviewKey(currentKey);
        setError(err.message);
        toast('The fixtures changed since your preview — check the updated preview', 'warn');
      } else if (err.code === 'clash_gate' && d.details) {
        setPreview({ ...shown, gate: d.details as api.AmendmentGate });
        setError(err.message);
      } else setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  const name = configQ.data?.branding?.name ?? slug;
  const p = preview;
  const fresh = !!p && previewKey === currentKey && busy === null;
  const blocked = !!p && (p.gate.introduced.length > 0 || !p.gate.ok);
  const canConfirm = fresh && !blocked && !!p && p.counts.applied > 0;
  const attention = p
    ? p.counts.unmatched +
      p.counts.ambiguous +
      p.counts['venue-unknown'] +
      p.counts['competition-unknown'] +
      p.counts.blocked
    : 0;

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Platform / Clients / {name} / Fixture amendments</div>
          <h1 className="ph-title">
            Fixture <em>amendments</em>
          </h1>
          <p className="ph-desc">
            Load the union&apos;s weekly reminder fixtures sheet. You&apos;ll see every venue, time,
            date and postponement change before anything is saved. Untick a row to leave that
            fixture as it is.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" size="sm" onClick={() => navigate(`/platform/tenants/${slug}`)}>
            Back to settings
          </Btn>
        </div>
      </div>

      <div className="upl-pick">
        <label htmlFor="fa-file" className="upl-label">
          Reminder fixtures workbook <span className="ump-sub">(.xlsx, up to 2 MB)</span>
        </label>
        <input
          ref={inputRef}
          id="fa-file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy === 'writing'}
          onChange={(e) => choose(e.target.files?.[0])}
        />
        {file && p && <span className="ump-sub">{file.name}</span>}
      </div>

      {busy === 'reading' && (
        <div className="mcs-empty" role="status">
          Reading the sheet and matching it to fixtures…
        </div>
      )}
      {error && (
        <div className="insights-callout alert" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {result && (
        <AmendmentResult
          out={result.out}
          preview={result.preview}
          onAgain={() => {
            if (inputRef.current) inputRef.current.value = '';
            choose(undefined);
            inputRef.current?.focus();
          }}
          onBack={() => navigate(`/platform/tenants/${slug}`)}
        />
      )}

      {p && (
        <>
          {p.gate.introduced.length > 0 && (
            <div className="insights-callout alert" role="alert" style={{ marginTop: 14 }}>
              <strong>
                Blocked — these amendments would introduce{' '}
                {plural(p.gate.introduced.length, 'venue clash', 'venue clashes')}.
              </strong>{' '}
              Nothing can be applied until they are gone: untick the rows involved, or turn on draft
              relocation below if a draft fixture holds the ground.
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {p.gate.introduced.map((c, i) => (
                  <li key={i}>{clashLine(c)}</li>
                ))}
              </ul>
            </div>
          )}
          {p.gate.introduced.length === 0 && !p.gate.ok && (
            <div className="insights-callout alert" role="alert" style={{ marginTop: 14 }}>
              <strong>The plan cannot be applied.</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {p.gate.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mcs-stats" style={{ marginTop: 14 }}>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Will be changed</div>
              <div className="mcs-stat-value">{p.counts.applied}</div>
              <div className="ump-sub">of {plural(p.counts.applicable, 'row')} with a change</div>
            </div>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Already correct</div>
              <div className="mcs-stat-value">{p.counts['matched-no-change']}</div>
              <div className="ump-sub">fixture already matches the sheet</div>
            </div>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Need attention</div>
              <div className="mcs-stat-value">{attention}</div>
              <div className="ump-sub">skipped, never applied</div>
            </div>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Existing clashes</div>
              <div className="mcs-stat-value">{p.gate.preExisting.length}</div>
              <div className="ump-sub">already on the weekend, not blocking</div>
            </div>
          </div>

          <RelocationPanel
            preview={p}
            relocate={relocate}
            disabled={busy === 'writing'}
            onToggle={toggleRelocate}
          />

          {p.sheets.map((s) => (
            <SheetSection
              key={s.sheet}
              sheet={s}
              skip={skipRowIds}
              disabled={busy === 'writing'}
              onToggle={toggleSkip}
            />
          ))}

          {p.gate.preExisting.length > 0 && (
            <details className="insights-callout warn" style={{ marginTop: 14 }}>
              <summary>
                <strong>
                  {plural(p.gate.preExisting.length, 'clash', 'clashes')} already on these dates
                </strong>{' '}
                — reported only; this upload doesn&apos;t create them and they don&apos;t block it.
              </summary>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {p.gate.preExisting.map((c, i) => (
                  <li key={i}>{clashLine(c)}</li>
                ))}
              </ul>
            </details>
          )}

          {p.skippedRows.length > 0 && (
            <details style={{ marginTop: 14 }}>
              <summary className="mcs-note">
                {plural(p.skippedRows.length, 'line')} on the sheet weren&apos;t fixture rows
              </summary>
              <ul className="mcs-note">
                {p.skippedRows.map((r) => (
                  <li key={`${r.sheet}:${r.sheetRow}`}>
                    {r.sheet} row {r.sheetRow}: “{r.text}” — {r.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="upl-confirm">
            <Btn tone="ink" disabled={!canConfirm} onClick={confirm}>
              {busy === 'writing' ? 'Applying…' : `Apply ${plural(p.counts.applied, 'change')}`}
            </Btn>
            <Btn
              tone="ghost"
              disabled={busy === 'writing'}
              onClick={() => {
                if (inputRef.current) inputRef.current.value = '';
                choose(undefined);
                inputRef.current?.focus();
              }}
            >
              Choose another file
            </Btn>
            {!fresh && busy !== 'writing' && (
              <span className="ump-sub">
                {busy === 'reading' ? 'Updating the preview…' : 'Preview out of date.'}
              </span>
            )}
            {!fresh && busy === null && file && (
              <Btn tone="outline" size="sm" onClick={() => void load(file, opts)}>
                Preview again
              </Btn>
            )}
            {fresh && blocked && <span className="ump-sub">Resolve the blocking clash first.</span>}
            {fresh && !blocked && p.counts.applied === 0 && (
              <span className="ump-sub">Nothing to change from this sheet.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RelocationPanel({
  preview: p,
  relocate,
  disabled,
  onToggle,
}: {
  preview: api.AmendmentPreview;
  relocate: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <section className="mcs-card" style={{ marginTop: 14 }} aria-labelledby="fa-relocate">
      <div className="mcs-card-title" id="fa-relocate">
        Draft fixtures on the same grounds
      </div>
      <p className="mcs-note">
        A change can land on a ground a DRAFT fixture (not yet released) holds that day. With
        relocation on, each such draft fixture moves to another ground. It is all or nothing: every
        move listed below is applied together.
      </p>
      <label className="upl-check">
        <input
          type="checkbox"
          checked={relocate}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        Move clashing draft fixtures to another ground
      </label>
      {relocate && (
        <>
          <div className="insights-callout warn" style={{ marginTop: 8 }}>
            The scan covers every draft fixture of this client on the sheet&apos;s dates, not only
            the competitions on the sheet.
          </div>
          {p.moves.length === 0 ? (
            <div className="mcs-empty">No draft fixture needs to move.</div>
          ) : (
            <div className="tbl-w" style={{ marginTop: 8 }}>
              <table className="tbl upl-tbl" aria-label="Draft fixtures that will move">
                <thead>
                  <tr>
                    <th>Draft fixture</th>
                    <th>Date</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Ground taken by</th>
                  </tr>
                </thead>
                <tbody>
                  {p.moves.map((m) => (
                    <tr key={`${m.seriesId}/${m.fixtureId}`}>
                      <td data-label="Draft fixture">
                        <div style={{ fontWeight: 700 }}>
                          {m.home} v {m.away}
                        </div>
                        <div className="ump-sub">{m.seriesName}</div>
                      </td>
                      <td data-label="Date">{m.date}</td>
                      <td data-label="From">{m.from}</td>
                      <td data-label="To">
                        {m.to}
                        {m.registryMiss && (
                          <div className="ump-sub">not in the venue list (free text)</div>
                        )}
                      </td>
                      <td data-label="Ground taken by">{m.takenBy.join('; ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SheetSection({
  sheet: s,
  skip,
  disabled,
  onToggle,
}: {
  sheet: api.AmendmentPreview['sheets'][number];
  skip: string[];
  disabled: boolean;
  onToggle: (rowId: string, apply: boolean) => void;
}) {
  const changes = s.rows.filter((r) => r.outcome === 'matched-change');
  const others = s.rows.filter((r) => r.outcome !== 'matched-change');
  return (
    <section style={{ marginTop: 18 }} aria-label={`Sheet ${s.sheet}`}>
      <h2 className="mcs-heading">
        {s.sheet} {s.status === 'refused' && <Pill tone="coral">Sheet not read</Pill>}
        {s.status === 'empty' && <Pill tone="muted">No fixtures</Pill>}
      </h2>
      {s.status === 'refused' && (
        <div className="insights-callout warn">
          This sheet was left out: {s.reason ?? 'its layout was not recognised'}.
        </div>
      )}
      {s.competitions.length > 0 && (
        <p className="mcs-note">
          {s.competitions
            .map(
              (c) =>
                `${c.competition}${c.seriesIds.length ? '' : ' (no matching competition found)'}`,
            )
            .join(' · ')}
        </p>
      )}

      {changes.length > 0 && (
        <div className="tbl-w" style={{ marginTop: 8 }}>
          <table className="tbl upl-tbl" aria-label={`Changes on ${s.sheet}`}>
            <thead>
              <tr>
                <th>Apply</th>
                <th>Fixture</th>
                <th>Changes</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((r) => {
                const applied = !skip.includes(r.rowId);
                return (
                  <tr key={r.rowId}>
                    <td data-label="Apply">
                      <input
                        type="checkbox"
                        checked={applied}
                        disabled={disabled}
                        aria-label={`Apply row ${r.sheetRow}: ${r.sheet.home} v ${r.sheet.away}`}
                        onChange={(e) => onToggle(r.rowId, e.target.checked)}
                      />
                    </td>
                    <td data-label="Fixture">
                      <div style={{ fontWeight: 700 }}>
                        {r.fixture
                          ? `${r.fixture.home} v ${r.fixture.away}`
                          : `${r.sheet.home} v ${r.sheet.away}`}
                      </div>
                      <div className="ump-sub">
                        Row {r.sheetRow} · {r.competition}
                        {r.group ? ` · Group ${r.group}` : ''}
                        {r.seriesName ? ` · ${r.seriesName}` : ''}
                      </div>
                      {r.warnings.map((w) => (
                        <div key={w} className="ump-sub">
                          ⚠ {w}
                        </div>
                      ))}
                    </td>
                    <td data-label="Changes">
                      <ChangeChips changes={r.changes ?? []} />
                      {!applied && <div className="ump-sub">Left as it is</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {s.alreadyCorrect > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="mcs-note">Already correct: {s.alreadyCorrect}</summary>
          <p className="mcs-note">
            {plural(s.alreadyCorrect, 'row')} on this sheet already match the fixtures — nothing to
            change.
          </p>
        </details>
      )}

      {others.length > 0 && (
        <div className="tbl-w" style={{ marginTop: 8 }}>
          <table className="tbl upl-tbl" aria-label={`Rows not applied on ${s.sheet}`}>
            <thead>
              <tr>
                <th>Row</th>
                <th>Sheet says</th>
                <th>Why it isn&apos;t applied</th>
              </tr>
            </thead>
            <tbody>
              {others.map((r) => {
                const why = NOT_APPLIED[r.outcome] ?? { label: r.outcome, tone: 'muted' };
                return (
                  <tr key={r.rowId}>
                    <td data-label="Row">Row {r.sheetRow}</td>
                    <td data-label="Sheet says">
                      <div style={{ fontWeight: 700 }}>
                        {r.sheet.home} v {r.sheet.away}
                      </div>
                      <div className="ump-sub">
                        {r.competition} · {r.sheet.date}
                        {r.sheet.time ? ` ${r.sheet.time}` : ''}
                      </div>
                    </td>
                    <td data-label="Why it isn't applied">
                      <Pill tone={why.tone}>{why.label}</Pill>
                      {r.outcome === 'venue-unknown' && (
                        <div className="ump-sub">
                          Sheet ground “{r.sheet.venue}” is not in the venue list
                        </div>
                      )}
                      {r.reason && <div className="ump-sub">{r.reason}</div>}
                      {r.warnings.map((w) => (
                        <div key={w} className="ump-sub">
                          ⚠ {w}
                        </div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AmendmentResult({
  out,
  preview,
  onAgain,
  onBack,
}: {
  out: api.AmendmentConfirmResult;
  preview: api.AmendmentPreview;
  onAgain: () => void;
  onBack: () => void;
}) {
  const label = new Map<string, string>();
  for (const s of preview.sheets)
    for (const r of s.rows)
      if (r.seriesId && r.fixtureId)
        label.set(
          `${r.seriesId}#${r.fixtureId}`,
          r.fixture ? `${r.fixture.home} v ${r.fixture.away}` : `${r.sheet.home} v ${r.sheet.away}`,
        );
  const nameOf = (seriesId: string, fixtureId: string) =>
    label.get(`${seriesId}#${fixtureId}`) ?? fixtureId;
  const seriesName = new Map(out.series.map((s) => [s.seriesId, s.seriesName]));
  const drifted = out.series.filter((s) => s.status === 'drifted');
  const officials = preview.officials ?? [];

  return (
    <div style={{ marginTop: 12 }}>
      {out.splitSlotRisks.length > 0 && (
        <div className="insights-callout alert" role="alert">
          <strong>Urgent — live double-booking risk.</strong> Part of a slot swap was written but
          the other half was not (its competition changed while you were confirming). These grounds
          are double-booked right now: upload the sheet again immediately to finish the write.
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {out.splitSlotRisks.map((k, i) => (
              <li key={i}>
                {k.date}
                {k.time ? ` ${k.time}` : ''} at {k.ground}:{' '}
                {nameOf(k.written.seriesId, k.written.fixtureId)} (written) and{' '}
                {nameOf(k.stranded.seriesId, k.stranded.fixtureId)} (
                {seriesName.get(k.stranded.seriesId) ?? k.stranded.seriesId}, not written)
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="insights-callout good" role="status" style={{ marginTop: 12 }}>
        <strong>
          Amended {plural(out.fixturesAmended, 'fixture')}
          {out.draftMoves ? ` and moved ${plural(out.draftMoves, 'draft fixture')}` : ''}.
        </strong>
        {drifted.length > 0 && (
          <>
            {' '}
            {plural(drifted.length, 'competition')} changed while you were confirming and{' '}
            {drifted.length === 1 ? 'was' : 'were'} not written — upload the sheet again to apply
            the rest.
          </>
        )}
      </div>

      <div className="insights-callout warn" style={{ marginTop: 12 }}>
        <strong>Clubs have NOT been notified.</strong> The union circulates this sheet itself;
        nobody is emailed or messaged by this upload.
      </div>

      <p className="mcs-note" style={{ marginTop: 12 }}>
        {out.medicoachSync
          ? 'The changes are queued for medicoach and go out with the next 15-minute sync. To send them sooner, use "Sync now" on the client\'s admin Medicoach sync page.'
          : 'Medicoach sync is off for this client, so nothing is sent to medicoach.'}
      </p>

      <div className="tbl-w" style={{ marginTop: 8 }}>
        <table className="tbl upl-tbl" aria-label="Competitions written">
          <thead>
            <tr>
              <th>Competition</th>
              <th>Fixtures</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {out.series.map((s) => (
              <tr key={s.seriesId}>
                <td data-label="Competition">{s.seriesName}</td>
                <td data-label="Fixtures">{s.fixtureIds.length}</td>
                <td data-label="Result">
                  {s.status === 'written' ? (
                    <Pill tone="teal">Written</Pill>
                  ) : (
                    <>
                      <Pill tone="coral">Not written</Pill>
                      <div className="ump-sub">changed since the preview — upload again</div>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {officials.length > 0 && (
        <Card
          title="Check the umpire appointments"
          sub="These amended fixtures already have officials appointed. Make sure they can still make the new time or ground."
        >
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {officials.map((o) => (
              <li key={`${o.seriesId}#${o.fixtureId}`}>
                {nameOf(o.seriesId, o.fixtureId)}: {o.umpires.join(', ') || '—'}
                {o.referee ? ` · referee ${o.referee}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="upl-confirm">
        <Btn tone="outline" size="sm" onClick={onAgain}>
          Upload another sheet
        </Btn>
        <Btn tone="ghost" size="sm" onClick={onBack}>
          Back to settings
        </Btn>
      </div>
    </div>
  );
}
