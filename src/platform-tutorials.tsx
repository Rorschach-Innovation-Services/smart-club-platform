/**
 * Operator console — per-tenant tutorial videos.
 *
 * The short how-to-use-the-app clips a chair sees on the public /tutorials page
 * (src/TutorialsPage.tsx). Operator-managed; PUT /tenant/config strips `tutorials`, so
 * this is the only surface that writes them. Absent/empty falls back to the backend's
 * shared default set unless `tutorialsNoFallback` is set — see the fallback toggle below.
 *
 * Lives outside platform.tsx (already ~3,300 lines) and imports only from atoms/api/types,
 * matching the CalendarsCard/StructuresCard sibling-file pattern.
 *
 * ── ORDER/RENAME VS UPLOAD/DELETE ──
 * Reordering and renaming edit a local draft (`rows`) with its own dirty flag and a
 * "Save order & titles" footer button — the same shape as everywhere else in this
 * console. Upload and delete, by contrast, always act on the server's LATEST tutorials
 * array (re-fetched immediately before the mutating PUT, like LeaguesCard/CalendarsCard),
 * so a lost upload/delete race with another tab can't silently discard that tab's write.
 * The two paths would conflict if run concurrently — an unsaved local reorder would be
 * clobbered by an upload's re-fetch — so upload/delete controls are disabled while the
 * draft is dirty. Simplest correct rule: finish (or discard) one kind of edit before
 * starting the other.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import { Btn, Card, EmptyState, Icon, ProgressBar } from './atoms';
import * as api from './api';
import { ApiError } from './api';
import type { TenantConfig, TutorialVideo } from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '8px 0 0' };

// Mirrors the backend's tutorial-upload content-type/size allowlist.
const VIDEO_TYPES = ['video/mp4', 'video/webm'];
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const POSTER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_POSTER_BYTES = 4 * 1024 * 1024;

/** "team-registration_v2.mp4" → "Team Registration V2" — a readable default title. */
function cleanTitle(fileName: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, '');
  const spaced = base.replace(/[-_]+/g, ' ').trim();
  if (!spaced) return 'Untitled video';
  return spaced.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1));
}

/** Last path segment of a tutorial URL — the closest thing to a filename hint. */
function urlHint(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || url;
  } catch {
    return url;
  }
}

interface ActiveUpload {
  kind: 'video' | 'poster';
  /** Which row this upload targets — 'new' for the add-video flow. */
  row: number | 'new';
  progress: number;
  controller: AbortController;
}

