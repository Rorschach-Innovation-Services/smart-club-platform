/**
 * Public transfer-certificate verification page (`/verify/:serial`). No auth, no app chrome —
 * it is opened from the QR code on a printed or digital clearance certificate, almost always
 * on a phone. The registry lookup (GET /verify/:serial) is the authority: the page shows a
 * large VALID / REVOKED / NOT FOUND banner and, for a valid certificate, the facts the holder
 * should check against the paper in front of them. A revoked certificate is status-only — the
 * API deliberately returns no player or club data for it.
 *
 * Served on the platform-owned verify host (not a tenant vanity domain), so it brand-themes
 * itself from the certificate's own tenant (tenantBranding on the response), not /tenant.
 *
 * `/verify` with no serial (or a serial that 404s) shows a "Check a certificate" box for
 * typing the reference off the paper. A valid result also offers a client-side PDF check:
 * the chosen file is SHA-256'd in the browser (WebCrypto — it is never uploaded) and compared
 * with the registry's hash of the issued PDF.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { verifyCertificate, ApiError } from './api';
import { applyTheme } from './config';
import { qk } from './query';
import { formatDayYear, formatStampDay } from './dates';
import type { CertificateVerifyResult } from './types';

// Status colours are fixed, NOT brand tokens: a tenant's primary (aliased as --green) may be
// any hue, and "valid" must always read green and "revoked" red.
const STATUS = {
  valid: { bg: '#E7F6EC', fg: '#0B6B36', border: '#0F8F4A', label: 'Valid certificate' },
  revoked: { bg: '#FDECEA', fg: '#9B1C1C', border: '#C62828', label: 'Certificate revoked' },
  notfound: { bg: '#EEF1F6', fg: '#1B2A4A', border: '#8A97AD', label: 'Certificate not found' },
  error: { bg: '#EEF1F6', fg: '#1B2A4A', border: '#8A97AD', label: 'Could not check' },
} as const;

/** A date-only value (YYYY-MM-DD) stays a calendar day; an instant renders in local time. */
const fmtDate = (v?: string) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDayYear(v) : formatStampDay(v);

// The file check's match/mismatch tones — fixed for the same reason as STATUS.
const FILE_TONE = {
  match: { bg: '#E7F6EC', fg: '#0B6B36', border: '#0F8F4A' },
  mismatch: { bg: '#FFF6E0', fg: '#7A4E00', border: '#D99A00' },
  error: { bg: '#EEF1F6', fg: '#1B2A4A', border: '#8A97AD' },
} as const;

const SERIAL_EXAMPLE = 'SC-TRF-XXXXX-XXXXX-XXXXX-XXXXX';

/**
 * WebCrypto digest is only exposed in a secure context (https / localhost). Probing it can
 * throw in some embedded browsers, so a throw reads as "unavailable" — the PDF check is an
 * optional extra and simply isn't offered.
 */
function webCryptoAvailable(): boolean {
  try {
    return typeof globalThis.crypto?.subtle?.digest === 'function';
  } catch {
    return false;
  }
}

/** A file's bytes. Blob.arrayBuffer is missing on older Safari (<14), so FileReader backs it. */
function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsArrayBuffer(file);
  });
}

/** Lower-case hex SHA-256 of a file's bytes, computed locally. */
async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(await readBytes(file)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const monoFont = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const headingFont = "'Montserrat',sans-serif";

/** The reference-entry box shown on bare /verify and after a NOT FOUND lookup. */
function SerialEntry({ initial = '' }: { initial?: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed) return;
    navigate(`/verify/${encodeURIComponent(trimmed)}`);
  };
  return (
    <section style={{ marginTop: 22 }}>
      <h2 style={{ fontFamily: headingFont, fontSize: 16, margin: '0 0 4px' }}>
        Check a certificate
      </h2>
      <p style={{ fontSize: 13, color: 'var(--muted, #5A6B8C)', margin: '0 0 12px' }}>
        Enter the certificate reference exactly as printed, e.g. {SERIAL_EXAMPLE}.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label htmlFor="verify-serial" style={{ fontSize: 13, fontWeight: 600 }}>
          Certificate reference
        </label>
        <input
          id="verify-serial"
          className="field-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={SERIAL_EXAMPLE}
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          style={{ width: '100%', boxSizing: 'border-box', fontFamily: monoFont, fontSize: 16 }}
        />
        <button
          type="submit"
          className="btn btn-ink"
          disabled={!trimmed}
          style={{ justifyContent: 'center', padding: '13px 16px', fontSize: 14 }}
        >
          Check certificate
        </button>
      </form>
    </section>
  );
}

