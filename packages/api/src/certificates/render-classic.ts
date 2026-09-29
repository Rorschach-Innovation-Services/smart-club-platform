/**
 * Template "classic": landscape A4 formal certificate — double gold rule border with corner
 * squares, logo (or wordmark), large EB Garamond title, the transfer statement, dual approval
 * blocks either side of a programmatic seal, and a certificate-reference footer with the QR.
 *
 * All geometry is computed from the page centre so the layout stays symmetric; every text
 * run is width-budgeted (fitText/truncateToWidth) so long names can't collide.
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {
  INK,
  MUTED,
  approvalCopy,
  embedLogo,
  fitBox,
  fitText,
  fmtDate,
  garamondBytes,
  idLabel,
  truncateToWidth,
  type CertificateView,
} from './render-common.js';

const W = 841.89;
const H = 595.28;
const CX = W / 2;
const OUTER = 20;
const INNER = 28;

/** Top-down y → pdf-lib's bottom-up y. */
const Y = (fromTop: number) => H - fromTop;

function centred(
  page: PDFPage,
  font: PDFFont,
  text: string,
  size: number,
  top: number,
  color: RGB,
  cx = CX,
) {
  page.drawText(text, {
    x: cx - font.widthOfTextAtSize(text, size) / 2,
    y: Y(top),
    size,
    font,
    color,
  });
}

function border(page: PDFPage, accent: RGB) {
  const rect = (inset: number, thickness: number) => {
    const halfW = W / 2 - inset;
    const halfH = H / 2 - inset;
    page.drawRectangle({
      x: CX - halfW,
      y: H / 2 - halfH,
      width: halfW * 2,
      height: halfH * 2,
      borderColor: accent,
      borderWidth: thickness,
    });
  };
  rect(OUTER, 2.4);
  rect(INNER, 0.8);
  const sq = 7;
  const halfW = W / 2 - INNER;
  const halfH = H / 2 - INNER;
  for (const [dx, dy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    page.drawRectangle({
      x: CX + dx * halfW - sq / 2,
      y: H / 2 + dy * halfH - sq / 2,
      width: sq,
      height: sq,
      color: accent,
    });
  }
}

function divider(page: PDFPage, top: number, accent: RGB) {
  const half = 110;
  page.drawLine({
    start: { x: CX - half, y: Y(top) },
    end: { x: CX - 8, y: Y(top) },
    thickness: 0.8,
    color: accent,
  });
  page.drawLine({
    start: { x: CX + 8, y: Y(top) },
    end: { x: CX + half, y: Y(top) },
    thickness: 0.8,
    color: accent,
  });
  page.drawCircle({ x: CX, y: Y(top), size: 2.6, color: accent });
}

function seal(
  page: PDFPage,
  cxTop: number,
  accent: RGB,
  fonts: { semibold: PDFFont },
  year: string,
) {
  const cy = Y(cxTop);
  page.drawCircle({
    x: CX,
    y: cy,
    size: 40,
    color: rgb(1, 1, 1),
    borderColor: accent,
    borderWidth: 2,
  });
  page.drawCircle({ x: CX, y: cy, size: 35, borderColor: accent, borderWidth: 0.6 });
  page.drawCircle({ x: CX, y: cy, size: 26, borderColor: accent, borderWidth: 0.6 });
  // Tick marks between the two outer rings.
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    page.drawLine({
      start: { x: CX + Math.cos(a) * 36.5, y: cy + Math.sin(a) * 36.5 },
      end: { x: CX + Math.cos(a) * 38.5, y: cy + Math.sin(a) * 38.5 },
      thickness: 0.6,
      color: accent,
    });
  }
  const f = fonts.semibold;
  const l1 = 'CLEARED';
  page.drawText(l1, {
    x: CX - f.widthOfTextAtSize(l1, 9) / 2,
    y: cy + 2,
    size: 9,
    font: f,
    color: accent,
  });
  page.drawText(year, {
    x: CX - f.widthOfTextAtSize(year, 9) / 2,
    y: cy - 10,
    size: 9,
    font: f,
    color: accent,
  });
}

function approvalBlock(
  page: PDFPage,
  x: number,
  width: number,
  top: number,
  heading: string,
  clubName: string,
  copy: ReturnType<typeof approvalCopy>,
  fonts: { regular: PDFFont; semibold: PDFFont; italic: PDFFont },
  accent: RGB,
) {
  const cx = x + width / 2;
  const h = heading.toUpperCase();
  centred(page, fonts.semibold, h, 9, top, accent, cx);
  const club = fitText(fonts.semibold, clubName, 14, 10, width);
  centred(page, fonts.semibold, club.text, club.size, top + 19, INK, cx);
  page.drawLine({
    start: { x: cx - width / 2 + 20, y: Y(top + 26) },
    end: { x: cx + width / 2 - 20, y: Y(top + 26) },
    thickness: 0.5,
    color: accent,
  });
  const official = truncateToWidth(fonts.regular, copy.official, 10.5, width);
  centred(page, fonts.regular, official, 10.5, top + 41, INK, cx);
  const detail = truncateToWidth(fonts.italic, `${copy.decision} · ${copy.via}`, 9.5, width);
  centred(page, fonts.italic, detail, 9.5, top + 55, MUTED, cx);
  const when = truncateToWidth(fonts.regular, copy.when, 9.5, width);
  centred(page, fonts.regular, when, 9.5, top + 69, MUTED, cx);
}

