import { describe, it, expect } from 'vitest';
import {
  greeting,
  safeguardingMeta,
  safeguardingSatisfied,
  ageFromSaId,
  termRemaining,
  teamIdsForClub,
  resolveTeam,
  relTimeAgo,
  buildRecentActivity,
  fixtureCost,
  composeDob,
} from './data';

describe('greeting', () => {
  const at = (h) => new Date(2026, 5, 11, h, 0, 0);
  it('is morning before noon', () => {
    expect(greeting(at(0))).toBe('Good morning');
    expect(greeting(at(11))).toBe('Good morning');
  });
  it('is afternoon from noon to 17:59', () => {
    expect(greeting(at(12))).toBe('Good afternoon');
    expect(greeting(at(17))).toBe('Good afternoon');
  });
  it('is evening from 18:00', () => {
    expect(greeting(at(18))).toBe('Good evening');
    expect(greeting(at(23))).toBe('Good evening');
  });
});

describe('safeguardingMeta', () => {
  it('normalizes missing meta to an empty file list', () => {
    expect(safeguardingMeta(undefined)).toEqual({
      files: [],
      markedCompliant: false,
      courseBooked: false,
      courseDate: '',
      unavailable: false,
      at: undefined,
    });
  });

  it('normalizes a legacy single upload to a one-entry array', () => {
    const legacy = { objectKey: 't/c/safeguarding-x.pdf', size: 10, uploadedAt: '2026-01-01' };
    expect(safeguardingMeta(legacy)).toEqual({
      files: [legacy],
      markedCompliant: false,
      courseBooked: false,
      courseDate: '',
      unavailable: false,
    });
  });

  it('normalizes the legacy admin sentinel to empty files with the flag', () => {
    expect(safeguardingMeta({ markedCompliant: true, at: '2026-01-01' })).toEqual({
      files: [],
      markedCompliant: true,
      courseBooked: false,
      courseDate: '',
      unavailable: false,
      at: '2026-01-01',
    });
  });

  it('passes the canonical wrapper shape through', () => {
    const files = [{ objectKey: 'a' }, { objectKey: 'b' }];
    expect(safeguardingMeta({ files, markedCompliant: true, at: 'T' })).toEqual({
      files,
      markedCompliant: true,
      courseBooked: false,
      courseDate: '',
      unavailable: false,
      at: 'T',
    });
  });

  it('surfaces a club unavailable declaration alongside any files', () => {
    const files = [{ objectKey: 'a' }];
    expect(safeguardingMeta({ files, unavailable: true, at: 'T' })).toEqual({
      files,
      markedCompliant: false,
      courseBooked: false,
      courseDate: '',
      unavailable: true,
      at: 'T',
    });
  });

  it('surfaces a booked safeguarding course (no files yet)', () => {
    expect(safeguardingMeta({ files: [], courseBooked: true, courseDate: '2026-09-01' })).toEqual({
      files: [],
      markedCompliant: false,
      courseBooked: true,
      courseDate: '2026-09-01',
      unavailable: false,
      at: undefined,
    });
    expect(safeguardingSatisfied({ files: [], courseBooked: true, courseDate: '2026-09-01' })).toBe(
      true,
    );
  });
});

describe('safeguardingSatisfied', () => {
  it('requires the two-person minimum', () => {
    expect(safeguardingSatisfied(undefined)).toBe(false);
    expect(safeguardingSatisfied({ files: [{ objectKey: 'a' }] })).toBe(false);
    expect(safeguardingSatisfied({ files: [{ objectKey: 'a' }, { objectKey: 'b' }] })).toBe(true);
  });

  it('honours an admin override regardless of file count', () => {
    expect(safeguardingSatisfied({ files: [], markedCompliant: true })).toBe(true);
  });
});

