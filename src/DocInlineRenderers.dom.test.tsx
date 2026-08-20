import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import * as XLSX from 'xlsx';
import {
  isSafeHref,
  sanitizeSheetHtml,
  stripUnsafeHrefs,
  capWorksheetRows,
  MAX_PREVIEW_ROWS,
  MAX_PREVIEW_COLS,
  SheetInlinePreview,
} from './DocInlineRenderers';

/* ─── Href sanitizer — the most security-sensitive new code ─── */

describe('isSafeHref', () => {
  it('rejects javascript: and other non-http(s) schemes', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('  JavaScript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>1</script>')).toBe(false);
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeHref('file:///etc/passwd')).toBe(false);
    expect(isSafeHref('mailto:x@y.z')).toBe(false);
    expect(isSafeHref('')).toBe(false);
    expect(isSafeHref(null)).toBe(false);
  });

  it('keeps http(s), fragment, and relative hrefs', () => {
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('http://example.com/a?b=1')).toBe(true);
    expect(isSafeHref('#top')).toBe(true);
    expect(isSafeHref('/path')).toBe(true);
    expect(isSafeHref('./rel')).toBe(true);
    expect(isSafeHref('//cdn.example.com/x')).toBe(true);
  });
});

describe('sanitizeSheetHtml / stripUnsafeHrefs', () => {
  it('strips a javascript: hyperlink emitted by sheet_to_html', () => {
    const html =
      '<html><body><table><tr><td>' +
      '<a href="javascript:alert(document.cookie)">click</a>' +
      '<a href="https://ok.example">ok</a>' +
      '</td></tr></table></body></html>';
    const out = sanitizeSheetHtml(html);
    expect(out).not.toContain('javascript:');
    expect(out).toContain('https://ok.example');
    // the anchor text survives, only the dangerous href is dropped
    expect(out).toContain('click');
  });

  it('removes inline on* event handlers', () => {
    const doc = new DOMParser().parseFromString(
      '<div><img src="x" onerror="alert(1)"><a href="#" onclick="steal()">y</a></div>',
      'text/html',
    );
    stripUnsafeHrefs(doc);
    expect(doc.body.innerHTML).not.toContain('onerror');
    expect(doc.body.innerHTML).not.toContain('onclick');
  });
});

/* ─── Row cap must shrink the range BEFORE sheet_to_html ─── */

describe('capWorksheetRows', () => {
  it('truncates the worksheet !ref to the first MAX_PREVIEW_ROWS rows in place', () => {
    const rows = Array.from({ length: 600 }, (_, i) => [`r${i}`, i]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const before = XLSX.utils.decode_range(ws['!ref']!);
    expect(before.e.r - before.s.r + 1).toBe(600);

    const { totalRows, truncated } = capWorksheetRows(XLSX, ws);
    expect(truncated).toBe(true);
    expect(totalRows).toBe(600);
    const after = XLSX.utils.decode_range(ws['!ref']!);
    expect(after.e.r - after.s.r + 1).toBe(MAX_PREVIEW_ROWS);
  });

  it('leaves a small sheet untouched', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['a', 'b'],
      ['1', '2'],
    ]);
    const { totalRows, truncated, colsTruncated } = capWorksheetRows(XLSX, ws);
    expect(truncated).toBe(false);
    expect(colsTruncated).toBe(false);
    expect(totalRows).toBe(2);
  });

  it('truncates the worksheet !ref to the first MAX_PREVIEW_COLS columns in place', () => {
    // one row that is MAX_PREVIEW_COLS + 50 columns wide
    const wide = Array.from({ length: MAX_PREVIEW_COLS + 50 }, (_, i) => i);
    const ws = XLSX.utils.aoa_to_sheet([wide]);
    const before = XLSX.utils.decode_range(ws['!ref']!);
    expect(before.e.c - before.s.c + 1).toBe(MAX_PREVIEW_COLS + 50);

    const { truncated, colsTruncated } = capWorksheetRows(XLSX, ws);
    expect(colsTruncated).toBe(true);
    expect(truncated).toBe(false); // only one row — rows not capped
    const after = XLSX.utils.decode_range(ws['!ref']!);
    expect(after.e.c - after.s.c + 1).toBe(MAX_PREVIEW_COLS);
  });
});

/* ─── SheetInlinePreview component ─── */

function workbookArrayBuffer(sheets: { name: string; aoa: unknown[][] }[]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.aoa), s.name);
  // type:'array' yields an ArrayBuffer directly.
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

function stubFetch(buf: ArrayBuffer) {
  global.fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => buf })) as never;
}

describe('SheetInlinePreview', () => {
  const realFetch = global.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    global.fetch = realFetch; // never leak the stub into sibling suites
  });

  it('renders the workbook and shows a tab per sheet', async () => {
    stubFetch(
      workbookArrayBuffer([
        { name: 'Committee', aoa: [['Name'], ['Alice']] },
        { name: 'Members', aoa: [['Name'], ['Bob']] },
      ]),
    );
    render(<SheetInlinePreview url="https://s3/file.xlsx" />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Committee', 'Members']);
    expect(await screen.findByTitle('Spreadsheet preview')).toBeInTheDocument();
  });

  it('shows the row-cap note when a sheet exceeds MAX_PREVIEW_ROWS', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => [`r${i}`]);
    stubFetch(workbookArrayBuffer([{ name: 'Big', aoa: rows }]));
    render(<SheetInlinePreview url="https://s3/big.xlsx" />);
    expect(await screen.findByText(/Showing first 500 of 600 rows/)).toBeInTheDocument();
  });

  it('gates an oversized workbook to the download fallback without fetching', () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as never;
    render(<SheetInlinePreview url="https://s3/huge.xlsx" size={6 * 1024 * 1024} />);
    expect(screen.getByText(/too large to preview inline/)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('degrades to the download fallback when the fetch fails', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('CORS');
    }) as never;
    render(<SheetInlinePreview url="https://s3/file.xlsx" />);
    expect(await screen.findByText(/couldn’t be previewed inline/)).toBeInTheDocument();
  });
});
