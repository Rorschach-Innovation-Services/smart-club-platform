/**
 * Audit trail display text (ADR 0023; contract: docs/api/audit.md).
 *
 * Pure functions from an `AuditEntry` / `AuditChange` to the words the Activity page and the
 * History modal show: who did it, a sentence for what they did, which record, when, and each
 * field's before → after. No React here, so every rule is unit-tested directly.
 *
 * Action names come from the API's route registry (`packages/api/src/audit-routes.ts`) plus a
 * few a handler sets itself. A name not listed here still reads sensibly: the dotted name is
 * turned into "Verb record" (`umpire.update` → "Edited umpire").
 */
import { formatStamp, timeAgo } from './dates';
import type { AuditActor, AuditChange, AuditEntry, AuditTargetHead, AuditValue } from './types';

/* ─── Record types ─── */

/** Singular display name per record type (the API's AUDIT_ENTITY_TYPES). */
const AUDIT_TYPE_LABELS: Record<string, string> = {
  club: 'Club',
  player: 'Player',
  clearance: 'Clearance',
  'registration-review': 'Registration review',
  'club-invite': 'Club invite',
  'veterans-affiliation': 'Veterans club',
  'veterans-request': 'Veterans request',
  postponement: 'Postponement',
  series: 'Series',
  fixture: 'Fixture',
  'season-run': 'Season',
  'fixture-result': 'Result',
  scorecard: 'Scorecard',
  'fixture-officials': 'Fixture officials',
  'captains-report': "Captain's report",
  'squad-request': 'Squad request',
  'doc-request': 'Document request',
  umpire: 'Umpire',
  scorer: 'Scorer',
  user: 'Team member',
  'tenant-config': 'Settings',
  venue: 'Venue',
  competition: 'Competition',
  'signup-link': 'Registration link',
  tenant: 'Client',
};

/** Record types an admin can filter by, in display order. */
export const AUDIT_FILTER_TYPES = Object.keys(AUDIT_TYPE_LABELS)
  .filter((t) => t !== 'tenant')
  .sort((a, b) => AUDIT_TYPE_LABELS[a].localeCompare(AUDIT_TYPE_LABELS[b]));

/** `fixture-officials` → "Fixture officials"; unknown types are humanised from the slug. */
export function auditTypeLabel(type: string): string {
  return AUDIT_TYPE_LABELS[type] ?? sentenceCase(type.replace(/[-_.]+/g, ' '));
}

/* ─── Actor ─── */

const RECIPIENT_LABELS: Record<string, string> = {
  captain: 'Captain',
  chair: 'Club chair',
  player: 'Player',
};

/** How each public link kind is named after "via". */
const LINK_LABELS: Record<string, string> = {
  'captains-report': "captain's report link",
  squad: 'squad link',
  'doc-request': 'document request link',
  'player-registration': 'registration link',
  'club-signup': 'registration link',
  'official-signup': 'registration link',
};

/** Shown in place of a person for each self-registration link (no named person). */
const SHARED_LINK_LABELS: Record<string, string> = {
  'player-registration': 'Player',
  'club-signup': 'Club',
  'official-signup': 'Official',
};

export interface ActorDisplay {
  /** The main line: an email, "Captain via captain's report link", "System". */
  label: string;
  /** Held the platform operator membership when they made the change. */
  operator: boolean;
  /** A second, quieter line (e.g. "Operator portal"); absent when nothing adds to it. */
  detail?: string;
}

/** Who made the change, as the feed shows it. */
export function auditActorDisplay(actor: AuditActor | undefined): ActorDisplay {
  if (!actor || actor.kind === 'system')
    return { label: 'System', operator: false, detail: 'Not made by a person' };
  if (actor.kind === 'link') {
    const via = LINK_LABELS[actor.via] ?? `${actor.via.replace(/[-_]+/g, ' ')} link`;
    const who = actor.recipientKind
      ? (RECIPIENT_LABELS[actor.recipientKind] ?? sentenceCase(actor.recipientKind))
      : (SHARED_LINK_LABELS[actor.via] ?? 'Someone');
    return { label: `${who} via ${via}`, operator: false };
  }
  return {
    label: actor.email || 'Unknown person',
    operator: !!actor.operator,
    ...(actor.via === 'platform' ? { detail: 'Operator portal' } : {}),
  };
}