describe('ageFromSaId', () => {
  it('derives a whole-year age from a valid RSA ID', () => {
    // 900101… → born 1990-01-01. Age is at least 30 from any date after 2020.
    const age = ageFromSaId('9001015800086');
    expect(typeof age).toBe('number');
    expect(age).toBeGreaterThanOrEqual(30);
  });

  it('returns null for a malformed ID', () => {
    expect(ageFromSaId('123')).toBeNull();
    expect(ageFromSaId('')).toBeNull();
    expect(ageFromSaId(undefined)).toBeNull();
  });
});

describe('termRemaining', () => {
  it('reports expired for a past end date', () => {
    expect(termRemaining('2000-01-01').expired).toBe(true);
    expect(termRemaining('2000-01-01').label).toBe('expired');
  });

  it('returns an empty label when no end date is given', () => {
    expect(termRemaining('').label).toBe('');
    expect(termRemaining(undefined).label).toBe('');
  });

  it('produces a human label for a future end date', () => {
    const far = new Date();
    far.setFullYear(far.getFullYear() + 2);
    const t = termRemaining(far.toISOString());
    expect(t.expired).toBe(false);
    expect(t.years).toBeGreaterThanOrEqual(1);
    expect(t.label).toMatch(/left$/);
  });
});

describe('teamIdsForClub / resolveTeam', () => {
  const clubs = [
    { id: 'glenwood', name: 'Glenwood', ground: { venue: 'Oval', lat: -29.85, lon: 31.02 } },
    { id: 'pirates', name: 'Pirates', ground: { venue: 'Bay', lat: -29.9, lon: 31.0 } },
  ];
  const clubBy = (id) => clubs.find((c) => c.id === id);

  it('legacy series (no participants): teamId is the clubId', () => {
    const s = { teams: ['glenwood', 'pirates'] };
    expect(teamIdsForClub(s, 'glenwood')).toEqual(['glenwood']);
    const r = resolveTeam(s, 'pirates', clubBy);
    expect(r.clubId).toBe('pirates');
    expect(r.name).toBe('Pirates');
    expect(r.ground.lat).toBe(-29.9);
  });

  it('participant series: resolves names/coords from the snapshot, not the live club', () => {
    const s = {
      teams: ['tm_a', 'tm_b', 'pirates'],
      participants: [
        {
          teamId: 'tm_a',
          clubId: 'glenwood',
          name: 'Glenwood A',
          venue: 'Oval',
          lat: -29.85,
          lon: 31.02,
        },
        { teamId: 'tm_b', clubId: 'glenwood', name: 'Glenwood B', lat: -29.85, lon: 31.02 },
        { teamId: 'pirates', clubId: 'pirates', name: 'Pirates' },
      ],
    };
    // Both of Glenwood's sides resolve to the club.
    expect(teamIdsForClub(s, 'glenwood').sort()).toEqual(['tm_a', 'tm_b']);
    const a = resolveTeam(s, 'tm_a', clubBy);
    expect(a.clubId).toBe('glenwood');
    expect(a.name).toBe('Glenwood A');
    expect(a.club.name).toBe('Glenwood'); // underlying club for avatar/colour
    expect(a.ground.venue).toBe('Oval');
  });

  it('falls back to the club ground when a participant has no own pin', () => {
    const s = {
      teams: ['tm_b'],
      participants: [{ teamId: 'tm_b', clubId: 'glenwood', name: 'Glenwood B' }],
    };
    const r = resolveTeam(s, 'tm_b', clubBy);
    expect(r.ground.lat).toBe(-29.85); // from the club ground
    expect(r.ground.venue).toBe('Oval');
  });

  it('an orphaned participant id resolves without throwing', () => {
    const s = {
      teams: ['tm_x'],
      participants: [{ teamId: 'tm_y', clubId: 'glenwood', name: 'X' }],
    };
    const r = resolveTeam(s, 'tm_x', clubBy);
    expect(r.name).toBe('Unknown team');
    expect(r.clubId).toBeUndefined();
  });
});