export function TutorialsCard({
  slug,
  config,
  save,
  toast,
}: {
  slug: string;
  config: TenantConfig;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig>;
  toast: Toast;
}) {
  const savedTutorials = config.tutorials ?? [];
  const [rows, setRows] = useState<TutorialVideo[]>(savedTutorials);
  const [rowsDirty, setRowsDirty] = useState(false);
  // Picks up a server-side change (this upload/delete flow, another tab, a refetch)
  // whenever there's no unsaved local reorder/rename to protect.
  useEffect(() => {
    if (!rowsDirty) setRows(savedTutorials);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.tutorials, rowsDirty]);

  const [err, setErr] = useState('');
  const [orderErr, setOrderErr] = useState('');
  const [orderBusy, setOrderBusy] = useState(false);
  const [confirmIndex, setConfirmIndex] = useState<number | null>(null);
  const [activeUpload, setActiveUpload] = useState<ActiveUpload | null>(null);

  const addFileRef = useRef<HTMLInputElement>(null);
  const replaceFileRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const posterFileRefs = useRef<Record<number, HTMLInputElement | null>>({});

  const busy = rowsDirty || !!activeUpload;

  function patchRow(i: number, patch: Partial<TutorialVideo>) {
    setRows((r) => r.map((t, j) => (j === i ? { ...t, ...patch } : t)));
    setRowsDirty(true);
  }
  function move(i: number, dir: -1 | 1) {
    setRows((r) => {
      const j = i + dir;
      if (j < 0 || j >= r.length) return r;
      const next = [...r];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setRowsDirty(true);
  }
  function discardOrder() {
    setRows(savedTutorials);
    setRowsDirty(false);
    setOrderErr('');
  }
  async function saveOrder() {
    setOrderErr('');
    setOrderBusy(true);
    try {
      await save({ tutorials: rows });
      setRowsDirty(false);
      toast('Order & titles saved');
    } catch (e) {
      setOrderErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setOrderBusy(false);
    }
  }

  /**
   * Rebuild-and-PUT against the server's latest tutorials, not this tab's cache — the
   * same guard LeaguesCard/CalendarsCard use, so a concurrent edit in another tab isn't
   * silently erased by a stale array.
   */
  async function saveTutorials(
    build: (fresh: TutorialVideo[]) => TutorialVideo[],
    fallback: string,
  ): Promise<void> {
    const current = await api.platformGetTenant(slug);
    await save({ tutorials: build(current.tutorials ?? []) }).catch((e) => {
      throw e instanceof ApiError ? e : new ApiError(0, fallback);
    });
  }

  async function doUpload(
    kind: 'video' | 'poster',
    row: number | 'new',
    file: File,
    apply: (fresh: TutorialVideo[], publicUrl: string) => TutorialVideo[],
  ) {
    setErr('');
    const types = kind === 'video' ? VIDEO_TYPES : POSTER_TYPES;
    const maxBytes = kind === 'video' ? MAX_VIDEO_BYTES : MAX_POSTER_BYTES;
    if (!types.includes(file.type)) {
      setErr(kind === 'video' ? 'MP4 or WebM only' : 'JPEG, PNG or WebP only');
      return;
    }
    if (file.size > maxBytes) {
      setErr(kind === 'video' ? 'Video must be 2 GiB or less' : 'Poster must be 4 MiB or less');
      return;
    }
    const controller = new AbortController();
    setActiveUpload({ kind, row, progress: 0, controller });
    const onProgress = (fraction: number) =>
      setActiveUpload((u) => (u ? { ...u, progress: fraction } : u));
    try {
      const grant = await api.platformTutorialUploadUrl(slug, {
        kind,
        contentType: file.type,
        sizeBytes: file.size,
        fileName: file.name,
      });
      if (grant.mode === 'post') {
        try {
          await api.uploadPostToS3(grant, file, { onProgress, signal: controller.signal });
        } catch (e) {
          if (e instanceof api.UploadAbortedError) {
            // Nothing to abort server-side for a single POST — at worst the object
            // already landed in S3 and stays unreferenced (we never save its URL).
            toast('Upload cancelled');
            return;
          }
          throw e;
        }
      } else {
        let parts;
        try {
          parts = await api.uploadMultipartToS3(grant, file, {
            onProgress,
            signal: controller.signal,
          });
        } catch (e) {
          if (e instanceof api.UploadAbortedError) {
            await api
              .platformTutorialUploadAbort(slug, {
                objectKey: grant.objectKey,
                uploadId: grant.uploadId,
              })
              .catch(() => {});
            toast('Upload cancelled');
            return;
          }
          // Genuine failure (not a cancel) — release the uploaded parts too, so they
          // don't linger on S3 until the 3-day multipart lifecycle rule cleans them up.
          // Best-effort: this is cleanup, not the reason the upload failed.
          await api
            .platformTutorialUploadAbort(slug, {
              objectKey: grant.objectKey,
              uploadId: grant.uploadId,
            })
            .catch(() => {});
          throw e;
        }
        await api.platformTutorialUploadComplete(slug, {
          objectKey: grant.objectKey,
          uploadId: grant.uploadId,
          parts,
        });
      }
      // Persist immediately — an unsaved upload would orphan the S3 object.
      await saveTutorials((fresh) => apply(fresh, grant.publicUrl), 'Could not save the upload');
      toast(kind === 'video' ? 'Video uploaded' : 'Poster uploaded');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Upload failed — try again');
    } finally {
      setActiveUpload(null);
    }
  }

  function onAddVideo(file: File) {
    doUpload('video', 'new', file, (fresh, publicUrl) => [
      ...fresh,
      { title: cleanTitle(file.name), url: publicUrl },
    ]);
  }
  function onReplaceVideo(i: number, file: File) {
    // Match on the OLD row's url, not the index — `fresh` is re-fetched right before
    // the save, and a concurrent edit in another tab can shift indices in the meantime.
    // URLs are UUID-suffixed and unique, so they're a stable identity.
    const target = rows[i];
    doUpload('video', i, file, (fresh, publicUrl) =>
      fresh.map((t) => (t.url === target.url ? { ...t, url: publicUrl } : t)),
    );
  }
  function onSetPoster(i: number, file: File) {
    const target = rows[i];
    doUpload('poster', i, file, (fresh, publicUrl) =>
      fresh.map((t) => (t.url === target.url ? { ...t, poster: publicUrl } : t)),
    );
  }

  async function deleteRow(i: number) {
    const removed = rows[i];
    setConfirmIndex(null);
    setErr('');
    try {
      // Match on url, not index — see onReplaceVideo's comment.
      await saveTutorials(
        (fresh) => fresh.filter((t) => t.url !== removed.url),
        'Could not delete video',
      );
      toast(`${removed?.title || 'Video'} · deleted`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not delete — try again');
    }
  }

  const fallbackOn = !config.tutorialsNoFallback;
  const [fallbackBusy, setFallbackBusy] = useState(false);
  async function onFallbackChange(checked: boolean) {
    setFallbackBusy(true);
    try {
      await save({ tutorialsNoFallback: !checked });
      toast(
        checked
          ? 'Shared default set restored when empty'
          : 'Now shown empty when this client has no videos',
      );
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save — try again', 'warn');
    } finally {
      setFallbackBusy(false);
    }
  }

  const statusLine =
    savedTutorials.length > 0
      ? `Currently serving: ${savedTutorials.length} own video${savedTutorials.length === 1 ? '' : 's'}`
      : fallbackOn
        ? 'Currently serving: the shared default set'
        : 'Currently serving: nothing (coming-soon empty state)';

  return (
    <Card
      title="Tutorial videos"
      sub="The short how-to-use-the-app clips on the public /tutorials page. Absent or empty falls back to the shared default set unless the toggle below turns that off."
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={Icon.Upload}
          title="No videos of its own yet"
          sub="Until one is added, this client's chairs see the shared default tutorial set (or nothing, if the fallback below is off)."
        />
      ) : (
        <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
          {rows.map((t, i) => (
            <div
              key={t.url}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
                padding: '10px 12px',
                border: '1px solid var(--line)',
                borderRadius: 10,
              }}
            >
              <span
                style={{
                  fontFamily: "'Montserrat',sans-serif",
                  fontWeight: 700,
                  fontSize: 12.5,
                  color: 'var(--muted-2)',
                  minWidth: 20,
                  paddingTop: 8,
                }}
              >
                {i + 1}.
              </span>
              {t.poster ? (
                <img
                  src={t.poster}
                  alt=""
                  style={{
                    width: 64,
                    height: 40,
                    objectFit: 'cover',
                    borderRadius: 6,
                    flexShrink: 0,
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 64,
                    height: 40,
                    borderRadius: 6,
                    flexShrink: 0,
                    background: 'var(--paper)',
                    border: '1px solid var(--line)',
                  }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Draft edits are locked while an upload is in flight (and vice versa —
                    see the header comment): a draft dirtied mid-upload blocks the sync
                    effect, so its later wholesale save would drop the just-uploaded
                    video and the server-side cleanup would delete the object. */}
                <input
                  className="field-input"
                  value={t.title}
                  onChange={(e) => patchRow(i, { title: e.target.value })}
                  placeholder="Video title"
                  disabled={!!activeUpload}
                />
                <p style={{ ...HINT, ...MONO_HINT }}>{urlHint(t.url)}</p>
                {activeUpload && activeUpload.row === i && (
                  <div style={{ marginTop: 6 }}>
                    <ProgressBar value={activeUpload.progress * 100} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>
                        {activeUpload.kind === 'video' ? 'Uploading video…' : 'Uploading poster…'}{' '}
                        {Math.round(activeUpload.progress * 100)}%
                      </span>
                      <Btn tone="ghost" size="sm" onClick={() => activeUpload.controller.abort()}>
                        Cancel
                      </Btn>
                    </div>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <Btn
                  tone="ghost"
                  size="sm"
                  onClick={() => move(i, -1)}
                  disabled={!!activeUpload || i === 0}
                >
                  ↑
                </Btn>
                <Btn
                  tone="ghost"
                  size="sm"
                  onClick={() => move(i, 1)}
                  disabled={!!activeUpload || i === rows.length - 1}
                >
                  ↓
                </Btn>
                <input
                  ref={(el) => {
                    replaceFileRefs.current[i] = el;
                  }}
                  type="file"
                  accept={VIDEO_TYPES.join(',')}
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) onReplaceVideo(i, f);
                  }}
                />
                <Btn
                  tone="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => replaceFileRefs.current[i]?.click()}
                >
                  Replace video
                </Btn>
                <input
                  ref={(el) => {
                    posterFileRefs.current[i] = el;
                  }}
                  type="file"
                  accept={POSTER_TYPES.join(',')}
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) onSetPoster(i, f);
                  }}
                />
                <Btn
                  tone="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => posterFileRefs.current[i]?.click()}
                >
                  {t.poster ? 'Replace poster' : 'Add poster'}
                </Btn>
                <Btn tone="ghost" size="sm" disabled={busy} onClick={() => setConfirmIndex(i)}>
                  Delete
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      <input
        ref={addFileRef}
        type="file"
        accept={VIDEO_TYPES.join(',')}
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onAddVideo(f);
        }}
      />
      <Btn
        tone="teal"
        size="sm"
        icon={Icon.Plus}
        disabled={busy}
        onClick={() => addFileRef.current?.click()}
      >
        Add video
      </Btn>
      {activeUpload && activeUpload.row === 'new' && (
        <div style={{ marginTop: 8, maxWidth: 320 }}>
          <ProgressBar value={activeUpload.progress * 100} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>
              Uploading… {Math.round(activeUpload.progress * 100)}%
            </span>
            <Btn tone="ghost" size="sm" onClick={() => activeUpload.controller.abort()}>
              Cancel
            </Btn>
          </div>
        </div>
      )}
      {err && <div style={{ ...ERR, marginTop: 8 }}>{err}</div>}

      {rowsDirty && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginTop: 14,
            paddingTop: 14,
            borderTop: '1px solid var(--line2)',
          }}
        >
          <Btn tone="teal" size="sm" onClick={saveOrder} disabled={orderBusy}>
            {orderBusy ? 'Saving…' : 'Save order & titles'}
          </Btn>
          <Btn tone="outline" size="sm" onClick={discardOrder} disabled={orderBusy}>
            Discard
          </Btn>
          {orderErr && <span style={ERR}>{orderErr}</span>}
        </div>
      )}

      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line2)' }}>
        <label style={{ fontSize: 12.5, display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={fallbackOn}
            disabled={fallbackBusy || !!activeUpload}
            onChange={(e) => onFallbackChange(e.target.checked)}
          />
          When this client has no videos of its own, show the shared default set
        </label>
        <p style={HINT}>{statusLine}</p>
      </div>

      {confirmIndex != null &&
        createPortal(
          <div
            className="fix-confirm"
            onClick={(e) => e.target === e.currentTarget && setConfirmIndex(null)}
          >
            <div className="fix-confirm-box">
              <div className="fix-confirm-icon danger">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 2L22 21H2L12 2z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 9v5M12 17v.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div className="fix-confirm-title">
                Delete “{rows[confirmIndex]?.title || 'this video'}”?
              </div>
              <div className="fix-confirm-body">
                It disappears from the public tutorials page immediately. The video and its poster
                are removed from storage.
              </div>
              <div className="fix-confirm-actions">
                <Btn tone="outline" onClick={() => setConfirmIndex(null)}>
                  Cancel
                </Btn>
                <Btn tone="ink" onClick={() => deleteRow(confirmIndex)}>
                  Yes, delete
                </Btn>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </Card>
  );
}

const MONO_HINT: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