/* ─── Action sentence ─── */

/** Every registry action, as a short past-tense sentence without the record's name. */
export const AUDIT_ACTION_SENTENCES: Readonly<Record<string, string>> = {
  // Public links
  'player.register': 'Registered a player',
  'official.signup': 'Registered as an official',
  'club.signup': 'Registered a club',
  // Clubs, players, rosters
  'club.update': 'Edited club',
  'club.delete': 'Deleted club',
  'club.create': 'Added club',
  'club.exco.update': 'Edited club committee',
  'club.doc.update': 'Updated a club document',
  'club.doc.delete-file': 'Removed a club document file',
  'club.note.add': 'Added a note',
  'club.team-captain.set': 'Set a team captain',
  'player.create': 'Added a player',
  'player.batch-create': 'Added players',
  'roster.commit': 'Uploaded a roster',
  'player.id-doc.update': 'Updated an ID document',
  'player.remove': 'Removed a player from the roster',
  'player.erase': "Erased a player's data",
  'veterans-affiliation.set': 'Set the veterans club',
  'veterans-affiliation.remove': 'Removed the veterans club',
  'veterans-request.create': 'Asked for a veterans player',
  'veterans-request.accept': 'Accepted a veterans request',
  'veterans-request.decline': 'Declined a veterans request',
  'veterans-request.withdraw': 'Withdrew a veterans request',
  // Clearances and reviews
  'clearance.create': 'Opened a clearance',
  'clearance.update': 'Answered a clearance',
  'clearance.override': 'Overrode a clearance',
  'clearance.reassign': 'Reassigned a clearance',
  'clearance.reject': 'Rejected a clearance',
  'clearance.reopen': 'Reopened a clearance',
  'clearance.remind': 'Sent a clearance reminder',
  'clearance.certificate.issue': 'Issued a clearance certificate',
  'clearance.certificate.revoke': 'Revoked a clearance certificate',
  'registration-review.ack': 'Acknowledged a registration review',
  // Series, fixtures, competitions, seasons, venues
  'series.create': 'Added series',
  'series.patch': 'Edited series',
  // A generic series PATCH, classified by what it did
  'series.update': 'Edited series',
  'series.fixtures.edit': 'Edited fixtures',
  'series.approve': 'Approved fixtures',
  'series.unapprove': 'Withdrew fixture approval',
  'series.release': 'Released fixtures to clubs',
  'series.recall': 'Recalled fixtures to draft',
  'series.reveal': 'Revealed withheld venues or times',
  'series.set-side': 'Set a knockout team',
  'series.delete': 'Deleted series',
  'series.duplicate': 'Duplicated series',
  'fixture-officials.set': 'Set fixture officials',
  'fixture-result.confirm': 'Confirmed a result',
  'fixture-result.unconfirm': 'Reopened a result',
  'competition.create': 'Added competition',
  'competition.update': 'Edited competition',
  'competition.regenerate': 'Regenerated competition fixtures',
  'competition.delete': 'Deleted competition',
  'competition.advance': 'Advanced competition',
  'season-run.create': 'Started a season',
  'season-run.update': 'Edited season',
  'season-run.generate': 'Generated stage fixtures',
  'season-run.rebase': 'Moved season dates',
  'season-run.delete': 'Deleted season',
  'venue.save': 'Saved venue',
  'venue.delete': 'Deleted venue',
  'fixture-amendments.confirm': 'Applied fixture amendments',
  // Postponements
  'postponement.create': 'Asked for a postponement',
  'postponement.counter': 'Proposed another date',
  'postponement.accept': 'Accepted a postponement',
  'postponement.withdraw': 'Withdrew a postponement',
  'postponement.decline': 'Declined a postponement',
  'postponement.acknowledge': 'Acknowledged a postponement ruling',
  'postponement.override': 'Ruled on a postponement',
  // Match Centre
  'medicoach.sync-trigger': 'Started a Match Centre sync',
  'medicoach.conflicts.apply': 'Applied Match Centre changes',
  'medicoach.conflicts.discard': 'Discarded Match Centre changes',
  'medicoach.outbox.retry': 'Retried Match Centre updates',
  'medicoach.outbox.drop': 'Dropped Match Centre updates',
  'medicoach.players.retry': 'Retried Match Centre players',
  'medicoach.player-review.resolve': 'Resolved a Match Centre player',
  'medicoach.reconcile': 'Reconciled with Match Centre',
  // Officials
  'umpire.create': 'Added umpire',
  'umpire.update': 'Edited umpire',
  'umpire.approve': 'Approved umpire',
  'umpire.merge': 'Merged umpire',
  'umpire.delete': 'Deleted umpire',
  'umpire.appointments.confirm': 'Uploaded umpire appointments',
  'scorer.create': 'Added scorer',
  'scorer.update': 'Edited scorer',
  'scorer.approve': 'Approved scorer',
  'scorer.merge': 'Merged scorer',
  'scorer.delete': 'Deleted scorer',
  // Captain's reports, squads, document requests
  'captains-report.create': "Started a captain's report",
  'captains-report.create-unlisted': "Started a captain's report for an unlisted match",
  'captains-report.save': "Saved a captain's report",
  'captains-report.forward': "Passed on a captain's report",
  'captains-report.attribute-umpire': 'Matched an umpire on a report',
  'squad-request.save': 'Saved a squad',
  'squad-request.forward': 'Passed on a squad request',
  'squad-request.resend': 'Resent a squad request',
  'squad-request.void': 'Cancelled a squad request',
  'doc-request.send': 'Sent a document request',
  'doc-request.complete': 'Uploaded a requested document',
  'message.send-fixtures': 'Sent fixtures to a club',
  // Settings, team, clients
  'tenant-config.update': 'Changed settings',
  'tenant-config.support.update': 'Changed the support contact',
  'tenant.create': 'Created client',
  'tenant.update': 'Changed client settings',
  'tenant.setup-complete': 'Marked setup complete',
  'tenant.setup-reopen': 'Reopened setup',
  'tutorial.upload': 'Uploaded a tutorial video',
  'doc-intake.commit': 'Imported club documents',
  'roster-intake.commit': 'Imported rosters',
  'structure-intake.commit': 'Imported team entries',
  'user.invite': 'Invited a team member',
  'user.invite-admin': 'Invited an admin',
  'user.invite-rep': 'Invited a club rep',
  'user.invite-resend': 'Resent an invite',
  'user.update': "Changed a team member's access",
  'user.delete': "Removed a team member's access",
  'user.email-change': "Corrected a team member's email",
};

