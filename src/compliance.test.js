import { describe, it, expect } from 'vitest';
import {
  computeMarkCompliance,
  computeRevertCompliance,
  docsAllComplete,
  docsUploadedCount,
  docFileMeta,
  REQUIRED_DOCS,
} from './data.jsx';

// A club with no financial statements can mark that doc "Unavailable": docs.financials
// flips true (so compliance reads complete) with a distinct {unavailable} sentinel,
// which carries no objectKey and so never renders a viewable file.
describe('financial-statements "Unavailable" sentinel', () => {
  const allButFin = Object.fromEntries(REQUIRED_DOCS.map((d) => [d.key, d.key !== 'financials']));

  it('counts an unavailable doc as complete', () => {
    const club = {
      docs: { ...allButFin, financials: true },
      docMeta: { financials: { unavailable: true, at: '2026-06-15T00:00:00.000Z' } },
    };
    expect(docsUploadedCount(club)).toBe(REQUIRED_DOCS.length);
    expect(docsAllComplete(club)).toBe(true);
  });

  it('exposes no real file for the sentinel (no View affordance)', () => {
    expect(docFileMeta({ unavailable: true, at: 'x' }).real).toBe(false);
  });

  it('undo (clearing the flag) drops it back to incomplete', () => {
    const club = { docs: { ...allButFin, financials: false }, docMeta: {} };
    expect(docsAllComplete(club)).toBe(false);
  });
});

// A subset of compliance-doc keys — these helpers operate on the keys passed in,
// not on REQUIRED_DOCS, so this stays a fixed list independent of the full set.
const KEYS = ['constitution', 'agm', 'financials', 'exco'];
const AT = '2026-06-03T10:00:00.000Z';

// Minimal club factory — only the fields the compliance helpers read.
function club({ docs = {}, docMeta = {} } = {}) {
  return { docs, docMeta };
}

describe('computeMarkCompliance', () => {
  it('marks all-missing docs compliant with a markedCompliant sentinel', () => {
    const c = club({ docs: { constitution: false, agm: false, financials: false, exco: false } });
    const { docs, docMeta, flipped } = computeMarkCompliance(c, KEYS, AT);

    expect(docs).toEqual({ constitution: true, agm: true, financials: true, exco: true });
    expect(flipped).toEqual(KEYS);
    for (const k of KEYS) expect(docMeta[k]).toEqual({ markedCompliant: true, at: AT });
  });

  it('never touches a doc with a real upload (objectKey)', () => {
    const upload = { objectKey: 'tenant/club/agm-x.pdf', size: 2048, uploadedAt: '2026-05-01' };
    const c = club({
      docs: { constitution: false, agm: true, financials: false, exco: false },
      docMeta: { agm: upload },
    });
    const { docs, docMeta, flipped } = computeMarkCompliance(c, KEYS, AT);

    // agm stays exactly as uploaded; not in the flipped (undoable) set.
    expect(docMeta.agm).toBe(upload);
    expect(docs.agm).toBe(true);
    expect(flipped).toEqual(['constitution', 'financials', 'exco']);
  });

  it('excludes already-override docs from flipped so Undo cannot over-revert', () => {
    const c = club({
      docs: { constitution: true, agm: false, financials: false, exco: false },
      docMeta: { constitution: { markedCompliant: true, at: '2026-01-01' } },
    });
    const { flipped } = computeMarkCompliance(c, KEYS, AT);

    // constitution was already an override → not part of this action's undo set.
    expect(flipped).toEqual(['agm', 'financials', 'exco']);
  });

  it('returns an empty flipped set when nothing is missing', () => {
    const c = club({
      docs: { constitution: true, agm: true, financials: true, exco: true },
      docMeta: {
        constitution: { objectKey: 'k' },
        agm: { markedCompliant: true, at: AT },
        financials: { objectKey: 'k2' },
        exco: { markedCompliant: true, at: AT },
      },
    });
    expect(computeMarkCompliance(c, KEYS, AT).flipped).toEqual([]);
  });

  it('does not mutate the input club', () => {
    const docs = { constitution: false };
    const docMeta = {};
    const c = club({ docs, docMeta });
    computeMarkCompliance(c, ['constitution'], AT);
    expect(docs).toEqual({ constitution: false });
    expect(docMeta).toEqual({});
  });
});

