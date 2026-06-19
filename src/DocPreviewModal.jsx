/* ─── Compliance document preview — shared by club portal + admin ─── */

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icon, Btn, useEscapeClose } from './atoms';
import { docFileMeta, resolvePreviewSource } from './data';
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
export function DocPreviewModal({ clubId, docKey, docName, clubName, meta, objectKey, onClose }) {
  useEscapeClose(onClose);

  // `meta` is always a single file entry: multi-file docs (safeguarding) pass the
  // selected entry plus its objectKey so the API presigns that specific file.
  const source = resolvePreviewSource(meta, import.meta.env.VITE_LOCAL_AUTH === '1');
  const [state, setState] = useState({ status: 'loading', src: null });
  const [reloadKey, setReloadKey] = useState(0);
  const { metaText, isPdf } = docFileMeta(meta);

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
    getDocViewUrl(clubId, docKey, objectKey)
      .then((r) => alive && setState({ status: 'ready', src: r.viewUrl }))
      .catch(() => alive && setState({ status: 'error', src: null }));
    return () => {
      alive = false;
    };
  }, [source, clubId, docKey, objectKey, reloadKey]);

  const caption = metaText || (source === 'demo' ? 'Demo preview · sample document' : 'Document');
  // Demo mode always serves the bundled sample PDF, so render the iframe even
  // when the entry itself is a Word file — the "open in new tab" hint would
  // point at a PDF and read as broken.
  const renderInline = isPdf || source === 'demo';

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" style={{ maxWidth: 880, width: '92vw' }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Compliance · {clubName}</div>
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

          {(state.status === 'error' || state.status === 'nofile') && (
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

          {state.status === 'ready' && state.src && !renderInline && (
            // Browsers can't render Word documents in an iframe — offer the
            // download (the presigned GET serves it) instead of a broken frame.
            <div style={{ textAlign: 'center', padding: '48px 8px', color: 'var(--muted)' }}>
              <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
                Word document
              </div>
              Word documents can’t be previewed inline — use “Open in new tab” to download it.
            </div>
          )}

          {state.status === 'ready' && state.src && renderInline && (
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