/** Verbs for the generic fallback, keyed on the last segment of the action. */
const VERBS: Record<string, string> = {
  create: 'Added',
  add: 'Added',
  update: 'Edited',
  patch: 'Edited',
  edit: 'Edited',
  save: 'Saved',
  set: 'Set',
  delete: 'Deleted',
  remove: 'Removed',
  approve: 'Approved',
  merge: 'Merged',
  erase: 'Erased',
  confirm: 'Confirmed',
  send: 'Sent',
  resend: 'Resent',
  accept: 'Accepted',
  decline: 'Declined',
  reject: 'Rejected',
  withdraw: 'Withdrew',
  reopen: 'Reopened',
  revoke: 'Revoked',
  copy: 'Copied',
  mint: 'Created',
  submit: 'Submitted',
  upload: 'Uploaded',
  import: 'Imported',
  commit: 'Saved',
};

/** `link.copy` / `link.mint` / `link.revoke` read differently per link. */
function linkSentence(entry: Pick<AuditEntry, 'action' | 'targets'>): string | null {
  const verb = entry.action.split('.')[1];
  const t = entry.targets?.[0];
  const what =
    t?.type === 'captains-report'
      ? "the captain's report link"
      : t?.type === 'squad-request'
        ? 'the squad link'
        : t?.type === 'signup-link'
          ? t.id === 'club'
            ? 'the club registration link'
            : `the ${t.id} registration link`
          : t?.type === 'club'
            ? 'a player registration link'
            : entry.action === 'link.copy'
              ? 'a document request link'
              : 'a link';
  if (verb === 'copy') return `Copied ${what}`;
  if (verb === 'mint') return `Created ${what}`;
  if (verb === 'revoke') return `Turned off ${what}`;
  return null;
}

