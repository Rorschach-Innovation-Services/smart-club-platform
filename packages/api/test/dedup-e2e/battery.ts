/**
 * The dedup CLI battery as one runner: each E2E-FINDINGS.md repro that a CLI run can show,
 * encoded as a named pass/fail check against the REAL CLIs (child processes) on a dynalite this
 * runner owns (:4714, never 3333/3201/4567). One fresh table per scenario.
 *   npx tsx test/dedup-e2e/battery.ts            (from packages/api)
 * Prints one line per check and a final `failing: <n>/<total>`; exits 1 when any check fails.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API_DIR, DDB_PORT, childEnv } from './env.js';

// dynalite in its OWN process: spawnSync below blocks this one's event loop.
const server = spawn('npx', ['tsx', 'test/dedup-e2e/db-server.ts'], {
  cwd: API_DIR,
  env: { ...process.env, DEDUP_E2E_DDB_PORT: String(DDB_PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise<void>((resolve, reject) => {
  server.stdout!.on('data', (b: Buffer) => b.toString().includes('dynalite on') && resolve());
  server.on('exit', (code) => reject(new Error(`db-server exited ${code}`)));
});

const ROOT = mkdtempSync(path.join(tmpdir(), 'dedup-battery-'));
let tableN = 0;
const results: Array<{ id: string; ok: boolean; detail: string }> = [];
const check = (id: string, ok: boolean, detail = '') => {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail && !ok ? `  — ${detail}` : ''}`);
};

interface Run {
  code: number;
  out: string;
}
interface Scenario {
  table: string;
  uploads: string;
  dir: string;
  m: Record<string, string> & { pairs?: unknown };
  run: (script: string, args: string[]) => Run;
  resolve: (args: string[]) => Run;
  tomb: (args: string[]) => Run;
  dump: () => Dump;
  mutate: (...ops: string[]) => Run;
}
interface Dump {
  players: Array<{
    naturalKey: string;
    clubId: string;
    placeholder?: boolean;
    [k: string]: unknown;
  }>;
  pendingSync: Array<{ sk: string; op?: string }>;
  distinct: string[];
}

function scenario(name: string): Scenario {
  const table = `DedupBattery${++tableN}`;
  const dir = path.join(ROOT, `${tableN}-${name.replace(/[^a-z0-9]/gi, '')}`);
  const uploads = path.join(dir, 'uploads');
  const env = childEnv(table, uploads);
  const run = (script: string, args: string[]): Run => {
    const r = spawnSync('npx', ['tsx', script, ...args], {
      cwd: API_DIR,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const manifest = path.join(ROOT, `${table}.manifest.json`);
  const seeded = run('test/dedup-e2e/seed.ts', [name, manifest]);
  if (seeded.code !== 0) throw new Error(`seed ${name} failed:\n${seeded.out}`);
  const m = JSON.parse(readFileSync(manifest, 'utf8'));
  return {
    table,
    uploads,
    dir,
    m,
    run,
    resolve: (args) => run('src/resolve-duplicate-players.ts', ['--tenant', 'dolphins', ...args]),
    tomb: (args) => run('src/tombstone-deleted-players.ts', args),
    dump: () => {
      const f = path.join(ROOT, `${table}.dump.json`);
      run('test/dedup-e2e/inspect.ts', [f]);
      return JSON.parse(readFileSync(f, 'utf8')) as Dump;
    },
    mutate: (...ops) => run('test/dedup-e2e/mutate.ts', [manifest, ...ops]),
  };
}

type Entry = {
  id: string;
  status: string;
  naturalKeys: string[];
  action: string;
  kind: string;
  rows: Array<{ naturalKey: string; clubId: string }>;
  blockedBy?: string[];
};
type File = { tenant: string; entries: Entry[] };
const readJson = <T>(f: string): T => JSON.parse(readFileSync(f, 'utf8')) as T;
const has = (d: Dump, nk: string, clubId?: string) =>
  d.players.some((p) => p.naturalKey === nk && (!clubId || p.clubId === clubId));
const byKey = (f: File, nk: string) =>
  f.entries.find((e) => e.naturalKeys.includes(nk) && e.kind === 'name-dob-group')!;
const writeDecisions = (s: Scenario, f: File, name = 'edited.json') => {
  const p = path.join(s.dir, name);
  writeFileSync(p, JSON.stringify(f, null, 2));
  return p;
};
const plan = (s: Scenario, out = path.join(s.dir, 'out'), extra: string[] = []) => {
  const r = s.resolve(['--out', out, ...extra]);
  return {
    r,
    file: existsSync(path.join(out, 'decisions.json'))
      ? readJson<File>(path.join(out, 'decisions.json'))
      : null,
    out,
  };
};
const confirm = (s: Scenario, decisions: string, out = path.join(s.dir, 'out')) =>
  s.resolve(['--out', out, '--confirm', '--decisions', decisions]);
/** Only the named entries act; everything else skip. */
const only = (f: File, acts: Record<string, string>): File => ({
  ...f,
  entries: f.entries.map((e) => ({ ...e, action: acts[e.id] ?? 'skip' })),
});

