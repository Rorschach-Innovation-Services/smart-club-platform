/**
 * Unit tests for the contact-import plan-builder — PURE, no AWS: parsed contacts + a fake
 * club list + fake existing-user lookups + fake exco state go in, a plan comes out. Asserts
 * account actions, email grouping + clubId union, exco set/keep/CONFLICT/DUPLICATE-SLOT
 * detection, channel skips (no-cell / landline), and the run-level blockers. Importing the
 * CLI module never runs main() (it guards its own entry point). Same style as
 * test/import-titans.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const {
  buildPlan,
  isLikelyLandline,
  computeClubWrites,
  mergeManifestEntry,
  effectiveInviteChannels,
  runConfirm,
  runRevert,
  dryRunSendRefusals,
  bootstrapNotifyEnvFromSst,
  resendIdempotencyKeyFor,
} = await import('../src/import-titans-contacts.js');
type Mod = typeof import('../src/import-titans-contacts.js');
type ManifestEntry = Parameters<Mod['mergeManifestEntry']>[0];
type ConfirmDeps = NonNullable<Parameters<Mod['runConfirm']>[5]>;
type RevertDeps = NonNullable<Parameters<Mod['runRevert']>[2]>;
type FakeRepo = Parameters<Mod['runConfirm']>[0];
type Args = Parameters<Mod['runConfirm']>[4];
const { resolveClubs } = await import('../src/titans-contacts-parse.js');

/** A minimal Args for the write paths (only `manifest` and the flags they read matter). */
function confirmArgs(manifest: string): Args {
  return {
    file: '',
    parseOnly: false,
    confirm: true,
    skipClubs: [],
    channels: ['email', 'whatsapp'],
    dataOnly: false,
    revert: false,
    manifest,
    resend: false,
    allowDryRunSends: false,
  };
}

type Person = {
  name: string;
  surname: string;
  fullName: string;
  designation: string;
  cell: string;
  email: string;
  section: string;
  rowNumber: number;
};

const LIVE = [
  { id: 'adelaar-cricket-club', name: 'Adelaar Cricket Club' },
  { id: 'tut-cricket-club', name: 'TUT Cricket Club' },
  { id: 'brits-cricket-club', name: 'Brits Cricket Club' },
];

let row = 10;
function person(
  section: string,
  fullName: string,
  designation: string,
  email: string,
  cell = '',
): Person {
  const [name, ...rest] = fullName.split(' ');
  return {
    name,
    surname: rest.join(' '),
    fullName,
    designation,
    cell,
    email,
    section,
    rowNumber: row++,
  };
}

function makeInputs(opts: {
  people: Person[];
  sections?: string[];
  clubExco?: Record<string, Record<string, unknown>>;
  clubCoaches?: Record<string, unknown[]>;
  userByEmail?: Record<
    string,
    { active: boolean; role: 'admin' | 'rep' | null; clubIds: string[] }
  >;
  origin?: string | null;
  channels?: ('email' | 'whatsapp')[];
  dataOnly?: boolean;
  skipSections?: string[];
  onlySection?: string;
}) {
  const sections = opts.sections ?? [...new Set(opts.people.map((p) => p.section))];
  const parsed = {
    sheetName: 'CLUB CONTACT LIST',
    sections,
    people: opts.people,
    strayRows: [],
  };
  const resolved = resolveClubs(sections, LIVE);
  return {
    parsed,
    resolved,
    clubExco: new Map(Object.entries(opts.clubExco ?? {})),
    clubCoaches: new Map(Object.entries(opts.clubCoaches ?? {})),
    userByEmail: new Map(Object.entries(opts.userByEmail ?? {})),
    origin: opts.origin === undefined ? 'https://titans.example.com' : opts.origin,
    channels: opts.channels ?? (['email'] as ('email' | 'whatsapp')[]),
    dataOnly: opts.dataOnly ?? false,
    skipSections: opts.skipSections ?? [],
    onlySection: opts.onlySection,
  };
}

