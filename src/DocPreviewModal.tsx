/* ─── Compliance document preview — shared by club portal + admin ─── */

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icon, Btn, useEscapeClose } from './atoms';
import { docFileMeta, resolvePreviewSource, docPreviewKind } from './data';
import { SheetInlinePreview, DocxInlinePreview } from './DocInlineRenderers';
import { getDocViewUrl } from './api';

// Local/demo fallback. Vite serves public/ at BASE_URL, so this resolves to
// `/sample-document.pdf` in the default deploy.
const SAMPLE_PDF = `${import.meta.env.BASE_URL || '/'}sample-document.pdf`;

/**
 * Read-only preview of an uploaded compliance PDF, matching the AffiliationViewModal /
 * CqiViewModal pattern. The source decision (resolvePreviewSource) yields one of:
 *  - 'real' → mint a presigned GET from the API and render it inline.
 *  - 'demo' → render the bundled sample PDF (local/demo mode; no real file exists).
 *  - 'none' → a production doc with no file (admin override / empty key); show an explicit
 *             "no file on record" state. We never substitute the sample for a real doc, as
 *             that would misrepresent its content.
 *
 * On mobile (iOS Safari / many Android browsers) `application/pdf` won't render in an
 * iframe, so "Open in new tab" is a first-class action, not a footnote. The presigned URL
 * expires (server-side, 15 min); "Try again" re-mints it if a stale preview fails.
 */
export function DocPreviewModal({
  clubId,
  docKey,
  docName,
  clubName,
  meta,
  objectKey,
  onClose,
  fetchUrl,
  eyebrow,
  caption: captionOverride,
  onFetchError,
}: {
  clubId?: string;
  docKey?: string;
  docName: string;
  clubName?: string;
  meta?: { objectKey?: string; contentType?: string; size?: number; uploadedAt?: string } | null;
  objectKey?: string;
  onClose: () => void;
  /**
   * Custom presign — e.g. a clearance certificate. When set, the compliance-doc source
   * decision (demo/none) is skipped: the modal always mints via this fn and renders the
   * result by `meta` (pass { contentType: 'application/pdf' } for a PDF).
   */
  fetchUrl?: () => Promise<string>;
  /** Header eyebrow text; defaults to "Compliance · <clubName>". */
  eyebrow?: string;
  /** Muted line above the preview; defaults to the file meta text. */
  caption?: string;
  /**
   * Called when `fetchUrl` rejects. Return a node to render in place of the generic
   * "Preview unavailable" state (e.g. a revoked-certificate notice), or null for the default.
   */
  onFetchError?: (err: unknown) => React.ReactNode | null;
}) {
  useEscapeClose(onClose);

  // `meta` is always a single file entry: multi-file docs (safeguarding) pass the
  // selected entry plus its objectKey so the API presigns that specific file.
  const source = fetchUrl
    ? 'real'
    : resolvePreviewSource(meta, import.meta.env.VITE_LOCAL_AUTH === '1');
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error' | 'nofile';
    src: string | null;
    errorNode?: React.ReactNode;
  }>({ status: 'loading', src: null });
  const [reloadKey, setReloadKey] = useState(0);
  const { metaText } = docFileMeta(meta);

  useEffect(() => {
    if (source === 'demo') {
      setState({ status: 'ready', src: SAMPLE_PDF });
      return undefined;
    }
    if (source === 'none') {
      setState({ status: 'nofile', src: null });
      return undefined;
    }
    let alive = true;
    setState({ status: 'loading', src: null });
    const mint =
      fetchUrl ?? (() => getDocViewUrl(clubId, docKey, objectKey).then((r) => r.viewUrl));
    mint()
      .then((src) => alive && setState({ status: 'ready', src }))
      .catch(
        (err) =>
          alive && setState({ status: 'error', src: null, errorNode: onFetchError?.(err) ?? null }),
      );
    return () => {
      alive = false;
    };
    // fetchUrl/onFetchError are expected to be stable for the modal's lifetime (inline
    // closures from the opener); re-minting only on the identity inputs + Try again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, clubId, docKey, objectKey, reloadKey]);

  const caption =
    captionOverride ||
    metaText ||
    (source === 'demo' ? 'Demo preview · sample document' : 'Document');
  // Demo mode always serves the bundled sample PDF, so force the pdf iframe even when the
  // entry itself is a non-PDF file — the "open in new tab" hint would otherwise point at a
  // PDF and read as broken.
  const kind = source === 'demo' ? 'pdf' : docPreviewKind(meta);

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" style={{ maxWidth: 880, width: '92vw' }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">{eyebrow ?? `Compliance · ${clubName}`}</div>
            <div className="task-modal-head-title">{docName}</div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <div
            className="row"
            style={{
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{caption}</div>
            {state.status === 'ready' && state.src && (
              <Btn
                tone="outline"
                size="sm"
                icon={Icon.Eye}
                onClick={() => window.open(state.src, '_blank', 'noopener,noreferrer')}
              >
                Open in new tab
              </Btn>
            )}
          </div>

          {state.status === 'loading' && (
            <div style={{ textAlign: 'center', padding: '48px 8px', color: 'var(--muted)' }}>
              Loading preview…
            </div>
          )}

          {state.status === 'error' && state.errorNode}

          {(state.status === 'nofile' || (state.status === 'error' && !state.errorNode)) && (
            <div style={{ textAlign: 'center', padding: '48px 8px', color: 'var(--muted)' }}>
              <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
                {state.status === 'nofile' ? 'No file on record' : 'Preview unavailable'}
              </div>
              {state.status === 'nofile'
                ? 'This document was marked compliant without an uploaded file.'
                : 'We couldn’t load this document right now.'}
              {state.status === 'error' && (
                <div style={{ marginTop: 12 }}>
                  <Btn tone="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                    Try again
                  </Btn>
                </div>
              )}
            </div>
          )}

          {state.status === 'ready' && state.src && kind === 'sheet' && (
            <SheetInlinePreview url={state.src} size={meta?.size} />
          )}

          {state.status === 'ready' && state.src && kind === 'docx' && (
            <DocxInlinePreview url={state.src} size={meta?.size} />
          )}

          {state.status === 'ready' && state.src && kind === 'image' && (
            <img
              src={state.src}
              alt={`${docName} preview`}
              onError={() => setState({ status: 'error', src: null })}
              style={{
                display: 'block',
                maxWidth: '100%',
                maxHeight: '68vh',
                margin: '0 auto',
                borderRadius: 8,
              }}
            />
          )}

          {state.status === 'ready' &&
            state.src &&
            (kind === 'word-legacy' || kind === 'unknown') && (
              // No in-browser renderer (legacy .doc) or an unrecognised type — offer the
              // download (the presigned GET serves it) instead of a broken frame.
              <div style={{ textAlign: 'center', padding: '48px 8px', color: 'var(--muted)' }}>
                <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
                  {kind === 'word-legacy' ? 'Legacy Word document' : 'Preview unavailable'}
                </div>
                {kind === 'word-legacy'
                  ? 'This is a legacy .doc file — it can’t be previewed inline; use “Open in new tab” to download it.'
                  : 'This file can’t be previewed inline — use “Open in new tab” to download it.'}
              </div>
            )}

          {state.status === 'ready' && state.src && kind === 'pdf' && (
            <iframe
              title={`${docName} preview`}
              src={state.src}
              onError={() => setState({ status: 'error', src: null })}
              style={{
                width: '100%',
                height: '68vh',
                border: '1px solid var(--line, rgba(10,15,20,0.12))',
                borderRadius: 8,
                background: '#fff',
              }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