try {
  // ── main: plan shape ──
  {
    const s = scenario('main');
    const { r, file } = plan(s);
    check('plan exits 0', r.code === 0, r.out);
    const H = byKey(file!, s.m.SHA_H);
    check('B1 plan: partly-distinct group is not PROPOSED', H.status !== 'PROPOSED', H.status);
    const I = byKey(file!, s.m.SHA_I);
    check(
      'B9 plan: survivor placeholder does not force NEEDS-CHOICE',
      I.status === 'PROPOSED',
      I.status,
    );
    const md = readFileSync(path.join(s.dir, 'out', 'decisions-review.md'), 'utf8');
    const firstNeeds = md.search(/\n## [^\n]*NEEDS-CHOICE/);
    const firstProposed = md.search(/\n## [^\n]*· PROPOSED/);
    check(
      'U1 md: NEEDS-CHOICE entries come before PROPOSED',
      firstNeeds >= 0 && firstNeeds < firstProposed,
    );
    check(
      'U8 md: no "proposed action: `skip`" on undecided entries',
      !/proposed action: `skip`/.test(md),
    );
    const F = byKey(file!, s.m.SHA_F);
    check(
      'C4 plan: clearance blocker names the clubs',
      /Westville CC/.test(F.blockedBy?.join(' ') ?? ''),
      JSON.stringify(F.blockedBy),
    );

    // B11: a re-plan never overwrites an edited decisions.json
    const p = path.join(s.dir, 'out', 'decisions.json');
    writeFileSync(
      p,
      readFileSync(p, 'utf8').replace('"generatedAt"', '"edited": true, "generatedAt"'),
    );
    const again = s.resolve(['--out', path.join(s.dir, 'out')]);
    check(
      'B11 re-plan into the same --out refused (exit 2)',
      again.code === 2,
      `exit ${again.code}`,
    );
    check('B11 edited decisions.json kept', readFileSync(p, 'utf8').includes('"edited": true'));
    const forced = s.resolve(['--out', path.join(s.dir, 'out'), '--force']);
    check(
      'B11 --force overwrites',
      forced.code === 0 && !readFileSync(p, 'utf8').includes('"edited"'),
      forced.out,
    );

    // B1 confirm: forcing a merge across a distinct pair is refused at execute time
    const f1 = readJson<File>(p);
    const h = byKey(f1, s.m.SHA_H);
    const b1 = confirm(
      s,
      writeDecisions(s, only(f1, { [h.id]: `merge-into:${s.m.SHA_H}` }), 'b1.json'),
      path.join(s.dir, 'out-b1'),
    );
    const d1 = s.dump();
    check('B1 confirm: distinct-marked key survives a forced merge', has(d1, s.m.SLUG_H1), b1.out);
    check('B1 confirm: exit 4 (refused)', b1.code === 4, `exit ${b1.code}`);

    // B3: merge into the legacy slug when a sha key exists → refused, sha rows intact
    const i = byKey(f1, s.m.SHA_I);
    const b3 = confirm(
      s,
      writeDecisions(s, only(f1, { [i.id]: `merge-into:${s.m.SLUG_I}` }), 'b3.json'),
      path.join(s.dir, 'out-b3'),
    );
    const d3 = s.dump();
    check('B3 slug survivor refused; sha row kept', has(d3, s.m.SHA_I, 'durban-hc'), b3.out);

    // B4: one malformed entry aborts everything, exit 2
    const a = byKey(f1, s.m.SHA_A);
    const c = byKey(f1, s.m.SHA_C);
    const b4 = confirm(
      s,
      writeDecisions(
        s,
        only(f1, { [a.id]: `merge-into:${s.m.SHA_A}`, [c.id]: 'merge' }),
        'b4.json',
      ),
      path.join(s.dir, 'out-b4'),
    );
    check('B4 bad action → exit 2', b4.code === 2, `exit ${b4.code}`);
    check('B4 bad action → nothing applied', has(s.dump(), s.m.SLUG_A), b4.out);

    // B16 / C5 / C6: decisions file shape
    const bad = (body: string, n: string) => {
      const f = path.join(s.dir, n);
      writeFileSync(f, body);
      return confirm(s, f, path.join(s.dir, `out-${n}`));
    };
    const e1 = bad('[]', 'arr.json');
    check(
      'B16 `[]` → exit 2 with a shape message',
      e1.code === 2 && !/undefined/.test(e1.out),
      e1.out,
    );
    const e2 = bad(JSON.stringify({ tenant: 'dolphins', generatedAt: 'x' }), 'noentries.json');
    check('B16 missing entries → exit 2', e2.code === 2 && !/not iterable/.test(e2.out), e2.out);
    const e3 = bad(
      JSON.stringify({
        ...f1,
        entries: f1.entries.map((e) => ({ ...e, action: 'skip', purgeCertificates: 'yes' })),
      }),
      'purge.json',
    );
    check('B16 purgeCertificates "yes" → exit 2', e3.code === 2, e3.out);
    const e4 = bad('{ "tenant": ', 'syntax.json');
    check(
      'C5 JSON syntax error names the file',
      e4.out.includes('syntax.json') && e4.code === 2,
      e4.out,
    );

    // Exit 4: a live refusal (BLOCKED F) next to an applied merge
    const f = byKey(f1, s.m.SHA_F);
    const x4 = confirm(
      s,
      writeDecisions(
        s,
        only(f1, { [a.id]: `merge-into:${s.m.SHA_A}`, [f.id]: `merge-into:${s.m.SHA_F}` }),
        'x4.json',
      ),
      path.join(s.dir, 'out-x4'),
    );
    check('exit 4 when some entries are refused', x4.code === 4, `exit ${x4.code}`);
    check(
      'C10 summary names the refused group',
      new RegExp(`Refused[\\s\\S]*${f.id}`).test(x4.out.slice(x4.out.lastIndexOf('\nmerged '))),
      x4.out.slice(-400),
    );
    check(
      'C11 next step names tombstone-deleted-players',
      /tombstone-deleted-players/.test(x4.out),
    );
    check('C12 progress prefix', /\[\d+\/\d+\]/.test(x4.out));
    const dA = s.dump();
    check('A merged: slug gone, doc on disk', !has(dA, s.m.SLUG_A) && existsSync(s.m.docA));

    // B8: conflicting values reported (C battingHand Right vs Left; V veterans club)
    const v = byKey(f1, s.m.SHA_V);
    const b8 = confirm(
      s,
      writeDecisions(
        s,
        only(f1, { [c.id]: `merge-into:${s.m.SHA_C}`, [v.id]: `merge-into:${s.m.SHA_V}` }),
        'b8.json',
      ),
      path.join(s.dir, 'out-b8'),
    );
    check('B8 battingHand conflict logged', /conflict[^\n]*battingHand/i.test(b8.out), b8.out);
    check('B8 veterans-club conflict named', /veterans[^\n]*KZN Veterans/i.test(b8.out), b8.out);

    // B9: merge into the sha survivor that also has a placeholder elsewhere
    const b9 = confirm(
      s,
      writeDecisions(s, only(f1, { [i.id]: `merge-into:${s.m.SHA_I}` }), 'b9.json'),
      path.join(s.dir, 'out-b9'),
    );
    const d9 = s.dump();
    check(
      'B9 merge applies; placeholder untouched',
      !has(d9, s.m.SLUG_I) && has(d9, s.m.SHA_I, 'northwood'),
      b9.out,
    );

    // B13: re-applying `distinct` is a no-op (no new backup)
    const dE = byKey(f1, s.m.SHA_E1);
    const dd = writeDecisions(s, only(f1, { [dE.id]: 'distinct' }), 'distinct.json');
    const outD = path.join(s.dir, 'out-distinct');
    confirm(s, dd, outD);
    const d2 = confirm(s, dd, outD);
    const backups = readdirSync(outD).filter((n) => n.startsWith('backup-'));
    check(
      'B13 distinct re-run writes no second backup',
      backups.length === 1,
      `${backups.length} backups; ${d2.out.slice(-200)}`,
    );

    // C7 --help
    const help = s.resolve(['--help']);
    check('C7 --help exits 0', help.code === 0, `exit ${help.code}`);
  }

  // ── B5: data drift between plan and confirm ──
  {
    const s = scenario('main');
    const { file } = plan(s);
    s.mutate('new-slug-a', 'stale-b-at-umhlali');
    const a = byKey(file!, s.m.SHA_A);
    const b = byKey(file!, s.m.SHA_B);
    const r = confirm(
      s,
      writeDecisions(
        s,
        only(file!, { [a.id]: `merge-into:${s.m.SHA_A}`, [b.id]: `merge-into:${s.m.SHA_B}` }),
      ),
    );
    const d = s.dump();
    check('B5a new identity after plan → group refused', has(d, s.m.SLUG_A), r.out);
    check('B5b stale key live elsewhere → group refused', has(d, s.m.SLUG_B, 'crusaders'), r.out);
    const del = path.join(s.dir, 'out', 'deleted-nks.json');
    const recorded = existsSync(del)
      ? readJson<Array<{ naturalKey: string }>>(del).map((x) => x.naturalKey)
      : [];
    check('B5b live key never recorded deleted', !recorded.includes(s.m.SLUG_B));
  }

  // ── B2: deleted-nks.json not writable ──
  {
    const s = scenario('main');
    const { file } = plan(s);
    const out = path.join(s.dir, 'out');
    const del = path.join(out, 'deleted-nks.json');
    writeFileSync(del, '[]');
    chmodSync(del, 0o400);
    const a = byKey(file!, s.m.SHA_A);
    const dec = writeDecisions(s, only(file!, { [a.id]: `merge-into:${s.m.SHA_A}` }));
    const r1 = confirm(s, dec);
    check(
      'B2 unwritable deleted-nks → refused before any delete',
      has(s.dump(), s.m.SLUG_A),
      r1.out,
    );
    chmodSync(del, 0o600);
    confirm(s, dec);
    const recorded = readJson<Array<{ naturalKey: string }>>(del).map((x) => x.naturalKey);
    const gone = !has(s.dump(), s.m.SLUG_A);
    check(
      'B2 every deleted key is recorded',
      !gone || recorded.includes(s.m.SLUG_A),
      JSON.stringify(recorded),
    );
    // Backfill: drop the record, re-run → the "already merged" branch restores it.
    writeFileSync(del, '[]');
    confirm(s, dec);
    const back = readJson<Array<{ naturalKey: string }>>(del).map((x) => x.naturalKey);
    check(
      'B2 already-merged branch backfills a missing record',
      back.includes(s.m.SLUG_A),
      JSON.stringify(back),
    );
  }

  // ── tombstone CLI ──
  {
    const s = scenario('main');
    const { file } = plan(s);
    const acts: Record<string, string> = {};
    for (const k of ['SHA_A', 'SHA_B', 'SHA_C', 'SHA_V'])
      acts[byKey(file!, s.m[k]).id] = `merge-into:${s.m[k]}`;
    confirm(s, writeDecisions(s, only(file!, acts)));
    const del = path.join(s.dir, 'out', 'deleted-nks.json');
    const dry0 = s.tomb(['--tenant', 'dolphins', '--deleted', del]);
    check('B14 tombstone dry run works with sync off', dry0.code === 0, dry0.out);
    check(
      'C9 sync-off message names the flags',
      /playerSync/.test(dry0.out) && /medicoachSync/.test(dry0.out),
      dry0.out,
    );
    s.mutate('sync-on');
    const dry = s.tomb(['--tenant', 'dolphins', '--deleted', del]);
    const slugs = [s.m.SLUG_A, s.m.SLUG_B, s.m.SLUG_C1, s.m.SLUG_C2, s.m.SLUG_V];
    check(
      'B6 tombstone output shows no slug fragment',
      !slugs.some((x) => dry.out.includes(x.slice(0, 8))),
      dry.out,
    );
    const conf = s.tomb(['--tenant', 'dolphins', '--deleted', del, '--confirm']);
    check('tombstone confirm exit 0', conf.code === 0, conf.out);
    s.mutate('flush-pending');
    const again = s.tomb(['--tenant', 'dolphins', '--deleted', del, '--confirm']);
    check('B15 re-run after drain re-queues nothing', /(^|\n)queued 0,/.test(again.out), again.out);

    const junk = (body: string, n: string) => {
      const f = path.join(s.dir, n);
      writeFileSync(f, body);
      return s.tomb(['--tenant', 'dolphins', '--deleted', f, '--confirm']);
    };
    const j1 = junk('[{"tenant":"dolphins"}]', 'j1.json');
    const j2 = junk('[{"tenant":"dolphins","naturalKey":"","clubIds":[]}]', 'j2.json');
    const j3 = junk('[1,2]', 'j3.json');
    const d = s.dump();
    check('B7 no-naturalKey entry → exit 2', j1.code === 2, `exit ${j1.code} ${j1.out}`);
    check('B7 empty naturalKey → exit 2', j2.code === 2, `exit ${j2.code} ${j2.out}`);
    check('B7 non-object entries → exit 2', j3.code === 2, `exit ${j3.code} ${j3.out}`);
    check(
      'B7 no junk tombstone written',
      !d.pendingSync.some(
        (p) => p.sk === 'PENDINGPLAYERSYNC#undefined' || p.sk === 'PENDINGPLAYERSYNC#',
      ),
    );
    const t10 = s.tomb(['--tenant', 'dolphinz', '--deleted', del]);
    check('B10 tombstone unknown tenant → exit 2', t10.code === 2, `exit ${t10.code} ${t10.out}`);
    const z = s.run('src/resolve-duplicate-players.ts', [
      '--tenant',
      'dolphinz',
      '--out',
      path.join(s.dir, 'out-zz'),
    ]);
    check('B10 plan unknown tenant → exit 2', z.code === 2, `exit ${z.code} ${z.out}`);
  }

  // ── empty tenant ──
  {
    const s = scenario('empty');
    const { r } = plan(s);
    check('C8 empty plan says "No duplicates found"', /No duplicates found/i.test(r.out), r.out);
  }

  // ── U2: stable ids across a partial run + re-plan ──
  {
    const s = scenario('main');
    const { file } = plan(s);
    const a = byKey(file!, s.m.SHA_A);
    confirm(s, writeDecisions(s, only(file!, { [a.id]: `merge-into:${s.m.SHA_A}` })));
    const { file: f2 } = plan(s, path.join(s.dir, 'out2'));
    const same = ['SHA_H', 'SHA_I', 'SHA_V'].every(
      (k) => byKey(file!, s.m[k]).id === byKey(f2!, s.m[k]).id,
    );
    check('U2 entry ids stable across re-plan', same);
  }
} finally {
  server.kill();
}

const failing = results.filter((r) => !r.ok);
console.log(`\nfailing: ${failing.length}/${results.length}`);
for (const f of failing) console.log(`  - ${f.id}`);
process.exit(failing.length ? 1 : 0);