describe('buildPlan — accounts, grouping, and sends', () => {
  test('a new chair on an empty slot: account=create, exco set, email send, no blockers', () => {
    const plan = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com', '0831112222')],
      }),
    );
    assert.equal(plan.blockers.length, 0);
    assert.equal(plan.people.length, 1);
    const p = plan.people[0];
    assert.equal(p.account, 'create');
    assert.equal(p.roles[0].exco?.slot, 'chair');
    assert.equal(p.roles[0].exco?.action, 'set');
    assert.equal(p.invite, true);
    assert.deepEqual(p.channels, [{ channel: 'email', status: 'send', to: 'aden@example.com' }]);
  });

  test('one person chairing two clubs is ONE person with two roles and a unioned grant', () => {
    const plan = buildPlan(
      makeInputs({
        people: [
          person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com'),
          person('TUT', 'Aden Schadle', 'Chairman', 'aden@example.com'),
        ],
        userByEmail: {
          'aden@example.com': { active: false, role: 'rep', clubIds: ['brits-cricket-club'] },
        },
      }),
    );
    assert.equal(plan.people.length, 1);
    const p = plan.people[0];
    assert.equal(p.roles.length, 2);
    assert.equal(p.account, 'pending-exists');
    // Union: both sheet clubs PLUS the pre-existing membership club (grantClubRep replaces wholesale).
    assert.deepEqual([...p.unionClubIds].sort(), [
      'adelaar-cricket-club',
      'brits-cricket-club',
      'tut-cricket-club',
    ]);
    // One send marker (the first resolved club), not one per club.
    assert.equal(p.sendMarkerClubId, 'adelaar-cricket-club');
  });

  test('an already-active user is not re-invited (account=active, invite=false)', () => {
    const plan = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com')],
        userByEmail: {
          'aden@example.com': { active: true, role: 'rep', clubIds: ['adelaar-cricket-club'] },
        },
      }),
    );
    assert.equal(plan.people[0].account, 'active');
    assert.equal(plan.people[0].invite, false);
    assert.equal(plan.blockers.length, 0);
  });

  test('a titans admin is an admin-elsewhere BLOCKER (grant would demote them)', () => {
    const plan = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'boss@example.com')],
        userByEmail: { 'boss@example.com': { active: true, role: 'admin', clubIds: [] } },
      }),
    );
    assert.equal(plan.people[0].account, 'admin-elsewhere');
    assert.ok(plan.blockers.some((b) => b.includes('ADMIN')));
  });
});

describe('buildPlan — exco slot detection', () => {
  test('an occupied slot holding a DIFFERENT email is a CONFLICT blocker', () => {
    const plan = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com')],
        clubExco: { 'adelaar-cricket-club': { chair: { email: 'someone-else@example.com' } } },
      }),
    );
    assert.equal(plan.people[0].roles[0].exco?.action, 'CONFLICT');
    assert.ok(plan.blockers.some((b) => b.includes('already held by someone-else@example.com')));
  });

  test('an occupied slot holding the SAME email is a keep, not a conflict', () => {
    const plan = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com')],
        clubExco: { 'adelaar-cricket-club': { chair: { email: 'Aden@Example.com' } } },
      }),
    );
    assert.equal(plan.people[0].roles[0].exco?.action, 'keep');
    assert.equal(plan.blockers.length, 0);
  });

  test('two DIFFERENT people claiming the same empty slot is a DUPLICATE-SLOT blocker for both', () => {
    const plan = buildPlan(
      makeInputs({
        people: [
          person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com'),
          person('ADELAAR', 'Bea Molefe', 'Chairperson', 'bea@example.com'),
        ],
      }),
    );
    for (const p of plan.people) assert.equal(p.roles[0].exco?.action, 'DUPLICATE-SLOT');
    assert.ok(plan.blockers.some((b) => b.includes('two sheet rows both map to exco slot')));
  });

  test('different slots in one club (chair + treasurer) both set, no conflict', () => {
    const plan = buildPlan(
      makeInputs({
        people: [
          person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com'),
          person('ADELAAR', 'Bea Molefe', 'Treasurer', 'bea@example.com'),
        ],
      }),
    );
    assert.equal(plan.blockers.length, 0);
    assert.deepEqual(
      plan.people.map((p) => p.roles[0].exco?.action),
      ['set', 'set'],
    );
  });
});

describe('buildPlan — channels', () => {
  test('WhatsApp: a valid mobile sends, no cell skips, a landline skips as landline?', () => {
    const mobile = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com', '081 869 5204')],
        channels: ['email', 'whatsapp'],
      }),
    ).people[0];
    assert.deepEqual(
      mobile.channels.find((c) => c.channel === 'whatsapp'),
      {
        channel: 'whatsapp',
        status: 'send',
        to: '27818695204',
      },
    );

    const noCell = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com', '')],
        channels: ['whatsapp'],
      }),
    ).people[0];
    assert.equal(noCell.channels[0].status, 'skip');
    assert.equal(noCell.channels[0].reason, 'no cell');

    const landline = buildPlan(
      makeInputs({
        people: [
          person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com', '012  382 5396'),
        ],
        channels: ['whatsapp'],
      }),
    ).people[0];
    assert.equal(landline.channels[0].status, 'skip');
    assert.equal(landline.channels[0].reason, 'landline?');
  });

  test('--data-only plans no invite and no channels', () => {
    const p = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com', '0831112222')],
        dataOnly: true,
      }),
    ).people[0];
    assert.equal(p.invite, false);
    assert.deepEqual(p.channels, []);
  });

  test('a missing canonical origin is a blocker when a real send would go out', () => {
    const plan = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com')],
        origin: null,
      }),
    );
    assert.ok(plan.blockers.some((b) => b.includes('no canonical web origin')));
  });

  test('no missing-origin blocker under --data-only (nothing would send)', () => {
    const plan = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com')],
        origin: null,
        dataOnly: true,
      }),
    );
    assert.equal(plan.blockers.length, 0);
  });
});

