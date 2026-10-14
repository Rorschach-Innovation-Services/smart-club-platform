/**
 * Pure tests for the per-tenant compliance-doc fixes that live server-side:
 *   - `optional` records: validateRequiredDocs accepts the flag (boolean only), and the
 *     tuskers catalogue marks exactly its four archive keys optional (without the
 *     unavailable escape hatch, which the requirements keep).
 *   - the affiliation-submit exco fix, server half: a catalogue with no exco entry
 *     rejects `docs.exco` (why the client must not send it), one with it accepts it.
 *   - roleSourceFile / roleFileParseable — the one picker every role consumer reads.
 * No dynalite, no repo.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { validateRequiredDocs } = await import('../src/config-validation.js');
const { CATALOGUES } = await import('../src/configure-tenant-docs.js');
const {
  DEFAULT_REQUIRED_DOCS,
  roleSourceFile,
  roleFileParseable,
  validateClubPatch,
  activeRequiredDocs,
} = await import('../src/catalogue.js');

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF = 'application/pdf';

describe('RequiredDoc.optional validation', () => {
  test('accepts optional: true on a file doc and on a multi-file doc', () => {
    assert.doesNotThrow(() =>
      validateRequiredDocs([
        { key: 'records', name: 'Records', optional: true },
        { key: 'letters', name: 'Letters', multiFile: true, minFiles: 1, optional: true },
      ]),
    );
  });

  test('rejects a non-boolean optional', () => {
    assert.throws(
      () => validateRequiredDocs([{ key: 'records', name: 'Records', optional: 'yes' }]),
      /optional must be a boolean/,
    );
  });
});

describe('tuskers catalogue: record keys are optional', () => {
  const RECORD_KEYS = [
    'disciplinaryRecords',
    'unionCorrespondence',
    'playerRegistrations',
    'clubRecords',
  ];
  const tuskers = CATALOGUES.tuskers;

  test('still passes the operator route validator', () => {
    assert.doesNotThrow(() => validateRequiredDocs(tuskers));
  });

  test('exactly the four archive keys are optional, and none keeps allowUnavailable', () => {
    const optional = tuskers.filter((d) => d.optional).map((d) => d.key);
    assert.deepEqual(optional.sort(), [...RECORD_KEYS].sort());
    for (const k of RECORD_KEYS) {
      assert.equal(tuskers.find((d) => d.key === k)?.allowUnavailable, undefined, k);
    }
  });

  test('the requirements that may be lacking keep their unavailable escape hatch', () => {
    for (const k of ['financials', 'affiliationFees', 'clubLogo', 'facilityAgreement']) {
      assert.equal(tuskers.find((d) => d.key === k)?.allowUnavailable, true, k);
    }
  });

  test('an optional record still refuses a newly introduced unavailable sentinel', () => {
    const keys = new Set(tuskers.map((d) => d.key));
    const err = validateClubPatch(
      { docMeta: { clubRecords: { unavailable: true } } },
      new Set(),
      keys,
      new Set(),
      tuskers,
      {},
    );
    assert.match(String(err), /cannot be marked unavailable/);
  });
});

describe('affiliation submit docs.exco — server gate', () => {
  test('a catalogue without an exco entry (tuskers) rejects docs.exco', () => {
    const keys = new Set(
      activeRequiredDocs({ requiredDocs: CATALOGUES.tuskers }).map((d) => d.key),
    );
    const err = validateClubPatch({ docs: { exco: true } }, new Set(), keys, new Set());
    assert.match(String(err), /unknown document keys: exco/);
  });

  test('the default catalogue (exco form doc) accepts it', () => {
    const keys = new Set(DEFAULT_REQUIRED_DOCS.map((d) => d.key));
    assert.equal(validateClubPatch({ docs: { exco: true } }, new Set(), keys, new Set()), null);
  });
});

describe('roleFileParseable', () => {
  test('contentType wins; the extension is only a fallback', () => {
    assert.equal(roleFileParseable(XLSX, 'a/x.pdf', 'memberDatabase'), true);
    assert.equal(roleFileParseable(PDF, 'a/x.xlsx', 'memberDatabase'), false);
    assert.equal(roleFileParseable(undefined, 'a/x.XLS', 'committee'), true);
    assert.equal(roleFileParseable(undefined, 'a/x.csv', 'committee'), true);
    assert.equal(roleFileParseable(undefined, 'a/x.docx', 'committee'), false);
  });
});

describe('roleSourceFile', () => {
  const f = (objectKey: string, contentType: string | undefined, uploadedAt?: string) => ({
    objectKey,
    size: 1,
    contentType,
    uploadedAt: uploadedAt as string,
  });

  test('picks the most recently uploaded parseable file, not files[0]', () => {
    const meta = {
      files: [
        f('old.xlsx', XLSX, '2026-01-01T00:00:00Z'),
        f('scan.pdf', PDF, '2026-03-01T00:00:00Z'),
        f('new.xlsx', XLSX, '2026-02-01T00:00:00Z'),
      ],
    };
    assert.equal(roleSourceFile(meta, 'memberDatabase')?.objectKey, 'new.xlsx');
  });

  test('with no parseable file, falls back to the most recent file of any type', () => {
    const meta = {
      files: [f('a.pdf', PDF, '2026-01-01T00:00:00Z'), f('b.pdf', PDF, '2026-04-01T00:00:00Z')],
    };
    assert.equal(roleSourceFile(meta, 'committee')?.objectKey, 'b.pdf');
  });

  test('ties and missing stamps fall back to append order (later wins)', () => {
    const meta = { files: [f('first.xlsx', XLSX), f('second.xlsx', XLSX)] };
    assert.equal(roleSourceFile(meta, 'memberDatabase')?.objectKey, 'second.xlsx');
  });

  test('reads every historical shape: legacy single upload, sentinel, nothing', () => {
    assert.equal(
      roleSourceFile({ objectKey: 'solo.xlsx', size: 1 }, 'memberDatabase')?.objectKey,
      'solo.xlsx',
    );
    assert.equal(roleSourceFile({ markedCompliant: true }, 'memberDatabase'), undefined);
    assert.equal(roleSourceFile(undefined, 'memberDatabase'), undefined);
  });
});

describe('club "unavailable" declaration rides the shared docMeta machinery', () => {
  const at = '2026-08-01T00:00:00.000Z';
  const file = { objectKey: 'local/x.pdf', size: 1, uploadedAt: at };

  test('normalizeDocMeta surfaces it; docMetaValue re-wraps it with its stamp', async () => {
    const { normalizeDocMeta, docMetaValue } = await import('../src/catalogue.js');
    const norm = normalizeDocMeta({ files: [], unavailable: true, at });
    assert.equal(norm.unavailable, true);
    assert.deepEqual(docMetaValue([file], norm.markedCompliant, norm.at, norm), {
      files: [file],
      unavailable: true,
      at,
    });
    // Absent ⇒ unchanged legacy shape (no stray keys).
    const plain = normalizeDocMeta({ files: [file] });
    assert.equal(plain.unavailable, false);
    assert.deepEqual(docMetaValue([file], false, undefined, plain), { files: [file] });
  });

  test('unavailableDeclared honors the catalogue: allowed, withdrawn (stale), retired key', async () => {
    const { unavailableDeclared } = await import('../src/catalogue.js');
    const norm = { unavailable: true };
    assert.equal(unavailableDeclared(norm, { key: 'a', name: 'A', allowUnavailable: true }), true);
    assert.equal(unavailableDeclared(norm, { key: 'a', name: 'A' }), false);
    assert.equal(unavailableDeclared(norm, undefined), true);
    assert.equal(unavailableDeclared({ unavailable: false }, undefined), false);
  });

  test('tuskers compliance CLI re-run merge keeps a multi-file declaration', async () => {
    const { buildDocMetaValue, normalizeDocMeta } =
      await import('../src/import-tuskers-compliance.js');
    const norm = normalizeDocMeta({ files: [], unavailable: true, at });
    assert.deepEqual(buildDocMetaValue('financials', [file], norm), {
      files: [file],
      unavailable: true,
      at,
    });
  });

  test('titans compliance CLI re-run merge keeps a multi-file declaration', async () => {
    const { buildDocMetaValue, normalizeDocMeta } =
      await import('../src/import-titans-compliance.js');
    const norm = normalizeDocMeta({ files: [], unavailable: true, at });
    assert.deepEqual(buildDocMetaValue('facilityAgreement', [file], norm), {
      files: [file],
      unavailable: true,
      at,
    });
  });
});

describe('titans catalogue: safeguardingCoaching (Oct 2026 top-up)', () => {
  const titans = CATALOGUES.titans;
  const def = titans.find((d) => d.key === 'safeguardingCoaching');

  test('still passes the operator route validator', () => {
    assert.doesNotThrow(() => validateRequiredDocs(titans));
  });

  test('is optional, multiFile and accepts images (the PECC coaching cert is a .jpg)', () => {
    assert.ok(def);
    assert.equal(def.optional, true);
    assert.equal(def.multiFile, true);
    assert.equal(def.minFiles, 1);
    assert.ok((def.maxFiles ?? 0) >= 2);
    for (const ext of ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png']) {
      assert.ok(def.accepts?.includes(ext as never), ext);
    }
    assert.equal(def.archived, undefined);
  });

  test('the archived `safeguarding` key is untouched (minFiles 2 would flip every club)', () => {
    const old = titans.find((d) => d.key === 'safeguarding');
    assert.deepEqual(old, {
      key: 'safeguarding',
      name: 'Safeguarding certificates (retired)',
      desc: 'Not part of the Titans 2026-27 requirements',
      multiFile: true,
      minFiles: 2,
      maxFiles: 10,
      allowCourseBooked: true,
      archived: true,
    });
  });

  test('is excluded from completion (optional) but present in the active catalogue', () => {
    const active = activeRequiredDocs({ requiredDocs: titans });
    assert.ok(active.some((d) => d.key === 'safeguardingCoaching'));
  });

  test('every key the titans import writes is in the titans catalogue', async () => {
    const { TITANS_DOC_KEYS } = await import('../src/titans-import-map.js');
    const keys = new Set(titans.map((d) => d.key));
    for (const k of TITANS_DOC_KEYS) assert.ok(keys.has(k), k);
  });
});

describe('titans catalogueCoverageProblems — safeguardingCoaching both directions', () => {
  const base = [
    'leagueEntry',
    'assetsRegister',
    'healthTracker',
    'memberDatabase',
    'committee',
    'constitution',
    'chairmansReport',
    'financials',
  ].map((key) => ({ key, name: key }));
  const multi = (key: string, maxFiles = 10) => ({
    key,
    name: key,
    multiFile: true,
    minFiles: 1,
    maxFiles,
  });

  test('the shipped titans catalogue satisfies the import', async () => {
    const { catalogueCoverageProblems } = await import('../src/import-titans-compliance.js');
    const active = activeRequiredDocs({ requiredDocs: CATALOGUES.titans });
    assert.deepEqual(catalogueCoverageProblems(active, new Map([['safeguardingCoaching', 2]])), []);
  });

  test('forward: absent, single-file, or under-capped safeguardingCoaching is a problem', async () => {
    const { catalogueCoverageProblems } = await import('../src/import-titans-compliance.js');
    const others = [...base, multi('agm'), multi('facilityAgreement')];
    const absent = catalogueCoverageProblems(others as never, new Map());
    assert.ok(absent.some((p) => p.includes('"safeguardingCoaching" is archived or absent')));
    const single = catalogueCoverageProblems(
      [...others, { key: 'safeguardingCoaching', name: 's' }] as never,
      new Map(),
    );
    assert.ok(single.some((p) => p.includes('"safeguardingCoaching" is configured single-file')));
    const capped = catalogueCoverageProblems(
      [...others, multi('safeguardingCoaching', 1)] as never,
      new Map([['safeguardingCoaching', 2]]),
    );
    assert.ok(capped.some((p) => p.includes('"safeguardingCoaching" allows maxFiles=1')));
  });

  test('reverse: with safeguardingCoaching multi-file, a single-file key marked multiFile is still caught', async () => {
    const { catalogueCoverageProblems } = await import('../src/import-titans-compliance.js');
    const docs = [
      ...base.filter((d) => d.key !== 'financials'),
      multi('financials'),
      multi('agm'),
      multi('facilityAgreement'),
      multi('safeguardingCoaching'),
    ];
    const problems = catalogueCoverageProblems(docs as never, new Map());
    assert.ok(problems.some((p) => p.includes('"financials" is configured multiFile')));
    assert.ok(!problems.some((p) => p.includes('"safeguardingCoaching"')));
  });
});

describe('configure-tenant-docs catalogueDiff — full-definition diff', () => {
  test('reports added keys, changed attributes, removed keys and reordering', async () => {
    const { catalogueDiff } = await import('../src/configure-tenant-docs.js');
    const current = [
      { key: 'a', name: 'A', maxFiles: 6 },
      { key: 'b', name: 'B' },
      { key: 'gone', name: 'Gone' },
    ];
    const next = [
      { key: 'b', name: 'B' },
      { key: 'a', name: 'A', maxFiles: 10, accepts: ['pdf'] },
      { key: 'new', name: 'New' },
    ];
    const lines = catalogueDiff(current as never, next as never);
    assert.ok(lines.some((l) => l.startsWith('+ new:')));
    assert.ok(lines.includes('~ a: accepts: (unset) → ["pdf"]; maxFiles: 6 → 10'));
    assert.ok(lines.includes('- gone'));
    assert.ok(lines.some((l) => l.startsWith('order: a, b → b, a')));
    assert.ok(!lines.some((l) => l.startsWith('~ b')));
  });

  test('an identical catalogue is an empty diff', async () => {
    const { catalogueDiff } = await import('../src/configure-tenant-docs.js');
    assert.deepEqual(catalogueDiff(CATALOGUES.titans, CATALOGUES.titans), []);
  });
});
