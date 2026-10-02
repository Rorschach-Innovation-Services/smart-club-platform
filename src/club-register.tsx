/**
 * Chair-led player registration (club portal) — three ways for a chair to put players on the
 * roster without the public link:
 *
 *  - `RegisterPlayerForm`: one player, full field parity with the public RegisterPage (same
 *    required set, previous-club picker, optional ID document uploaded after the create).
 *  - `QuickAddPlayersGrid`: up to 25 rows of the identity minimum (names, SA ID or passport+DOB,
 *    gender, team) in one batch call, with a per-row outcome badge afterwards.
 *  - `ClubRosterUpload`: the downloadable template → parse → review (conflict column says what
 *    each row will do) → chunked commit with a progress bar → summary.
 *
 * Every path goes through the server's clearance-aware core, so a player already registered at
 * another club opens a clearance from that club rather than a silent duplicate. The components
 * own their network calls and invalidate the roster/clearance caches themselves; the caller
 * only mounts them in a Modal and closes it on `onDone`.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CHAIR_BATCH_MAX_ROWS,
  CHAIR_ROSTER_COMMIT_MAX_ROWS,
  commitClubRoster,
  getClubDirectory,
  getPlayerIdDocUploadUrl,
  markPlayerIdDoc,
  parseClubRoster,
  registerPlayer,
  registerPlayersBatch,
  uploadToPresigned,
} from './api';
import type {
  ChairBatchRow,
  ChairBulkResult,
  ChairRosterCommitItem,
  ChairRosterParseResponse,
  ChairRosterParseRow,
  RegisterPlayerResponse,
} from './api';
import {
  BATTING_TYPES,
  BOWLER_TYPES,
  DISTRICTS,
  GENDERS,
  HANDS,
  NATIONALITIES,
  RACES,
  dobFromSaId,
} from './data';
import { labelByKey, leagueOptionsForDistrict } from '../packages/engine/src/leagues';
import { useModule, useVertical } from './branding';
import { Btn, Icon, Pill } from './atoms';
import { qk } from './query';
import {
  applyRosterDecision,
  buildClubSummaries,
  committableCounts,
  rosterRowKey,
} from './roster-review';
import type { RosterDecisions } from './roster-review';

type Toast = (msg: string, tone?: string) => void;
interface ClubLike {
  id: string;
  name: string;
  district?: string;
}
type LeagueLike = { key: string; label?: string; district?: string };

const MAX_ID_DOC_BYTES = 5 * 1024 * 1024; // kept in step with the backend
const MAX_ROSTER_BYTES = 2 * 1024 * 1024; // the roster parse route's cap

/**
 * A valid 13-digit RSA ID: a real birth date AND the Luhn check digit — the same two tests the
 * server's batch route applies (dobFromSaId + luhnValid), so the grid can flag a typo before
 * the round trip.
 */