describe('buildPlan — section filtering', () => {
  test('an unmatched section is a blocker; --skip-club removes it and drops its people', () => {
    const withScorers = makeInputs({
      people: [
        person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com'),
        person('TITANS SCORERS ASSOCIATION', 'Zed Scorer', 'Chairman', 'zed@example.com'),
      ],
    });
    const blocked = buildPlan(withScorers);
    assert.ok(
      blocked.blockers.some((b) => b.includes('unmatched section "TITANS SCORERS ASSOCIATION"')),
    );

    const skipped = buildPlan({ ...withScorers, skipSections: ['TITANS SCORERS ASSOCIATION'] });
    assert.equal(skipped.blockers.length, 0);
    assert.deepEqual(skipped.skippedSections, ['TITANS SCORERS ASSOCIATION']);
    assert.deepEqual(
      skipped.people.map((p) => p.email),
      ['aden@example.com'],
    );
  });

  test('--club filters to a single section', () => {
    const plan = buildPlan(
      makeInputs({
        people: [
          person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com'),
          person('TUT', 'Cody Naidoo', 'Chairman', 'cody@example.com'),
        ],
        onlySection: 'ADELAAR',
      }),
    );
    assert.deepEqual(
      plan.people.map((p) => p.email),
      ['aden@example.com'],
    );
  });

  test('a --club matching no section is a blocker, not a silent empty plan (minor 6)', () => {
    const plan = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com')],
        onlySection: 'NO SUCH CLUB',
      }),
    );
    assert.equal(plan.people.length, 0);
    assert.ok(plan.blockers.some((b) => b.includes('matched no section')));
  });
});

describe('buildPlan — invalid-email guard (must-fix 1)', () => {
  test('an empty email and a garbage email each block, with no plan entry', () => {
    const empty = buildPlan(
      makeInputs({ people: [person('ADELAAR', 'Ann Empty', 'Chairman', '')] }),
    );
    assert.equal(empty.people.length, 0);
    assert.ok(empty.blockers.some((b) => b.includes('Ann Empty') && b.includes('no usable email')));

    const garbage = buildPlan(
      makeInputs({ people: [person('ADELAAR', 'Gary Garbage', 'Chairman', 'not-an-email')] }),
    );
    assert.equal(garbage.people.length, 0);
    assert.ok(
      garbage.blockers.some((b) => b.includes('Gary Garbage') && b.includes('no usable email')),
    );
  });

  test('two email-less rows do NOT merge into one pseudo-person', () => {
    const plan = buildPlan(
      makeInputs({
        people: [
          person('ADELAAR', 'Ann Empty', 'Chairman', ''),
          person('TUT', 'Bob Blank', 'Chairman', ''),
        ],
      }),
    );
    assert.equal(plan.people.length, 0);
    // Each blank-email row raises its own blocker — they were never collapsed under one ''.
    assert.equal(plan.blockers.filter((b) => b.includes('no usable email')).length, 2);
  });
});

describe('isLikelyLandline', () => {
  test('ZA mobiles (06/07/08) are not landlines', () => {
    assert.equal(isLikelyLandline('081 869 5204'), false);
    assert.equal(isLikelyLandline('0712345678'), false);
    assert.equal(isLikelyLandline('27829782786'), false);
  });

  test('a 012 (Pretoria) number is a likely landline', () => {
    assert.equal(isLikelyLandline('012  382 5396'), true);
    assert.equal(isLikelyLandline('021 555 1234'), true);
  });

  test('an empty cell is not a landline (it is "no cell")', () => {
    assert.equal(isLikelyLandline(''), false);
  });
});