/** "Edited umpire", "Copied the squad link", … — never names the record (the row does). */
export function auditActionSentence(entry: Pick<AuditEntry, 'action' | 'targets'>): string {
  const action = entry.action ?? '';
  if (action.startsWith('link.')) {
    const s = linkSentence(entry);
    if (s) return s;
  }
  // A save that submitted reads as a submission (the target's op says so).
  if (entry.targets?.some((t) => t.op === 'submit')) {
    if (action === 'captains-report.save') return "Submitted a captain's report";
    if (action === 'squad-request.save') return 'Submitted a squad';
  }
  const known = AUDIT_ACTION_SENTENCES[action];
  if (known) return known;
  return fallbackSentence(action);
}

/** `umpire.update` → "Edited umpire"; `club.widget.frobnicate` → "Frobnicate club widget". */
export function fallbackSentence(action: string): string {
  const parts = action.split('.').filter(Boolean);
  if (parts.length === 0) return 'Made a change';
  if (parts.length === 1) return sentenceCase(parts[0].replace(/[-_]+/g, ' '));
  const verb = parts[parts.length - 1];
  const noun = parts.slice(0, -1).join(' ').replace(/[-_]+/g, ' ').toLowerCase();
  const past = VERBS[verb];
  return past ? `${past} ${noun}` : `${sentenceCase(verb.replace(/[-_]+/g, ' '))} ${noun}`;
}

/* ─── Outcome and counts ─── */

/**
 * How long a long change's "started" headline reads as still running. A started row older
 * than this was never replaced by its final entry (e.g. the request timed out).
 */
const AUDIT_IN_PROGRESS_MS = 60_000;

/** A started entry younger than {@link AUDIT_IN_PROGRESS_MS}: the change may still be running. */
export function auditInProgress(
  entry: Pick<AuditEntry, 'outcome' | 'at'>,
  now: number = Date.now(),
): boolean {
  return entry.outcome === 'started' && now - Date.parse(entry.at) < AUDIT_IN_PROGRESS_MS;
}

/** A word for an entry that did not simply succeed; null for a plain success. */
export function auditOutcomeLabel(
  entry: Pick<AuditEntry, 'outcome' | 'at'>,
  now: number = Date.now(),
): string | null {
  if (entry.outcome === 'failed') return 'Failed';
  if (entry.outcome === 'started')
    return auditInProgress(entry, now) ? 'In progress' : 'Did not finish';
  return null;
}

/**
 * `{ sent: 12, failed: 1 }` → "12 sent, 1 failed"; `fixturesChanged` reads "fixtures changed";
 * zero counts are left out.
 */
export function auditCountsText(counts?: Record<string, number>): string {
  if (!counts) return '';
  return Object.entries(counts)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .map(([k, n]) => `${n} ${splitWords(k)}`)
    .join(', ');
}

/* ─── Records ─── */

/**
 * Looks a record up by type and id when the entry carries no label (a team member's sub →
 * their email, a club id → its name). Returns undefined when it does not know the record.
 */
export type AuditLabelResolver = (type: string, id: string) => string | undefined;

/** The record's name: its label, else a lookup, else a readable id; "Removed" once erased. */
export function auditTargetLabel(
  target: Pick<AuditTargetHead, 'type' | 'id' | 'label' | 'scrubbed'>,
  resolve?: AuditLabelResolver,
): string {
  if (target.scrubbed || !target.id) return target.label || 'Removed';
  if (target.label) return target.label;
  const looked = resolve?.(target.type, target.id);
  if (looked) return looked;
  return readableId(target.id);
}

/**
 * The headline target each detail target belongs to, by position: the detail lists the targets
 * that recorded changes, in headline order, so the k-th detail target is the k-th headline
 * target with a `changeCount`. An erasure can blank several ids of one type, so a type + id join
 * would give every one of them the first one's head. A position whose type or id disagrees
 * falls back to the first head with that type and id. Mirrors the API's `auditDetailHeads`.
 */
