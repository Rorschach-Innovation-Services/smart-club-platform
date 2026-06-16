/**
 * Public player-registration page — the real target of the share links the admin
 * generates (`/register/:clubId?t=<token>`). No auth. Validates the token, then
 * captures a registration with full parity to the in-portal chair form: the Union
 * field set plus an ID-document upload and a first-person POPIA consent. `dob` is
 * derived server-side from the 13-digit RSA ID; minors (under 18) require a guardian
 * name. A successful submit increments the club's derived player count.
 */
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  getRegistration,
  submitRegistration,
  getRegistrationIdDocUploadUrl,
  uploadToPresigned,
  ApiError,
} from './api.js';
import {
  RACES,
  GENDERS,
  BOWLER_TYPES,
  BATTING_TYPES,
  HANDS,
  DISTRICTS,
  dobFromSaId,
} from './data.jsx';
import { leagueOptionsForDistrict } from './leagues.js';

const EMPTY = {
  surname: '',
  firstNames: '',
  idNumber: '',
  race: '',
  gender: '',
  postalAddress: '',
  postalCode: '',
  phone: '',
  email: '',
  team: '',
  district: '',
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
  const [d, setD] = useState(EMPTY);
  const [idFile, setIdFile] = useState(null);
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
  const dob = dobFromSaId(d.idNumber);
  const idValid = /^\d{13}$/.test(d.idNumber);
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
      await submitRegistration(clubId, token, {
        firstName: d.firstNames.trim(),
        lastName: d.surname.trim(),
        idNumber: d.idNumber,
        race: d.race,
        gender: d.gender,
        cell: d.phone,
        email: d.email || undefined,
        postalAddress: d.postalAddress || undefined,
        postalCode: d.postalCode || undefined,
        team: d.team,
        district: d.district,
        lastClub: d.lastClub || undefined,
        battingHand: d.battingHand,
        bowlingHand: d.bowlingHand,
        battingType: d.battingType,
        bowlerType: d.bowlerType || undefined,
        isAllRounder: d.isAllRounder,
        isWk: d.isWk,
        guardianName: minor ? d.guardianName : undefined,
        idDocMeta: { objectKey, size: idFile.size, contentType },
      });
      setState('done');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('This person is already registered for the club.');
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
          <div>
            <Field
              label="ID number"
              required
              value={d.idNumber}
              inputMode="numeric"
              onChange={(e) => setVal('idNumber', e.target.value.replace(/\D/g, '').slice(0, 13))}
              placeholder="13-digit RSA ID"
            />
            {d.idNumber && !idValid && (
              <div style={{ color: 'var(--coral)', fontSize: 12, marginTop: 4 }}>
                Must be exactly 13 digits.
              </div>
            )}
            {dob && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>
                ✓ Date of birth: <strong>{dob}</strong>
              </div>
            )}
          </div>
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
          <Field
            span
            label="Club for which last registered"
            value={d.lastClub}
            onChange={set('lastClub')}
            placeholder="Previous club, or — if first registration"
          />
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
                  SA ID book photo or scan · JPG, PNG or PDF · max ~5MB
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

        {error && <div style={{ color: 'var(--coral)', fontSize: 12.5 }}>{error}</div>}
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

function CenterCard({ children, wide }) {
  return (
    <div className="ps-screen">
      <div className={`ps-cards ${wide ? 'reg-cards' : 'reg-cards-sm'}`}>
        <div className="ps-card reg-card">{children}</div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="reg-section">
      <div className="reg-section-title">{title}</div>
      <div className="reg-grid">{children}</div>
    </div>
  );
}

function Label({ label, required }) {
  return (
    <span className="reg-label">
      {label}
      {required && <span className="req">*</span>}
    </span>
  );
}

function Field({ label, type = 'text', required, value, onChange, placeholder, inputMode, span }) {
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

function Select({ label, required, value, onChange, placeholder, children, span }) {
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

function Seg({ label, options, value, onPick, span }) {
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

function Check({ label, checked, onChange }) {
  return (
    <label className="rp-check rp-pill" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
