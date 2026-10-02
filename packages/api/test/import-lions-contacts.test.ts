/**
 * Unit tests for the Lions (CGL) contact import — PURE plan-building plus the confirm/revert
 * write paths against an in-memory fake repo (no AWS). Parsed affiliation records are built
 * directly with the real parser's normalizeCell/normalizeEmail and real CLUB_MAP entries;
 * every contact detail is invented — no real PII. Same style as
 * test/import-titans-contacts.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  buildPlan,
  extractInvitees,
  pickPrimaryIndex,
  summarizePlan,
  effectiveInviteChannels,
  dryRunSendRefusals,
  manifestPathFor,
  runConfirm,
  runRevert,
  SLOT_OF,
} = await import('../src/import-lions-contacts.js');
const { normalizeCell, normalizeEmail } = await import('../src/lions-affiliation-parse.js');
const { CLUB_MAP } = await import('../src/lions-import-map.js');

type Mod = typeof import('../src/import-lions-contacts.js');
type Inputs = Parameters<Mod['buildPlan']>[0];
type Parsed = Inputs['parsed'];
type Rec = Parsed['records'][number];
type ConfirmDeps = NonNullable<Parameters<Mod['runConfirm']>[5]>;
type RevertDeps = NonNullable<Parameters<Mod['runRevert']>[2]>;
type FakeRepo = Parameters<Mod['runConfirm']>[0];
type Args = Parameters<Mod['runConfirm']>[4];

const AFFILIATED = CLUB_MAP.filter((c) => c.sources.includes('affiliation'));
const NON_AFFILIATED = CLUB_MAP.filter((c) => !c.sources.includes('affiliation'));
const A = AFFILIATED[0];
const B = AFFILIATED[1];

function contact(name: string, email: string, cell: string) {
  return { name, email: normalizeEmail(email).email, cell: normalizeCell(cell) };
}

let rowNo = 2;
function rec(
  club: (typeof CLUB_MAP)[number],
  chairman: ReturnType<typeof contact>,
  secretary: ReturnType<typeof contact>,
  warnings: string[] = [],
): Rec {
  return { rowNumber: rowNo++, club, chairman, secretary, warnings } as unknown as Rec;
}

function parsed(records: Rec[], rejected: Parsed['rejected'] = []): Parsed {
  return {
    sheetName: 'Form Responses 1',
    responseCount: records.length,
    records,
    duplicates: [],
    rejected,
  };
}

const live = (clubs = AFFILIATED, exco: Record<string, Record<string, unknown>> = {}) =>
  clubs.map((c) => ({ id: c.id, name: c.name, exco: exco[c.id] }));

function inputs(over: Partial<Inputs> & { records: Rec[] }): Inputs {
  const { records, ...rest } = over;
  return {
    parsed: parsed(records),
    liveClubs: live(),
    userByEmail: new Map(),
    origin: 'https://lions.example.test',
    channels: ['email', 'whatsapp'],
    dataOnly: false,
    skipClubs: [],
    ...rest,
  };
}

const ADA = () => contact('Ada Example', 'ada@example.com', '082 000 0001');
const BEN = () => contact('Ben Example', 'ben@example.com', '+27 82 000 0002');

describe('slot mapping', () => {
  test('chairman → chair, secretary → sec; new users create + set + both channels send', () => {
    assert.deepEqual(SLOT_OF, { chairman: 'chair', secretary: 'sec' });
    const plan = buildPlan(inputs({ records: [rec(A, ADA(), BEN())] }));
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.people.length, 2);
    const [ada, ben] = plan.people;
    assert.deepEqual(
      ada.roles.map((r) => [r.clubId, r.role, r.exco.slot, r.exco.action]),
      [[A.id, 'chairman', 'chair', 'set']],
    );
    assert.deepEqual(
      ben.roles.map((r) => [r.role, r.exco.slot]),
      [['secretary', 'sec']],
    );
    assert.equal(ben.cell, '0820000002', 'secretary cell normalised from +27');
    assert.equal(ada.account, 'create');
    assert.deepEqual(
      ada.channels.map((c) => `${c.channel}:${c.status}`),
      ['email:send', 'whatsapp:send'],
    );
  });

  test('slots already filled by the affiliation import with the SAME email are keep', () => {
    const plan = buildPlan(
      inputs({
        records: [rec(A, ADA(), BEN())],
        liveClubs: live(AFFILIATED, {
          [A.id]: {
            chair: { name: 'Ada Example', email: 'ADA@example.com' },
            sec: { email: 'ben@example.com' },
          },
        }),
      }),
    );
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(
      plan.people.map((p) => p.roles[0].exco.action),
      ['keep', 'keep'],
    );
  });

  test('a slot held by a DIFFERENT email is a CONFLICT blocker (never overwritten)', () => {
    const plan = buildPlan(
      inputs({
        records: [rec(A, ADA(), BEN())],
        liveClubs: live(AFFILIATED, { [A.id]: { chair: { email: 'someone@else.test' } } }),
      }),
    );
    assert.equal(plan.people[0].roles[0].exco.action, 'CONFLICT');
    assert.ok(plan.blockers.some((b) => /Chairperson.*someone@else\.test/.test(b)));
  });

  test('a lions admin is a blocker (granting rep would demote them)', () => {
    const plan = buildPlan(
      inputs({
        records: [rec(A, ADA(), BEN())],
        userByEmail: new Map([['ada@example.com', { active: true, role: 'admin', clubIds: [] }]]),
      }),
    );
    assert.equal(plan.people[0].account, 'admin-elsewhere');
    assert.ok(plan.blockers.some((b) => /lions ADMIN/.test(b)));
  });

  test('an active user is neither granted nor invited; a pending one is re-granted + invited', () => {
    const plan = buildPlan(
      inputs({
        records: [rec(A, ADA(), BEN())],
        userByEmail: new Map([
          ['ada@example.com', { active: true, role: 'rep', clubIds: [A.id] }],
          ['ben@example.com', { active: false, role: 'rep', clubIds: [B.id] }],
        ]),
      }),
    );
    const [ada, ben] = plan.people;
    assert.equal(ada.account, 'active');
    assert.equal(ada.grant, false);
    assert.equal(ada.invite, false);
    assert.equal(ben.account, 'pending-exists');
    assert.deepEqual(ben.unionClubIds, [A.id, B.id], 'grant unions the existing membership');
    assert.equal(ben.invite, true);
  });
});

describe('same-person chairman + secretary', () => {
  test('one email for both officers is ONE person holding both slots; name + cell from the email owner', () => {
    const chair = contact('Craig Other', 'mikephillips9@example.com', '079 000 0001');
    const sec = contact('Michael Phillips', 'mikephillips9@example.com', '064 000 0002');
    const plan = buildPlan(inputs({ records: [rec(A, chair, sec)] }));
    assert.equal(plan.people.length, 1);
    const p = plan.people[0];
    assert.deepEqual(
      p.roles.map((r) => r.exco.slot),
      ['chair', 'sec'],
    );
    assert.equal(p.name, 'Michael Phillips');
    assert.equal(p.cell, '0640000002', 'WhatsApp goes to the named owner, not the other officer');
    // Each slot still carries its own form name.
    assert.deepEqual(
      p.roles.map((r) => r.contact.name),
      ['Craig Other', 'Michael Phillips'],
    );
    assert.ok(plan.issues.some((i) => i.kind === 'shared-email' && !i.blocking));
    assert.deepEqual(plan.blockers, []);
  });

  test('one cell under two emails: both granted, secretary WhatsApp suppressed (no double message)', () => {
    const chair = contact('Sam One', 'sam@example.com', '078 000 0009');
    const sec = contact('Sam Two', 'sam.two@example.com', '0780000009');
    const plan = buildPlan(inputs({ records: [rec(A, chair, sec)] }));
    assert.equal(plan.people.length, 2);
    const [c, s] = plan.people;
    assert.equal(c.channels.find((x) => x.channel === 'whatsapp')?.status, 'send');
    const wa = s.channels.find((x) => x.channel === 'whatsapp');
    assert.equal(wa?.status, 'skip');
    assert.match(wa?.reason ?? '', /cell shared with sam@example\.com/);
    assert.equal(s.channels.find((x) => x.channel === 'email')?.status, 'send');
    assert.ok(plan.issues.some((i) => i.kind === 'shared-cell'));
  });

  test('pickPrimaryIndex falls back to the first named row', () => {
    assert.equal(pickPrimaryIndex('info@club.test', [{ name: '' }, { name: 'Zed' }]), 1);
    assert.equal(pickPrimaryIndex('zz@club.test', [{ name: '' }]), 0);
  });
});

describe('email-only fallbacks + missing fields', () => {
  test('a landline (016…) rides email only; the confirm channel set drops WhatsApp and blanks the cell', () => {
    const chair = contact('Lan Line', 'lan@example.com', '016 000 0000');
    const plan = buildPlan(inputs({ records: [rec(A, chair, BEN())] }));
    const p = plan.people[0];
    assert.deepEqual(
      p.channels.map((c) => `${c.channel}:${c.status}${c.reason ? `(${c.reason})` : ''}`),
      ['email:send', 'whatsapp:skip(landline?)'],
    );
    assert.deepEqual(effectiveInviteChannels(p), { channels: ['email'], cell: '' });
    assert.ok(plan.issues.some((i) => i.kind === 'landline'));
    assert.equal(summarizePlan(plan).emailOnly, 1);
  });

  test('an officer with details but no usable email is a BLOCKER, not a crash or a plan entry', () => {
    const sec = contact('No Mail', 'not-an-email', '082 000 0003');
    const plan = buildPlan(inputs({ records: [rec(A, ADA(), sec)] }));
    assert.equal(plan.people.length, 1);
    assert.ok(plan.blockers.some((b) => /No Mail has no usable email/.test(b)));
  });

  test('a blank officer is reported and its slot left empty — not a blocker', () => {
    const plan = buildPlan(inputs({ records: [rec(A, ADA(), contact('', '', ''))] }));
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.people.length, 1);
    assert.ok(plan.issues.some((i) => i.kind === 'blank-officer' && /secretary/.test(i.detail)));
  });

  test("the parser's multi-email warning is surfaced as a form-warning note", () => {
    const multi = normalizeEmail('first@example.com / second@example.com');
    assert.equal(multi.email, 'first@example.com');
    const sec = { name: 'Multi', email: multi.email, cell: normalizeCell('0820000004') };
    const plan = buildPlan(
      inputs({ records: [rec(A, ADA(), sec, [`secretary email: ${multi.warning}`])] }),
    );
    assert.ok(plan.issues.some((i) => i.kind === 'form-warning'));
    assert.ok(plan.people.some((p) => p.email === 'first@example.com'));
  });
});

describe('club coverage', () => {
  test('clubs with no affiliation response are reported as having no contacts', () => {
    const plan = buildPlan(inputs({ records: [rec(A, ADA(), BEN())] }));
    const ids = new Set(plan.clubsWithoutContacts.map((c) => c.id));
    for (const c of NON_AFFILIATED) assert.ok(ids.has(c.id), `${c.id} reported`);
    assert.ok(!ids.has(A.id));
  });

  test('an affiliated club missing from the stage blocks; --skip-club lifts it and drops its people', () => {
    const records = [rec(A, ADA(), BEN())];
    const blocked = buildPlan(inputs({ records, liveClubs: live([B]) }));
    assert.ok(blocked.blockers.some((b) => /not on this stage/.test(b)));
    assert.equal(blocked.people.length, 0);
    const skipped = buildPlan(inputs({ records, liveClubs: live([B]), skipClubs: [A.name] }));
    assert.deepEqual(skipped.blockers, []);
    assert.deepEqual(skipped.skippedClubs, [A.name]);
  });

  test('a parser-rejected row and an unknown --club are blockers', () => {
    const plan = buildPlan({
      ...inputs({ records: [] }),
      parsed: parsed([], [{ rowNumber: 9, rawClubName: 'Mystery CC', reason: 'unknown' }]),
      onlyClub: 'nope',
    });
    assert.ok(plan.blockers.some((b) => /row 9/.test(b)));
    assert.ok(plan.blockers.some((b) => /--club "nope"/.test(b)));
  });

  test('the same person on two clubs is one invite with both clubs granted', () => {
    const plan = buildPlan(
      inputs({ records: [rec(A, ADA(), BEN()), rec(B, ADA(), contact('', '', ''))] }),
    );
    const ada = plan.people.find((p) => p.email === 'ada@example.com')!;
    assert.deepEqual(ada.sheetClubIds, [A.id, B.id]);
    assert.equal(ada.sendMarkerClubId, A.id);
  });
});

describe('--data-only', () => {
  test('grants memberships but plans no send, no origin blocker, and no dry-run refusal', () => {
    const plan = buildPlan(
      inputs({ records: [rec(A, ADA(), BEN())], dataOnly: true, origin: null }),
    );
    assert.deepEqual(plan.blockers, []);
    for (const p of plan.people) {
      assert.equal(p.grant, true);
      assert.equal(p.invite, false);
      assert.deepEqual(p.channels, []);
    }
    assert.deepEqual(dryRunSendRefusals(plan, { email: true, whatsapp: true }), []);
  });

  test('a missing origin IS a blocker when sends are planned', () => {
    const plan = buildPlan(inputs({ records: [rec(A, ADA(), BEN())], origin: null }));
    assert.ok(plan.blockers.some((b) => /no canonical web origin/.test(b)));
  });
});

describe('manifestPathFor', () => {
  test('stage-scoped from SST_STAGE / SST_RESOURCE_App; legacy name without a stage', () => {
    assert.equal(
      manifestPathFor({ SST_STAGE: 'dev' }),
      './lions-contacts-import-manifest.dev.json',
    );
    assert.equal(
      manifestPathFor({ SST_RESOURCE_App: JSON.stringify({ stage: 'production' }) }),
      './lions-contacts-import-manifest.production.json',
    );
    assert.equal(manifestPathFor({}), './lions-contacts-import-manifest.json');
    assert.throws(() => manifestPathFor({ SST_STAGE: '../x' }), /unsafe stage/);
  });
});

// ───────────────────────── confirm → revert round-trip ─────────────────────────

/** In-memory club store + call recorders shared by runConfirm and runRevert. */
function fakeWorld() {
  const clubs = new Map<
    string,
    { id: string; name: string; exco: Record<string, unknown>; version: number }
  >();
  for (const c of AFFILIATED.slice(0, 2))
    clubs.set(c.id, { id: c.id, name: c.name, exco: {}, version: 1 });
  const sends: Array<{ email: string; channels: string[]; cell: string; link: string }> = [];
  const grants: Array<{ email: string; clubIds: string[] }> = [];
  const restores: Array<{ sub: string; prior: unknown }> = [];
  const repo = {
    listClubs: async () => [...clubs.values()],
    getTenantConfig: async () => null,
    getClub: async (_t: string, id: string) => {
      const c = clubs.get(id);
      return c ? structuredClone(c) : null;
    },
    updateClub: async (
      _t: string,
      id: string,
      patch: { exco?: Record<string, unknown>; version?: number },
    ) => {
      const c = clubs.get(id)!;
      assert.equal(patch.version, c.version, 'write carries the read version');
      if (patch.exco) c.exco = patch.exco;
      c.version++;
      return c as never;
    },
    getUser: async () => null,
    claimInviteSend: async () => null,
    completeInviteSend: async () => {},
    releaseInviteClaim: async () => {},
    appendClubCommEvents: async () => {},
  } as unknown as FakeRepo;
  const confirmDeps: ConfirmDeps = {
    grantClubRep: (async (
      _c: unknown,
      _p: string,
      _t: string,
      email: string,
      clubIds: string[],
    ) => {
      grants.push({ email, clubIds });
      return { sub: `sub-${email}`, clubIds };
    }) as never,
    getUserSubByEmail: (async () => null) as never,
    sendStaffInvite: (async (a: {
      email: string;
      channels: string[];
      cell: string;
      link: string;
    }) => {
      sends.push({ email: a.email, channels: a.channels, cell: a.cell, link: a.link });
      return { results: a.channels.map((channel) => ({ channel, status: 'sent', to: a.email })) };
    }) as never,
    orgCopy: (() => ({ name: 'Central Gauteng Lions' })) as never,
    dryRun: { email: false, whatsapp: false },
  };
  const revertDeps: RevertDeps = {
    restoreMembership: (async (sub: string, _t: string, prior: unknown) => {
      restores.push({ sub, prior });
      return { offboarded: true, adminDelta: 0 };
    }) as never,
  };
  return { clubs, repo, confirmDeps, revertDeps, sends, grants, restores };
}