export function auditDetailHeads(
  heads: readonly AuditTargetHead[],
  details: ReadonlyArray<{ type: string; id: string }>,
): Array<AuditTargetHead | undefined> {
  const withChanges = heads.filter((h) => (h.changeCount ?? 0) > 0);
  return details.map((d, k) => {
    const h = withChanges[k];
    if (h && h.type === d.type && h.id === d.id) return h;
    return heads.find((x) => x.type === d.type && x.id === d.id);
  });
}

/** `s1#f1` → "s1 · f1"; `a.ngubane` stays; very long ids are shortened. */
function readableId(id: string): string {
  const s = id.split('#').join(' · ');
  return s.length > 40 ? `${s.slice(0, 37)}…` : s;
}

/** "Umpire · A.Ngubane" for the Record column. */
export function auditTargetLine(target: AuditTargetHead, resolve?: AuditLabelResolver): string {
  return `${auditTypeLabel(target.type)} · ${auditTargetLabel(target, resolve)}`;
}

/* ─── Time ─── */

/** Relative ("2h ago") and absolute ("12 Nov 2026, 14:32") forms of an entry's instant. */
export function auditWhen(
  at: string,
  now: number = Date.now(),
): { relative: string; absolute: string } {
  return { relative: timeAgo(at, now), absolute: formatStamp(at) };
}

/* ─── Field changes ─── */