type FileCheck =
  | { kind: 'idle' }
  | { kind: 'hashing'; name: string }
  | { kind: 'match'; name: string }
  | { kind: 'mismatch'; name: string }
  | { kind: 'error'; name: string };

/**
 * "Check the PDF file": hash the holder's copy locally and compare it with the registry's
 * hash of the issued PDF. A mismatch is not proof of forgery (a re-saved or printed-to-PDF
 * copy differs byte-wise), so it is amber, not red, and points back at the details above.
 */
function PdfFileCheck({ expectedSha256 }: { expectedSha256: string }) {
  const [check, setCheck] = useState<FileCheck>({ kind: 'idle' });
  // Only the latest pick may set the result — an earlier, slower hash must not overwrite it.
  const pick = useRef(0);

  const onFile = async (file: File | undefined) => {
    const id = ++pick.current;
    if (!file) {
      setCheck({ kind: 'idle' });
      return;
    }
    setCheck({ kind: 'hashing', name: file.name });
    try {
      const actual = await sha256Hex(file);
      if (id !== pick.current) return;
      setCheck({
        kind: actual === expectedSha256.toLowerCase() ? 'match' : 'mismatch',
        name: file.name,
      });
    } catch (err) {
      if (id !== pick.current) return;
      console.error('Certificate PDF check: could not hash the chosen file', err);
      setCheck({ kind: 'error', name: file.name });
    }
  };

  const tone =
    check.kind === 'match' || check.kind === 'mismatch' || check.kind === 'error'
      ? FILE_TONE[check.kind]
      : null;

  return (
    <section style={{ marginTop: 22 }}>
      <h2 style={{ fontFamily: headingFont, fontSize: 16, margin: '0 0 4px' }}>
        Check the PDF file
      </h2>
      <p style={{ fontSize: 13, color: 'var(--muted, #5A6B8C)', margin: '0 0 12px' }}>
        Have the certificate as a PDF? Choose it to confirm it is the exact file we issued. The
        check runs in your browser — the file never leaves your device.
      </p>
      <label htmlFor="verify-pdf" style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
        Certificate PDF
      </label>
      <input
        id="verify-pdf"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(e) => onFile(e.target.files?.[0])}
        style={{ display: 'block', width: '100%', marginTop: 6, fontSize: 14 }}
      />
      {check.kind === 'hashing' && (
        <p role="status" style={{ fontSize: 13, color: 'var(--muted, #5A6B8C)', marginTop: 10 }}>
          Checking {check.name}…
        </p>
      )}
      {tone && check.kind !== 'idle' && check.kind !== 'hashing' && (
        <div
          role="status"
          style={{
            marginTop: 12,
            background: tone.bg,
            color: tone.fg,
            border: `2px solid ${tone.border}`,
            borderRadius: 12,
            padding: '12px 14px',
            fontSize: 14,
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontFamily: headingFont, fontWeight: 800, fontSize: 15 }}>
            {check.kind === 'match' && 'Exact file we issued'}
            {check.kind === 'mismatch' && 'Not the issued file'}
            {check.kind === 'error' && 'Could not check this file'}
          </div>
          <div style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
            {check.kind === 'match' &&
              `${check.name} is byte-for-byte identical to the certificate we issued.`}
            {check.kind === 'mismatch' &&
              `${check.name} is not the issued file. Its printed details may still match the record above — check them — but digital copies of the certificate should be byte-identical to the one we issued.`}
            {check.kind === 'error' && `${check.name} couldn’t be read. Try choosing it again.`}
          </div>
        </div>
      )}
    </section>
  );
}