describe('computeRevertCompliance', () => {
  it('reverts override-only docs back to Missing and deletes their meta', () => {
    const c = club({
      docs: { constitution: true, agm: true },
      docMeta: {
        constitution: { markedCompliant: true, at: AT },
        agm: { markedCompliant: true, at: AT },
      },
    });
    const { docs, docMeta, reverted } = computeRevertCompliance(c, ['constitution', 'agm']);

    expect(docs).toEqual({ constitution: false, agm: false });
    expect(docMeta).toEqual({});
    expect(reverted).toEqual(['constitution', 'agm']);
  });

  it('never reverts a real upload — uploads are structurally untouchable', () => {
    const upload = { objectKey: 'tenant/club/agm.pdf', size: 10, uploadedAt: AT };
    const c = club({ docs: { agm: true }, docMeta: { agm: upload } });
    const { docs, docMeta, reverted } = computeRevertCompliance(c, ['agm']);

    expect(docs.agm).toBe(true);
    expect(docMeta.agm).toBe(upload);
    expect(reverted).toEqual([]);
  });

  it('no-ops (empty reverted) when the key was concurrently replaced by an upload', () => {
    // Simulates: marked override, then a file landed before the Undo fired.
    const c = club({
      docs: { agm: true },
      docMeta: { agm: { objectKey: 'late-upload.pdf', markedCompliant: true } },
    });
    // objectKey present → gate skips it even though markedCompliant lingers.
    expect(computeRevertCompliance(c, ['agm']).reverted).toEqual([]);
  });

  it('ignores keys with no override marker', () => {
    const c = club({ docs: { agm: false }, docMeta: {} });
    expect(computeRevertCompliance(c, ['agm']).reverted).toEqual([]);
  });
});

describe('mark → undo → undo round-trip', () => {
  it('returns to the original state and back, preserving an existing upload throughout', () => {
    const upload = { objectKey: 'tenant/club/fin.pdf', size: 99, uploadedAt: AT };
    const original = club({
      docs: { constitution: false, agm: false, financials: true, exco: false },
      docMeta: { financials: upload },
    });

    // 1. Mark all four compliant.
    const marked = computeMarkCompliance(original, KEYS, AT);
    expect(marked.docs).toEqual({
      constitution: true,
      agm: true,
      financials: true,
      exco: true,
    });
    expect(marked.flipped).toEqual(['constitution', 'agm', 'exco']); // financials excluded (upload)
    expect(marked.docMeta.financials).toBe(upload); // upload preserved

    // 2. Undo: revert exactly what was flipped.
    const afterUndo = computeRevertCompliance(
      { docs: marked.docs, docMeta: marked.docMeta },
      marked.flipped,
    );
    // Back to the original doc states.
    expect(afterUndo.docs).toEqual({
      constitution: false,
      agm: false,
      financials: true,
      exco: false,
    });
    expect(afterUndo.docMeta).toEqual({ financials: upload }); // upload still intact

    // 3. Undo-the-undo: re-mark the same set → identical to step 1's result.
    const afterRedo = computeMarkCompliance(
      { docs: afterUndo.docs, docMeta: afterUndo.docMeta },
      marked.flipped,
      AT,
    );
    expect(afterRedo.docs).toEqual(marked.docs);
    expect(afterRedo.docMeta.financials).toBe(upload);
    expect(afterRedo.flipped).toEqual(['constitution', 'agm', 'exco']);
  });
});