/** Names the API uses for fields, as people say them. */
export const AUDIT_FIELD_LABELS: Readonly<Record<string, string>> = {
  displayName: 'Name',
  fullName: 'Full name',
  firstName: 'First name',
  lastName: 'Last name',
  name: 'Name',
  phone: 'Phone',
  cell: 'Cell',
  email: 'Email',
  active: 'Active',
  pending: 'Awaiting review',
  mergedInto: 'Merged into',
  aliases: 'Other spellings',
  idNumber: 'ID number',
  passportNumber: 'Passport number',
  dob: 'Date of birth',
  dateOfBirth: 'Date of birth',
  address: 'Address',
  clubIds: 'Clubs',
  clubId: 'Club',
  role: 'Role',
  status: 'Status',
  chair: 'Chair',
  exco: 'Committee',
  leagues: 'Leagues',
  leagueTeams: 'Teams per league',
  district: 'District',
  sub: 'Suburb',
  released: 'Released',
  approved: 'Approved',
  date: 'Date',
  time: 'Time',
  venue: 'Venue',
  home: 'Home',
  away: 'Away',
  umpires: 'Umpires',
  scorers: 'Scorers',
  team: 'Team',
  notes: 'Notes',
  submissionDeadline: 'Submission deadline',
  support: 'Support contact',
  branding: 'Branding',
  features: 'Features',
  // Team & access
  note: 'Note',
  // Tenant settings
  title: 'Title',
  logoUrl: 'Logo',
  faviconUrl: 'Browser icon',
  colors: 'Colours',
  copy: 'Wording',
  sport: 'Sport',
  seasonLabel: 'Season label',
  districts: 'Districts',
  knownClubs: 'Club directory',
  calendars: 'Season calendars',
  structures: 'Competition structures',
  requiredDocs: 'Required documents',
  tutorials: 'Tutorial videos',
  tutorialsNoFallback: 'No default tutorials',
  transferWindows: 'Transfer windows',
  fixtureReminders: 'Fixture reminders',
  captainsReportsExcludedSeriesPrefixes: "Series excluded from captain's reports",
  officialsContactLine: 'Officials contact line',
  scorecardCorrectionRecipients: 'Scorecard correction recipients',
  orgContact: 'Organisation contact',
  clearanceCertTemplate: 'Clearance certificate layout',
  integrations: 'Integrations',
  competitionDefaults: 'Competition defaults',
  setupCompletedAt: 'Setup completed',
  setupCompletedBy: 'Setup completed by',
  // Clubs
  affiliation: 'Affiliation',
  cqi: 'CQI score',
  cqiAnswers: 'CQI answers',
  teams: 'Teams',
  women: "Women's teams",
  juniors: 'Junior teams',
  color: 'Colour',
  teamRosters: 'Named teams',
  coaches: 'Coaches',
  remindersOptIn: 'Receives fixture reminders',
  amendmentPending: 'Amendment awaiting review',
  nameChangePending: 'Rename awaiting review',
  previousName: 'Previous name',
  playerRegLink: 'Player registration link',
  ground: 'Ground',
  secondaryVenue: 'Second venue',
  pitchCount: 'Pitches',
  sec: 'Secretary',
  tre: 'Treasurer',
  termStart: 'Term start',
  termEnd: 'Term end',
  // Club documents
  docs: 'Documents',
  docMeta: 'Document',
  fileCount: 'Files',
  files: 'Stored files',
  objectKey: 'Stored file',
  size: 'File size',
  contentType: 'File type',
  uploadedAt: 'Uploaded',
  uploadedByRole: 'Uploaded by',
  markedCompliant: 'Marked compliant',
  courseBooked: 'Course booked',
  courseDate: 'Course date',
  meetingBooked: 'Meeting booked',
  meetingDate: 'Meeting date',
  expiry: 'Expiry',
  expiryDate: 'Expiry date',
  expiresAt: 'Expires',
  unavailable: 'Declared unavailable',
  at: 'Recorded',
  // Players and registration
  position: 'Position',
  battingHand: 'Batting hand',
  bowlingHand: 'Bowling hand',
  battingType: 'Batting style',
  bowlerType: 'Bowling style',
  isAllRounder: 'All-rounder',
  isWk: 'Wicketkeeper',
  registeredVia: 'Registered through',
  veteransClub: 'Veterans club',
  isMinor: 'Minor',
  nationality: 'Nationality',
  gender: 'Gender',
  race: 'Race',
  guardianName: 'Guardian',
  postalAddress: 'Postal address',
  postalCode: 'Postal code',
  lastClub: 'Previous club',
  transferNote: 'Transfer note',
  clearanceRejectedReason: 'Clearance rejection reason',
  idDocMeta: 'ID document',
  previousIdDocMeta: 'Previous ID document',
  // Clearances, veterans requests, registration reviews
  fromClub: 'From club',
  toClub: 'To club',
  origin: 'Started by',
  feesCleared: 'Fees cleared',
  misconductCleared: 'Misconduct cleared',
  rejectOutcome: 'Outcome of the rejection',
  certificateDeclined: 'No certificate',
  certificate: 'Certificate',
  certificateStatus: 'Certificate status',
  rejectReason: 'Rejection reason',
  overrideReason: 'Override reason',
  reason: 'Reason',
  primaryClub: "Player's club",
  leagueKey: 'League',
  declineReason: 'Decline reason',
  kind: 'Kind',
  resolution: 'Resolution',
  destClub: 'Registering club',
  typedPreviousClub: 'Previous club (typed)',
  previousClub: 'Previous club',
  // Series and fixtures
  startDate: 'Start date',
  endDate: 'End date',
  dateMode: 'Date spacing',
  activateFrom: 'Visible to clubs from',
  seriesType: 'Format',
  maxOvers: 'Overs',
  schedule: 'Schedule',
  seasonRunId: 'Season',
  stageSpecId: 'Stage',
  groupId: 'Group',
  withheld: 'Withheld from clubs',
  slot: 'Slot',
  round: 'Round',
  venueOverride: 'Venue (typed)',
  venueStatus: 'Venue status',
  originalDate: 'Original date',
  dateTbc: 'Date to be confirmed',
  homeScore: 'Home score',
  awayScore: 'Away score',
  winner: 'Winner',
  confirmed: 'Confirmed',
  recordedAt: 'Result recorded',
  // Competitions
  type: 'Type',
  overs: 'Overs',
  format: 'Format',
  points: 'Points',
  seed: 'Draw seed',
  // Season runs
  calendarFrozenAt: 'Calendar fixed',
  structure: 'Structure',
  calendar: 'Calendar',
  stages: 'Stages',
  groups: 'Groups',
  pairingOverride: 'Knockout pairing',
  staleSchedule: 'Needs regenerating',
  formatChanged: 'Format changed',
  carriedPoints: 'Carried points',
  // Venues
  suburb: 'Suburb',
  lat: 'Latitude',
  lon: 'Longitude',
  homeClubIds: 'Home clubs',
  surfaces: 'Matches a day',
  unavailableWeekdays: 'Unavailable weekdays',
  // Postponements
  awaiting: 'Whose turn',
  requestingClub: 'Asked by',
  opposingClub: 'Other club',
  originalTime: 'Original time',
  proposedDate: 'Proposed date',
  proposedTime: 'Proposed time',
  proposedVenue: 'Proposed venue',
  proposedBy: 'Proposed by',
  proposals: 'Proposals',
  agreedDate: 'Agreed date',
  acknowledged: 'Acknowledged',
  // Captain's reports
  submittedVia: 'Submitted through',
  ref: 'Report number',
  declaration: 'Declaration',
  scorecard: 'Scorecard answer',
  scorecardFeedback: 'Scorecard feedback',
  recipientKind: 'Sent to',
  recipient: 'Recipient',
  recipientContact: 'Recipient contact',
  forwardCount: 'Times passed on',
  captainName: 'Captain',
  general: 'General comments',
  umpire: 'Umpire',
  substitute: 'Different umpire stood',
  ratings: 'Ratings',
  concerns: 'Concerns',
  otherConcern: 'Other concern',
  comments: 'Comments',
  attribution: 'Matched in the register',
  // Squads and team captains
  selection: 'Squad',
  players: 'Players',
  player: 'Player',
  guests: 'Guests',
  captain: 'Captain',
  voidReason: 'Cancelled because',
  // Document requests
  document: 'Document',
  // Match Centre console
  medicoach: 'Match Centre',
  conflict: 'Held change',
  conflictRef: 'Held change ref',
  outbox: 'Queued update',
  outboxRef: 'Queued update ref',
  review: 'Player review',
  playerId: 'Match Centre player',
  candidatesAcknowledged: 'Candidates shown',
};