describe('buildPlan — coach dedupe (finding 6)', () => {
  test('two coach rows for the same person+club: first sets, second keeps (no double write)', () => {
    const plan = buildPlan(
      makeInputs({
        people: [
          person('ADELAAR', 'Cy Coach', 'Head Coach', 'cy@example.com', '0831112222'),
          person('ADELAAR', 'Cy Coach', 'Director of Cricket', 'cy@example.com', '0831112222'),
        ],
      }),
    );
    const coachActions = plan.people[0].roles.map((r) => r.coach);
    assert.deepEqual([...coachActions].sort(), ['keep', 'set']);
  });

  test('a coach already listed on the club (case-insensitive) is a keep', () => {
    const plan = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Cy Coach', 'Head Coach', 'cy@example.com')],
        clubCoaches: { 'adelaar-cricket-club': [{ email: 'CY@Example.com', name: 'Cy' }] },
      }),
    );
    assert.equal(plan.people[0].roles[0].coach, 'keep');
  });
});

describe('computeClubWrites — keep never writes (finding 2)', () => {
  test('a keep exco slot is left ENTIRELY untouched (governance fields preserved)', () => {
    const chair = {
      name: 'Aden',
      email: 'aden@example.com',
      idNumber: '9001015800088',
      termStart: '2026-01-01',
      termEnd: '2026-12-31',
      gender: 'M',
      race: 'X',
    };
    // Slot already holds the same email → plan action is `keep`.
    const plan = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com')],
        clubExco: { 'adelaar-cricket-club': { chair } },
      }),
    );
    const p = plan.people[0];
    assert.equal(p.roles[0].exco?.action, 'keep');
    const writes = computeClubWrites(
      { id: 'adelaar-cricket-club', exco: { chair }, coaches: [] },
      p.roles,
      p,
    );
    assert.equal(writes.excoWrites.length, 0);
    assert.equal(writes.coachesChanged, false);
    // The governance-bearing slot is untouched — no name/email-only overwrite.
    assert.deepEqual(writes.nextExco.chair, chair);
  });

  test('a set exco slot writes name/email/cell into an empty slot', () => {
    const plan = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com', '0831112222')],
      }),
    );
    const p = plan.people[0];
    const writes = computeClubWrites(
      { id: 'adelaar-cricket-club', exco: {}, coaches: [] },
      p.roles,
      p,
    );
    assert.equal(writes.excoWrites.length, 1);
    assert.equal((writes.nextExco.chair as { email: string }).email, 'aden@example.com');
  });
});

describe('effectiveInviteChannels — confirm channel enforcement (finding 1)', () => {
  test('a landline drops whatsapp and blanks the cell; email still sends', () => {
    const p = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com', '012 382 5396')],
        channels: ['email', 'whatsapp'],
      }),
    ).people[0];
    const eff = effectiveInviteChannels(p);
    assert.deepEqual(eff.channels, ['email']);
    assert.equal(eff.cell, '');
  });

  test('a valid mobile keeps whatsapp and the cell', () => {
    const p = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com', '081 869 5204')],
        channels: ['email', 'whatsapp'],
      }),
    ).people[0];
    const eff = effectiveInviteChannels(p);
    assert.deepEqual(eff.channels, ['email', 'whatsapp']);
    assert.equal(eff.cell, '081 869 5204');
  });
});

describe('mergeManifestEntry — earliest pre-image wins (finding 4)', () => {
  const base = (over: Partial<ManifestEntry>): ManifestEntry => ({
    email: 'aden@example.com',
    sub: '',
    createdUser: false,
    granted: false,
    priorMembership: null,
    excoWrites: [],
    commLog: [],
    idempotencyKey: 'staff-import-aden@example.com',
    sendMarkerClubId: null,
    ...over,
  });

  test('keeps the earliest priorMembership and earliest exco priorValue; unions the rest', () => {
    const prior = base({
      sub: 'sub-run1',
      createdUser: true,
      granted: true,
      // Captured FIRST — the original state before any run.
      priorMembership: { tenantId: 'titans', role: 'rep', clubIds: ['orig-club'] } as never,
      excoWrites: [{ clubId: 'adelaar-cricket-club', slot: 'chair', priorValue: null }],
      commLog: [{ clubId: 'adelaar-cricket-club', eventId: 'e1' }],
    });
    const next = base({
      sub: 'sub-run2',
      granted: true,
      // Run-2 saw run-1's OUTPUT as the "prior" — must NOT overwrite the true original.
      priorMembership: { tenantId: 'titans', role: 'rep', clubIds: ['run1-club'] } as never,
      excoWrites: [
        { clubId: 'adelaar-cricket-club', slot: 'chair', priorValue: { email: 'run1@x' } },
        { clubId: 'tut-cricket-club', slot: 'tre', priorValue: null },
      ],
      commLog: [{ clubId: 'adelaar-cricket-club', eventId: 'e2' }],
    });
    const merged = mergeManifestEntry(prior, next);
    // Earliest membership pre-image survives.
    assert.deepEqual(merged.priorMembership, prior.priorMembership);
    // The chair slot keeps run-1's (null) pre-image, not run-2's overwrite.
    const chairWrite = merged.excoWrites.find((w) => w.slot === 'chair');
    assert.equal(chairWrite?.priorValue, null);
    // New slot from run-2 is unioned in.
    assert.ok(merged.excoWrites.some((w) => w.slot === 'tre'));
    // Comm-log entries union (audit-only).
    assert.deepEqual(merged.commLog.map((c) => c.eventId).sort(), ['e1', 'e2']);
    // Latest account facts; earliest createdUser.
    assert.equal(merged.sub, 'sub-run2');
    assert.equal(merged.createdUser, true);
    assert.equal(merged.granted, true);
  });
});