function args(manifest: string, over: Partial<Args> = {}): Args {
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
    ...over,
  };
}

describe('runConfirm / runRevert — manifest round-trip', () => {
  test('confirm writes slots + grants + sends and records them; revert restores exactly that', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lions-contacts-'));
    const manifest = join(tmp, 'manifest.json');
    const w = fakeWorld();
    const landlineChair = contact('Lan Line', 'lan@example.com', '016 000 0000');
    // B already has the secretary slot held by an unrelated manual entry — sec on B is not ours.
    w.clubs.get(B.id)!.exco = { sec: { name: 'Manual', email: 'manual@example.com' } };
    try {
      const plan = buildPlan(
        inputs({
          records: [rec(A, landlineChair, BEN())],
          liveClubs: [...w.clubs.values()],
        }),
      );
      assert.deepEqual(plan.blockers, []);
      await runConfirm(w.repo, {} as never, 'pool', plan, args(manifest), w.confirmDeps);

      assert.deepEqual(Object.keys(w.clubs.get(A.id)!.exco).sort(), ['chair', 'sec']);
      assert.deepEqual(w.clubs.get(A.id)!.exco.chair, {
        name: 'Lan Line',
        email: 'lan@example.com',
        cell: '0160000000',
      });
      assert.deepEqual(
        w.grants.map((g) => g.email),
        ['lan@example.com', 'ben@example.com'],
      );
      // Landline chair: email only, blank cell. Link is the plan origin.
      assert.deepEqual(w.sends[0], {
        email: 'lan@example.com',
        channels: ['email'],
        cell: '',
        link: 'https://lions.example.test',
      });
      assert.deepEqual(w.sends[1].channels, ['email', 'whatsapp']);

      const entries = JSON.parse(readFileSync(manifest, 'utf8')) as Array<{
        email: string;
        granted: boolean;
        excoWrites: Array<{ clubId: string; slot: string; priorValue: unknown }>;
      }>;
      assert.deepEqual(
        entries.map((e) => [e.email, e.granted, e.excoWrites.map((x) => `${x.clubId}:${x.slot}`)]),
        [
          ['lan@example.com', true, [`${A.id}:chair`]],
          ['ben@example.com', true, [`${A.id}:sec`]],
        ],
      );

      await runRevert(w.repo, args(manifest, { revert: true }), w.revertDeps);
      assert.deepEqual(w.clubs.get(A.id)!.exco, {}, 'both slots removed (prior was empty)');
      assert.deepEqual(
        w.clubs.get(B.id)!.exco,
        { sec: { name: 'Manual', email: 'manual@example.com' } },
        'an untouched club is left alone',
      );
      assert.deepEqual(w.restores, [
        { sub: 'sub-lan@example.com', prior: null },
        { sub: 'sub-ben@example.com', prior: null },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--data-only grants + writes slots with ZERO sends, and revert undoes the grant', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lions-contacts-'));
    const manifest = join(tmp, 'manifest.json');
    const w = fakeWorld();
    // Notify fully dry-run: --data-only must not trip the send guard.
    w.confirmDeps.dryRun = { email: true, whatsapp: true };
    try {
      const plan = buildPlan(
        inputs({
          records: [rec(A, ADA(), BEN())],
          liveClubs: [...w.clubs.values()],
          dataOnly: true,
          origin: null,
        }),
      );
      await runConfirm(
        w.repo,
        {} as never,
        'pool',
        plan,
        args(manifest, { dataOnly: true }),
        w.confirmDeps,
      );
      assert.equal(w.sends.length, 0);
      assert.equal(w.grants.length, 2);
      assert.ok(w.clubs.get(A.id)!.exco.chair);

      await runRevert(w.repo, args(manifest, { revert: true }), w.revertDeps);
      assert.equal(w.restores.length, 2);
      assert.deepEqual(w.clubs.get(A.id)!.exco, {});
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a dry-run notify channel refuses --confirm BEFORE any write when sends are planned', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lions-contacts-'));
    const w = fakeWorld();
    w.confirmDeps.dryRun = { email: true, whatsapp: false };
    try {
      const plan = buildPlan(
        inputs({ records: [rec(A, ADA(), BEN())], liveClubs: [...w.clubs.values()] }),
      );
      await assert.rejects(
        runConfirm(w.repo, {} as never, 'pool', plan, args(join(tmp, 'm.json')), w.confirmDeps),
        /email channel is in notify dry-run/,
      );
      assert.equal(w.grants.length, 0);
      assert.deepEqual(w.clubs.get(A.id)!.exco, {});
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('extractInvitees', () => {
  test('two officers per club, in chairman-then-secretary order', () => {
    const { invitees } = extractInvitees(parsed([rec(A, ADA(), BEN())]));
    assert.deepEqual(
      invitees.map((i) => [i.role, i.slot, i.email]),
      [
        ['chairman', 'chair', 'ada@example.com'],
        ['secretary', 'sec', 'ben@example.com'],
      ],
    );
  });
});