export function VerifyCertificatePage() {
  const { serial = '' } = useParams();
  const query = useQuery({
    queryKey: qk.certificateVerify(serial),
    queryFn: () => verifyCertificate(serial),
    enabled: !!serial,
    // 404 is an answer, not a transient failure.
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
    staleTime: 60_000,
  });
  const data: CertificateVerifyResult | undefined = query.data;
  const valid = data?.status === 'valid' ? data : null;

  // Theme from the certificate's tenant (colours + favicon + tab title). AppRoutes skips its
  // own /tenant theming on this route so the host's tenant can't overwrite it.
  useEffect(() => {
    if (!valid) return;
    applyTheme({
      colors: valid.tenantBranding?.colors,
      logoUrl: valid.tenantBranding?.logoUrl,
      title: `${valid.orgName || valid.tenantBranding?.name || 'Certificate'} · Certificate check`,
    });
  }, [valid]);

  const notFound = query.error instanceof ApiError && query.error.status === 404;
  const kind: keyof typeof STATUS | null =
    !serial || query.isLoading
      ? null
      : data?.status === 'valid'
        ? 'valid'
        : data?.status === 'revoked'
          ? 'revoked'
          : notFound
            ? 'notfound'
            : 'error';
  // Probed once: availability can't change while the page is open.
  const [canHash] = useState(webCryptoAvailable);
  const tone = kind ? STATUS[kind] : null;
  const orgName = valid?.orgName || valid?.tenantBranding?.name;
  const logoUrl = valid?.tenantBranding?.logoUrl;

  const rows: [string, string][] = valid
    ? [
        ['Certificate reference', valid.serial],
        ['Player name', valid.playerName],
        ['ID number', valid.idNumberMasked],
        ['Transferring club', valid.fromClubName],
        ['Acquiring club', valid.toClubName],
        ['Effective date', fmtDate(valid.effectiveDate)],
        ['Date issued', fmtDate(valid.issuedAt)],
      ]
    : [];

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--paper, #f6f8fb)',
        color: 'var(--ink, #1B2A4A)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
          borderTop: valid ? '4px solid var(--brand-primary, #1B2A4A)' : undefined,
          borderBottom: '1px solid var(--line, #e3e8f0)',
          background: 'var(--white, #fff)',
        }}
      >
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={orgName || ''}
            style={{ height: 36, width: 'auto', maxWidth: 120, objectFit: 'contain' }}
          />
        ) : null}
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: "'Montserrat',sans-serif",
              fontWeight: 700,
              fontSize: 15,
              overflowWrap: 'anywhere',
            }}
          >
            {orgName || 'Transfer certificate'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted, #5A6B8C)' }}>
            Player transfer certificate check
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 560, margin: '0 auto', padding: '20px 16px 48px' }}>
        {!serial ? (
          <SerialEntry />
        ) : !tone ? (
          <p style={{ color: 'var(--muted, #5A6B8C)', textAlign: 'center', padding: '40px 0' }}>
            Checking certificate…
          </p>
        ) : (
          <>
            <div
              role="status"
              style={{
                background: tone.bg,
                color: tone.fg,
                border: `2px solid ${tone.border}`,
                borderRadius: 14,
                padding: '22px 18px',
                textAlign: 'center',
              }}
            >
              <div
                aria-hidden
                style={{
                  width: 52,
                  height: 52,
                  margin: '0 auto 10px',
                  borderRadius: '50%',
                  background: tone.border,
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none">
                  {kind === 'valid' ? (
                    <path
                      d="M4 12l5 5L20 6"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ) : kind === 'revoked' ? (
                    <path
                      d="M6 6l12 12M18 6L6 18"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                    />
                  ) : (
                    <path
                      d="M12 7v6M12 17h.01"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                    />
                  )}
                </svg>
              </div>
              <div
                style={{
                  fontFamily: "'Montserrat',sans-serif",
                  fontWeight: 800,
                  fontSize: 24,
                  letterSpacing: '0.02em',
                  textTransform: 'uppercase',
                }}
              >
                {tone.label}
              </div>
              <div style={{ fontSize: 14, marginTop: 6, lineHeight: 1.45 }}>
                {kind === 'valid' &&
                  `This certificate was issued by ${orgName || 'the union'} and is on record as valid.`}
                {kind === 'revoked' &&
                  'This certificate has been revoked by the issuing union and is no longer valid.'}
                {kind === 'notfound' &&
                  'No certificate with this reference is on record. Check the reference, or contact the issuing union.'}
                {kind === 'error' &&
                  'We couldn’t reach the certificate register. Check your connection and try again.'}
              </div>
            </div>

            {valid && (
              <section style={{ marginTop: 22 }}>
                <h2
                  style={{
                    fontFamily: "'Montserrat',sans-serif",
                    fontSize: 16,
                    margin: '0 0 4px',
                  }}
                >
                  Confirm these details match the certificate
                </h2>
                <p style={{ fontSize: 13, color: 'var(--muted, #5A6B8C)', margin: '0 0 12px' }}>
                  If any detail differs from the document you are holding, the document has been
                  altered — do not accept it.
                </p>
                <ul
                  style={{
                    listStyle: 'none',
                    margin: 0,
                    padding: 0,
                    background: 'var(--white, #fff)',
                    border: '1px solid var(--line, #e3e8f0)',
                    borderRadius: 12,
                  }}
                >
                  {rows.map(([label, value], i) => (
                    <li
                      key={label}
                      style={{
                        display: 'flex',
                        gap: 12,
                        alignItems: 'flex-start',
                        padding: '12px 14px',
                        borderTop: i ? '1px solid var(--line, #e3e8f0)' : 'none',
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          flexShrink: 0,
                          width: 20,
                          height: 20,
                          marginTop: 1,
                          borderRadius: 5,
                          border: '2px solid var(--brand-primary, #1B2A4A)',
                        }}
                      />
                      <span style={{ minWidth: 0 }}>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 11,
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            color: 'var(--muted, #5A6B8C)',
                            fontFamily: "'Montserrat',sans-serif",
                            fontWeight: 700,
                          }}
                        >
                          {label}
                        </span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 15,
                            fontWeight: 600,
                            overflowWrap: 'anywhere',
                            fontFamily:
                              label === 'Certificate reference' || label === 'ID number'
                                ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
                                : undefined,
                          }}
                        >
                          {value || '—'}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data?.status === 'revoked' && (
              <dl
                style={{
                  marginTop: 22,
                  background: 'var(--white, #fff)',
                  border: '1px solid var(--line, #e3e8f0)',
                  borderRadius: 12,
                  padding: '4px 14px',
                  fontSize: 14,
                }}
              >
                {[
                  ['Certificate reference', data.serial],
                  ['Date issued', fmtDate(data.issuedAt)],
                  ['Date revoked', fmtDate(data.revokedAt)],
                ].map(([label, value], i) => (
                  <div
                    key={label}
                    style={{
                      padding: '10px 0',
                      borderTop: i ? '1px solid var(--line, #e3e8f0)' : 'none',
                    }}
                  >
                    <dt style={{ fontSize: 12, color: 'var(--muted, #5A6B8C)' }}>{label}</dt>
                    <dd style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>
                      {value || '—'}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {(kind === 'notfound' || kind === 'error') && serial && (
              <p
                style={{
                  marginTop: 16,
                  fontSize: 13,
                  color: 'var(--muted, #5A6B8C)',
                  textAlign: 'center',
                  overflowWrap: 'anywhere',
                }}
              >
                Reference checked: <strong>{serial}</strong>
              </p>
            )}
            {kind === 'error' && (
              <div style={{ textAlign: 'center', marginTop: 12 }}>
                <button className="btn btn-outline" onClick={() => query.refetch()}>
                  Try again
                </button>
              </div>
            )}

            {valid && canHash && valid.sha256 && (
              <PdfFileCheck key={valid.serial} expectedSha256={valid.sha256} />
            )}

            {kind === 'notfound' ? (
              // Keyed on the serial so a new NOT FOUND starts from the reference just tried.
              <SerialEntry key={serial} initial={serial} />
            ) : (
              <p style={{ marginTop: 28, textAlign: 'center', fontSize: 14 }}>
                <Link to="/verify" style={{ color: 'var(--brand-primary, #1B2A4A)' }}>
                  Check another certificate
                </Link>
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