describe('runConfirm — channel + version assembly (findings 1 & 9)', () => {
  test('landline person: sends email-only with blank cell, marker records email, updateClub carries version', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'titans-confirm-'));
    // The backup lands next to the manifest (tmp), so no chdir is needed — chdir'ing the
    // shared tsx --test runner mid-run is what made this test flaky.
    const updateClubCalls: Array<{ patch: Record<string, unknown> }> = [];
    const claimCalls: Array<{ channels: string[] }> = [];
    const sendCalls: Array<{ channels: string[]; cell: string }> = [];
    let completed = 0;
    let released = 0;
    try {
      const repo = {
        listClubs: async () => [],
        getTenantConfig: async () => null,
        getClub: async (_t: string, id: string) => ({
          id,
          name: 'Adelaar',
          exco: {},
          coaches: [],
          version: 3,
        }),
        updateClub: async (_t: string, _id: string, patch: Record<string, unknown>) => {
          updateClubCalls.push({ patch });
          return {} as never;
        },
        getUser: async () => null,
        claimInviteSend: async (_t: string, _c: string, _k: string, channels: string[]) => {
          claimCalls.push({ channels });
          return null; // fresh claim
        },
        completeInviteSend: async () => {
          completed++;
        },
        releaseInviteClaim: async () => {
          released++;
        },
        appendClubCommEvents: async () => {},
      } as unknown as FakeRepo;

      const deps: ConfirmDeps = {
        grantClubRep: (async () => ({ sub: 'sub-1', clubIds: ['adelaar-cricket-club'] })) as never,
        getUserSubByEmail: (async () => null) as never,
        sendStaffInvite: (async (a: { channels: string[]; cell: string }) => {
          sendCalls.push({ channels: a.channels, cell: a.cell });
          return {
            results: [
              { channel: 'email', status: 'sent', to: 'aden@example.com', messageId: 'm1' },
            ],
          };
        }) as never,
        orgCopy: (() => ({ name: 'Titans' })) as never,
        dryRun: { email: false, whatsapp: false },
      };

      const plan = buildPlan(
        makeInputs({
          people: [
            person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com', '012 382 5396'),
          ],
          channels: ['email', 'whatsapp'],
        }),
      );
      await runConfirm(
        repo,
        {} as never,
        'pool',
        plan,
        confirmArgs(join(tmp, 'manifest.json')),
        deps,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // Finding 1: only the planned `send` channel goes out; the landline cell is blanked.
    assert.deepEqual(sendCalls, [{ channels: ['email'], cell: '' }]);
    assert.deepEqual(claimCalls, [{ channels: ['email'] }]);
    // Finding 9: the exco write carries OUR re-read version so a concurrent save is rejected.
    assert.equal(updateClubCalls.length, 1);
    assert.equal(updateClubCalls[0].patch.version, 3);
    assert.equal(completed, 1);
    assert.equal(released, 0);
  });
});