describe('safeguarding (multi-file) mark/revert', () => {
  const f = (k) => ({ objectKey: `t/c/safeguarding-${k}.pdf`, size: 10, uploadedAt: AT });

  it('mark with no files sets the sentinel with an empty files array', () => {
    const c = club({ docs: { safeguarding: false } });
    const { docs, docMeta, flipped } = computeMarkCompliance(c, ['safeguarding'], AT);
    expect(docs.safeguarding).toBe(true);
    expect(docMeta.safeguarding).toEqual({ files: [], markedCompliant: true, at: AT });
    expect(flipped).toEqual(['safeguarding']);
  });

  it('mark below the minimum preserves the uploaded files in the sentinel', () => {
    const c = club({
      docs: { safeguarding: false },
      docMeta: { safeguarding: { files: [f('a')] } },
    });
    const { docs, docMeta, flipped } = computeMarkCompliance(c, ['safeguarding'], AT);
    expect(docs.safeguarding).toBe(true);
    expect(docMeta.safeguarding).toEqual({ files: [f('a')], markedCompliant: true, at: AT });
    expect(flipped).toEqual(['safeguarding']);
  });

  it('mark is a no-op when the two-file minimum is already met', () => {
    const c = club({
      docs: { safeguarding: true },
      docMeta: { safeguarding: { files: [f('a'), f('b')] } },
    });
    const { docMeta, flipped } = computeMarkCompliance(c, ['safeguarding'], AT);
    expect(docMeta.safeguarding).toEqual({ files: [f('a'), f('b')] });
    expect(flipped).toEqual([]);
  });

  it('mark treats a legacy single-file upload as one file (below minimum)', () => {
    const legacy = f('legacy');
    const c = club({ docs: { safeguarding: true }, docMeta: { safeguarding: legacy } });
    const { docs, docMeta, flipped } = computeMarkCompliance(c, ['safeguarding'], AT);
    // Grandfathered flag was true, so nothing flips for Undo — but the sentinel
    // now wraps the legacy file rather than discarding it.
    expect(flipped).toEqual([]);
    expect(docs.safeguarding).toBe(true);
    expect(docMeta.safeguarding).toEqual({ files: [legacy], markedCompliant: true, at: AT });
  });

  it('revert strips the override but keeps the files, rederiving the flag', () => {
    const c = club({
      docs: { safeguarding: true },
      docMeta: { safeguarding: { files: [f('a')], markedCompliant: true, at: AT } },
    });
    const { docs, docMeta, reverted } = computeRevertCompliance(c, ['safeguarding']);
    expect(docs.safeguarding).toBe(false); // 1 file < minimum
    expect(docMeta.safeguarding).toEqual({ files: [f('a')] });
    expect(reverted).toEqual(['safeguarding']);
  });

  it('revert keeps the doc compliant when the minimum is met by uploads', () => {
    const c = club({
      docs: { safeguarding: true },
      docMeta: { safeguarding: { files: [f('a'), f('b')], markedCompliant: true, at: AT } },
    });
    const { docs, docMeta, reverted } = computeRevertCompliance(c, ['safeguarding']);
    expect(docs.safeguarding).toBe(true); // sentinel gone, flag derives from files
    expect(docMeta.safeguarding).toEqual({ files: [f('a'), f('b')] });
    expect(reverted).toEqual(['safeguarding']);
  });

  it('revert deletes the docMeta key when no files remain', () => {
    const c = club({
      docs: { safeguarding: true },
      docMeta: { safeguarding: { files: [], markedCompliant: true, at: AT } },
    });
    const { docs, docMeta } = computeRevertCompliance(c, ['safeguarding']);
    expect(docs.safeguarding).toBe(false);
    expect(docMeta.safeguarding).toBeUndefined();
  });

  it('revert ignores safeguarding that is neither flagged nor overridden', () => {
    const c = club({
      docs: { safeguarding: false },
      docMeta: { safeguarding: { files: [f('a')] } },
    });
    expect(computeRevertCompliance(c, ['safeguarding']).reverted).toEqual([]);
  });

  it('revert handles a legacy flag-only record (no docMeta at all)', () => {
    // Seeded demo clubs have docs.safeguarding true with no docMeta entry.
    const c = club({ docs: { safeguarding: true }, docMeta: {} });
    const { docs, docMeta, reverted } = computeRevertCompliance(c, ['safeguarding']);
    expect(docs.safeguarding).toBe(false);
    expect(docMeta.safeguarding).toBeUndefined();
    expect(reverted).toEqual(['safeguarding']);
  });

  it('revert handles a grandfathered single-file record (flag true, no sentinel)', () => {
    const legacy = f('legacy');
    const c = club({ docs: { safeguarding: true }, docMeta: { safeguarding: legacy } });
    const { docs, docMeta, reverted } = computeRevertCompliance(c, ['safeguarding']);
    expect(docs.safeguarding).toBe(false); // 1 file < minimum once the flag is reverted
    expect(docMeta.safeguarding).toEqual({ files: [legacy] }); // upload kept
    expect(reverted).toEqual(['safeguarding']);
  });

  it('mark compliant leaves a booked safeguarding course untouched', () => {
    const c = club({
      docs: { safeguarding: true },
      docMeta: {
        safeguarding: { files: [], courseBooked: true, courseDate: '2026-09-01', at: AT },
      },
    });
    const { docs, docMeta, flipped } = computeMarkCompliance(c, ['safeguarding'], AT);
    expect(flipped).toEqual([]); // already declared → nothing flips
    expect(docs.safeguarding).toBe(true);
    expect(docMeta.safeguarding).toEqual({
      files: [],
      courseBooked: true,
      courseDate: '2026-09-01',
      at: AT,
    });
  });

  it('revert never strips a booked safeguarding course (club self-declaration)', () => {
    const c = club({
      docs: { safeguarding: true },
      docMeta: {
        safeguarding: { files: [], courseBooked: true, courseDate: '2026-09-01', at: AT },
      },
    });
    const { docs, docMeta, reverted } = computeRevertCompliance(c, ['safeguarding']);
    expect(reverted).toEqual([]); // booking is not an admin override → not reverted
    expect(docs.safeguarding).toBe(true);
    expect(docMeta.safeguarding).toEqual({
      files: [],
      courseBooked: true,
      courseDate: '2026-09-01',
      at: AT,
    });
  });

  it('mark → undo round-trips below the minimum', () => {
    const original = club({
      docs: { safeguarding: false },
      docMeta: { safeguarding: { files: [f('a')] } },
    });
    const marked = computeMarkCompliance(original, ['safeguarding'], AT);
    const undone = computeRevertCompliance(
      { docs: marked.docs, docMeta: marked.docMeta },
      marked.flipped,
    );
    expect(undone.docs.safeguarding).toBe(false);
    expect(undone.docMeta.safeguarding).toEqual({ files: [f('a')] });
  });
});