export async function renderClassic(v: CertificateView): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`Certificate of Player Transfer ${v.serial}`);
  doc.setSubject(`${v.playerName}: ${v.fromClubName} to ${v.toClubName}`);
  doc.setProducer('Smart Club platform');
  doc.setCreator(v.orgName);
  const [regular, semibold, italic] = await Promise.all([
    doc.embedFont(await garamondBytes('regular'), { subset: true }),
    doc.embedFont(await garamondBytes('semibold'), { subset: true }),
    doc.embedFont(await garamondBytes('italic'), { subset: true }),
  ]);
  const fonts = { regular, semibold, italic };
  const page = doc.addPage([W, H]);
  const accent = v.accent;
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 0.995, 0.975) });
  border(page, accent);

  // Header: logo (or wordmark) + org line.
  const logo = await embedLogo(doc, v.logo);
  if (logo) {
    const box = fitBox(logo.width, logo.height, 170, 50);
    page.drawImage(logo, { x: CX - box.width / 2, y: Y(44 + box.height), ...box });
  } else {
    const mark = fitText(semibold, v.orgName, 24, 14, 560);
    centred(page, semibold, mark.text, mark.size, 96, accent);
  }
  if (logo) {
    const org = truncateToWidth(regular, v.orgName.toUpperCase(), 10.5, 560);
    centred(page, regular, org, 10.5, 110, accent);
  }

  const title = 'Certificate of Player Transfer';
  centred(page, semibold, title, 32, 146, INK);
  divider(page, 160, accent);

  centred(page, italic, 'This is to certify that', 13, 186, MUTED);
  const name = fitText(semibold, v.playerName, 28, 16, 600);
  centred(page, semibold, name.text, name.size, 218, INK);
  const idBits = [
    v.idNumber ? `${idLabel(v.idType)} ${v.idNumber}` : '',
    v.dob ? `Date of birth ${fmtDate(v.dob)}` : '',
  ].filter(Boolean);
  if (idBits.length) {
    const idLine = truncateToWidth(regular, idBits.join('   ·   '), 10.5, 600);
    centred(page, regular, idLine, 10.5, 236, MUTED);
  }

  centred(page, italic, 'has been duly cleared to transfer from', 13, 260, MUTED);
  const from = fitText(semibold, v.fromClubName, 18, 11, 620);
  centred(page, semibold, from.text, from.size, 282, INK);
  centred(page, italic, 'to', 12, 299, MUTED);
  const to = fitText(semibold, v.toClubName, 18, 11, 620);
  centred(page, semibold, to.text, to.size, 320, INK);
  centred(page, italic, `with effect from ${fmtDate(v.effectiveDate)}`, 12, 342, MUTED);

  // Approval blocks either side of the seal.
  const blockW = 250;
  const gap = 60;
  const blocksTop = 374;
  approvalBlock(
    page,
    CX - gap - blockW,
    blockW,
    blocksTop,
    'Transferring club',
    v.fromClubName,
    approvalCopy(v.transferring, 'transferring'),
    fonts,
    accent,
  );
  approvalBlock(
    page,
    CX + gap,
    blockW,
    blocksTop,
    'Acquiring club',
    v.toClubName,
    approvalCopy(v.acquiring, 'acquiring'),
    fonts,
    accent,
  );
  seal(page, blocksTop + 30, accent, { semibold }, v.effectiveDate.slice(0, 4));

  // QR bottom-right inside the border; reference footer centred.
  const qr = await doc.embedPng(v.qrPng);
  const qrSize = 80;
  const qrX = W - INNER - 14 - qrSize;
  const qrTop = H - INNER - 26 - qrSize;
  page.drawImage(qr, { x: qrX, y: Y(qrTop + qrSize), width: qrSize, height: qrSize });
  centred(page, regular, 'Scan to verify', 8, qrTop + qrSize + 11, MUTED, qrX + qrSize / 2);

  const footerW = 2 * (qrX - CX) - 30;
  const ref = truncateToWidth(
    regular,
    `Certificate ref ${v.serial}   ·   Issued ${fmtDate(v.issuedAt)}`,
    9.5,
    footerW,
  );
  centred(page, regular, ref, 9.5, H - INNER - 30, INK);
  const url = truncateToWidth(regular, `Verify at ${v.verifyUrl}`, 8.5, footerW);
  centred(page, regular, url, 8.5, H - INNER - 17, MUTED);

  return doc.save();
}
