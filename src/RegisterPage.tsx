/**
 * Public player-registration page — the real target of the share links the admin
 * generates (`/register/:clubId?t=<token>`). No auth. Validates the token, then
 * captures a registration with full parity to the in-portal chair form: the Union
 * field set plus an ID-document upload and a first-person POPIA consent. `dob` is
 * derived server-side from the 13-digit RSA ID; minors (under 18) require a guardian
 * name. A successful submit increments the club's derived player count.
 */
import { useEffect, useState } from 'react';
import type { ReactNode, ChangeEventHandler, InputHTMLAttributes } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  getRegistration,
  submitRegistration,
  getRegistrationIdDocUploadUrl,
  uploadToPresigned,
  ApiError,
} from './api';
import {
  RACES,
  GENDERS,
  NATIONALITIES,
  BOWLER_TYPES,
  BATTING_TYPES,
  HANDS,
  DISTRICTS,
  dobFromSaId,
} from './data';
import { leagueOptionsForDistrict } from './leagues';

const EMPTY = {
  surname: '',
  firstNames: '',
  idType: 'sa-id', // 'sa-id' (13-digit RSA ID, dob derived) | 'passport' (passport/visa + manual dob)
  idNumber: '',
  dob: '', // only used when idType === 'passport'; SA IDs derive dob from the number
  nationality: 'South African', // pre-filled default; editable, no empty option, so never blank
  race: '',
  gender: '',
  postalAddress: '',
  postalCode: '',
  phone: '',
  email: '',
  team: '',
  district: '',
  // Previous-club picker: '' (unanswered) | '__first__' | '__other__' | a real club id.
  // The free-text `lastClub` is only used with '__other__' (or when the backend sent no
  // club list and the page falls back to the legacy free-text field).
  lastClubChoice: '',
  lastClub: '',
  battingHand: 'Right',
  battingType: 'Mid Order',
  bowlingHand: 'Right',
  bowlerType: '',
  isAllRounder: false,
  isWk: false,
  guardianName: '',
  consentChecked: false,
};

const MAX_ID_DOC_BYTES = 5 * 1024 * 1024; // 5 MB — kept in step with the backend

function isMinor(dob) {
  if (!dob) return false;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return false;
  const eighteen = new Date(born);
  eighteen.setFullYear(eighteen.getFullYear() + 18);
  return eighteen.getTime() > Date.now();
}

