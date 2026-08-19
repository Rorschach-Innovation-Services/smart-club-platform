/**
 * Operator console — bulk document-intake wizard.
 *
 * Reads a client's whole compliance-doc submission pack (a zip, or a picked folder for
 * packs too large to hold as one zip in memory) and turns it into (club, doc type)
 * uploads without the operator dragging 200 files one at a time onto club pages.
 *
 * The matching itself lives in intake-match.ts (pure, unit-tested) — this file is
 * strictly the DOM/network shell around it: extract files → run the matcher → let the
 * operator correct/confirm in a table → upload → commit. Nothing here reimplements
 * scoring or duplicate/conflict detection; edits re-run the same exported pipeline
 * (buildRows / findDuplicates / findConflicts) so a manual correction can surface a
 * NEW duplicate or conflict exactly the way the initial pass would have.
 *
 * ── FOUR STEPS, TWO SCREENS ──
 * The spec's "layout" and "review" steps are one screen here: the strategy picker sits
 * above the table it drives, so switching "one folder per club" ↔ "all files together"
 * re-matches in place with no navigation — that's the whole point of having a picker at
 * all. Ingest and commit get their own screens because they're genuinely sequential
 * (nothing to review before files exist; nothing to edit once uploads are in flight).
 *
 * ── WHY UPLOAD FILES CARRY THEIR OWN BLOB MAP ──
 * intake-match's IntakeFile is deliberately metadata-only (no React, no network, no
 * Blob) so it stays a pure, framework-free module. This file needs the actual bytes to
 * PUT, so it keeps a parallel `Map<fileId, Blob>` alongside the IntakeFile[] rather than
 * widening the shared type — buildRows/findDuplicates/etc. never see or need the blob.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { unzip } from 'fflate';
import { queryClient, qk } from './query';
import * as api from './api';
import { ApiError } from './api';
import { Btn, Card, EmptyState, Icon, Pill } from './atoms';
import { DEFAULT_REQUIRED_DOCS, DISTRICTS, resolveDocMime } from './data';
import {
  buildClubIndex,
  buildRows,
  committableRows,
  findConflicts,
  findDuplicates,
  flagExistingDocs,
  isJunkFile,
  baseStem,
  MAX_INTAKE_BYTES,
  INTAKE_STRATEGIES,
  type IntakeFile,
  type IntakeRow,
  type MatchStatus,
} from './intake-match';
import {
  BulkActionBar,
  CreateClubModal,
  ERR,
  HINT,
  ReviewCounters,
  formatBytes,
  useRowSelection,
} from './platform-wizard';
import type { DocIntakePresignResult, InsightsClub, RequiredDoc } from './types';

type Toast = (m: string, t?: string) => void;

/** Chip label + tone per MatchStatus — one place so the table and summary bar agree. */
const STATUS_META: Record<MatchStatus, { label: string; tone: string }> = {
  ready: { label: 'Ready', tone: 'teal' },
  'unmatched-club': { label: 'Pick a club', tone: 'gold' },
  'unmatched-doc': { label: 'Pick a document', tone: 'gold' },
  duplicate: { label: 'Duplicate', tone: 'muted' },
  conflict: { label: 'Conflict', tone: 'coral' },
  'too-large': { label: 'Too large', tone: 'coral' },
  excluded: { label: 'Excluded', tone: 'muted' },
};

/**
 * A row's club/doc after a manual pick. `settle` in intake-match.ts isn't exported (the
 * module deliberately keeps its internals private), so this mirrors its handful of lines
 * rather than widening that module's surface for one caller. Confidence is pinned to 1 —
 * an operator's own selection is definitive, never a "check this" guess.
 */
function applyManualPick(row: IntakeRow, clubId: string | null, docKey: string | null): IntakeRow {
  const next: IntakeRow = {
    ...row,
    clubId,
    clubConfidence: clubId ? 1 : 0,
    docKey,
    docConfidence: docKey ? 1 : 0,
    note: undefined,
  };
  if (next.file.size > MAX_INTAKE_BYTES)
    return { ...next, status: 'too-large', note: 'Over the 10 MB limit' };
  if (!next.clubId) return { ...next, status: 'unmatched-club', note: 'Pick a club' };
  if (!next.docKey) return { ...next, status: 'unmatched-doc', note: 'Pick a document type' };
  return { ...next, status: 'ready' };
}

/** Drop a shared single top-level wrapper folder ("Compliance Documents/") if every
 *  entry has one — a zip export always adds one, a folder pick sometimes does too. */
function dropSharedRoot<T extends { segments: string[] }>(items: T[]): T[] {
  if (!items.length) return items;
  const first = items[0].segments[0];
  if (!first || !items.every((it) => it.segments[0] === first)) return items;
  return items.map((it) => ({ ...it, segments: it.segments.slice(1) }));
}

