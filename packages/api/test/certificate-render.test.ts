/**
 * Certificate rendering: both templates produce parseable single-page PDFs of the right page
 * size (with and without a logo, and with maximal-length names/contact), text fitting always
 * lands inside its width budget, logo sniffing, approval copy, and the template/orgContact
 * config resolvers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { renderClassic } from '../src/certificates/render-classic.js';
import { renderConfirmation } from '../src/certificates/render-confirmation.js';
import {
  accentColor,
  approvalCopy,
  buildApprovals,
  fitText,
  qrPng,
  resolveLogo,
  sniffImage,
  truncateToWidth,
  wrapText,
  type CertificateView,
} from '../src/certificates/render-common.js';
import {
  resolveCertTemplate,
  validateCertTemplate,
  validateOrgContact,
} from '../src/certificates/config.js';
import type { PlayerClearance } from '../src/types.js';

const LONG_NAME =
  'Maximiliano Alexander Bartholomew Wolfeschlegelsteinhausenbergerdorff Senior The Third';
const LONG_CLUB =
  'Hollywoodbets Chatsworth Sporting and Recreational Cricket Club Incorporated of KwaZulu-Natal North Coast';

async function view(overrides: Partial<CertificateView> = {}): Promise<CertificateView> {
  const verifyUrl = 'https://platform.club.example/verify/SC-TRF-ABCDE-FGHJK-MNPQR-STVWX';
  return {
    template: 'classic',
    serial: 'SC-TRF-ABCDE-FGHJK-MNPQR-STVWX',
    issuedAt: '2026-09-29T10:00:00.000Z',
    orgName: 'Test Cricket Union',
    logo: null,
    accent: accentColor({}),
    playerName: 'Test Player',
    idNumber: '9001015009087',
    idType: 'sa-id',
    dob: '1990-01-01',
    fromClubName: 'Alpha CC',
    toClubName: 'Beta CC',
    effectiveDate: '2026-09-29',
    origin: 'request',
    transferring: { kind: 'club', by: 'rep@alpha.test', at: '2026-09-29T09:00:00.000Z' },
    acquiring: { kind: 'club', by: 'rep@beta.test', at: '2026-09-20T09:00:00.000Z' },
    verifyUrl,
    qrPng: await qrPng(verifyUrl),
    ...overrides,
  };
}

async function pages(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getSize());
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('renderers', () => {
  test('classic → one landscape A4 page', async () => {
    const sizes = await pages(await renderClassic(await view()));
    assert.equal(sizes.length, 1);
    assert.ok(sizes[0].width > sizes[0].height);
    assert.ok(Math.abs(sizes[0].width - 841.89) < 0.01);
  });

  test('confirmation → one portrait A4 page', async () => {
    const sizes = await pages(await renderConfirmation(await view({ template: 'confirmation' })));
    assert.equal(sizes.length, 1);
    assert.ok(sizes[0].height > sizes[0].width);
    assert.ok(Math.abs(sizes[0].height - 841.89) < 0.01);
  });

  test('both survive maximal-length names, a full contact footer, a logo and non-Latin text', async () => {
    const worst = await view({
      playerName: `${LONG_NAME} 名前 Łukasz`,
      fromClubName: LONG_CLUB,
      toClubName: `${LONG_CLUB} Veterans`,
      team: LONG_CLUB,
      orgName: `${LONG_CLUB} Union`,
      orgContact: {
        regNo: '2001/012345/08',
        address: `${LONG_CLUB}, 2 Kingsmead Close, Stamford Hill Road, Durban Central 4001`,
        phone: '+27 31 335 4200',
        website: 'https://example-union-with-a-long-domain.example.co.za',
        email: 'secretary.general.office@example-union-with-a-long-domain.example.co.za',
      },
      transferring: {
        kind: 'club',
        by: `${'x'.repeat(80)}@example.co.za`,
        at: '2026-09-29T09:00:00.000Z',
      },
      logo: { bytes: new Uint8Array(PNG_1PX), kind: 'png' },
    });
    for (const render of [renderClassic, renderConfirmation]) {
      const sizes = await pages(await render(worst));
      assert.equal(sizes.length, 1);
    }
  });

  test('a corrupt logo degrades to the wordmark instead of failing', async () => {
    const bad = await view({
      logo: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]), kind: 'png' },
    });
    assert.equal((await pages(await renderClassic(bad))).length, 1);
    assert.equal((await pages(await renderConfirmation(bad))).length, 1);
  });
});

describe('text fitting', () => {
  test('truncateToWidth and fitText never exceed the budget', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const width of [40, 120, 300]) {
      const t = truncateToWidth(font, LONG_CLUB, 10, width);
      assert.ok(font.widthOfTextAtSize(t, 10) <= width, `${t} fits ${width}`);
      assert.ok(t.endsWith('…'));
      const f = fitText(font, LONG_CLUB, 18, 9, width);
      assert.ok(f.size >= 9 && f.size <= 18);
      assert.ok(font.widthOfTextAtSize(f.text, f.size) <= width);
    }
    assert.equal(truncateToWidth(font, 'Short', 10, 300), 'Short');
    assert.deepEqual(fitText(font, 'Short', 18, 9, 300), { text: 'Short', size: 18 });
  });

  test('fitText shrinks before it truncates', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const text = 'Alpha Beta Gamma Delta';
    const w = font.widthOfTextAtSize(text, 18);
    const f = fitText(font, text, 18, 9, w * 0.8);
    assert.equal(f.text, text);
    assert.ok(f.size < 18);
  });

  test('wrapText caps lines and ellipsises the last', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = wrapText(font, `${LONG_CLUB} `.repeat(10), 9, 200, 3);
    assert.equal(lines.length, 3);
    assert.ok(lines[2].endsWith('…'));
    for (const l of lines) assert.ok(font.widthOfTextAtSize(l, 9) <= 200);
  });
});

describe('logos', () => {
  test('sniffImage accepts PNG/JPEG only', () => {
    assert.equal(sniffImage(new Uint8Array(PNG_1PX)), 'png');
    assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0])), 'jpg');
    assert.equal(
      sniffImage(new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))),
      null,
    );
  });

  test('resolveLogo falls back to null for an empty, SVG or unreachable logo', async () => {
    assert.equal(await resolveLogo('', undefined), null);
    assert.equal(await resolveLogo('/favicon.svg', undefined), null);
    assert.equal(await resolveLogo('/does-not-exist.png', undefined), null);
  });

  test('resolveLogo reads a relative SPA asset from public/', async () => {
    const logo = await resolveLogo('/dolphins-logo.png', undefined);
    assert.equal(logo?.kind, 'png');
  });
});

describe('approval copy', () => {
  const base = {
    id: 'c',
    playerNaturalKey: 'nk',
    playerName: 'P',
    fromClubId: 'a',
    toClubId: 'b',
    fromClubName: 'A',
    toClubName: 'B',
    requestedAt: '2026-09-01T08:00:00.000Z',
    feesCleared: true,
    misconductCleared: true,
    version: 1,
  } as PlayerClearance;

  test('club approval with a recorded official', () => {
    const a = buildApprovals({
      ...base,
      status: 'approved',
      clubApprovedAt: '2026-09-29T09:00:00.000Z',
      clubApprovedBy: 'rep@a.test',
      requestedBy: 'rep@b.test',
    });
    assert.deepEqual(a.transferring, {
      kind: 'club',
      by: 'rep@a.test',
      at: '2026-09-29T09:00:00.000Z',
    });
    assert.equal(a.acquiring.kind, 'club');
  });

  test('pre-feature club approval says the official was not recorded', () => {
    const a = buildApprovals({
      ...base,
      status: 'approved',
      clubApprovedAt: '2026-08-01T09:00:00.000Z',
    });
    assert.equal(a.transferring.kind, 'not-recorded');
    assert.match(
      approvalCopy(a.transferring, 'transferring').summary,
      /^Approving official not recorded · 1 August 2026$/,
    );
  });

  test('override is issued by the union office; registration origin reads as self-registration', () => {
    const a = buildApprovals({
      ...base,
      status: 'admin-override',
      origin: 'registration',
      adminOverrideAt: '2026-09-29T09:00:00.000Z',
      overriddenBy: 'admin@union.test',
    });
    assert.equal(a.transferring.kind, 'admin');
    assert.match(approvalCopy(a.transferring, 'transferring').via, /on the clubs' behalf/);
    assert.match(
      approvalCopy(a.acquiring, 'acquiring').summary,
      /^Registered via public registration/,
    );
  });

  test('historical copy for imported clearances', () => {
    const a = buildApprovals(
      { ...base, status: 'approved', clubApprovedAt: '2026-08-01T09:00:00.000Z' },
      { historical: true },
    );
    assert.equal(
      approvalCopy(a.transferring, 'transferring').summary,
      'Recorded from historical records · no digital approval on file',
    );
  });
});

describe('tenant certificate config', () => {
  test('resolveCertTemplate defaults to classic', () => {
    assert.equal(resolveCertTemplate(null), 'classic');
    assert.equal(resolveCertTemplate({}), 'classic');
    assert.equal(resolveCertTemplate({ clearanceCertTemplate: 'confirmation' }), 'confirmation');
    assert.equal(resolveCertTemplate({ clearanceCertTemplate: 'bogus' as never }), 'classic');
  });

  test('validateCertTemplate rejects unknown templates', () => {
    assert.equal(validateCertTemplate('confirmation'), 'confirmation');
    assert.throws(() => validateCertTemplate('fancy'), /clearanceCertTemplate/);
    assert.throws(() => validateCertTemplate(undefined), /clearanceCertTemplate/);
  });

  test('validateOrgContact trims, drops blanks, and rejects bad shapes', () => {
    assert.deepEqual(validateOrgContact({ regNo: ' 123 ', phone: '', email: 'a@b.c' }), {
      regNo: '123',
      email: 'a@b.c',
    });
    assert.deepEqual(validateOrgContact({}), {});
    assert.throws(() => validateOrgContact(null), /object/);
    assert.throws(() => validateOrgContact(['x']), /object/);
    assert.throws(() => validateOrgContact({ fax: '1' }), /unknown field/);
    assert.throws(() => validateOrgContact({ phone: 5 }), /must be a string/);
    assert.throws(() => validateOrgContact({ address: 'x'.repeat(201) }), /at most 200/);
  });
});