/** A captain's report umpire card: `umpires.2.ratings` → "Umpire 2 › Ratings". */
const UMPIRE_CARD_RE = /^umpires\.(\d+)\.(\w+)$/;

/** A committee field: `exco.vc.name` → "Vice chair · name" (its value is never recorded). */
const EXCO_FIELD_RE = /^exco\.([^.]+)(?:\.(\w+))?$/;
const EXCO_ROLE_LABELS: Record<string, string> = {
  chair: 'Chair',
  sec: 'Secretary',
  tre: 'Treasurer',
  vc: 'Vice chair',
  additionalMembers: 'Other committee members',
};

/** "Name" → "name", "Term start" → "term start"; an acronym ("ID number") keeps its case. */
const lowerFirst = (s: string) =>
  /^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);

/** `displayName` → "Name", `homeGround.venue` → "Home ground › Venue", `last_seen` → "Last seen". */
export function auditFieldLabel(field: string): string {
  if (AUDIT_FIELD_LABELS[field]) return AUDIT_FIELD_LABELS[field];
  const card = UMPIRE_CARD_RE.exec(field);
  if (card) return `Umpire ${card[1]} › ${auditFieldLabel(card[2])}`;
  const exco = EXCO_FIELD_RE.exec(field);
  if (exco) {
    const role = EXCO_ROLE_LABELS[exco[1]] ?? sentenceCase(splitWords(exco[1]));
    return exco[2] ? `${role} · ${lowerFirst(auditFieldLabel(exco[2]))}` : role;
  }
  return field
    .split('.')
    .map((part) => AUDIT_FIELD_LABELS[part] ?? sentenceCase(splitWords(part)))
    .join(' › ');
}

/** One value as text: arrays joined, booleans as Yes / No, empty as "—". */
export function auditValueText(v: AuditValue | undefined): string {
  if (v === undefined || v === null || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => auditValueText(x)).join(', ') : '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

export interface ChangeRow {
  field: string;
  /** Before / after text; both absent when the row speaks as one (`note`). */
  before?: string;
  after?: string;
  /** "Changed (hidden)" for a masked field, "Removed" for an erased one. */
  note?: string;
}

/** A field change as one Before → After row. */
export function auditChangeRow(change: AuditChange): ChangeRow {
  const field = auditFieldLabel(change.field);
  if (change.scrubbed) return { field, note: 'Removed' };
  if (change.masked) return { field, note: 'Changed (hidden)' };
  return { field, before: auditValueText(change.from), after: auditValueText(change.to) };
}

/* ─── helpers ─── */

function splitWords(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase();
}

function sentenceCase(s: string): string {
  const t = s.trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}