describe('relTimeAgo', () => {
  const now = Date.parse('2026-07-09T12:00:00Z');
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const H = 3_600_000;

  it('formats the seconds/minutes/hours/days boundaries', () => {
    expect(relTimeAgo(iso(0), now)).toBe('just now');
    expect(relTimeAgo(iso(59_000), now)).toBe('just now');
    expect(relTimeAgo(iso(60_000), now)).toBe('1m ago');
    expect(relTimeAgo(iso(59 * 60_000), now)).toBe('59m ago');
    expect(relTimeAgo(iso(H), now)).toBe('1h ago');
    expect(relTimeAgo(iso(23 * H), now)).toBe('23h ago');
    expect(relTimeAgo(iso(24 * H), now)).toBe('1d ago');
    expect(relTimeAgo(iso(6 * 24 * H), now)).toBe('6d ago');
  });

  it('returns empty string for missing or invalid input', () => {
    expect(relTimeAgo(undefined, now)).toBe('');
    expect(relTimeAgo('not-a-date', now)).toBe('');
  });
});

describe('buildRecentActivity', () => {
  const now = Date.parse('2026-07-09T12:00:00Z');
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const H = 3_600_000;
  const D = 86_400_000;

  it('returns [] for empty or missing clubs', () => {
    expect(buildRecentActivity([], now)).toEqual([]);
    expect(buildRecentActivity(undefined as any, now)).toEqual([]);
  });

  it('derives typed rows from commLog + onboarding, newest first', () => {
    const clubs = [
      {
        name: 'Alpha CC',
        commLog: [
          { id: '1', kind: 'invite', status: 'sent', to: 'chair@alpha.example', at: iso(2 * H) },
          { id: '2', kind: 'fixtures', status: 'sent', summary: '11 players', at: iso(5 * H) },
        ],
      },
      { name: 'Beta CC', onboardedVia: 'self-signup', onboardedAt: iso(1 * D) },
    ];
    const rows = buildRecentActivity(clubs as any, now);
    expect(rows.map((r) => [r.who, r.what])).toEqual([
      ['Alpha CC', 'Onboarding invite sent'],
      ['Alpha CC', 'Fixtures shared with players'],
      ['Beta CC', 'Joined via signup link'],
    ]);
  });

  it('never leaks recipient contact details, send summaries, or note bodies', () => {
    const clubs = [
      {
        name: 'Alpha CC',
        commLog: [
          { id: '1', kind: 'invite', status: 'sent', to: 'chair@alpha.example', at: iso(H) },
          { id: '2', kind: 'fixtures', status: 'sent', summary: 'SECRET SUMMARY', at: iso(2 * H) },
        ],
        notes: [{ id: 'n1', text: 'PRIVATE ADMIN NOTE', at: iso(3 * H), by: 'admin' }],
      },
    ];
    const blob = JSON.stringify(buildRecentActivity(clubs as any, now));
    expect(blob).not.toContain('chair@alpha.example');
    expect(blob).not.toContain('SECRET SUMMARY');
    expect(blob).not.toContain('PRIVATE ADMIN NOTE');
  });

  it('filters events outside the 7-day window and caps at 6', () => {
    const commLog = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      kind: 'invite',
      status: 'sent',
      at: iso(i * H),
    }));
    commLog.push({ id: 'old', kind: 'invite', status: 'sent', at: iso(8 * D) });
    const rows = buildRecentActivity([{ name: 'Alpha CC', commLog }] as any, now);
    expect(rows).toHaveLength(6); // capped
    expect(rows.every((r) => r.what === 'Onboarding invite sent')).toBe(true); // 8d-old excluded
  });

  it('skips skipped sends and flags failures with a coral tone', () => {
    const clubs = [
      {
        name: 'Gamma CC',
        commLog: [
          { id: '1', kind: 'invite', status: 'failed', at: iso(H) },
          { id: '2', kind: 'invite', status: 'skipped', at: iso(2 * H) },
        ],
      },
    ];
    const rows = buildRecentActivity(clubs as any, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ what: 'Onboarding invite failed to send', tone: 'coral' });
  });
});

