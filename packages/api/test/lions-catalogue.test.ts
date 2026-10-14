/**
 * Lions (CGL) compliance catalogue in configure-tenant-docs.ts, plus the ppt/pptx
 * DOC_FORMAT_MIME additions it relies on. Pure — no AWS, no tenant config.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { CATALOGUES } = await import('../src/configure-tenant-docs.js');
const { validateRequiredDocs } = await import('../src/config-validation.js');
const { DOC_FORMAT_MIME, DEFAULT_DOC_FORMATS, acceptedMimes, docKeyForRole } =
  await import('../src/catalogue.js');

const LIONS = CATALOGUES.lions;
const byKey = (key: string) => LIONS.find((d: { key: string }) => d.key === key);

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PPT_MIME = 'application/vnd.ms-powerpoint';

describe('lions catalogue (configure-tenant-docs.ts)', () => {
  test('passes the same validator the operator route runs', () => {
    assert.doesNotThrow(() => validateRequiredDocs(LIONS));
  });

  test('has exactly the planned keys, none archived (fresh tenant)', () => {
    assert.deepEqual(
      LIONS.map((d: { key: string }) => d.key),
      [
        'constitution',
        'agmMinutes',
        'financials',
        'committee',
        'memberDatabase',
        'chairmansReport',
        'bankConfirmation',
        'orgRegistration',
        'beeCert',
        'clubLogo',
        'clubRecords',
      ],
    );
    assert.ok(LIONS.every((d: { archived?: boolean }) => !d.archived));
  });

  test('roles resolve to the titans-named keys', () => {
    assert.equal(docKeyForRole(LIONS, 'committee'), 'committee');
    assert.equal(docKeyForRole(LIONS, 'memberDatabase'), 'memberDatabase');
  });

  test('pptx is accepted on financials only', () => {
    assert.equal(acceptedMimes(byKey('financials'))[PPTX_MIME], 'pptx');
    for (const d of LIONS.filter((x: { key: string }) => x.key !== 'financials')) {
      assert.equal(acceptedMimes(d)[PPTX_MIME], undefined, d.key);
    }
  });

  test('bank confirmation takes phone photos; registration is pdf-only', () => {
    const bank = acceptedMimes(byKey('bankConfirmation'));
    assert.equal(bank['image/jpeg'], 'jpg');
    assert.equal(bank['image/png'], 'png');
    assert.deepEqual(Object.values(acceptedMimes(byKey('orgRegistration'))), ['pdf']);
  });

  test('escape hatches and optional records', () => {
    for (const key of ['financials', 'bankConfirmation', 'orgRegistration', 'clubLogo']) {
      assert.equal(byKey(key)?.allowUnavailable, true, key);
    }
    for (const key of ['chairmansReport', 'beeCert', 'clubLogo', 'clubRecords']) {
      assert.equal(byKey(key)?.optional, true, key);
    }
  });
});

describe('DOC_FORMAT_MIME additions (ppt + pptx)', () => {
  test('ppt/pptx resolve to their MIME types', () => {
    assert.equal(DOC_FORMAT_MIME.pptx, PPTX_MIME);
    assert.equal(DOC_FORMAT_MIME.ppt, PPT_MIME);
  });

  test('not part of the legacy default set', () => {
    assert.ok(!DEFAULT_DOC_FORMATS.includes('pptx'));
    assert.ok(!DEFAULT_DOC_FORMATS.includes('ppt'));
    assert.equal(acceptedMimes({ key: 'x', name: 'X' })[PPTX_MIME], undefined);
  });

  test('the validator accepts them in `accepts`', () => {
    assert.doesNotThrow(() =>
      validateRequiredDocs([{ key: 'deck', name: 'Deck', accepts: ['ppt', 'pptx'] }]),
    );
  });
});