describe('runRevert — granted-gated membership restore (findings 5 & 9)', () => {
  test('restores membership ONLY for granted entries; exco restore carries version for all', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'titans-revert-'));
    const manifestPath = join(tmp, 'manifest.json');
    const entry = (over: Partial<ManifestEntry>): ManifestEntry => ({
      email: 'x@example.com',
      sub: 'sub-x',
      createdUser: false,
      granted: false,
      priorMembership: null,
      excoWrites: [{ clubId: 'adelaar-cricket-club', slot: 'chair', priorValue: null }],
      commLog: [],
      idempotencyKey: 'k',
      sendMarkerClubId: null,
      ...over,
    });
    writeFileSync(
      manifestPath,
      JSON.stringify([
        entry({ email: 'granted@example.com', sub: 'sub-granted', granted: true }),
        entry({ email: 'ungranted@example.com', sub: 'sub-ungranted', granted: false }),
      ]),
    );

    const updateClubCalls: Array<Record<string, unknown>> = [];
    const restoreSubs: string[] = [];
    try {
      const repo = {
        // Current slot holds the entry email so the drift guard passes and a restore runs.
        getClub: async (_t: string, id: string) => ({
          id,
          name: 'Adelaar',
          exco: { chair: { email: 'granted@example.com' } },
          version: 5,
        }),
        updateClub: async (_t: string, _id: string, patch: Record<string, unknown>) => {
          updateClubCalls.push(patch);
          return {} as never;
        },
      } as unknown as FakeRepo;
      const deps: RevertDeps = {
        restoreMembership: (async (sub: string) => {
          restoreSubs.push(sub);
          return { offboarded: false, adminDelta: 0 };
        }) as never,
      };
      // getClub returns the SAME slot email for both entries; only the granted entry's exco
      // actually matches on drift (email 'granted@example.com'), which is fine — the point of
      // this test is the membership gate + version, so assert those.
      await runRevert(repo, { ...confirmArgs(manifestPath), revert: true }, deps);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // Finding 5: only the granted entry's membership is restored.
    assert.deepEqual(restoreSubs, ['sub-granted']);
    // Finding 9: every exco-restore updateClub carries OUR read's version.
    assert.ok(updateClubCalls.length >= 1);
    for (const patch of updateClubCalls) assert.equal(patch.version, 5);
  });
});

describe('runRevert — coach append removal (must-fix 2)', () => {
  test("removes this run's coach entry (email + source) and leaves a manual one intact", async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'titans-revert-coach-'));
    const manifestPath = join(tmp, 'manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify([
        {
          email: 'cy@example.com',
          sub: 'sub-cy',
          createdUser: false,
          granted: false,
          priorMembership: null,
          excoWrites: [],
          coachWrites: ['adelaar-cricket-club'],
          commLog: [],
          idempotencyKey: 'k',
          sendMarkerClubId: null,
        } as ManifestEntry,
      ]),
    );

    const updateClubCalls: Array<Record<string, unknown>> = [];
    try {
      const repo = {
        getClub: async (_t: string, id: string) => ({
          id,
          name: 'Adelaar',
          exco: {},
          coaches: [
            // This import's own append (email matches case-insensitively + source tag).
            { name: 'Cy Coach', email: 'CY@Example.com', source: 'import:titans-contacts' },
            // A coach someone else added by hand — must survive revert.
            { name: 'Manual Coach', email: 'manual@example.com' },
          ],
          version: 7,
        }),
        updateClub: async (_t: string, _id: string, patch: Record<string, unknown>) => {
          updateClubCalls.push(patch);
          return {} as never;
        },
      } as unknown as FakeRepo;
      const deps: RevertDeps = {
        restoreMembership: (async () => ({ offboarded: false, adminDelta: 0 })) as never,
      };
      await runRevert(repo, { ...confirmArgs(manifestPath), revert: true }, deps);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    assert.equal(updateClubCalls.length, 1);
    const nextCoaches = updateClubCalls[0].coaches as Array<{ email: string }>;
    assert.deepEqual(
      nextCoaches.map((c) => c.email),
      ['manual@example.com'],
    );
    // The revert write carries OUR read's version.
    assert.equal(updateClubCalls[0].version, 7);
  });
});

// ───────────── 29 Sep 2026 incident: dry-run guard, --resend, sst-shell bootstrap ─────────────

/** A fake repo whose claimInviteSend behaves like repo.ts: the FIRST claim of a key succeeds
 * (null); a key whose marker is `completed` replays. `completedKeys` seeds prior markers. */
function incidentHarness(completedKeys: string[] = []) {
  const markers = new Map<string, 'in_progress' | 'completed'>(
    completedKeys.map((k) => [k, 'completed']),
  );
  const calls = {
    claims: [] as string[],
    sends: 0,
    updateClub: 0,
    listClubs: 0,
    grants: 0,
  };
  const repo = {
    listClubs: async () => {
      calls.listClubs++;
      return [];
    },
    getTenantConfig: async () => null,
    getClub: async (_t: string, id: string) => ({
      id,
      name: 'Adelaar',
      exco: {},
      coaches: [],
      version: 1,
    }),
    updateClub: async () => {
      calls.updateClub++;
      return {} as never;
    },
    getUser: async () => null,
    claimInviteSend: async (_t: string, _c: string, key: string) => {
      calls.claims.push(key);
      const m = markers.get(key);
      if (m) return { pending: m !== 'completed', results: [] };
      markers.set(key, 'in_progress');
      return null;
    },
    completeInviteSend: async (_t: string, _c: string, key: string) => {
      markers.set(key, 'completed');
    },
    releaseInviteClaim: async (_t: string, _c: string, key: string) => {
      markers.delete(key);
    },
    appendClubCommEvents: async () => {},
  } as unknown as FakeRepo;
  const deps = (dryRun: { email: boolean; whatsapp: boolean }): ConfirmDeps => ({
    grantClubRep: (async () => {
      calls.grants++;
      return { sub: 'sub-1', clubIds: ['adelaar-cricket-club'] };
    }) as never,
    getUserSubByEmail: (async () => null) as never,
    sendStaffInvite: (async () => {
      calls.sends++;
      return {
        results: [{ channel: 'email', status: 'sent', to: 'aden@example.com', messageId: 'm1' }],
      };
    }) as never,
    orgCopy: (() => ({ name: 'Titans' })) as never,
    dryRun,
  });
  return { repo, deps, calls, markers };
}

