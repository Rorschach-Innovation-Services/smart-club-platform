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
