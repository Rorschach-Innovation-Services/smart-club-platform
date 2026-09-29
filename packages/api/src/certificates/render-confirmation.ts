/**
 * Template "confirmation": portrait A4, form/table style, ONE page. Header (logo + org),
 * a reference/date table, PLAYER DETAILS, TRANSFER DETAILS, the two APPROVAL RECORD tables
 * (label column shaded), the confirmation paragraph, an italic system note, and the org
 * contact footer with the QR in the bottom-right corner. Built-in Helvetica throughout.
 *
 * Every cell value is width-budgeted, so a maximal-length name truncates in its cell rather
 * than spilling into the next column or pushing the page past one sheet.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import {
  INK,
  MUTED,
  approvalCopy,
  contactSegments,
  embedLogo,
  fitBox,
  fitText,
  fmtDate,
  idLabel,
  tint,
  truncateToWidth,
  wrapText,
  type CertificateView,
} from './render-common.js';

const W = 595.28;
const H = 841.89;
const M = 48;
const TABLE_W = W - 2 * M;
const LABEL_W = 170;
const ROW_H = 17;
const CELL_PAD = 7;
const QR_SIZE = 88;

const Y = (fromTop: number) => H - fromTop;

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

function table(
  page: PDFPage,
  top: number,
  rows: Array<[string, string]>,
  fonts: Fonts,
  accent: RGB,
): number {
  const line = rgb(0.78, 0.78, 0.8);
  const shade = tint(accent, 0.86);
  rows.forEach(([label, value], i) => {
    const rowTop = top + i * ROW_H;
    page.drawRectangle({
      x: M,
      y: Y(rowTop + ROW_H),
      width: LABEL_W,
      height: ROW_H,
      color: shade,
    });
    const baseline = rowTop + ROW_H - 5;
    page.drawText(truncateToWidth(fonts.bold, label, 8.5, LABEL_W - 2 * CELL_PAD), {
      x: M + CELL_PAD,
      y: Y(baseline),
      size: 8.5,
      font: fonts.bold,
      color: INK,
    });
    const valueW = TABLE_W - LABEL_W - 2 * CELL_PAD;
    const fitted = fitText(fonts.regular, value || '—', 9.5, 8, valueW);
    page.drawText(fitted.text, {
      x: M + LABEL_W + CELL_PAD,
      y: Y(baseline),
      size: fitted.size,
      font: fonts.regular,
      color: INK,
    });
  });
  const height = rows.length * ROW_H;
  page.drawRectangle({
    x: M,
    y: Y(top + height),
    width: TABLE_W,
    height,
    borderColor: line,
    borderWidth: 0.6,
  });
  for (let i = 1; i < rows.length; i++) {
    page.drawLine({
      start: { x: M, y: Y(top + i * ROW_H) },
      end: { x: M + TABLE_W, y: Y(top + i * ROW_H) },
      thickness: 0.4,
      color: line,
    });
  }
  page.drawLine({
    start: { x: M + LABEL_W, y: Y(top) },
    end: { x: M + LABEL_W, y: Y(top + height) },
    thickness: 0.4,
    color: line,
  });
  return top + height;
}

function heading(page: PDFPage, top: number, text: string, fonts: Fonts, accent: RGB): number {
  page.drawText(text, { x: M, y: Y(top + 10), size: 9.5, font: fonts.bold, color: accent });
  return top + 14;
}

export async function renderConfirmation(v: CertificateView): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Player Transfer Confirmation Certificate ${v.serial}`);
  doc.setSubject(`${v.playerName}: ${v.fromClubName} to ${v.toClubName}`);
  doc.setProducer('Smart Club platform');
  doc.setCreator(v.orgName);
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  const page = doc.addPage([W, H]);
  const accent = v.accent;

  // Header: logo left, org name + document kind right-aligned.
  const logo = await embedLogo(doc, v.logo);
  let textLeft = M;
  if (logo) {
    const box = fitBox(logo.width, logo.height, 130, 56);
    page.drawImage(logo, { x: M, y: Y(40 + box.height), ...box });
    textLeft = M + box.width + 16;
  }
  const headW = W - M - textLeft;
  const org = fitText(fonts.bold, v.orgName, 14, 9, headW);
  page.drawText(org.text, {
    x: W - M - fonts.bold.widthOfTextAtSize(org.text, org.size),
    y: Y(62),
    size: org.size,
    font: fonts.bold,
    color: INK,
  });
  const kind = 'Official player transfer record';
  page.drawText(kind, {
    x: W - M - fonts.regular.widthOfTextAtSize(kind, 9),
    y: Y(78),
    size: 9,
    font: fonts.regular,
    color: MUTED,
  });
  page.drawLine({
    start: { x: M, y: Y(106) },
    end: { x: W - M, y: Y(106) },
    thickness: 1.5,
    color: accent,
  });
  const title = 'PLAYER TRANSFER CONFIRMATION CERTIFICATE';
  page.drawText(title, {
    x: W / 2 - fonts.bold.widthOfTextAtSize(title, 15) / 2,
    y: Y(132),
    size: 15,
    font: fonts.bold,
    color: INK,
  });

  let top = 146;
  top = table(
    page,
    top,
    [
      ['Certificate Reference', v.serial],
      ['Date Issued', fmtDate(v.issuedAt)],
    ],
    fonts,
    accent,
  );

  top = heading(page, top + 10, 'PLAYER DETAILS', fonts, accent);
  const playerRows: Array<[string, string]> = [['Full Name', v.playerName]];
  if (v.idNumber) playerRows.push([idLabel(v.idType, true), v.idNumber]);
  if (v.dob) playerRows.push(['Date of Birth', fmtDate(v.dob)]);
  top = table(page, top, playerRows, fonts, accent);

  top = heading(page, top + 10, 'TRANSFER DETAILS', fonts, accent);
  const transferRows: Array<[string, string]> = [
    ['Transferring Club (From)', v.fromClubName],
    ['Acquiring Club (To)', v.toClubName],
    ['Effective Date', fmtDate(v.effectiveDate)],
    [
      'Transfer Type',
      v.origin === 'registration'
        ? 'Registration with previous-club clearance'
        : 'Inter-club transfer',
    ],
  ];
  if (v.team) transferRows.push(['League / Team', v.team]);
  top = table(page, top, transferRows, fonts, accent);

  const approvalRows = (
    club: string,
    a: ReturnType<typeof approvalCopy>,
  ): Array<[string, string]> => [
    ['Club', club],
    ['Authorised Official', a.official],
    ['Decision', a.decision],
    ['Approved Via', a.via],
    ['Date & Time', a.when],
  ];
  top = heading(page, top + 10, 'APPROVAL RECORD — TRANSFERRING CLUB', fonts, accent);
  top = table(
    page,
    top,
    approvalRows(v.fromClubName, approvalCopy(v.transferring, 'transferring')),
    fonts,
    accent,
  );
  top = heading(page, top + 10, 'APPROVAL RECORD — ACQUIRING CLUB', fonts, accent);
  top = table(
    page,
    top,
    approvalRows(v.toClubName, approvalCopy(v.acquiring, 'acquiring')),
    fonts,
    accent,
  );

  // Confirmation paragraph + system note.
  const para =
    `This certifies that ${v.playerName} has been cleared to transfer from ${v.fromClubName} ` +
    `to ${v.toClubName} with effect from ${fmtDate(v.effectiveDate)}, and is registered with ` +
    `${v.toClubName} under ${v.orgName}. The approvals above were recorded electronically, ` +
    'against authenticated accounts, on the date and time shown.';
  top += 14;
  for (const l of wrapText(fonts.regular, para, 9.5, TABLE_W, 4)) {
    top += 13;
    page.drawText(l, { x: M, y: Y(top), size: 9.5, font: fonts.regular, color: INK });
  }
  const note =
    'This certificate was generated from the electronic approval record and carries no ' +
    'handwritten signature. Confirm its authenticity by scanning the QR code or visiting the ' +
    'verification address below; the details shown there must match this document.';
  top += 6;
  for (const l of wrapText(fonts.italic, note, 8, TABLE_W, 3)) {
    top += 11;
    page.drawText(l, { x: M, y: Y(top), size: 8, font: fonts.italic, color: MUTED });
  }

  // Footer: QR bottom-right; org + contact + ref + URL to its left.
  const qr = await doc.embedPng(v.qrPng);
  const qrX = W - M - QR_SIZE;
  const qrBottom = 40;
  page.drawImage(qr, { x: qrX, y: qrBottom, width: QR_SIZE, height: QR_SIZE });
  const scan = 'Scan to verify';
  page.drawText(scan, {
    x: qrX + QR_SIZE / 2 - fonts.regular.widthOfTextAtSize(scan, 7.5) / 2,
    y: qrBottom - 10,
    size: 7.5,
    font: fonts.regular,
    color: MUTED,
  });
  const footTop = H - qrBottom - QR_SIZE;
  page.drawLine({
    start: { x: M, y: Y(footTop - 10) },
    end: { x: qrX - 14, y: Y(footTop - 10) },
    thickness: 0.6,
    color: accent,
  });
  const footW = qrX - 14 - M;
  let fy = footTop + 6;
  const orgLine = truncateToWidth(fonts.bold, v.orgName, 9, footW);
  page.drawText(orgLine, { x: M, y: Y(fy), size: 9, font: fonts.bold, color: INK });
  const contact = contactSegments(v.orgContact).join('  ·  ');
  if (contact) {
    for (const l of wrapText(fonts.regular, contact, 8, footW, 2)) {
      fy += 11;
      page.drawText(l, { x: M, y: Y(fy), size: 8, font: fonts.regular, color: MUTED });
    }
  }
  fy += 14;
  page.drawText(truncateToWidth(fonts.regular, `Certificate ref ${v.serial}`, 8, footW), {
    x: M,
    y: Y(fy),
    size: 8,
    font: fonts.regular,
    color: INK,
  });
  fy += 11;
  page.drawText(truncateToWidth(fonts.regular, `Verify at ${v.verifyUrl}`, 8, footW), {
    x: M,
    y: Y(fy),
    size: 8,
    font: fonts.regular,
    color: MUTED,
  });

  return doc.save();
}