export function saIdValid(raw: string): boolean {
  const id = (raw || '').replace(/\s+/g, '');
  if (!/^\d{13}$/.test(id) || !dobFromSaId(id)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let d = Number(id[12 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function isMinor(dob: string): boolean {
  if (!dob) return false;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return false;
  const eighteen = new Date(born);
  eighteen.setFullYear(eighteen.getFullYear() + 18);
  return eighteen.getTime() > Date.now();
}

/** Refresh everything a registration can change: roster, clearances, the club's count. */
function useInvalidateRoster(clubId: string) {
  const client = useQueryClient();
  return () => {
    for (const key of [qk.players(clubId), qk.clearances(clubId), qk.club(clubId), qk.clubs()])
      client.invalidateQueries({ queryKey: key });
  };
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function Label({ children, required }: { children: ReactNode; required?: boolean }) {
  return (
    <label className="field-label">
      {children}
      {required && <span className="req"> *</span>}
    </label>
  );
}

/* ─── Single player ─── */

const EMPTY_PLAYER = {
  firstName: '',
  lastName: '',
  idType: 'sa-id' as 'sa-id' | 'passport',
  idNumber: '',
  dob: '',
  nationality: 'South African',
  race: '',
  gender: '',
  cell: '',
  email: '',
  guardianName: '',
  postalAddress: '',
  postalCode: '',
  district: '',
  team: '',
  // '' (unanswered) | '__first__' | '__other__' | a club id
  lastClubChoice: '',
  lastClub: '',
  battingHand: 'Right',
  bowlingHand: 'Right',
  battingType: 'Mid Order',
  bowlerType: '',
  isAllRounder: false,
  isWk: false,
  position: '',
};

/** The toast line for a successful single registration — one per server outcome. */
export function registerOutcomeMessage(res: RegisterPlayerResponse, previousClub?: string): string {
  const name = `${res.firstName} ${res.lastName}`.trim();
  if (res.outcome === 'clearance-opened')
    return `${name} registered as clearance pending — a clearance was opened from ${
      res.clearance?.fromClubName || 'their previous club'
    }.`;
  if (res.outcome === 'review-opened')
    return `${name} registered. ${
      previousClub ? `${previousClub} isn’t` : 'Their previous club isn’t'
    } on the system, so the union office has been asked to check the transfer.`;
  return `${name} registered.`;
}

export function RegisterPlayerForm({
  club,
  leagues,
  districts = DISTRICTS,
  toast,
  onDone,
  onCancel,
}: {
  club: ClubLike;
  leagues: LeagueLike[];
  districts?: string[];
  toast?: Toast;
  onDone: () => void;
  onCancel: () => void;
}) {
  const vertical = useVertical();
  const positionsMode = vertical.playerProfile === 'positions';
  const clearancesOn = useModule('clearances');
  const invalidate = useInvalidateRoster(club.id);
  const [d, setD] = useState({
    ...EMPTY_PLAYER,
    district: club.district || districts[0] || '',
  });
  const [idFile, setIdFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const directoryQuery = useQuery({
    queryKey: qk.clubDirectory(),
    queryFn: getClubDirectory,
    enabled: clearancesOn,
  });
  const otherClubs = (directoryQuery.data ?? []).filter((c) => c.id !== club.id);
  const set = (k: keyof typeof EMPTY_PLAYER) => (e: { target: { value: string } }) =>
    setD((f) => ({ ...f, [k]: e.target.value }));

  const districtOptions = [...new Set([club.district, ...districts].filter(Boolean))] as string[];
  const teamOptions = leagueOptionsForDistrict(leagues as never[], d.district) as LeagueLike[];
  const isPassport = d.idType === 'passport';
  const dob = isPassport ? d.dob : dobFromSaId(d.idNumber) || '';
  const idValid = isPassport ? d.idNumber.trim().length > 0 : saIdValid(d.idNumber);
  const minor = isMinor(dob);
  const required: Array<keyof typeof EMPTY_PLAYER> = [
    'lastName',
    'firstName',
    'idNumber',
    'race',
    'gender',
    'nationality',
    'cell',
    'district',
    'team',
  ];
  const missing = required.filter((k) => !String(d[k] ?? '').trim());
  const blocker = missing.length
    ? 'Fill in all the required fields marked with *.'
    : !isPassport && !idValid
      ? 'That South African ID number isn’t valid — check it (the date of birth is read from it).'
      : isPassport && !dob
        ? 'Enter the date of birth.'
        : minor && !d.guardianName.trim()
          ? 'Enter the parent/guardian’s name for a player under 18.'
          : d.lastClubChoice === '__other__' && !d.lastClub.trim()
            ? 'Type the name of the previous club.'
            : '';

  function pickFile(e: { target: { files?: FileList | null; value: string } }) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_ID_DOC_BYTES) {
      setError('The ID document must be under 5 MB.');
      e.target.value = '';
      return;
    }
    setError('');
    setIdFile(file);
  }

  async function submit() {
    if (blocker || busy) return;
    setBusy(true);
    setError('');
    const previousClubName =
      d.lastClubChoice === '__other__'
        ? d.lastClub.trim()
        : otherClubs.find((c) => c.id === d.lastClubChoice)?.name;
    let res: RegisterPlayerResponse;
    try {
      res = await registerPlayer(club.id, {
        firstName: d.firstName.trim(),
        lastName: d.lastName.trim(),
        idType: d.idType,
        idNumber: d.idNumber.trim(),
        ...(isPassport ? { dob: d.dob } : {}),
        nationality: d.nationality,
        race: d.race,
        gender: d.gender,
        cell: d.cell.trim(),
        ...(d.email.trim() ? { email: d.email.trim() } : {}),
        ...(d.postalAddress.trim() ? { postalAddress: d.postalAddress.trim() } : {}),
        ...(d.postalCode.trim() ? { postalCode: d.postalCode.trim() } : {}),
        team: d.team,
        district: d.district,
        ...(minor ? { guardianName: d.guardianName.trim() } : {}),
        // Same previous-club convention as the public form: a picked club sends its id (the
        // server opens a clearance when the player is found there), "Other" sends the typed
        // name (an off-system club → union review), a first registration sends '—'.
        ...(!clearancesOn
          ? {}
          : d.lastClubChoice === '__first__'
            ? { lastClub: '—' }
            : d.lastClubChoice === '__other__'
              ? { lastClub: d.lastClub.trim() }
              : d.lastClubChoice
                ? { lastClubId: d.lastClubChoice }
                : {}),
        ...(positionsMode
          ? d.position
            ? { position: d.position }
            : {}
          : {
              battingHand: d.battingHand,
              bowlingHand: d.bowlingHand,
              battingType: d.battingType,
              ...(d.bowlerType ? { bowlerType: d.bowlerType } : {}),
              isAllRounder: d.isAllRounder,
              isWk: d.isWk,
            }),
      });
    } catch (err) {
      // 409 = a duplicate on this roster or a transfer already in progress — the server's own
      // message says which. 400 = a field the server rejected.
      setError(errorText(err, 'Could not register the player. Please try again.'));
      setBusy(false);
      return;
    }
    let docFailed = false;
    if (idFile) {
      try {
        const ct = idFile.type || 'application/pdf';
        const grant = await getPlayerIdDocUploadUrl(club.id, res.naturalKey, ct);
        await uploadToPresigned(grant.uploadUrl, idFile, grant.contentType);
        await markPlayerIdDoc(club.id, res.naturalKey, {
          objectKey: grant.objectKey,
          size: idFile.size,
          contentType: grant.contentType,
        });
      } catch {
        docFailed = true;
      }
    }
    invalidate();
    setBusy(false);
    toast?.(registerOutcomeMessage(res, previousClubName));
    if (docFailed)
      toast?.(
        'The player is registered, but the ID document did not upload — the roster shows it as missing.',
        'warn',
      );
    onDone();
  }

  return (
    <div className="rp-form">
      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">Team</div>
          <div className="rp-section-title">Where they play</div>
        </div>
        <div className="field-grid-2">
          <div>
            <Label required>District</Label>
            <select
              className="field-select"
              aria-label="District"
              value={d.district}
              onChange={(e) => setD((f) => ({ ...f, district: e.target.value, team: '' }))}
            >
              {districtOptions.map((ds) => (
                <option key={ds} value={ds}>
                  {ds}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label required>Team</Label>
            <select
              className="field-select"
              aria-label="Team"
              value={d.team}
              onChange={set('team')}
            >
              <option value="">Select team</option>
              {teamOptions.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label || l.key}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">Identity</div>
          <div className="rp-section-title">The player</div>
        </div>
        <div className="field-grid-2">
          <div>
            <Label required>First name(s)</Label>
            <input
              className="field-input"
              aria-label="First name(s)"
              value={d.firstName}
              onChange={set('firstName')}
            />
          </div>
          <div>
            <Label required>Surname</Label>
            <input
              className="field-input"
              aria-label="Surname"
              value={d.lastName}
              onChange={set('lastName')}
            />
          </div>
          <div>
            <Label required>ID type</Label>
            <select
              className="field-select"
              aria-label="ID type"
              value={d.idType}
              onChange={(e) =>
                setD((f) => ({
                  ...f,
                  idType: e.target.value as 'sa-id' | 'passport',
                  idNumber: '',
                  dob: '',
                }))
              }
            >
              <option value="sa-id">South African ID</option>
              <option value="passport">Passport / Visa (non-SA citizen)</option>
            </select>
          </div>
          <div>
            <Label required>{isPassport ? 'Passport / visa number' : 'ID number'}</Label>
            <input
              className="field-input"
              aria-label={isPassport ? 'Passport / visa number' : 'ID number'}
              value={d.idNumber}
              inputMode={isPassport ? undefined : 'numeric'}
              placeholder={isPassport ? 'Passport or visa number' : '13-digit RSA ID'}
              onChange={(e) =>
                setD((f) => ({
                  ...f,
                  idNumber: isPassport
                    ? e.target.value
                    : e.target.value.replace(/\D/g, '').slice(0, 13),
                }))
              }
              style={{ fontVariantNumeric: 'tabular-nums' }}
            />
            {!isPassport && d.idNumber.length === 13 && !idValid && (
              <div className="rost-sub" style={{ color: 'var(--coral)', marginTop: 4 }}>
                Not a valid RSA ID number.
              </div>
            )}
            {!isPassport && idValid && (
              <div className="rost-sub" style={{ marginTop: 4 }}>
                Date of birth: <strong>{dob}</strong>
              </div>
            )}
          </div>
          {isPassport && (
            <div>
              <Label required>Date of birth</Label>
              <input
                className="field-input"
                type="date"
                aria-label="Date of birth"
                value={d.dob}
                onChange={set('dob')}
              />
            </div>
          )}
          <div>
            <Label required>Nationality</Label>
            <select
              className="field-select"
              aria-label="Nationality"
              value={d.nationality}
              onChange={set('nationality')}
            >
              {NATIONALITIES.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </div>
          <div>
            <Label required>Race</Label>
            <select
              className="field-select"
              aria-label="Race"
              value={d.race}
              onChange={set('race')}
            >
              <option value="">Select</option>
              {RACES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
          <div>
            <Label required>Gender</Label>
            <select
              className="field-select"
              aria-label="Gender"
              value={d.gender}
              onChange={set('gender')}
            >
              <option value="">Select</option>
              {GENDERS.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </div>
          <div>
            <Label required>Cell</Label>
            <input
              className="field-input"
              type="tel"
              aria-label="Cell"
              value={d.cell}
              onChange={set('cell')}
            />
          </div>
          <div>
            <Label>Email</Label>
            <input
              className="field-input"
              type="email"
              aria-label="Email"
              value={d.email}
              onChange={set('email')}
            />
          </div>
          {minor && (
            <div>
              <Label required>Parent / guardian name</Label>
              <input
                className="field-input"
                aria-label="Parent / guardian name"
                value={d.guardianName}
                onChange={set('guardianName')}
              />
            </div>
          )}
          <div>
            <Label>Postal address</Label>
            <input
              className="field-input"
              aria-label="Postal address"
              value={d.postalAddress}
              onChange={set('postalAddress')}
            />
          </div>
          <div>
            <Label>Postal code</Label>
            <input
              className="field-input"
              aria-label="Postal code"
              inputMode="numeric"
              value={d.postalCode}
              onChange={(e) =>
                setD((f) => ({ ...f, postalCode: e.target.value.replace(/\D/g, '').slice(0, 4) }))
              }
            />
          </div>
        </div>
      </div>

      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">Playing profile</div>
          <div className="rp-section-title">Optional</div>
        </div>
        <div className="field-grid-2">
          {positionsMode ? (
            <div>
              <Label>Position</Label>
              <select
                className="field-select"
                aria-label="Position"
                value={d.position}
                onChange={set('position')}
              >
                <option value="">— Select position —</option>
                {vertical.positions.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </div>
          ) : (
            <>
              <div>
                <Label>Batting hand</Label>
                <select
                  className="field-select"
                  aria-label="Batting hand"
                  value={d.battingHand}
                  onChange={set('battingHand')}
                >
                  {HANDS.map((h) => (
                    <option key={h}>{h}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Bowling hand</Label>
                <select
                  className="field-select"
                  aria-label="Bowling hand"
                  value={d.bowlingHand}
                  onChange={set('bowlingHand')}
                >
                  {HANDS.map((h) => (
                    <option key={h}>{h}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Batting type</Label>
                <select
                  className="field-select"
                  aria-label="Batting type"
                  value={d.battingType}
                  onChange={set('battingType')}
                >
                  {BATTING_TYPES.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Bowler type</Label>
                <select
                  className="field-select"
                  aria-label="Bowler type"
                  value={d.bowlerType}
                  onChange={set('bowlerType')}
                >
                  <option value="">— Not a bowler —</option>
                  {BOWLER_TYPES.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </div>
              <label className="rp-check" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={d.isAllRounder}
                  onChange={(e) => setD((f) => ({ ...f, isAllRounder: e.target.checked }))}
                />
                All-rounder
              </label>
              <label className="rp-check" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={d.isWk}
                  onChange={(e) => setD((f) => ({ ...f, isWk: e.target.checked }))}
                />
                Wicket-keeper
              </label>
            </>
          )}
        </div>
      </div>

      {clearancesOn && (
        <div className="rp-section">
          <div className="rp-section-head">
            <div className="rp-section-eyebrow">Registration history</div>
            <div className="rp-section-title">Previous club</div>
          </div>
          <div className="field-grid-2">
            <div>
              <Label>Club last registered for</Label>
              <select
                className="field-select"
                aria-label="Club last registered for"
                value={d.lastClubChoice}
                onChange={(e) =>
                  setD((f) => ({ ...f, lastClubChoice: e.target.value, lastClub: '' }))
                }
              >
                <option value="">Not asked</option>
                <option value="__first__">None (first registration)</option>
                {otherClubs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value="__other__">Other club (type the name)</option>
              </select>
            </div>
            {d.lastClubChoice === '__other__' && (
              <div>
                <Label required>Previous club name</Label>
                <input
                  className="field-input"
                  aria-label="Previous club name"
                  value={d.lastClub}
                  onChange={set('lastClub')}
                />
              </div>
            )}
          </div>
          {d.lastClubChoice && !d.lastClubChoice.startsWith('__') && (
            <p className="ph-desc" style={{ marginTop: 8 }}>
              If the player is still registered there, a clearance is opened from that club — the
              player shows as clearance pending until it (or the union office) approves.
            </p>
          )}
          {d.lastClubChoice === '__other__' && (
            <p className="ph-desc" style={{ marginTop: 8 }}>
              A club that isn’t on the system can’t release the player itself, so the union office
              is asked to check the transfer. The player is still registered.
            </p>
          )}
        </div>
      )}

      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">ID document</div>
          <div className="rp-section-title">Optional — you can add it later</div>
        </div>
        <input
          type="file"
          aria-label="ID document"
          accept="image/jpeg,image/png,application/pdf"
          onChange={pickFile}
        />
        {idFile && <div className="rost-sub">Will upload {idFile.name} after registering.</div>}
      </div>

      {error && (
        <div className="field-error" role="alert" style={{ marginTop: 6 }}>
          {error}
        </div>
      )}
      {!error && blocker && (
        <div className="rost-sub" role="status" style={{ marginTop: 6 }}>
          {blocker}
        </div>
      )}
      <div className="rp-actions">
        <Btn tone="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Btn>
        <Btn tone="teal" icon={Icon.Check} disabled={!!blocker || busy} onClick={submit}>
          {busy ? 'Registering…' : 'Register player'}
        </Btn>
      </div>
    </div>
  );
}

/* ─── Bulk outcome badge (shared by the grid and the spreadsheet summary) ─── */

export function BulkOutcomePill({ result }: { result: ChairBulkResult }) {
  switch (result.outcome) {
    case 'created':
      return (
        <Pill tone="teal" dot>
          Registered
        </Pill>
      );
    case 'clearance-opened':
      return (
        <Pill tone="gold" dot>
          Clearance opened{result.fromClubName ? ` from ${result.fromClubName}` : ''}
        </Pill>
      );
    case 'clearance-already-open':
      return (
        <Pill tone="gold" dot>
          Transfer already in progress
        </Pill>
      );
    case 'skipped-duplicate':
      return <Pill tone="muted">Already on your roster</Pill>;
    default:
      return (
        <Pill tone="coral" dot>
          {result.error || 'Error'}
        </Pill>
      );
  }
}

function summaryLine(results: ChairBulkResult[]): string {
  const n = (o: ChairBulkResult['outcome']) => results.filter((r) => r.outcome === o).length;
  const parts = [
    `${n('created')} registered`,
    `${n('clearance-opened')} clearance${n('clearance-opened') === 1 ? '' : 's'} opened`,
  ];
  const skipped = n('skipped-duplicate') + n('clearance-already-open');
  if (skipped) parts.push(`${skipped} skipped`);
  if (n('error')) parts.push(`${n('error')} with errors`);
  return parts.join(', ');
}

/* ─── Quick-add grid ─── */

interface GridRow {
  key: number;
  firstName: string;
  lastName: string;
  idType: 'sa-id' | 'passport';
  idNumber: string;
  dob: string;
  nationality: string;
  gender: string;
  team: string;
  result?: ChairBulkResult;
}

let gridKey = 0;
const emptyGridRow = (): GridRow => ({
  key: ++gridKey,
  firstName: '',
  lastName: '',
  idType: 'sa-id',
  idNumber: '',
  dob: '',
  nationality: '',
  gender: '',
  team: '',
});

const rowIsBlank = (r: GridRow) =>
  !r.firstName.trim() && !r.lastName.trim() && !r.idNumber.trim() && !r.dob;
/** A row the server already settled (anything but an error) is locked against a re-send. */
const rowIsSettled = (r: GridRow) => !!r.result && r.result.outcome !== 'error';

/** The first reason a filled-in row can't be sent, or '' when it is ready. */
export function gridRowProblem(r: GridRow): string {
  if (!r.firstName.trim() || !r.lastName.trim()) return 'First name and surname are required.';
  if (r.idType === 'sa-id') return saIdValid(r.idNumber) ? '' : 'Not a valid RSA ID number.';
  if (!r.idNumber.trim()) return 'Enter the passport number.';
  if (!r.dob) return 'Enter the date of birth.';
  if (!r.nationality) return 'Pick the nationality.';
  return '';
}

export function QuickAddPlayersGrid({
  club,
  leagues,
  toast,
  onDone,
  onCancel,
}: {
  club: ClubLike;
  leagues: LeagueLike[];
  toast?: Toast;
  onDone: () => void;
  onCancel: () => void;
}) {
  const invalidate = useInvalidateRoster(club.id);
  const [rows, setRows] = useState<GridRow[]>(() => Array.from({ length: 5 }, emptyGridRow));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const teamOptions = leagueOptionsForDistrict(
    leagues as never[],
    club.district || '',
  ) as LeagueLike[];
  const patch = (key: number, p: Partial<GridRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p, result: undefined } : r)));

  const pending = rows.filter((r) => !rowIsBlank(r) && !rowIsSettled(r));
  const problems = pending.filter((r) => gridRowProblem(r));
  const anySettled = rows.some(rowIsSettled);

  async function submit() {
    if (busy || !pending.length || problems.length) return;
    setBusy(true);
    setError('');
    const sent = pending;
    try {
      const body: ChairBatchRow[] = sent.map((r) => ({
        firstName: r.firstName.trim(),
        lastName: r.lastName.trim(),
        idType: r.idType,
        idNumber: r.idNumber.trim(),
        ...(r.idType === 'passport' ? { dob: r.dob, nationality: r.nationality } : {}),
        ...(r.gender ? { gender: r.gender } : {}),
        ...(r.team ? { team: r.team } : {}),
      }));
      const res = await registerPlayersBatch(club.id, body);
      const byIndex = new Map(res.results.map((x) => [x.index, x]));
      const resultFor = new Map(sent.map((r, i) => [r.key, byIndex.get(i)]));
      setRows((rs) =>
        rs.map((r) => (resultFor.get(r.key) ? { ...r, result: resultFor.get(r.key) } : r)),
      );
      invalidate();
      toast?.(summaryLine(res.results), res.summary.error ? 'warn' : 'ok');
    } catch (err) {
      setError(errorText(err, 'Could not register these players. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rp-form">
      <p className="ph-desc" style={{ marginBottom: 12 }}>
        Add up to {CHAIR_BATCH_MAX_ROWS} players at once with just their names and ID. Contact
        details can be added later. A player already registered at another club opens a clearance
        from that club.
      </p>
      <div className="tbl-w">
        <table className="tbl">
          <thead>
            <tr>
              <th>First name</th>
              <th>Surname</th>
              <th>ID type</th>
              <th>ID / passport no.</th>
              <th>DOB (passport)</th>
              <th>Nationality (passport)</th>
              <th>Gender</th>
              <th>Team</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const locked = rowIsSettled(r) || busy;
              const problem = !rowIsBlank(r) && !rowIsSettled(r) ? gridRowProblem(r) : '';
              const passport = r.idType === 'passport';
              return (
                <tr key={r.key}>
                  <td>
                    <input
                      className="field-input"
                      aria-label={`Row ${i + 1} first name`}
                      value={r.firstName}
                      disabled={locked}
                      onChange={(e) => patch(r.key, { firstName: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="field-input"
                      aria-label={`Row ${i + 1} surname`}
                      value={r.lastName}
                      disabled={locked}
                      onChange={(e) => patch(r.key, { lastName: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="field-select"
                      aria-label={`Row ${i + 1} ID type`}
                      value={r.idType}
                      disabled={locked}
                      onChange={(e) =>
                        patch(r.key, {
                          idType: e.target.value as GridRow['idType'],
                          idNumber: '',
                          dob: '',
                          nationality: '',
                        })
                      }
                    >
                      <option value="sa-id">SA ID</option>
                      <option value="passport">Passport</option>
                    </select>
                  </td>
                  <td>
                    <input
                      className="field-input"
                      aria-label={`Row ${i + 1} ID number`}
                      value={r.idNumber}
                      disabled={locked}
                      inputMode={passport ? undefined : 'numeric'}
                      onChange={(e) =>
                        patch(r.key, {
                          idNumber: passport
                            ? e.target.value
                            : e.target.value.replace(/\D/g, '').slice(0, 13),
                        })
                      }
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    />
                  </td>
                  <td>
                    <input
                      className="field-input"
                      type="date"
                      aria-label={`Row ${i + 1} date of birth`}
                      value={r.dob}
                      disabled={locked || !passport}
                      onChange={(e) => patch(r.key, { dob: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="field-select"
                      aria-label={`Row ${i + 1} nationality`}
                      value={r.nationality}
                      disabled={locked || !passport}
                      onChange={(e) => patch(r.key, { nationality: e.target.value })}
                    >
                      <option value="">—</option>
                      {NATIONALITIES.map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="field-select"
                      aria-label={`Row ${i + 1} gender`}
                      value={r.gender}
                      disabled={locked}
                      onChange={(e) => patch(r.key, { gender: e.target.value })}
                    >
                      <option value="">—</option>
                      {GENDERS.map((g) => (
                        <option key={g}>{g}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="field-select"
                      aria-label={`Row ${i + 1} team`}
                      value={r.team}
                      disabled={locked}
                      onChange={(e) => patch(r.key, { team: e.target.value })}
                    >
                      <option value="">—</option>
                      {teamOptions.map((l) => (
                        <option key={l.key} value={l.key}>
                          {l.label || l.key}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {r.result ? (
                      <BulkOutcomePill result={r.result} />
                    ) : problem ? (
                      <span className="rost-sub" style={{ color: 'var(--coral)' }}>
                        {problem}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10 }}>
        <Btn
          tone="ghost"
          size="sm"
          icon={Icon.Plus}
          disabled={busy || rows.length >= CHAIR_BATCH_MAX_ROWS}
          onClick={() => setRows((rs) => [...rs, emptyGridRow()])}
        >
          Add row
        </Btn>
      </div>
      {error && (
        <div className="field-error" role="alert" style={{ marginTop: 6 }}>
          {error}
        </div>
      )}
      <div className="rp-actions">
        <Btn tone="outline" onClick={anySettled ? onDone : onCancel} disabled={busy}>
          {anySettled ? 'Done' : 'Cancel'}
        </Btn>
        <Btn
          tone="teal"
          icon={Icon.Check}
          disabled={busy || !pending.length || problems.length > 0}
          onClick={submit}
        >
          {busy
            ? 'Registering…'
            : pending.length
              ? `Register ${pending.length} player${pending.length === 1 ? '' : 's'}`
              : 'Register players'}
        </Btn>
      </div>
    </div>
  );
}

/* ─── Spreadsheet upload ─── */

const EXCEPTION_LABEL: Record<string, string> = {
  'bad-id': 'no valid ID number',
  'no-usable-identity': 'no usable name/ID',
  'bad-id-checksum': 'ID number fails its check digit',
  'unmapped-age-group': 'age group not recognised',
  'missing-surname': 'no surname',
};

interface ReviewRow extends ChairRosterParseRow {
  sheet: string;
}

/** What committing this parsed row will do — the review table's last column. */
export function conflictLabel(row: ChairRosterParseRow): ReactNode {
  const c = row.conflict;
  if (!c) return <Pill tone="teal">New registration</Pill>;
  if (c.type === 'in-club-duplicate') return <Pill tone="muted">Already on your roster</Pill>;
  if (c.status === 'clearance-pending')
    return (
      <Pill tone="gold" dot>
        Transfer already in progress ({c.clubName})
      </Pill>
    );
  return (
    <Pill tone="gold" dot>
      Will open a clearance from {c.clubName}
    </Pill>
  );
}

/** Split a list into fixed-size chunks (the commit route takes at most 50 items). */
export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function ClubRosterUpload({
  club,
  leagues,
  toast,
  onDone,
  onCancel,
}: {
  club: ClubLike;
  leagues: LeagueLike[];
  toast?: Toast;
  onDone: () => void;
  onCancel: () => void;
}) {
  const invalidate = useInvalidateRoster(club.id);
  const leagueLabel = labelByKey(leagues as never[]);
  const [file, setFile] = useState<File | null>(null);
  const [parse, setParse] = useState<ChairRosterParseResponse | null>(null);
  const [ageGroupMap, setAgeGroupMap] = useState<Record<string, string>>({});
  const [decisions, setDecisions] = useState<RosterDecisions>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Commit progress: chunks done of total, results so far, and whether we stopped early.
  const [committing, setCommitting] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<ChairBulkResult[] | null>(null);
  const [remaining, setRemaining] = useState<ChairRosterCommitItem[][]>([]);

  const rows: ReviewRow[] = useMemo(
    () =>
      (parse?.sheets ?? []).flatMap((s) =>
        s.skipped ? [] : s.rows.map((r) => ({ ...r, sheet: s.name })),
      ),
    [parse],
  );
  const keyOf = (r: { sheet: string; rowNumber: number }) =>
    rosterRowKey(club.id, r.sheet, r.rowNumber);
  const summary = parse
    ? buildClubSummaries([
        { clubId: club.id, clubName: club.name, parse: parse as never, allowMissingId: false },
      ])[0]
    : null;
  const counts = committableCounts(
    rows.map((r) => ({ clubId: club.id, sheet: r.sheet, rowNumber: r.rowNumber })),
    decisions,
    [],
  );
  const unmapped = (parse?.ageGroupRaws ?? []).filter((a) => a.leagueKey === null);

  async function runParse(map: Record<string, string>) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const res = await parseClubRoster(club.id, file, map);
      // Rows already on this roster are excluded by default — committing them would only
      // come back as "skipped", so the count on the button stays honest.
      const initial: RosterDecisions = {};
      for (const s of res.sheets)
        for (const r of s.rows)
          if (r.conflict?.type === 'in-club-duplicate')
            initial[rosterRowKey(club.id, s.name, r.rowNumber)] = 'exclude';
      setDecisions(initial);
      setParse(res);
    } catch (err) {
      setError(errorText(err, 'Could not read that workbook.'));
    } finally {
      setBusy(false);
    }
  }

  function pickFile(e: { target: { files?: FileList | null; value: string } }) {
    const f = e.target.files?.[0];
    setError('');
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) {
      setError('Upload an .xlsx workbook — save older .xls files as .xlsx first.');
      e.target.value = '';
      return;
    }
    if (f.size > MAX_ROSTER_BYTES) {
      setError('The workbook must be under 2 MB.');
      e.target.value = '';
      return;
    }
    setFile(f);
    setParse(null);
    setAgeGroupMap({});
  }

  /**
   * Send `chunks` one after another, appending to `prior`. `doneBefore`/`total` are chunk counts
   * for the progress bar (a retry resumes mid-way, so they include the chunks already sent).
   */
  async function runCommit(
    chunks: ChairRosterCommitItem[][],
    prior: ChairBulkResult[],
    doneBefore: number,
    total: number,
  ) {
    setBusy(true);
    setError('');
    let acc = prior;
    for (let i = 0; i < chunks.length; i++) {
      setCommitting({ done: doneBefore + i, total });
      try {
        // Sequential on purpose: a dropped connection loses at most one chunk, and the
        // server's re-commit is idempotent, so "Retry" just resumes from here.
        // eslint-disable-next-line no-await-in-loop
        const res = await commitClubRoster(club.id, chunks[i]);
        acc = [...acc, ...res.results];
        setResults(acc);
      } catch (err) {
        setRemaining(chunks.slice(i));
        setError(
          `${errorText(err, 'The upload stopped.')} — ${acc.length} row${
            acc.length === 1 ? '' : 's'
          } saved so far. Retry to send the rest.`,
        );
        setBusy(false);
        invalidate();
        return;
      }
    }
    setCommitting({ done: total, total });
    setRemaining([]);
    setBusy(false);
    invalidate();
    toast?.(summaryLine(acc), acc.some((r) => r.outcome === 'error') ? 'warn' : 'ok');
  }

  function startCommit() {
    const items: ChairRosterCommitItem[] = rows
      .filter((r) => (decisions[keyOf(r)] ?? 'include') === 'include' && r.idNumber)
      .map((r) => ({
        rowNumber: r.rowNumber,
        sheet: r.sheet,
        firstName: r.firstName,
        lastName: r.lastName,
        dob: r.dob,
        idNumber: r.idNumber!,
        ...(r.gender ? { gender: r.gender } : {}),
        ...(r.race ? { race: r.race } : {}),
        ...(r.team ? { team: r.team } : {}),
      }));
    if (!items.length) return;
    const chunks = chunk(items, CHAIR_ROSTER_COMMIT_MAX_ROWS);
    setResults([]);
    void runCommit(chunks, [], 0, chunks.length);
  }

  // ── Done / committing ──
  if (results && committing) {
    const finished = !busy && remaining.length === 0;
    const pct = committing.total ? Math.round((committing.done / committing.total) * 100) : 0;
    const errors = results.filter((r) => r.outcome === 'error');
    const clearances = results.filter((r) => r.outcome === 'clearance-opened');
    return (
      <div className="rp-form">
        {!finished && (
          <div role="status" style={{ marginBottom: 12 }}>
            <div className="rost-sub">
              {busy ? 'Registering players…' : 'Upload paused'} — {results.length} row
              {results.length === 1 ? '' : 's'} saved
            </div>
            <div
              style={{
                height: 8,
                background: 'var(--paper2)',
                borderRadius: 4,
                overflow: 'hidden',
                marginTop: 6,
              }}
            >
              <div
                aria-label="Upload progress"
                style={{ width: `${pct}%`, height: '100%', background: 'var(--teal)' }}
              />
            </div>
          </div>
        )}
        {finished && (
          <div className="rp-section">
            <div className="rp-section-head">
              <div className="rp-section-eyebrow">Upload complete</div>
              <div className="rp-section-title">{summaryLine(results)}</div>
            </div>
            {clearances.length > 0 && (
              <p className="ph-desc">
                Players with a clearance opened appear on your roster as clearance pending until
                their previous club (or the union office) approves the move.
              </p>
            )}
          </div>
        )}
        {(errors.length > 0 || clearances.length > 0) && (
          <div className="tbl-w" style={{ marginTop: 10 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Sheet · row</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {[...errors, ...clearances].map((r) => (
                  <tr key={`${r.sheet}:${r.rowNumber}:${r.index}`}>
                    <td>
                      <span className="rost-sub">
                        {r.sheet || '—'} · row {r.rowNumber ?? '—'}
                      </span>
                    </td>
                    <td>
                      <BulkOutcomePill result={r} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && (
          <div className="field-error" role="alert" style={{ marginTop: 6 }}>
            {error}
          </div>
        )}
        <div className="rp-actions">
          {!finished && !busy && (
            <Btn
              tone="teal"
              onClick={() => runCommit(remaining, results, committing.done, committing.total)}
            >
              Retry the rest
            </Btn>
          )}
          <Btn tone={finished ? 'teal' : 'outline'} disabled={busy} onClick={onDone}>
            {finished ? 'Done' : 'Close'}
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <div className="rp-form">
      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">Step 1</div>
          <div className="rp-section-title">Fill in the template</div>
        </div>
        <p className="ph-desc" style={{ marginBottom: 8 }}>
          One row per player: first name, surname, RSA ID number, date of birth, gender, race and
          age group (leave age group blank for senior players). Rows without a valid RSA ID are
          listed as exceptions and aren’t registered.
        </p>
        <a className="btn btn-outline btn-sm" href="/roster-template.xlsx" download>
          <Icon.Download />
          Download template
        </a>
      </div>
      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">Step 2</div>
          <div className="rp-section-title">Upload it</div>
        </div>
        <input
          type="file"
          aria-label="Roster workbook"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={pickFile}
        />
        <div style={{ marginTop: 8 }}>
          <Btn
            tone="teal"
            size="sm"
            icon={Icon.Upload}
            disabled={!file || busy}
            onClick={() => runParse(ageGroupMap)}
          >
            {busy && !parse ? 'Reading…' : parse ? 'Read again' : 'Read workbook'}
          </Btn>
        </div>
      </div>

      {parse && summary && (
        <div className="rp-section">
          <div className="rp-section-head">
            <div className="rp-section-eyebrow">Step 3</div>
            <div className="rp-section-title">Review</div>
          </div>
          <p className="ph-desc" style={{ marginBottom: 8 }}>
            {summary.validRowCount} player row{summary.validRowCount === 1 ? '' : 's'} found
            {summary.totalExceptions > 0
              ? ` · ${summary.totalExceptions} row${summary.totalExceptions === 1 ? '' : 's'} can’t be registered (${Object.entries(
                  summary.exceptionsByReason,
                )
                  .map(([reason, n]) => `${n} ${EXCEPTION_LABEL[reason] || reason}`)
                  .join(', ')})`
              : ''}
            .
          </p>
          {unmapped.length > 0 && (
            <div
              style={{
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: '10px 12px',
                marginBottom: 10,
              }}
            >
              <div className="rost-sub" style={{ marginBottom: 6 }}>
                These age groups weren’t recognised — pick the team each one means, then read the
                workbook again:
              </div>
              {unmapped.map((a) => (
                <div
                  key={a.raw}
                  style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}
                >
                  <span style={{ minWidth: 120, fontWeight: 600 }}>{a.raw}</span>
                  <select
                    className="field-select"
                    aria-label={`Team for age group ${a.raw}`}
                    value={ageGroupMap[a.raw] ?? ''}
                    onChange={(e) => setAgeGroupMap((m) => ({ ...m, [a.raw]: e.target.value }))}
                  >
                    <option value="">—</option>
                    {parse.juniorLeagueKeys.map((k) => (
                      <option key={k} value={k}>
                        {leagueLabel[k] || k}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <Btn
                tone="outline"
                size="sm"
                disabled={busy || !Object.values(ageGroupMap).some(Boolean)}
                onClick={() => runParse(ageGroupMap)}
              >
                Apply and read again
              </Btn>
            </div>
          )}
          {rows.length > 0 && (
            <div className="tbl-w">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>Add</th>
                    <th>Player</th>
                    <th>ID number</th>
                    <th>Team</th>
                    <th>What happens</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const key = keyOf(r);
                    const included = (decisions[key] ?? 'include') === 'include';
                    return (
                      <tr key={key}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Include ${r.firstName} ${r.lastName}`}
                            checked={included}
                            disabled={busy}
                            onChange={(e) =>
                              setDecisions((s) =>
                                applyRosterDecision(s, {
                                  type: e.target.checked ? 'include' : 'exclude',
                                  key,
                                }),
                              )
                            }
                          />
                        </td>
                        <td>
                          <div className="rost-name">
                            {r.firstName} {r.lastName}
                          </div>
                          <div className="rost-sub">
                            {r.sheet} · row {r.rowNumber}
                            {r.gender ? ` · ${r.gender}` : ''}
                          </div>
                        </td>
                        <td>
                          <span className="rost-id">{r.idNumber || '—'}</span>
                        </td>
                        <td>
                          {r.team ? (
                            <Pill tone="navy">{leagueLabel[r.team] || r.team}</Pill>
                          ) : (
                            <span className="rost-sub">—</span>
                          )}
                        </td>
                        <td>{conflictLabel(r)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="field-error" role="alert" style={{ marginTop: 6 }}>
          {error}
        </div>
      )}
      <div className="rp-actions">
        <Btn tone="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Btn>
        <Btn
          tone="teal"
          icon={Icon.Check}
          disabled={busy || !parse || counts.includedRows === 0}
          onClick={startCommit}
        >
          Register {counts.includedRows} player{counts.includedRows === 1 ? '' : 's'}
        </Btn>
      </div>
    </div>
  );
}

/** Which chair registration surface is open on the Players page. */
export type RegisterMode = 'single' | 'quick' | 'upload';

/** The modal title for each mode — kept beside the components it introduces. */
export const REGISTER_MODE_TITLE: Record<RegisterMode, ReactNode> = {
  single: (
    <>
      Register a <em>player</em>
    </>
  ),
  quick: (
    <>
      Quick-add <em>players</em>
    </>
  ),
  upload: (
    <>
      Upload a <em>roster</em>
    </>
  ),
};