interface RawEntry {
  segments: string[];
  name: string;
  blob: Blob;
  mime: string;
}

/**
 * fflate's async `unzip` decompresses off the main thread (worker-backed for large
 * entries), so a big compliance pack extracts without freezing the ingest screen —
 * `unzipSync` would block it for the whole file. Directory markers (zero-byte, path
 * ending in "/") are dropped before they ever reach the caller.
 */
function extractZip(file: File): Promise<RawEntry[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that zip file'));
    reader.onload = () => {
      const data = new Uint8Array(reader.result as ArrayBuffer);
      unzip(data, (err, unzipped) => {
        if (err) return reject(err);
        const entries: RawEntry[] = [];
        for (const [path, bytes] of Object.entries(unzipped)) {
          if (path.endsWith('/')) continue;
          const parts = path.split('/').filter(Boolean);
          const name = parts.pop() ?? path;
          // Browsers report '' for .doc/.xls MIME on File objects; a raw zip entry has
          // no browser-supplied type at all, so it's always resolved from the extension.
          const mime = resolveDocMime({ name }) || 'application/octet-stream';
          entries.push({ segments: parts, name, blob: new Blob([bytes], { type: mime }), mime });
        }
        resolve(dropSharedRoot(entries));
      });
    };
    reader.readAsArrayBuffer(file);
  });
}

/** `<input type="file" webkitdirectory>` fallback for packs too large to hold as one
 *  zip in memory — the files are already on disk, no extraction step needed. */
function entriesFromFileList(list: FileList): RawEntry[] {
  const raw = Array.from(list).map((f) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = rel.split('/').filter(Boolean);
    const name = parts.pop() ?? f.name;
    return { segments: parts, name, blob: f, mime: resolveDocMime(f) };
  });
  return dropSharedRoot(raw);
}

/** Junk/zero-byte filtered, ids minted, blobs split out into their own map. */
function toWizardFiles(entries: RawEntry[]): { files: IntakeFile[]; blobs: Map<string, Blob> } {
  const files: IntakeFile[] = [];
  const blobs = new Map<string, Blob>();
  let n = 0;
  for (const e of entries) {
    if (isJunkFile({ name: e.name, segments: e.segments })) continue;
    if (e.blob.size === 0) continue;
    const id = `${e.segments.join('/')}/${e.name}#${n++}`;
    files.push({ id, segments: e.segments, name: e.name, size: e.blob.size, mime: e.mime });
    blobs.set(id, e.blob);
  }
  return { files, blobs };
}

/** Best-guess name for the "Create club…" modal — the deepest folder segment (folder
 *  strategies), falling back to the copy-stripped filename stem (flat packs). */
function guessClubName(row: IntakeRow): string {
  const deepest = row.file.segments[row.file.segments.length - 1];
  return deepest || baseStem(row.file.name);
}

/* ─── Upload/commit bookkeeping types ─── */

type RowUploadState =
  | 'pending'
  | 'presigning'
  | 'uploading'
  | 'uploaded'
  | 'presign-failed'
  | 'upload-failed';
interface UploadStatus {
  state: RowUploadState;
  error?: string;
}
interface ClubCommitResult {
  ok: boolean;
  error?: string;
}

const UPLOAD_CONCURRENCY = 4;

/* ─── The wizard itself ─── */