export function RegisterPage() {
  const { clubId } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t');

  const [state, setState] = useState('loading'); // loading | ready | invalid | done
  const [clubName, setClubName] = useState('');
  const [leagues, setLeagues] = useState([]);
  // Sibling clubs for the previous-club dropdown; empty ⇒ free-text fallback.
  const [clubs, setClubs] = useState<{ id: string; name: string }[]>([]);
  // Set when the submit opened a transfer — drives the clearance success variant.
  const [clearanceFrom, setClearanceFrom] = useState('');
  const [d, setD] = useState(EMPTY);
  const [idFile, setIdFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!token) {
        setState('invalid');
        return;
      }
      try {
        const r = await getRegistration(clubId, token);
        if (!live) return;
        setClubName(r.clubName);
        setLeagues(r.leagues ?? []);
        setClubs(r.clubs ?? []);
        setState('ready');
      } catch {
        if (live) setState('invalid');
      }
    })();
    return () => {
      live = false;
    };
  }, [clubId, token]);

  const set = (k) => (e) => setD((f) => ({ ...f, [k]: e.target.value }));
  const setVal = (k, v) => setD((f) => ({ ...f, [k]: v }));

  // The team picker uses the same district-scoped helper as the portal; the registrant
  // picks their own district here, so the options follow that selection.
  const teamOptions = leagueOptionsForDistrict(leagues, d.district);
  const isPassport = d.idType === 'passport';
  // SA citizens derive dob from the RSA ID; non-SA enter it directly (no oracle for a passport).
  const dob = isPassport ? d.dob : dobFromSaId(d.idNumber);
  const idValid = isPassport ? d.idNumber.trim().length > 0 : /^\d{13}$/.test(d.idNumber);
  const minor = isMinor(dob);

  const required = [
    'surname',
    'firstNames',
    'idNumber',
    'race',
    'gender',
    'phone',
    'team',
    'district',
  ];
  const missing = required.filter((k) => !d[k]);
  const canSubmit =
    missing.length === 0 &&
    idValid &&
    !!dob &&
    !!idFile &&
    (!minor || !!d.guardianName) &&
    d.consentChecked &&
    !busy;

  // A disabled Register button is otherwise silent, so surface the first blocking
  // reason in form order. `missing` already covers an empty ID number; a filled but
  // invalid SA ID falls to the dedicated branch (its dob can't be derived).
  const disabledReason = busy
    ? ''
    : missing.length > 0
      ? 'Fill in all the required fields marked with *.'
      : !isPassport && !dob
        ? 'That South African ID number isn’t valid — please double-check it (the date of birth is read from it).'
        : isPassport && !dob
          ? 'Enter the date of birth.'
          : !idValid
            ? 'Check the ID number.'
            : !idFile
              ? 'Attach your ID document.'
              : minor && !d.guardianName
                ? 'Enter the parent/guardian’s name for a player under 18.'
                : !d.consentChecked
                  ? 'Tick the consent box to continue.'
                  : '';

  function pickFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_ID_DOC_BYTES) {
      setError('ID document must be under 5 MB.');
      return;
    }
    setError('');
    setIdFile(file);
  }

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) {
      setError('Fill all required fields, attach your ID document, and accept the consent.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      // Presign + upload the ID document first so its meta rides on the registration POST
      // (one atomic create, mirroring the portal's create-then-record but without auth).
      const ct = idFile.type || 'application/pdf';
      const { uploadUrl, objectKey, contentType } = await getRegistrationIdDocUploadUrl(
        clubId,
        token,
        ct,
      );
      await uploadToPresigned(uploadUrl, idFile, contentType);
      const res = await submitRegistration(clubId, token, {
        firstName: d.firstNames.trim(),
        lastName: d.surname.trim(),
        idType: d.idType,
        idNumber: d.idNumber.trim(),
        dob: isPassport ? d.dob : undefined,
        nationality: d.nationality,
        race: d.race,
        gender: d.gender,
        cell: d.phone,
        email: d.email || undefined,
        postalAddress: d.postalAddress || undefined,
        postalCode: d.postalCode || undefined,
        team: d.team,
        district: d.district,
        // Dropdown pick sends the club id (backend opens a clearance when the player
        // is found there); 'Other' sends the typed name; first registration sends the
        // documented '—' convention. No club list ⇒ legacy free-text behavior.
        ...(clubs.length === 0
          ? { lastClub: d.lastClub.trim() || undefined }
          : d.lastClubChoice === '__other__'
            ? { lastClub: d.lastClub.trim() || undefined }
            : d.lastClubChoice === '__first__'
              ? { lastClub: '—' }
              : d.lastClubChoice
                ? { lastClubId: d.lastClubChoice }
                : {}),
        battingHand: d.battingHand,
        bowlingHand: d.bowlingHand,
        battingType: d.battingType,
        bowlerType: d.bowlerType || undefined,
        isAllRounder: d.isAllRounder,
        isWk: d.isWk,
        guardianName: minor ? d.guardianName : undefined,
        idDocMeta: { objectKey, size: idFile.size, contentType },
      });
      if (res?.clearance?.fromClubName) setClearanceFrom(res.clearance.fromClubName);
      setState('done');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Matches the server's deliberately-collapsed conflict wording (dedup vs
        // mid-transfer are indistinguishable by design).
        setError('This person is already registered, or a transfer is already in progress.');
      } else {
        setError(err?.message || 'Could not submit. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') {
    return <CenterCard>Checking your registration link…</CenterCard>;
  }
  if (state === 'invalid') {
    return (
      <CenterCard>
        <h1 className="ps-title" style={{ fontSize: 22 }}>
          Link not valid
        </h1>
        <p className="ps-desc">
          This registration link is invalid or has expired. Ask your club for a fresh link.
        </p>
      </CenterCard>
    );
  }
  if (state === 'done') {
    if (clearanceFrom) {
      return (
        <CenterCard>
          <h1 className="ps-title" style={{ fontSize: 22 }}>
            Registration received — clearance pending
          </h1>
          <p className="ps-desc">
            Because you were last registered at <strong>{clearanceFrom}</strong>, a clearance
            request has been sent to them. You&apos;ll appear on {clubName}&apos;s roster as{' '}
            <em>clearance pending</em> until {clearanceFrom} (or the Union office) approves the
            transfer.
          </p>
        </CenterCard>
      );
    }
    return (
      <CenterCard>
        <h1 className="ps-title" style={{ fontSize: 22 }}>
          You&apos;re registered 🎉
        </h1>
        <p className="ps-desc">Thanks — your registration for {clubName} has been received.</p>
      </CenterCard>
    );
  }

  return (
    <CenterCard wide>
      <div className="ps-eyebrow">Player registration</div>
      <h1 className="ps-title" style={{ fontSize: 24 }}>
        {clubName}
      </h1>
      <p className="ps-desc" style={{ marginBottom: 18 }}>
        Register as a player for the 2026/27 season.
      </p>
      <form onSubmit={submit} className="reg-form">
        <Section title="Club & team">
          <Select
            label="District"
            required
            value={d.district}
            onChange={(e) => setD((f) => ({ ...f, district: e.target.value, team: '' }))}
            placeholder="Select district"
          >
            {DISTRICTS.map((ds) => (
              <option key={ds} value={ds}>
                {ds}
              </option>
            ))}
          </Select>
          <Select
            label="Team"
            required
            value={d.team}
            onChange={set('team')}
            placeholder="Select team"
          >
            {teamOptions.map((l) => (
              <option key={l.key} value={l.key}>
                {l.label}
              </option>
            ))}
          </Select>
        </Section>

        <Section title="Player identity">
          <Field label="Surname" required value={d.surname} onChange={set('surname')} />
          <Field label="First name(s)" required value={d.firstNames} onChange={set('firstNames')} />
          <Select
            label="ID type"
            required
            value={d.idType}
            onChange={(e) =>
              // Switching ID type clears the number and the manual dob so a stale value
              // from the other mode can't ride through (e.g. a 13-digit dob preview).
              setD((f) => ({ ...f, idType: e.target.value, idNumber: '', dob: '' }))
            }
          >
            <option value="sa-id">South African ID</option>
            <option value="passport">Passport / Visa (non-SA citizen)</option>
          </Select>
          <div>
            {isPassport ? (
              <Field
                label="Passport / Visa number"
                required
                value={d.idNumber}
                onChange={(e) => setVal('idNumber', e.target.value)}
                placeholder="Passport or visa number"
              />
            ) : (
              <Field
                label="ID number"
                required
                value={d.idNumber}
                inputMode="numeric"
                onChange={(e) => setVal('idNumber', e.target.value.replace(/\D/g, '').slice(0, 13))}
                placeholder="13-digit RSA ID"
              />
            )}
            {!isPassport && d.idNumber && !idValid && (
              <div style={{ color: 'var(--danger-on-dark)', fontSize: 12, marginTop: 4 }}>
                Must be exactly 13 digits.
              </div>
            )}
            {!isPassport && dob && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>
                ✓ Date of birth: <strong>{dob}</strong>
              </div>
            )}
          </div>
          {isPassport && (
            <label style={{ display: 'block' }}>
              <Label label="Date of birth" required />
              <input
                className="field-input"
                type="date"
                required
                max={new Date().toISOString().slice(0, 10)}
                value={d.dob}
                onChange={(e) => setVal('dob', e.target.value)}
                style={{ width: '100%', fontSize: 16 }}
              />
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>
                Enter your date of birth as it appears on your passport/visa.
              </span>
            </label>
          )}
          <Select label="Race" required value={d.race} onChange={set('race')} placeholder="Select">
            {RACES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
          <Select
            label="Gender"
            required
            value={d.gender}
            onChange={set('gender')}
            placeholder="Select"
          >
            {GENDERS.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </Select>
          {/* No placeholder: the field carries a real default ('South African'), so it can never
              be left blank — avoids a selectable empty option that would 400 on the server. */}
          <Select label="Nationality" required value={d.nationality} onChange={set('nationality')}>
            {NATIONALITIES.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </Select>
          <Field label="Phone" required type="tel" value={d.phone} onChange={set('phone')} />
          <Field label="Email" type="email" value={d.email} onChange={set('email')} />
          {minor && (
            <Field
              span
              label="Parent / guardian name (required for under-18s)"
              required
              value={d.guardianName}
              onChange={set('guardianName')}
            />
          )}
        </Section>

        <Section title="Address & contact">
          <Field
            span
            label="Postal address"
            value={d.postalAddress}
            onChange={set('postalAddress')}
          />
          <Field
            label="Postal code"
            value={d.postalCode}
            inputMode="numeric"
            onChange={(e) => setVal('postalCode', e.target.value.replace(/\D/g, '').slice(0, 4))}
          />
        </Section>

        <Section title="Playing profile">
          <Seg
            label="Batting hand"
            options={HANDS}
            value={d.battingHand}
            onPick={(v) => setVal('battingHand', v)}
          />
          <Seg
            label="Bowling hand"
            options={HANDS}
            value={d.bowlingHand}
            onPick={(v) => setVal('bowlingHand', v)}
          />
          <Select label="Batting type" value={d.battingType} onChange={set('battingType')}>
            {BATTING_TYPES.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </Select>
          <Select
            label="Bowler type"
            value={d.bowlerType}
            onChange={set('bowlerType')}
            placeholder="— Not a bowler —"
          >
            {BOWLER_TYPES.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </Select>
          <div className="reg-span reg-checks">
            <Check
              label="All-rounder"
              checked={d.isAllRounder}
              onChange={(v) => setVal('isAllRounder', v)}
            />
            <Check label="Wicket-keeper" checked={d.isWk} onChange={(v) => setVal('isWk', v)} />
          </div>
        </Section>

        <Section title="Registration history">
          {clubs.length === 0 ? (
            // Older backend (no club list in the link context) — legacy free text.
            <Field
              span
              label="Club for which last registered"
              value={d.lastClub}
              onChange={set('lastClub')}
              placeholder="Previous club, or — if first registration"
            />
          ) : (
            <>
              <Select
                span
                label="Club for which last registered"
                value={d.lastClubChoice}
                onChange={(e) =>
                  // Leaving 'Other' clears the typed name so it can't ride along with
                  // a club pick (same pattern as the admin venue picker).
                  setD((f) => ({ ...f, lastClubChoice: e.target.value, lastClub: '' }))
                }
                placeholder="Select…"
              >
                <option value="__first__">— First registration —</option>
                {clubs.map((cl) => (
                  <option key={cl.id} value={cl.id}>
                    {cl.name}
                  </option>
                ))}
                <option value="__other__">Other club (type below)</option>
              </Select>
              {d.lastClubChoice === '__other__' && (
                <Field
                  span
                  label="Previous club name"
                  value={d.lastClub}
                  onChange={set('lastClub')}
                  placeholder="Name of the club you last registered for"
                />
              )}
              {!!d.lastClubChoice &&
                d.lastClubChoice !== '__first__' &&
                d.lastClubChoice !== '__other__' && (
                  <div
                    className="reg-span"
                    style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}
                  >
                    If you&apos;re still registered there under this ID number, a clearance request
                    will be sent to that club — they (or the Union office) must approve it before
                    you join {clubName}.
                  </div>
                )}
            </>
          )}
        </Section>

        <Section title="ID document (required)">
          <input
            id="reg-id-file"
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            onChange={pickFile}
            style={{ display: 'none' }}
          />
          <label
            htmlFor="reg-id-file"
            className="reg-span"
            style={{
              display: 'block',
              padding: 16,
              borderRadius: 12,
              cursor: 'pointer',
              border: `1px solid ${idFile ? 'var(--teal)' : 'rgba(255,255,255,0.18)'}`,
              background: 'rgba(255,255,255,0.04)',
            }}
          >
            {idFile ? (
              <div style={{ fontSize: 13, color: '#fff' }}>
                <strong>{idFile.name}</strong>
                <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>Tap to replace</div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#fff' }}>
                <strong>Tap to attach your ID document</strong>
                <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>
                  SA ID / passport / visa photo or scan · JPG, PNG or PDF · max ~5MB
                </div>
              </div>
            )}
          </label>
        </Section>

        <label
          className="rp-check rp-pill"
          style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px' }}
        >
          <input
            type="checkbox"
            checked={d.consentChecked}
            onChange={(e) => setVal('consentChecked', e.target.checked)}
          />
          <span style={{ fontSize: 12.5, lineHeight: 1.55 }}>
            I request to register as a player for <strong>{clubName}</strong> under the{' '}
            <strong>Union Rules and Byelaws</strong>, and I consent to my personal information being
            processed for this registration (POPIA). I declare that I am not being paid by the club
            for my services as a cricketer.
          </span>
        </label>

        {error && <div style={{ color: 'var(--danger-on-dark)', fontSize: 12.5 }}>{error}</div>}
        {!error && !canSubmit && disabledReason && (
          <div
            role="status"
            aria-live="polite"
            style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12.5 }}
          >
            {disabledReason}
          </div>
        )}
        <button
          className="btn btn-teal"
          type="submit"
          disabled={!canSubmit}
          style={{ width: '100%', marginTop: 4 }}
        >
          {busy ? 'Submitting…' : 'Register'}
        </button>
      </form>
    </CenterCard>
  );
}

function CenterCard({ children, wide }: { children?: ReactNode; wide?: boolean }) {
  return (
    <div className="ps-screen">
      <div className={`ps-cards ${wide ? 'reg-cards' : 'reg-cards-sm'}`}>
        <div className="ps-card reg-card">{children}</div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="reg-section">
      <div className="reg-section-title">{title}</div>
      <div className="reg-grid">{children}</div>
    </div>
  );
}

function Label({ label, required }: { label: ReactNode; required?: boolean }) {
  return (
    <span className="reg-label">
      {label}
      {required && <span className="req">*</span>}
    </span>
  );
}

interface FieldProps {
  label: ReactNode;
  type?: string;
  required?: boolean;
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  placeholder?: string;
  inputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode'];
  span?: boolean;
}
function Field({
  label,
  type = 'text',
  required,
  value,
  onChange,
  placeholder,
  inputMode,
  span,
}: FieldProps) {
  return (
    <label className={span ? 'reg-span' : undefined} style={{ display: 'block' }}>
      <Label label={label} required={required} />
      <input
        className="field-input"
        type={type}
        inputMode={inputMode}
        required={required}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        style={{ width: '100%', fontSize: 16 }}
      />
    </label>
  );
}

interface SelectProps {
  label: ReactNode;
  required?: boolean;
  value: string;
  onChange: ChangeEventHandler<HTMLSelectElement>;
  placeholder?: string;
  children?: ReactNode;
  span?: boolean;
}
function Select({ label, required, value, onChange, placeholder, children, span }: SelectProps) {
  return (
    <label className={span ? 'reg-span' : undefined} style={{ display: 'block' }}>
      <Label label={label} required={required} />
      <select
        className="field-select"
        required={required}
        value={value}
        onChange={onChange}
        style={{ width: '100%', fontSize: 16 }}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {children}
      </select>
    </label>
  );
}

function Seg({
  label,
  options,
  value,
  onPick,
  span,
}: {
  label: ReactNode;
  options: string[];
  value: string;
  onPick: (v: string) => void;
  span?: boolean;
}) {
  return (
    <div className={span ? 'reg-span' : undefined}>
      <Label label={label} />
      <div className="seg">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            className={`seg-btn ${value === o ? 'on' : ''}`}
            onClick={() => onPick(o)}
          >
            {o} hander
          </button>
        ))}
      </div>
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="rp-check rp-pill" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
