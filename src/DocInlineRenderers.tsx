/* ─── Inline renderers for Word (.docx) & Excel (.xls/.xlsx/.ods) previews ───
 *
 * Both libraries are loaded ONLY via dynamic import() so they code-split out of the
 * main bundle (same pattern as exportXlsx.ts) — the previews are opened rarely.
 *
 * SECURITY: these render club-uploaded, UNTRUSTED content viewed by operators/admins —
 * a cross-privilege XSS surface. Two hard mitigations, both required:
 *  1. Sandboxed iframe. Sheet HTML goes into `<iframe sandbox="" srcdoc>` (fully locked:
 *     no scripts, opaque origin — a `javascript:` cell hyperlink can't fire in the app
 *     origin). docx renders into a `sandbox="allow-same-origin"` frame (scripts NOT
 *     allowed) so docx-preview's injected `<style>` is scoped to the frame, never the page.
 *  2. Href sanitizer. SheetJS `sheet_to_html` and docx-preview both emit live `<a href>`;
 *     any non-http(s) href (javascript:, data:, vbscript:, …) is stripped before render.
 */

import { useEffect, useRef, useState } from 'react';

/* ─── Href sanitizer (the most security-sensitive code — unit-tested) ─── */

/**
 * Only http(s) and same-document/relative hrefs survive. Untrusted club content emits
 * these `<a>` elements, and a `javascript:` (or `data:`/`vbscript:`) href fires in
 * whatever origin the click lands in — strip anything that isn't plainly navigational.
 */
export function isSafeHref(href: string | null | undefined): boolean {
  if (href == null) return false;
  const v = href.trim();
  if (v === '') return false;
  // Fragment / relative / protocol-relative — no scheme, safe to keep.
  if (v.startsWith('#') || v.startsWith('/') || v.startsWith('./') || v.startsWith('../')) {
    return true;
  }
  const scheme = v.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!scheme) return true; // no scheme at all → relative reference
  const s = scheme[1].toLowerCase();
  return s === 'http' || s === 'https';
}

/** Strip unsafe hrefs (and any inline event handlers) from every `<a>` under `root`. */
export function stripUnsafeHrefs(root: Document | HTMLElement): void {
  root.querySelectorAll('a[href]').forEach((a) => {
    if (!isSafeHref(a.getAttribute('href'))) a.removeAttribute('href');
  });
  // Defence in depth: drop on* handler attributes on any element in the fragment.
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) el.removeAttribute(attr.name);
    }
  });
}

/** Parse `sheet_to_html` output, sanitize its hrefs, and return just the body markup. */
export function sanitizeSheetHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  stripUnsafeHrefs(doc);
  return doc.body.innerHTML;
}

/* ─── Shared bits ─── */

// XLSX.read / renderAsync parse on the main thread; a big file can freeze the tab and
// balloon memory, so gate anything over this (sheet OR docx) to the download fallback.
export const MAX_INLINE_PREVIEW_BYTES = 5 * 1024 * 1024;
// sheet_to_html stringifies the WHOLE sheet, so the row/column caps must shrink the range
// BEFORE conversion — post-hoc trimming of the HTML doesn't help.
export const MAX_PREVIEW_ROWS = 500;
export const MAX_PREVIEW_COLS = 200;

/**
 * Truncate a worksheet's `!ref` range to the first MAX_PREVIEW_ROWS rows and
 * MAX_PREVIEW_COLS columns IN PLACE (before sheet_to_html). Returns the pre-truncation
 * row count + whether rows and/or columns were capped so the UI can show a "first N of M"
 * note. `XLSX` is passed in (dynamically imported by the caller) so this helper stays
 * synchronous and unit-testable.
 */
export function capWorksheetRows(
  XLSX: typeof import('xlsx'),
  ws: import('xlsx').WorkSheet,
  maxRows: number = MAX_PREVIEW_ROWS,
  maxCols: number = MAX_PREVIEW_COLS,
): { totalRows: number; truncated: boolean; colsTruncated: boolean } {
  const ref = ws['!ref'];
  if (!ref) return { totalRows: 0, truncated: false, colsTruncated: false };
  const range = XLSX.utils.decode_range(ref);
  const totalRows = range.e.r - range.s.r + 1;
  const totalCols = range.e.c - range.s.c + 1;
  const truncated = totalRows > maxRows;
  const colsTruncated = totalCols > maxCols;
  if (truncated) range.e.r = range.s.r + maxRows - 1;
  if (colsTruncated) range.e.c = range.s.c + maxCols - 1;
  if (truncated || colsTruncated) ws['!ref'] = XLSX.utils.encode_range(range);
  return { totalRows, truncated, colsTruncated };
}

// Callers pass a `height` (defaulting to '68vh') so the operator modal's shorter frames
// (60vh) line up with its other preview branches.
const frameStyle = (height = '68vh'): React.CSSProperties => ({
  width: '100%',
  height,
  border: '1px solid var(--line, rgba(10,15,20,0.12))',
  borderRadius: 8,
  background: '#fff',
});

const LoadingState = () => (
  <div style={{ textAlign: 'center', padding: '48px 8px', color: 'var(--muted)' }}>
    Loading preview…
  </div>
);

/** The graceful degrade shared by every renderer error/too-big path — points the user at
 *  the modal's "Open in new tab" action (which serves the raw file). A not-yet-deployed
 *  Uploads-bucket CORS config lands here too (fetch throws a TypeError). */
const FallbackNote = ({ title, body }: { title: string; body: string }) => (
  <div style={{ textAlign: 'center', padding: '48px 8px', color: 'var(--muted)' }}>
    <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>{title}</div>
    {body}
  </div>
);

/* ─── Spreadsheet preview ─── */