export function DocIntakeWizard({ toast }: { toast: Toast }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();

  const configQ = useQuery({
    queryKey: qk.platformTenant(slug),
    queryFn: () => api.platformGetTenant(slug),
    retry: 0,
  });
  const overviewQ = useQuery({
    queryKey: qk.platformTenantOverview(slug),
    queryFn: () => api.platformTenantOverview(slug),
    retry: 0,
  });

  // Local, appendable copy of the club list — creating a club updates this immediately
  // (rather than waiting on a refetch round-trip) so the row it was created for
  // re-matches on the very next render.
  const [clubs, setClubs] = useState<InsightsClub[]>([]);
  useEffect(() => {
    if (overviewQ.data) setClubs(overviewQ.data.clubs);
  }, [overviewQ.data]);
  const clubsById = useMemo(() => new Map(clubs.map((c) => [c.id, c])), [clubs]);
  const clubIndex = useMemo(() => buildClubIndex(clubs), [clubs]);
  const sortedClubs = useMemo(
    () => [...clubs].sort((a, b) => a.name.localeCompare(b.name)),
    [clubs],
  );

  // GET /platform/tenants/:slug returns the RAW config row — no server-side
  // resolveRequiredDocs fallback (that lives in the two intake routes' activeRequiredDocs
  // call, not here). A tenant that has never explicitly saved a catalogue has
  // `requiredDocs: undefined`, so this mirrors districts (two lines down) and
  // platform-required-docs.tsx's `configured ?? DEFAULT_REQUIRED_DOCS`: fall back to the
  // shared defaults rather than an empty catalogue, or the wizard is unusable on every
  // tenant that hasn't customized its docs yet. Memoized so identity is stable across
  // renders — pickableDocs/docsByKey below depend on it.
  const docsCatalogue: RequiredDoc[] = useMemo(
    () => configQ.data?.requiredDocs ?? DEFAULT_REQUIRED_DOCS,
    [configQ.data?.requiredDocs],
  );
  const pickableDocs = useMemo(
    () => docsCatalogue.filter((d) => !d.archived && d.kind !== 'form'),
    [docsCatalogue],
  );
  const docsByKey = useMemo(() => new Map(docsCatalogue.map((d) => [d.key, d])), [docsCatalogue]);
  const districts = configQ.data?.districts?.length ? configQ.data.districts : DISTRICTS;

  type Step = 'ingest' | 'review' | 'commit';
  const [step, setStep] = useState<Step>('ingest');

  // ── Ingest ──
  const [files, setFiles] = useState<IntakeFile[]>([]);
  const [blobs, setBlobs] = useState<Map<string, Blob>>(new Map());
  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestErr, setIngestErr] = useState('');
  const zipInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  function resetMatchState() {
    setEdits({});
    setOverrideIncluded({});
    selection.clear();
  }

  async function ingestZip(file: File) {
    setIngestErr('');
    setIngestBusy(true);
    try {
      const entries = await extractZip(file);
      const { files: f, blobs: b } = toWizardFiles(entries);
      setFiles(f);
      setBlobs(b);
      resetMatchState();
    } catch {
      setIngestErr('Could not read that zip file — try again, or use the folder picker below');
    } finally {
      setIngestBusy(false);
    }
  }
  function ingestFolder(list: FileList) {
    setIngestErr('');
    const entries = entriesFromFileList(list);
    const { files: f, blobs: b } = toWizardFiles(entries);
    setFiles(f);
    setBlobs(b);
    resetMatchState();
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  // ── Layout + Review (one screen — see header comment) ──
  const [strategyKey, setStrategyKey] = useState(INTAKE_STRATEGIES[0].key);
  const [edits, setEdits] = useState<
    Record<string, { clubId: string | null; docKey: string | null }>
  >({});
  const [overrideIncluded, setOverrideIncluded] = useState<Record<string, boolean>>({});
  const [createClubFor, setCreateClubFor] = useState<IntakeRow | null>(null);
  const [attentionOnly, setAttentionOnly] = useState(false);

  // Whether the resolved club already has a stored single-file doc for this key —
  // findConflicts only catches two files IN THIS BATCH competing for one slot; this is
  // the batch colliding with what's already on record, which committing would silently
  // S3-delete and replace. Stable across renders so it's safe as a rows-memo dependency.
  const hasExistingDoc = useCallback(
    (clubId: string, docKey: string) => !!clubsById.get(clubId)?.docs?.[docKey],
    [clubsById],
  );

  const rows = useMemo<IntakeRow[]>(() => {
    if (!files.length) return [];
    const base = buildRows(files, clubIndex, docsCatalogue, strategyKey);
    const matched = !Object.keys(edits).length
      ? base
      : // Re-run the same pure passes an initial match would — a manual reassignment can
        // introduce a fresh duplicate or single-file conflict just as easily as the
        // matcher can.
        findConflicts(
          findDuplicates(
            base.map((r) => {
              const e = edits[r.file.id];
              return e ? applyManualPick(r, e.clubId, e.docKey) : r;
            }),
          ),
          docsCatalogue,
        );
    return flagExistingDocs(matched, docsCatalogue, hasExistingDoc);
  }, [files, clubIndex, docsCatalogue, strategyKey, edits, hasExistingDoc]);

  const included = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const r of rows) {
      const manual = overrideIncluded[r.file.id];
      map.set(
        r.file.id,
        manual !== undefined
          ? manual
          : r.status !== 'duplicate' && r.status !== 'conflict' && !r.replacesExisting,
      );
    }
    return map;
  }, [rows, overrideIncluded]);

  function displayStatus(row: IntakeRow): MatchStatus {
    return included.get(row.file.id) ? row.status : 'excluded';
  }
  function lowConfidence(row: IntakeRow): boolean {
    return row.status === 'ready' && (row.clubConfidence < 1 || row.docConfidence < 0.6);
  }
  function needsAttention(row: IntakeRow): boolean {
    return !included.get(row.file.id) || row.status !== 'ready' || lowConfidence(row);
  }

  function setRowClub(id: string, clubId: string | null) {
    const row = rows.find((r) => r.file.id === id);
    setEdits((e) => ({ ...e, [id]: { clubId, docKey: row?.docKey ?? null } }));
  }
  function setRowDoc(id: string, docKey: string | null) {
    const row = rows.find((r) => r.file.id === id);
    setEdits((e) => ({ ...e, [id]: { clubId: row?.clubId ?? null, docKey } }));
  }
  function setIncluded(ids: Iterable<string>, on: boolean) {
    setOverrideIncluded((cur) => {
      const next = { ...cur };
      for (const id of ids) next[id] = on;
      return next;
    });
  }
  const visibleRows = attentionOnly ? rows.filter(needsAttention) : rows;
  const readyCount = rows.filter((r) => included.get(r.file.id) && r.status === 'ready').length;
  const excludedCount = rows.filter((r) => !included.get(r.file.id)).length;
  const attentionCount = rows.length - readyCount - excludedCount;

  const selection = useRowSelection(visibleRows.map((r) => r.file.id));
  const { selected } = selection;
  const toggleSelected = selection.toggle;

  const [bulkClub, setBulkClub] = useState('');
  const [bulkDoc, setBulkDoc] = useState('');
  function applyBulkClub() {
    if (!bulkClub) return;
    for (const id of selected) setRowClub(id, bulkClub);
  }
  function applyBulkDoc() {
    if (!bulkDoc) return;
    for (const id of selected) setRowDoc(id, bulkDoc);
  }

  // ── Commit ──
  const toCommit = useMemo(
    () => committableRows(rows).filter((r) => included.get(r.file.id)),
    [rows, included],
  );
  const [uploadStatus, setUploadStatus] = useState<Record<string, UploadStatus>>({});
  const [clubCommits, setClubCommits] = useState<Record<string, ClubCommitResult>>({});
  const [committing, setCommitting] = useState(false);
  const [presignByFile, setPresignByFile] = useState<Map<string, DocIntakePresignResult>>(
    new Map(),
  );

  function afterServerWrite() {
    queryClient.invalidateQueries({ queryKey: qk.platformTenant(slug) });
    queryClient.invalidateQueries({ queryKey: qk.platformTenantOverview(slug) });
  }

  /**
   * Presign every committable row (batches of ≤100, positional response) → upload with
   * a small concurrency pool → commit each club the MOMENT its own uploads have all
   * settled, rather than waiting for the whole run. Committing per club as it finishes
   * (instead of one big commit at the end) bounds how long a successfully-uploaded S3
   * object can sit unreferenced if the operator's tab closes mid-run.
   */
  async function runCommit() {
    setCommitting(true);
    const items = toCommit;
    const localPresign = new Map<string, DocIntakePresignResult>();
    const localStatus: Record<string, UploadStatus> = {};
    for (const r of items) localStatus[r.file.id] = { state: 'presigning' };
    setUploadStatus({ ...localStatus });

    for (let i = 0; i < items.length; i += 100) {
      const batch = items.slice(i, i + 100);
      const res = await api.platformDocIntakePresign(
        slug,
        batch.map((r) => ({
          clubId: r.clubId!,
          docKey: r.docKey!,
          contentType: r.file.mime,
          size: r.file.size,
        })),
      );
      batch.forEach((r, j) => {
        const p = res.items[j];
        localPresign.set(r.file.id, p);
        localStatus[r.file.id] = p.ok
          ? { state: 'pending' }
          : { state: 'presign-failed', error: (p as { ok: false; error: string }).error };
      });
    }
    setPresignByFile(new Map(localPresign));
    setUploadStatus({ ...localStatus });

    const byClub = new Map<string, IntakeRow[]>();
    for (const r of items) {
      if (!localPresign.get(r.file.id)?.ok) continue;
      const list = byClub.get(r.clubId!) ?? [];
      list.push(r);
      byClub.set(r.clubId!, list);
    }
    const remaining = new Map(Array.from(byClub.entries()).map(([id, rs]) => [id, rs.length]));
    const localCommits: Record<string, ClubCommitResult> = {};

    async function commitClub(clubId: string) {
      const clubRows = (byClub.get(clubId) ?? []).filter(
        (r) => localStatus[r.file.id]?.state === 'uploaded',
      );
      if (!clubRows.length) {
        localCommits[clubId] = { ok: false, error: 'No files uploaded for this club' };
        setClubCommits({ ...localCommits });
        return;
      }
      try {
        for (let i = 0; i < clubRows.length; i += 100) {
          const batch = clubRows.slice(i, i + 100);
          const res = await api.platformDocIntakeCommit(
            slug,
            batch.map((r) => {
              const p = localPresign.get(r.file.id) as Extract<
                DocIntakePresignResult,
                { ok: true }
              >;
              return {
                clubId,
                docKey: r.docKey!,
                objectKey: p.objectKey,
                size: r.file.size,
                contentType: r.file.mime,
                sourceName: r.file.name,
              };
            }),
          );
          const mine = res.clubs.find((c) => c.clubId === clubId);
          if (mine && !mine.ok) throw new ApiError(0, (mine as { ok: false; error: string }).error);
        }
        localCommits[clubId] = { ok: true };
      } catch (e) {
        localCommits[clubId] = {
          ok: false,
          error: e instanceof ApiError ? e.message : 'Commit failed',
        };
      }
      setClubCommits({ ...localCommits });
      afterServerWrite();
    }

    const commitPromises: Promise<void>[] = [];
    async function uploadOne(r: IntakeRow) {
      const p = localPresign.get(r.file.id) as Extract<DocIntakePresignResult, { ok: true }>;
      localStatus[r.file.id] = { state: 'uploading' };
      setUploadStatus({ ...localStatus });
      try {
        await api.uploadToPresigned(p.uploadUrl, blobs.get(r.file.id)!, p.contentType);
        localStatus[r.file.id] = { state: 'uploaded' };
      } catch (e) {
        localStatus[r.file.id] = {
          state: 'upload-failed',
          error: e instanceof ApiError ? e.message : 'Upload failed',
        };
      }
      setUploadStatus({ ...localStatus });
      const left = (remaining.get(r.clubId!) ?? 1) - 1;
      remaining.set(r.clubId!, left);
      if (left === 0) commitPromises.push(commitClub(r.clubId!));
    }

    const queue = items.filter((r) => localPresign.get(r.file.id)?.ok);
    async function worker() {
      let next: IntakeRow | undefined;
      while ((next = queue.shift())) await uploadOne(next);
    }
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker));
    await Promise.all(commitPromises);
    setCommitting(false);
  }

  /** One-off presign → upload → commit for a single failed row, outside the pooled run. */
  async function retryRow(row: IntakeRow) {
    setUploadStatus((s) => ({ ...s, [row.file.id]: { state: 'presigning' } }));
    try {
      const res = await api.platformDocIntakePresign(slug, [
        {
          clubId: row.clubId!,
          docKey: row.docKey!,
          contentType: row.file.mime,
          size: row.file.size,
        },
      ]);
      const p = res.items[0];
      setPresignByFile((m) => new Map(m).set(row.file.id, p));
      if (!p.ok) {
        const err = (p as { ok: false; error: string }).error;
        setUploadStatus((s) => ({ ...s, [row.file.id]: { state: 'presign-failed', error: err } }));
        return;
      }
      setUploadStatus((s) => ({ ...s, [row.file.id]: { state: 'uploading' } }));
      await api.uploadToPresigned(p.uploadUrl, blobs.get(row.file.id)!, p.contentType);
      setUploadStatus((s) => ({ ...s, [row.file.id]: { state: 'uploaded' } }));
      const commitRes = await api.platformDocIntakeCommit(slug, [
        {
          clubId: row.clubId!,
          docKey: row.docKey!,
          objectKey: p.objectKey,
          size: row.file.size,
          contentType: row.file.mime,
          sourceName: row.file.name,
        },
      ]);
      const mine = commitRes.clubs.find((c) => c.clubId === row.clubId);
      const commitResult: ClubCommitResult =
        mine && mine.ok
          ? { ok: true }
          : {
              ok: false,
              error: mine ? (mine as { ok: false; error: string }).error : 'Commit failed',
            };
      setClubCommits((cs) => ({ ...cs, [row.clubId!]: commitResult }));
      afterServerWrite();
      toast('Retried — file stored');
    } catch (e) {
      setUploadStatus((s) => ({
        ...s,
        [row.file.id]: {
          state: 'upload-failed',
          error: e instanceof ApiError ? e.message : 'Retry failed',
        },
      }));
    }
  }

  const uploadedCount = Object.values(uploadStatus).filter((s) => s.state === 'uploaded').length;
  const failedCount = Object.values(uploadStatus).filter(
    (s) => s.state === 'upload-failed' || s.state === 'presign-failed',
  ).length;
  const clubsUpdatedCount = Object.values(clubCommits).filter((c) => c.ok).length;
  const commitDone =
    !committing &&
    Object.keys(uploadStatus).length > 0 &&
    Object.values(uploadStatus).every((s) => s.state === 'uploaded' || s.state.endsWith('failed'));

  if (configQ.isLoading || overviewQ.isLoading)
    return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading client…</p>;
  if (configQ.isError || overviewQ.isError || !configQ.data || !overviewQ.data)
    return (
      <div>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 14 }}>
          Could not load this client — refresh to retry.
        </p>
        <Btn tone="outline" size="sm" onClick={() => navigate(`/platform/tenants/${slug}`)}>
          Back to settings
        </Btn>
      </div>
    );

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">
            Platform / Clients / {configQ.data.branding?.name ?? slug} / Bulk document intake
          </div>
          <h1 className="ph-title">
            Bulk document <em>intake</em>
          </h1>
          <p className="ph-desc">
            Turn a client's whole compliance-doc submission pack into per-club uploads without
            opening 100 club pages by hand.
          </p>
        </div>
        <div className="ph-actions">
          <Btn
            tone="outline"
            size="sm"
            onClick={() => navigate(`/platform/tenants/${slug}/onboarding`)}
          >
            Back to onboarding
          </Btn>
          <Btn tone="outline" size="sm" onClick={() => navigate(`/platform/tenants/${slug}`)}>
            Back to settings
          </Btn>
        </div>
      </div>

      {pickableDocs.length === 0 && (
        <Card>
          <EmptyState
            icon={Icon.Doc}
            title="No document types configured"
            sub="Add at least one active document to this client's compliance-doc catalogue before running an intake."
          />
        </Card>
      )}

      {pickableDocs.length > 0 && step === 'ingest' && (
        <Card
          title="1. Bring in the pack"
          sub="Nothing is uploaded at this stage — this only reads files in the browser."
        >
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) void ingestZip(f);
              }}
              style={{
                flex: '1 1 260px',
                border: '1.5px dashed var(--line2)',
                borderRadius: 10,
                padding: 20,
                textAlign: 'center',
              }}
            >
              <Icon.Upload />
              <p style={{ fontSize: 13, fontWeight: 700, margin: '8px 0 2px' }}>Drop a .zip here</p>
              <p style={HINT}>or</p>
              <input
                ref={zipInputRef}
                type="file"
                accept=".zip,application/zip"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void ingestZip(f);
                }}
              />
              <Btn
                tone="outline"
                size="sm"
                disabled={ingestBusy}
                onClick={() => zipInputRef.current?.click()}
              >
                {ingestBusy ? 'Extracting…' : 'Choose a .zip'}
              </Btn>
            </div>
            <div
              style={{
                flex: '1 1 260px',
                border: '1.5px dashed var(--line2)',
                borderRadius: 10,
                padding: 20,
                textAlign: 'center',
              }}
            >
              <Icon.Doc />
              <p style={{ fontSize: 13, fontWeight: 700, margin: '8px 0 2px' }}>Or pick a folder</p>
              <p style={HINT}>For packs too large to hold as one zip.</p>
              <input
                ref={folderInputRef}
                type="file"
                // webkitdirectory has no typed React prop — set as a raw DOM attribute.
                {...{ webkitdirectory: 'true', directory: 'true' }}
                style={{ display: 'none' }}
                onChange={(e) => {
                  const list = e.target.files;
                  e.target.value = '';
                  if (list && list.length) ingestFolder(list);
                }}
              />
              <Btn tone="outline" size="sm" onClick={() => folderInputRef.current?.click()}>
                Choose a folder
              </Btn>
            </div>
          </div>

          {ingestErr && <div style={{ ...ERR, marginTop: 12 }}>{ingestErr}</div>}

          {files.length > 0 && (
            <div
              style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop: '1px solid var(--line2)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <Pill tone="teal">
                {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
              </Pill>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Nothing uploaded yet.</span>
              <Btn tone="teal" size="sm" onClick={() => setStep('review')}>
                Continue to matching
              </Btn>
            </div>
          )}
        </Card>
      )}

      {pickableDocs.length > 0 && step === 'review' && (
        <>
          <Card
            title="2. Layout"
            sub="How the pack is organised — changing this re-matches every row immediately."
            style={{ marginBottom: 16 }}
          >
            <select
              className="field-select"
              style={{ maxWidth: 320 }}
              value={strategyKey}
              onChange={(e) => {
                setStrategyKey(e.target.value);
                resetMatchState();
              }}
            >
              {INTAKE_STRATEGIES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            <p style={HINT}>{INTAKE_STRATEGIES.find((s) => s.key === strategyKey)?.hint}</p>
          </Card>

          <Card
            title="3. Review"
            sub="Confirm the guesses, fix the rest. Low-confidence matches are flagged even when marked ready."
          >
            <div
              style={{
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <ReviewCounters
                counters={[
                  { label: 'ready', count: readyCount, tone: 'teal' },
                  { label: 'need attention', count: attentionCount, tone: 'gold' },
                  { label: 'excluded', count: excludedCount, tone: 'muted' },
                ]}
              />
              <label
                style={{
                  fontSize: 12,
                  display: 'inline-flex',
                  gap: 6,
                  alignItems: 'center',
                  marginLeft: 'auto',
                }}
              >
                <input
                  type="checkbox"
                  checked={attentionOnly}
                  onChange={(e) => setAttentionOnly(e.target.checked)}
                />
                Show only rows needing attention
              </label>
            </div>

            <BulkActionBar count={selected.size}>
              <select
                className="field-select"
                style={{ width: 200 }}
                value={bulkClub}
                onChange={(e) => setBulkClub(e.target.value)}
              >
                <option value="">— pick a club —</option>
                {sortedClubs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Btn tone="outline" size="sm" disabled={!bulkClub} onClick={applyBulkClub}>
                Assign club to selected
              </Btn>
              <select
                className="field-select"
                style={{ width: 200 }}
                value={bulkDoc}
                onChange={(e) => setBulkDoc(e.target.value)}
              >
                <option value="">— pick a document —</option>
                {pickableDocs.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.name}
                  </option>
                ))}
              </select>
              <Btn tone="outline" size="sm" disabled={!bulkDoc} onClick={applyBulkDoc}>
                Assign document type to selected
              </Btn>
              <Btn tone="ghost" size="sm" onClick={() => setIncluded(selected, false)}>
                Exclude selected
              </Btn>
              <Btn tone="ghost" size="sm" onClick={() => setIncluded(selected, true)}>
                Include selected
              </Btn>
            </BulkActionBar>

            {visibleRows.length === 0 ? (
              <EmptyState
                icon={Icon.Check}
                title="Nothing to show"
                sub="No rows match the current filter."
              />
            ) : (
              <div className="fix-table-wrap">
                <table className="fix-table">
                  <thead>
                    <tr>
                      <th style={{ width: 30 }}>
                        <input
                          type="checkbox"
                          checked={selection.allSelected}
                          onChange={(e) => selection.toggleAll(e.target.checked)}
                        />
                      </th>
                      <th>File</th>
                      <th style={{ width: 220 }}>Club</th>
                      <th style={{ width: 220 }}>Document</th>
                      <th style={{ width: 80, textAlign: 'right' }}>Size</th>
                      <th style={{ width: 150 }}>Status</th>
                      <th style={{ width: 70 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => {
                      const id = row.file.id;
                      const status = displayStatus(row);
                      const meta = STATUS_META[status];
                      const flagged = lowConfidence(row);
                      const dup = !!row.replacesExisting;
                      return (
                        <tr key={id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selected.has(id)}
                              onChange={(e) => toggleSelected(id, e.target.checked)}
                            />
                          </td>
                          <td>
                            <div style={{ fontWeight: 600, fontSize: 12.5 }}>{row.file.name}</div>
                            {row.file.segments.length > 0 && (
                              <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>
                                {row.file.segments.join(' / ')}
                              </div>
                            )}
                          </td>
                          <td>
                            <select
                              className="field-select"
                              style={{ width: '100%' }}
                              value={row.clubId ?? ''}
                              onChange={(e) => setRowClub(id, e.target.value || null)}
                            >
                              <option value="">— pick a club —</option>
                              {sortedClubs.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                            {row.status === 'unmatched-club' && (
                              <Btn tone="ghost" size="sm" onClick={() => setCreateClubFor(row)}>
                                Create club…
                              </Btn>
                            )}
                          </td>
                          <td>
                            <select
                              className="field-select"
                              style={{ width: '100%' }}
                              value={row.docKey ?? ''}
                              onChange={(e) => setRowDoc(id, e.target.value || null)}
                            >
                              <option value="">— pick a document —</option>
                              {pickableDocs.map((d) => (
                                <option key={d.key} value={d.key}>
                                  {d.name}
                                </option>
                              ))}
                            </select>
                            {dup && (
                              <div
                                style={{
                                  fontSize: 10.5,
                                  color: 'var(--coral, #C0392B)',
                                  marginTop: 2,
                                }}
                              >
                                Already uploaded — will be replaced
                              </div>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', fontSize: 11.5, color: 'var(--muted)' }}>
                            {formatBytes(row.file.size)}
                          </td>
                          <td>
                            <div
                              style={{
                                display: 'flex',
                                gap: 4,
                                flexWrap: 'wrap',
                                alignItems: 'center',
                              }}
                            >
                              <Pill tone={meta.tone}>{meta.label}</Pill>
                              {flagged && <Pill tone="gold">Check this</Pill>}
                            </div>
                            {row.note && status !== 'excluded' && (
                              <div
                                style={{ fontSize: 10.5, color: 'var(--muted-2)', marginTop: 2 }}
                              >
                                {row.note}
                              </div>
                            )}
                            {(row.status === 'duplicate' ||
                              row.status === 'conflict' ||
                              row.replacesExisting) &&
                              !included.get(id) && (
                                <Btn tone="ghost" size="sm" onClick={() => setIncluded([id], true)}>
                                  Include anyway
                                </Btn>
                              )}
                          </td>
                          <td>
                            <Btn
                              tone="ghost"
                              size="sm"
                              onClick={() => setIncluded([id], !included.get(id))}
                            >
                              {included.get(id) ? 'Exclude' : 'Include'}
                            </Btn>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <Btn tone="outline" size="sm" onClick={() => setStep('ingest')}>
                Back
              </Btn>
              <Btn
                tone="teal"
                size="sm"
                disabled={toCommit.length === 0}
                onClick={() => setStep('commit')}
              >
                Continue to upload ({toCommit.length} file{toCommit.length === 1 ? '' : 's'})
              </Btn>
            </div>
          </Card>
        </>
      )}

      {step === 'commit' && (
        <Card
          title="4. Upload & commit"
          sub="Presigns in batches, uploads a few files at a time, and records each club's files the moment that club's uploads finish."
        >
          {Object.keys(uploadStatus).length === 0 && !committing && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Btn tone="outline" size="sm" onClick={() => setStep('review')}>
                Back
              </Btn>
              <Btn tone="teal" size="sm" onClick={() => void runCommit()}>
                Start upload ({toCommit.length} file{toCommit.length === 1 ? '' : 's'})
              </Btn>
            </div>
          )}

          {Object.keys(uploadStatus).length > 0 && (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <Pill tone="teal">{uploadedCount} uploaded</Pill>
                <Pill tone="coral">{failedCount} failed</Pill>
                <Pill tone="muted">{clubsUpdatedCount} clubs updated</Pill>
                {committing && (
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>Working…</span>
                )}
              </div>
              <div className="fix-table-wrap">
                <table className="fix-table">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th style={{ width: 160 }}>Club</th>
                      <th style={{ width: 160 }}>Document</th>
                      <th style={{ width: 130 }}>Upload</th>
                      <th style={{ width: 130 }}>Club commit</th>
                      <th style={{ width: 70 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {toCommit.map((row) => {
                      const s = uploadStatus[row.file.id];
                      const club = clubsById.get(row.clubId!);
                      const doc = docsByKey.get(row.docKey!);
                      const commit = clubCommits[row.clubId!];
                      const failed = s?.state === 'upload-failed' || s?.state === 'presign-failed';
                      return (
                        <tr key={row.file.id}>
                          <td style={{ fontSize: 12.5 }}>{row.file.name}</td>
                          <td style={{ fontSize: 12.5 }}>{club?.name ?? row.clubId}</td>
                          <td style={{ fontSize: 12.5 }}>{doc?.name ?? row.docKey}</td>
                          <td>
                            <Pill
                              tone={s?.state === 'uploaded' ? 'teal' : failed ? 'coral' : 'muted'}
                            >
                              {s?.state ?? 'pending'}
                            </Pill>
                            {s?.error && (
                              <div style={{ fontSize: 10.5, color: 'var(--muted-2)' }}>
                                {s.error}
                              </div>
                            )}
                          </td>
                          <td>
                            {commit ? (
                              <Pill tone={commit.ok ? 'teal' : 'coral'}>
                                {commit.ok ? 'Committed' : commit.error || 'Failed'}
                              </Pill>
                            ) : (
                              <Pill tone="muted">—</Pill>
                            )}
                          </td>
                          <td>
                            {failed && (
                              <Btn tone="ghost" size="sm" onClick={() => void retryRow(row)}>
                                Retry
                              </Btn>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {commitDone && (
                <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line2)' }}>
                  <p style={{ fontSize: 13, fontWeight: 700 }}>
                    {clubsUpdatedCount} club{clubsUpdatedCount === 1 ? '' : 's'} updated ·{' '}
                    {uploadedCount} file{uploadedCount === 1 ? '' : 's'} stored
                    {failedCount > 0 && ` · ${failedCount} failed`}
                  </p>
                  <Btn
                    tone="teal"
                    size="sm"
                    onClick={() => {
                      toast('Bulk intake complete');
                      navigate(`/platform/tenants/${slug}/overview`);
                    }}
                  >
                    Done — view overview
                  </Btn>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {createClubFor &&
        (() => {
          const target = createClubFor;
          return (
            <CreateClubModal
              slug={slug}
              initialName={guessClubName(target)}
              districts={districts}
              eyebrow="Bulk intake · New club"
              onClose={() => setCreateClubFor(null)}
              onCreated={(club) => {
                setClubs((cs) => [...cs, club as unknown as InsightsClub]);
                setCreateClubFor(null);
                toast(`${club.name} created — rows re-matched`);
              }}
            />
          );
        })()}
    </div>
  );
}