const oneChairPlan = (channels: ('email' | 'whatsapp')[] = ['email', 'whatsapp']) =>
  buildPlan(
    makeInputs({
      people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com', '081 869 5204')],
      channels,
    }),
  );

async function withTmp<T>(fn: (manifest: string) => Promise<T>): Promise<T> {
  const tmp = mkdtempSync(join(tmpdir(), 'titans-incident-'));
  try {
    return await fn(join(tmp, 'manifest.json'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('runConfirm — dry-run send guard (29 Sep 2026 incident)', () => {
  test('a dry-run email channel aborts BEFORE any backup, write, claim or send', async () => {
    const h = incidentHarness();
    await withTmp(async (manifest) => {
      await assert.rejects(
        runConfirm(
          h.repo,
          {} as never,
          'pool',
          oneChairPlan(),
          confirmArgs(manifest),
          h.deps({ email: true, whatsapp: false }),
        ),
        (err: Error) => {
          assert.match(err.message, /email channel is in notify dry-run/);
          assert.match(err.message, /refusing --confirm/);
          return true;
        },
      );
      // Nothing written: no backup file / manifest in the dir, no DB touch at all.
      assert.deepEqual(readdirSync(dirname(manifest)), []);
    });
    assert.deepEqual(h.calls.claims, []);
    assert.equal(h.calls.sends, 0);
    assert.equal(h.calls.updateClub, 0);
    assert.equal(h.calls.grants, 0);
    assert.equal(h.calls.listClubs, 0);
  });

  test('a dry-run whatsapp channel also aborts when whatsapp is requested', async () => {
    const h = incidentHarness();
    await withTmp(async (manifest) => {
      await assert.rejects(
        runConfirm(
          h.repo,
          {} as never,
          'pool',
          oneChairPlan(),
          confirmArgs(manifest),
          h.deps({ email: false, whatsapp: true }),
        ),
        /whatsapp channel is in notify dry-run/,
      );
    });
    assert.deepEqual(h.calls.claims, []);
  });

  test('--allow-dry-run-sends proceeds (claims + sends) despite a dry-run channel', async () => {
    const h = incidentHarness();
    await withTmp(async (manifest) => {
      await runConfirm(
        h.repo,
        {} as never,
        'pool',
        oneChairPlan(),
        { ...confirmArgs(manifest), allowDryRunSends: true },
        h.deps({ email: true, whatsapp: true }),
      );
    });
    assert.deepEqual(h.calls.claims, ['staff-import-aden@example.com']);
    assert.equal(h.calls.sends, 1);
  });

  test('dryRunSendRefusals: only REQUESTED channels count, and nothing fires with no send planned', () => {
    // whatsapp is dry-run but only email was requested → no refusal.
    assert.deepEqual(
      dryRunSendRefusals(oneChairPlan(['email']), { email: false, whatsapp: true }),
      [],
    );
    // --data-only plans no sends → no refusal even with both channels dry-run.
    const dataOnly = buildPlan(
      makeInputs({
        people: [person('ADELAAR', 'Aden Schadle', 'Chairman', 'aden@example.com')],
        channels: ['email', 'whatsapp'],
        dataOnly: true,
      }),
    );
    assert.deepEqual(dryRunSendRefusals(dataOnly, { email: true, whatsapp: true }), []);
    // The refusal names the missing config (and never a value).
    const [msg] = dryRunSendRefusals(oneChairPlan(['email']), { email: true, whatsapp: false }, {});
    assert.match(msg, /FROM_EMAIL unset/);
  });
});

describe('runConfirm — --resend (29 Sep 2026 recovery)', () => {
  const completedByIncident = ['staff-import-aden@example.com'];

  test('without --resend a completed marker replays (sent-previously, no send)', async () => {
    const h = incidentHarness(completedByIncident);
    await withTmp(async (manifest) => {
      await runConfirm(
        h.repo,
        {} as never,
        'pool',
        oneChairPlan(),
        confirmArgs(manifest),
        h.deps({ email: false, whatsapp: false }),
      );
    });
    assert.deepEqual(h.calls.claims, ['staff-import-aden@example.com']);
    assert.equal(h.calls.sends, 0);
  });

  test('with --resend a FRESH key is claimed, bypassing the completed marker, and the invite sends', async () => {
    const h = incidentHarness(completedByIncident);
    await withTmp(async (manifest) => {
      await runConfirm(
        h.repo,
        {} as never,
        'pool',
        oneChairPlan(),
        { ...confirmArgs(manifest), resend: true },
        h.deps({ email: false, whatsapp: false }),
      );
    });
    assert.deepEqual(h.calls.claims, [resendIdempotencyKeyFor('aden@example.com')]);
    assert.notEqual(h.calls.claims[0], 'staff-import-aden@example.com');
    assert.equal(h.calls.sends, 1);
    assert.equal(h.markers.get(resendIdempotencyKeyFor('aden@example.com')), 'completed');
  });

  test('a second --resend run replays on the resend key (no double send after a partial run)', async () => {
    const h = incidentHarness([
      ...completedByIncident,
      resendIdempotencyKeyFor('aden@example.com'),
    ]);
    await withTmp(async (manifest) => {
      await runConfirm(
        h.repo,
        {} as never,
        'pool',
        oneChairPlan(),
        { ...confirmArgs(manifest), resend: true },
        h.deps({ email: false, whatsapp: false }),
      );
    });
    assert.equal(h.calls.sends, 0);
  });
});

describe('bootstrapNotifyEnvFromSst — sst shell linked secrets', () => {
  const sstEnv = (): NodeJS.ProcessEnv => ({
    SST_RESOURCE_FromEmail: JSON.stringify({ type: 'sst.sst.Secret', value: 'info@example.com' }),
    SST_RESOURCE_WhatsappAccessToken: JSON.stringify({ type: 'sst.sst.Secret', value: 'tok' }),
    SST_RESOURCE_WhatsappPhoneNumberId: JSON.stringify({ type: 'sst.sst.Secret', value: '123' }),
  });

  test('fills missing env names from the SST_RESOURCE_* secrets; returns names only', () => {
    const env = sstEnv();
    const filled = bootstrapNotifyEnvFromSst(env);
    assert.deepEqual(filled, ['FROM_EMAIL', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']);
    assert.equal(env.FROM_EMAIL, 'info@example.com');
    assert.equal(env.WHATSAPP_ACCESS_TOKEN, 'tok');
    assert.equal(env.WHATSAPP_PHONE_NUMBER_ID, '123');
  });

  test('an already-set env value wins; an empty (default) secret is not copied; no SST ⇒ no-op', () => {
    const env: NodeJS.ProcessEnv = {
      ...sstEnv(),
      FROM_EMAIL: 'override@example.com',
      SST_RESOURCE_WhatsappAccessToken: JSON.stringify({ type: 'sst.sst.Secret', value: '' }),
    };
    assert.deepEqual(bootstrapNotifyEnvFromSst(env), ['WHATSAPP_PHONE_NUMBER_ID']);
    assert.equal(env.FROM_EMAIL, 'override@example.com');
    assert.equal(env.WHATSAPP_ACCESS_TOKEN, undefined);

    const bare: NodeJS.ProcessEnv = {};
    assert.deepEqual(bootstrapNotifyEnvFromSst(bare), []);
    assert.deepEqual(bare, {});
  });

  test('load order: importing the CLI does not load the notify senders, so they see the bootstrapped env', () => {
    // A fresh process (module caches are per-process): import the CLI module, bootstrap, THEN
    // load the notify modules — their import-time dry-run flags must reflect the secrets.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = (f: string) => JSON.stringify(join(here, '..', 'src', f));
    const code = `
      const cli = await import(${src('import-titans-contacts.ts')});
      cli.bootstrapNotifyEnvFromSst();
      const { EMAIL_DRY_RUN } = await import(${src('notify/email.ts')});
      const { WHATSAPP_DRY_RUN } = await import(${src('notify/whatsapp.ts')});
      console.log(JSON.stringify({ EMAIL_DRY_RUN, WHATSAPP_DRY_RUN }));
    `;
    const env: NodeJS.ProcessEnv = { ...process.env, ...sstEnv() };
    for (const k of [
      'FROM_EMAIL',
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'NOTIFY_DRY_RUN',
    ])
      delete env[k];
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', code],
      { env, encoding: 'utf8', cwd: join(here, '..') },
    );
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.trim().split('\n').pop()!);
    assert.deepEqual(out, { EMAIL_DRY_RUN: false, WHATSAPP_DRY_RUN: false });
  });
});