describe('fixtureCost — per-side legs', () => {
  // Three Durban grounds, far enough apart that the legs are clearly distinguishable.
  const home = { ground: { lat: -29.856, lon: 31.03 } }; // Kingsmead
  const away = { ground: { lat: -29.918, lon: 30.888 } }; // Chatsworth
  const neutral = { lat: -29.6, lon: 30.39 }; // Pietermaritzburg way

  it('charges the away side only when the match is at the home ground', () => {
    const c = fixtureCost(home, away, 2, 3);
    expect(c.home.roundTripKm).toBe(0);
    expect(c.home.fuelR).toBe(0);
    expect(c.away.roundTripKm).toBe(c.roundTripKm); // the whole trip is theirs
    expect(c.away.fuelR).toBe(c.fuelR);
  });

  it('splits the journey per side once the fixture is allocated to a neutral ground', () => {
    const c = fixtureCost(home, away, 2, 3, neutral);
    expect(c.home.roundTripKm).toBeGreaterThan(0); // the HOME side travels too
    expect(c.away.roundTripKm).toBeGreaterThan(0);
    // The combined figure is the sum — right for a union's series total, and exactly why
    // a club portal must not show it as one club's distance.
    expect(c.home.roundTripKm + c.away.roundTripKm).toBeCloseTo(c.roundTripKm, 6);
    expect(c.home.fuelR + c.away.fuelR).toBeCloseTo(c.fuelR, 6);
  });

  it('leaves the home side at zero when allocation put the match at its own ground', () => {
    const c = fixtureCost(home, away, 2, 3, home.ground);
    expect(c.home.roundTripKm).toBeCloseTo(0, 6);
    expect(c.away.roundTripKm).toBeCloseTo(c.roundTripKm, 6);
  });
});

describe('composeDob', () => {
  it('composes and zero-pads single-digit day and month', () => {
    expect(composeDob('5', '3', '1990')).toEqual({ dob: '1990-03-05', error: '' });
  });

  it('trims stray whitespace from pasted/autofilled parts', () => {
    expect(composeDob(' 5 ', '3 ', ' 1990')).toEqual({ dob: '1990-03-05', error: '' });
  });

  it('accepts 29 Feb in a leap year, rejects it otherwise', () => {
    expect(composeDob('29', '2', '2000').dob).toBe('2000-02-29');
    expect(composeDob('29', '2', '1999')).toEqual({ dob: '', error: 'not-real' });
  });

  it('rejects impossible dates', () => {
    expect(composeDob('31', '2', '1990').error).toBe('not-real');
    expect(composeDob('31', '4', '1990').error).toBe('not-real');
    expect(composeDob('00', '3', '1990').error).toBe('not-real');
  });

  it('rejects an over-long day like "005" (the UI maxLength must not be the only guard)', () => {
    expect(composeDob('005', '3', '1990')).toEqual({ dob: '', error: 'not-real' });
  });

  it('asks for a 4-digit year instead of calling "58" too old', () => {
    expect(composeDob('15', '3', '58')).toEqual({ dob: '', error: 'year-format' });
  });

  it('treats a 4-digit ancient year as too-old, bounded at 1920', () => {
    expect(composeDob('5', '3', '0019').error).toBe('too-old');
    expect(composeDob('31', '12', '1919').error).toBe('too-old');
    expect(composeDob('1', '1', '1920')).toEqual({ dob: '1920-01-01', error: '' });
  });

  it('rejects future dates but allows today', () => {
    const now = new Date();
    const today = composeDob(
      String(now.getDate()),
      String(now.getMonth() + 1),
      String(now.getFullYear()),
    );
    expect(today.error).toBe('');
    expect(composeDob('1', '1', String(now.getFullYear() + 1)).error).toBe('future');
  });

  it('is silently incomplete until all three parts are present', () => {
    expect(composeDob('', '', '')).toEqual({ dob: '', error: 'incomplete' });
    expect(composeDob('15', '', '1958')).toEqual({ dob: '', error: 'incomplete' });
    expect(composeDob('15', '3', '')).toEqual({ dob: '', error: 'incomplete' });
  });
});
