/* ─── Admin: Upload appointments ───
 *
 * The union's weekly appointments workbook, uploaded from the Umpires page. The server parses
 * and matches it with the same code as the `import-umpire-appointments` CLI (no second parser)
 * and answers a preview; nothing is written until Confirm, which writes exactly what the CLI's
 * --confirm would. The preview carries a plan hash: if appointments or umpires changed in the
 * meantime the server refuses and returns the fresh preview to confirm instead.
 */
import { useRef, useState } from 'react';
import * as api from './api';
import { ApiError } from './api';
import { Btn, Pill } from './atoms';

const MAX_BYTES = 2 * 1024 * 1024;

const ACTION: Record<string, { label: string; tone: 'teal' | 'gold' | 'muted' | 'coral' }> = {
  new: { label: 'New', tone: 'teal' },
  changed: { label: 'Changed', tone: 'gold' },
  unchanged: { label: 'Unchanged', tone: 'muted' },
  skipped: { label: 'Not written', tone: 'coral' },
};

const UNMATCHED: Record<string, string> = {
  'unknown-team': 'Unknown team',
  'no-fixture': 'No such fixture',
  ambiguous: 'More than one fixture fits',
  duplicate: 'Same fixture twice on the sheet',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function UmpireAppointmentsUpload({
  onBack,
  onDone,
}: {
  onBack: () => void;
  /** Called after a confirm wrote something (refresh umpires + series). */
  onDone?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [create, setCreate] = useState(false);
  const [preview, setPreview] = useState<api.AppointmentPreview | null>(null);
  const [busy, setBusy] = useState<'reading' | 'writing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<{ written: number; created: number } | null>(null);

  async function load(f: File, withCreate: boolean) {
    setBusy('reading');
    setError(null);
    try {
      setPreview(await api.previewUmpireAppointments(f, withCreate));
    } catch (err) {
      setPreview(null);
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't read the workbook. Check your connection.",
      );
    } finally {
      setBusy(null);
    }
  }

  function choose(f: File | undefined) {
    setDone(null);
    setNotice(null);
    setPreview(null);
    setCreate(false);
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) {
      setFile(null);
      setError('Choose the appointments sheet as an Excel .xlsx file.');
      return;
    }
    if (f.size > MAX_BYTES) {
      setFile(null);
      setError('That file is larger than 2 MB. The appointments sheet is usually far smaller.');
      return;
    }
    setFile(f);
    void load(f, false);
  }

  async function confirm() {
    if (!file || !preview) return;
    setBusy('writing');
    setError(null);
    setNotice(null);
    try {
      const out = await api.confirmUmpireAppointments(file, create, preview.planHash);
      setDone(out);
      setPreview(null);
      onDone?.();
    } catch (err) {
      const fresh = err instanceof ApiError ? err.details?.preview : undefined;
      if (err instanceof ApiError && err.code === 'plan_changed' && fresh) {
        setPreview(fresh as api.AppointmentPreview);
        setError(`${err.message} Review the updated preview, then confirm again.`);
      } else
        setError(
          err instanceof ApiError
            ? err.message
            : "Couldn't write the appointments. Check your connection.",
        );
    } finally {
      setBusy(null);
    }
  }

  const p = preview;
  const writes = p ? p.summary.new + p.summary.changed : 0;
  const differences = p ? p.rows.filter((r) => r.differences.length) : [];
  const unknown = p ? p.unknownUmpires : [];
  const confirmLabel = p
    ? `Write ${plural(writes, 'appointment')}${p.summary.toCreate ? ` and add ${plural(p.summary.toCreate, 'umpire')}` : ''}`
    : '';

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">
            Admin Console /{' '}
            <a
              href="/admin/umpires"
              onClick={(e) => {
                e.preventDefault();
                onBack();
              }}
            >
              Umpires
            </a>{' '}
            / Upload appointments
          </div>
          <h1 className="ph-title">
            Upload <em>appointments</em>
          </h1>
          <p className="ph-desc">
            Load the union&apos;s weekly appointments sheet. You&apos;ll see what matches before
            anything is saved. Venues and times on the sheet are only compared, never changed — edit
            the fixture if the sheet is right.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" size="sm" onClick={onBack}>
            Back to Umpires
          </Btn>
        </div>
      </div>

      <div className="upl-pick">
        <label htmlFor="upl-file" className="upl-label">
          Appointments workbook <span className="ump-sub">(.xlsx, up to 2 MB)</span>
        </label>
        <input
          ref={inputRef}
          id="upl-file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy !== null}
          onChange={(e) => choose(e.target.files?.[0])}
        />
        {file && !error && busy === null && p && (
          <span className="ump-sub">
            {file.name} · sheet “{p.sheet}” · {plural(p.summary.rows, 'row')}
          </span>
        )}
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
      {notice && <div className="insights-callout warn">{notice}</div>}
      {done && (
        <div className="insights-callout good" role="status" style={{ marginTop: 12 }}>
          <strong>
            Wrote {plural(done.written, 'appointment')}
            {done.created ? `, added ${plural(done.created, 'umpire')}` : ''}.
          </strong>{' '}
          They show in the Umpires column on Fixtures &amp; Venues.{' '}
          <Btn tone="outline" size="sm" onClick={onBack}>
            Back to Umpires
          </Btn>
        </div>
      )}

      {p && (
        <>
          <div className="mcs-stats" style={{ marginTop: 14 }}>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Will be written</div>
              <div className="mcs-stat-value">{writes}</div>
              <div className="ump-sub">
                {p.summary.new} new · {p.summary.changed} changed
              </div>
            </div>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Already up to date</div>
              <div className="mcs-stat-value">{p.summary.unchanged}</div>
              <div className="ump-sub">same umpires as now</div>
            </div>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Need attention</div>
              <div className="mcs-stat-value">{p.summary.skipped + p.summary.notMatched}</div>
              <div className="ump-sub">
                {p.summary.notMatched} not matched · {p.summary.skipped} not written
              </div>
            </div>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Venue / time differences</div>
              <div className="mcs-stat-value">{differences.length}</div>
              <div className="ump-sub">reported, never changed</div>
            </div>
          </div>

          {(unknown.length > 0 || p.toCreate.length > 0) && (
            <section className="mcs-card" style={{ marginTop: 14 }} aria-labelledby="upl-unknown">
              <div className="mcs-card-title" id="upl-unknown">
                Umpires not on your panel
              </div>
              <p className="mcs-note">
                Rows naming them are not written unless you add them. Only umpires on rows that will
                be written are listed.
              </p>
              <div className="upl-names">
                {(p.toCreate.length ? p.toCreate.map((u) => u.displayName) : unknown).map((n) => (
                  <Pill key={n} tone="navy">
                    {n}
                  </Pill>
                ))}
              </div>
              <label className="upl-check">
                <input
                  type="checkbox"
                  checked={create}
                  disabled={busy !== null || !file}
                  onChange={(e) => {
                    setCreate(e.target.checked);
                    if (file) void load(file, e.target.checked);
                  }}
                />
                Create these umpires ({unknown.length || p.toCreate.length}) and appoint them
              </label>
            </section>
          )}

          {p.doubleBookings.length > 0 && (
            <div className="insights-callout warn" style={{ marginTop: 14 }}>
              <strong>Possible double bookings</strong> — you can still save; check these with the
              umpires:
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {p.doubleBookings.map((d, i) => (
                  <li key={i}>
                    {d.umpireId} on {d.date}: {d.a.venue}
                    {d.a.time ? ` ${d.a.time}` : ''} and {d.b.venue}
                    {d.b.time ? ` ${d.b.time}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {differences.length > 0 && (
            <>
              <h2 className="mcs-heading">Venue and time differences</h2>
              <p className="mcs-note">
                The upload never changes a fixture. If the sheet is right, edit the fixture on
                Fixtures &amp; Venues.
              </p>
              <div className="tbl-w" style={{ marginTop: 8 }}>
                <table className="tbl upl-tbl" aria-label="Venue and time differences">
                  <thead>
                    <tr>
                      <th>Fixture</th>
                      <th>What</th>
                      <th>Sheet says</th>
                      <th>Fixture has</th>
                    </tr>
                  </thead>
                  <tbody>
                    {differences.flatMap((r) =>
                      r.differences.map((d) => (
                        <tr key={`${r.sheetRow}-${d.field}`}>
                          <td data-label="Fixture">
                            <div style={{ fontWeight: 700 }}>
                              {r.home} v {r.away}
                            </div>
                            <div className="ump-sub">
                              Row {r.sheetRow} · {r.date}
                            </div>
                          </td>
                          <td data-label="What">{d.field === 'time' ? 'Time' : 'Venue'}</td>
                          <td data-label="Sheet says">{d.sheet}</td>
                          <td data-label="Fixture has">{d.fixture || '—'}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h2 className="mcs-heading">Matched ({p.rows.length})</h2>
          {p.rows.length === 0 ? (
            <div className="mcs-empty">No row on the sheet matched a fixture.</div>
          ) : (
            <div className="tbl-w" style={{ marginTop: 8 }}>
              <table className="tbl upl-tbl" aria-label="Matched rows">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Fixture</th>
                    <th>Date</th>
                    <th>Umpires</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {p.rows.map((r) => {
                    const a = ACTION[r.action] ?? ACTION.skipped;
                    return (
                      <tr key={r.sheetRow}>
                        <td data-label="Row">Row {r.sheetRow}</td>
                        <td data-label="Fixture">
                          <div style={{ fontWeight: 700 }}>
                            {r.home} v {r.away}
                          </div>
                          <div className="ump-sub">{r.seriesName}</div>
                        </td>
                        <td data-label="Date">
                          {r.fixture.date}
                          {r.fixture.time ? ` ${r.fixture.time}` : ''}
                        </td>
                        <td data-label="Umpires">
                          {(r.appointed ?? r.umpires).join(', ') || '—'}
                          {r.previous && (
                            <div className="ump-sub">was {r.previous.join(', ') || '—'}</div>
                          )}
                        </td>
                        <td data-label="Result">
                          <Pill tone={a.tone}>{a.label}</Pill>
                          {r.skipReason && <div className="ump-sub">{r.skipReason}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {p.unmatched.length > 0 && (
            <>
              <h2 className="mcs-heading">Not matched ({p.unmatched.length})</h2>
              <p className="mcs-note">
                These rows are not written. Fix the sheet (or the fixture) and upload it again.
              </p>
              <div className="tbl-w" style={{ marginTop: 8 }}>
                <table className="tbl upl-tbl" aria-label="Rows not matched">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Teams</th>
                      <th>Date</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.unmatched.map((u) => (
                      <tr key={`${u.sheetRow}-${u.kind}`}>
                        <td data-label="Row">Row {u.sheetRow}</td>
                        <td data-label="Teams">
                          {u.home} v {u.away}
                          <div className="ump-sub">{u.section}</div>
                        </td>
                        <td data-label="Date">
                          {u.date}
                          {u.time ? ` ${u.time}` : ''}
                        </td>
                        <td data-label="Why">
                          <Pill tone={u.kind === 'ambiguous' ? 'gold' : 'coral'}>
                            {UNMATCHED[u.kind] ?? u.kind}
                          </Pill>
                          <div className="ump-sub">{u.reason}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {p.problems.length > 0 && (
            <>
              <h2 className="mcs-heading">Rows that couldn&apos;t be read</h2>
              <ul className="mcs-note">
                {p.problems.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </>
          )}

          <div className="upl-confirm">
            <Btn
              tone="ink"
              disabled={busy !== null || (writes === 0 && p.summary.toCreate === 0)}
              onClick={confirm}
            >
              {busy === 'writing' ? 'Writing…' : confirmLabel}
            </Btn>
            <Btn
              tone="ghost"
              disabled={busy !== null}
              onClick={() => {
                if (inputRef.current) inputRef.current.value = '';
                setFile(null);
                choose(undefined);
                inputRef.current?.focus();
              }}
            >
              Choose another file
            </Btn>
            {writes === 0 && p.summary.toCreate === 0 && (
              <span className="ump-sub">Nothing new to write from this sheet.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