type SheetTab = {
  name: string;
  html: string;
  totalRows: number;
  truncated: boolean;
  colsTruncated: boolean;
};
type SheetState =
  | { status: 'loading' }
  | { status: 'ready'; sheets: SheetTab[] }
  | { status: 'error' }
  | { status: 'too-big' };

function sheetSrcDoc(bodyHtml: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;padding:12px;font:12.5px/1.4 system-ui,Segoe UI,Roboto,sans-serif;color:#0a0f14}' +
    'table{border-collapse:collapse;width:auto}' +
    'td,th{border:1px solid #d7dde3;padding:3px 7px;white-space:nowrap}' +
    'tr:first-child td{background:#f2f5f8;font-weight:600}' +
    '</style></head><body>' +
    bodyHtml +
    '</body></html>'
  );
}

export function SheetInlinePreview({
  url,
  size,
  height,
}: {
  url: string;
  /** Stored `meta.size` (bytes) — gates oversized workbooks to the download fallback. */
  size?: number;
  /** Frame height (default '68vh'); the operator modal passes '60vh'. */
  height?: string;
}) {
  const [state, setState] = useState<SheetState>({ status: 'loading' });
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (size != null && size > MAX_INLINE_PREVIEW_BYTES) {
      setState({ status: 'too-big' });
      return undefined;
    }
    let alive = true;
    setActive(0);
    setState({ status: 'loading' });
    (async () => {
      try {
        const res = await fetch(url);
        if (!alive) return;
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const buf = await res.arrayBuffer();
        if (!alive) return;
        const XLSX = await import('xlsx');
        if (!alive) return;
        const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
        const sheets: SheetTab[] = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          const { totalRows, truncated, colsTruncated } = capWorksheetRows(XLSX, ws);
          return {
            name,
            html: sanitizeSheetHtml(XLSX.utils.sheet_to_html(ws)),
            totalRows,
            truncated,
            colsTruncated,
          };
        });
        if (alive) setState({ status: 'ready', sheets });
      } catch {
        if (alive) setState({ status: 'error' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [url, size]);

  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'too-big') {
    return (
      <FallbackNote
        title="Large spreadsheet"
        body={
          'This spreadsheet is too large to preview inline — use “Open in new tab” to download it.'
        }
      />
    );
  }
  if (state.status === 'error') {
    return (
      <FallbackNote
        title="Preview unavailable"
        body={
          'This spreadsheet couldn’t be previewed inline — use “Open in new tab” to download it.'
        }
      />
    );
  }

  const sheets = state.sheets;
  const current = sheets[active] ?? sheets[0];
  return (
    <div>
      {sheets.length > 1 && (
        <div role="tablist" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                border: '1px solid var(--line, rgba(10,15,20,0.12))',
                background: i === active ? 'var(--ink, #0a0f14)' : 'transparent',
                color: i === active ? '#fff' : 'var(--ink)',
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {(current?.truncated || current?.colsTruncated) && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>
          {current.truncated
            ? `Showing first ${MAX_PREVIEW_ROWS.toLocaleString()} of ${current.totalRows.toLocaleString()} rows`
            : 'Showing all rows'}
          {current.colsTruncated ? ` · first ${MAX_PREVIEW_COLS.toLocaleString()} columns` : ''} —
          open the file for the full sheet.
        </div>
      )}
      <iframe
        title="Spreadsheet preview"
        sandbox=""
        srcDoc={sheetSrcDoc(current?.html ?? '')}
        style={{ ...frameStyle(height), overflow: 'auto' }}
      />
    </div>
  );
}

/* ─── Word (.docx) preview ─── */

export function DocxInlinePreview({
  url,
  size,
  height,
}: {
  url: string;
  /** Stored `meta.size` (bytes) — gates oversized documents to the download fallback. */
  size?: number;
  /** Frame height (default '68vh'); the operator modal passes '60vh'. */
  height?: string;
}) {
  const tooBig = size != null && size > MAX_INLINE_PREVIEW_BYTES;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (tooBig) return undefined;
    let alive = true;
    setStatus('loading');
    (async () => {
      try {
        const res = await fetch(url);
        if (!alive) return;
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const buf = await res.arrayBuffer();
        if (!alive) return;
        const { renderAsync } = await import('docx-preview');
        if (!alive) return;
        const doc = frameRef.current?.contentDocument;
        if (!doc) throw new Error('no frame document');
        // Reset the frame document, then render into it. sandbox="allow-same-origin"
        // (no allow-scripts) keeps this same-origin so we can reach in, while any script
        // the file might carry can't run.
        doc.open();
        doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
        doc.close();
        await renderAsync(buf, doc.body, doc.head, { inWrapper: true });
        if (!alive) return;
        stripUnsafeHrefs(doc);
        if (alive) setStatus('ready');
      } catch {
        if (alive) setStatus('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [url, tooBig]);

  if (tooBig) {
    return (
      <FallbackNote
        title="Large document"
        body={
          'This document is too large to preview inline — use “Open in new tab” to download it.'
        }
      />
    );
  }
  if (status === 'error') {
    return (
      <FallbackNote
        title="Preview unavailable"
        body={'This document couldn’t be previewed inline — use “Open in new tab” to download it.'}
      />
    );
  }
  return (
    <div style={{ position: 'relative' }}>
      {status === 'loading' && (
        <div style={{ position: 'absolute', inset: 0, background: 'var(--panel, #fff)' }}>
          <LoadingState />
        </div>
      )}
      <iframe
        ref={frameRef}
        title="Document preview"
        sandbox="allow-same-origin"
        style={{ ...frameStyle(height), overflow: 'auto' }}
      />
    </div>
  );
}
