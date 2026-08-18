import { describe, it, expect } from 'vitest';
import type { RequiredDoc } from './types';
import {
  computeMarkCompliance,
  computeRevertCompliance,
  docsAllComplete,
  docsUploadedCount,
  docFileMeta,
  agmMeta,
  cohortStats,
  computeDocUnavailable,
  REQUIRED_DOCS,
  DEFAULT_REQUIRED_DOCS,
  docCompletion,
  docAccept,
  docMimeAllowed,
  safeguardingSatisfied,
  DOC_FORMAT_MIME,
} from './data';

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

// A club with no AGM minutes can instead record the future date its AGM will be held:
// docs.agm flips true (per decision a booked meeting counts the doc complete) with a
// {meetingBooked, meetingDate} sentinel — the single-file analogue of safeguarding's course
// booking. It carries no objectKey (no viewable file) and is NOT an admin override.
describe('AGM "meeting booked" sentinel', () => {
  const allButAgm = Object.fromEntries(REQUIRED_DOCS.map((d) => [d.key, d.key !== 'agm']));

  it('counts a booked-meeting AGM as complete', () => {
    const club = {
      docs: { ...allButAgm, agm: true },
      docMeta: { agm: { meetingBooked: true, meetingDate: '2026-09-01', at: AT } },
    };
    expect(docsUploadedCount(club)).toBe(REQUIRED_DOCS.length);
    expect(docsAllComplete(club)).toBe(true);
  });

  it('agmMeta reads the sentinel; exposes no real file (no View affordance)', () => {
    const meta = { meetingBooked: true, meetingDate: '2026-09-01', at: AT };
    expect(agmMeta(meta)).toEqual({ meetingBooked: true, meetingDate: '2026-09-01' });
    expect(docFileMeta(meta).real).toBe(false);
    expect(agmMeta(undefined)).toEqual({ meetingBooked: false, meetingDate: '' });
  });

  it('admin Revert never strips a booked meeting (club self-declaration, not an override)', () => {
    const c = club({
      docs: { agm: true },
      docMeta: { agm: { meetingBooked: true, meetingDate: '2026-09-01', at: AT } },
    });
    const { docs, docMeta, reverted } = computeRevertCompliance(c, ['agm']);
    expect(reverted).toEqual([]);
    expect(docs.agm).toBe(true);
    expect(docMeta.agm).toEqual({ meetingBooked: true, meetingDate: '2026-09-01', at: AT });
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

// ── Per-tenant catalogue (ADR 0009) ──
// The helpers take the tenant's catalogue as a parameter; every legacy call site omits
// it and gets DEFAULT_REQUIRED_DOCS. These pin BOTH halves: that the default path is
// byte-identical to the pre-catalogue behaviour (dolphins' numbers must not move), and
// that a custom catalogue drives counts, multi-file thresholds and escape hatches off
// its own flags rather than the old key literals.
describe('per-tenant doc catalogue', () => {
  // A Titans-shaped catalogue: no key from the default six behaves the same way. The
  // committee doc is deliberately NOT keyed `exco` (a file, not the on-platform form),
  // and facilityAgreement is multi-file with a minimum of ONE, not two.
  const TITANS: RequiredDoc[] = [
    { key: 'leagueEntry', name: 'Club League Entry', accepts: ['pdf', 'xls', 'xlsx'] },
    { key: 'committee', name: 'Club Committee' },
    {
      key: 'facilityAgreement',
      name: 'Facility Agreements',
      multiFile: true,
      minFiles: 1,
      maxFiles: 3,
      allowUnavailable: true,
    },
    { key: 'retiredThing', name: 'Retired', archived: true },
  ];
  const file = (k) => ({ objectKey: `titans/c/${k}-1.pdf`, size: 10, uploadedAt: 'x' });

  it('counts against the tenant catalogue, ignoring the default six', () => {
    const club = { docs: { leagueEntry: true, committee: true, facilityAgreement: true } };
    // Three ACTIVE docs — the archived entry is excluded from the denominator.
    expect(docsUploadedCount(club, TITANS)).toBe(3);
    expect(docsAllComplete(club, TITANS)).toBe(true);
    expect(docCompletion(club, TITANS)).toBe(100);
    // The same club scored against the defaults is nowhere near complete.
    expect(docsAllComplete(club)).toBe(false);
  });

  it('an archived doc never blocks completion even when the club never had it', () => {
    const club = { docs: { leagueEntry: true, committee: true, facilityAgreement: true } };
    expect(docsAllComplete(club, TITANS)).toBe(true);
  });

  it('a tenant with no required docs is trivially complete', () => {
    expect(docCompletion({ docs: {} }, [])).toBe(100);
    expect(docsAllComplete({ docs: {} }, [])).toBe(true);
  });

  it('mark-compliant honours multiFile from the catalogue, not the key name', () => {
    const club = { docs: {}, docMeta: {} };
    const { docs, docMeta } = computeMarkCompliance(
      club,
      ['facilityAgreement', 'committee'],
      'AT',
      TITANS,
    );
    expect(docs.facilityAgreement).toBe(true);
    // The multi-file sentinel PRESERVES a files array; the single-file one does not.
    expect(docMeta.facilityAgreement).toEqual({ files: [], markedCompliant: true, at: 'AT' });
    expect(docMeta.committee).toEqual({ markedCompliant: true, at: 'AT' });
  });

  it('respects a per-doc minFiles of 1 (the default six use 2)', () => {
    // One file already satisfies facilityAgreement, so mark-compliant must leave it alone.
    const club = {
      docs: { facilityAgreement: true },
      docMeta: { facilityAgreement: { files: [file('facilityAgreement')] } },
    };
    const { docMeta, flipped } = computeMarkCompliance(club, ['facilityAgreement'], 'AT', TITANS);
    expect(flipped).toEqual([]);
    expect(docMeta.facilityAgreement.markedCompliant).toBeUndefined();
    // Under the DEFAULT catalogue's 2-file minimum the same shape is NOT satisfied —
    // proving the threshold comes from the definition, not a constant.
    expect(safeguardingSatisfied(club.docMeta.facilityAgreement, 1)).toBe(true);
    expect(safeguardingSatisfied(club.docMeta.facilityAgreement, 2)).toBe(false);
  });

  it('revert strips an override on a custom multi-file doc but keeps its files', () => {
    const club = {
      docs: { facilityAgreement: true },
      docMeta: {
        facilityAgreement: {
          files: [file('facilityAgreement')],
          markedCompliant: true,
          at: 'AT',
        },
      },
    };
    const { docs, docMeta, reverted } = computeRevertCompliance(
      club,
      ['facilityAgreement'],
      TITANS,
    );
    expect(reverted).toEqual(['facilityAgreement']);
    // One file meets this doc's minimum of 1, so it stays satisfied on its own merit.
    expect(docs.facilityAgreement).toBe(true);
    expect(docMeta.facilityAgreement).toEqual({ files: [file('facilityAgreement')] });
  });

  it('a booked meeting is protected by shape, not by the key being "agm"', () => {
    const club = {
      docs: { committee: true },
      docMeta: { committee: { meetingBooked: true, meetingDate: '2026-09-01' } },
    };
    const { reverted } = computeRevertCompliance(club, ['committee'], TITANS);
    expect(reverted).toEqual([]);
  });

  it('per-doc accepted formats drive the file picker', () => {
    const [leagueEntry, committee] = TITANS;
    expect(docAccept(leagueEntry)).toBe('.pdf,.xls,.xlsx');
    expect(docMimeAllowed(leagueEntry, DOC_FORMAT_MIME.xlsx)).toBe(true);
    // A doc with no `accepts` keeps the legacy PDF/Word set.
    expect(docAccept(committee)).toBe('.pdf,.doc,.docx');
    expect(docMimeAllowed(committee, DOC_FORMAT_MIME.xlsx)).toBe(false);
  });

  it('default-catalogue behaviour is unchanged (dolphins parity)', () => {
    const club = Object.fromEntries([
      ['docs', Object.fromEntries(REQUIRED_DOCS.map((d) => [d.key, true]))],
    ]);
    expect(docsUploadedCount(club)).toBe(REQUIRED_DOCS.length);
    expect(docCompletion(club)).toBe(100);
    // Omitting the catalogue argument === passing the defaults explicitly.
    expect(docCompletion(club, DEFAULT_REQUIRED_DOCS)).toBe(docCompletion(club));
  });
});

// The doc helpers gained a trailing catalogue parameter, which makes them look like
// drop-in array predicates — but `filter`/`map` pass the INDEX as the second argument,
// and a plain default only covers `undefined`. Index 0 therefore reached `.filter` on a
// number and white-screened the admin dashboard and its nav counter.
//
// TypeScript rejects the bare form at TYPED call sites (hence the casts below), but
// data.ts itself is loose JS and typechecks nothing — which is exactly where the real
// crash lived. So the guard is a runtime one, and this pins it.
describe('doc helpers used as array callbacks', () => {
  const clubs = [
    { affiliation: 'complete', cqi: 50, docs: {} },
    { affiliation: 'not_started', cqi: 0, docs: {} },
  ];

  it('cohortStats survives (it wraps the predicate) and counts against the given catalogue', () => {
    expect(() => cohortStats(clubs)).not.toThrow();
    const titans = [{ key: 'leagueEntry', name: 'League entry' }];
    const complete = [{ affiliation: 'complete', cqi: 1, docs: { leagueEntry: true } }];
    expect(cohortStats(complete, titans).docsComplete).toBe(1);
    // Against the shared defaults the same club is nowhere near complete.
    expect(cohortStats(complete).docsComplete).toBe(0);
  });

  it('the helpers tolerate a bare .filter/.map that hands them an index', () => {
    // Casts stand in for an untyped JS caller — the shape that actually shipped broken.
    const bare = (fn: unknown) => fn as (v: unknown, i: number) => never;
    expect(() => clubs.filter(bare(docsAllComplete))).not.toThrow();
    expect(() => clubs.map(bare(docsUploadedCount))).not.toThrow();
    expect(() => clubs.map(bare(docCompletion))).not.toThrow();
  });
});

// The "Unavailable" escape hatch, extracted from main.tsx's setDocUnavailable so the
// shape branching is pinned rather than trusted. The sentinel must ride ALONGSIDE stored
// files, never replace them: a flat overwrite would erase a multi-file doc's uploads and
// drop a single-file doc's objectKey, orphaning that object in a bucket with no
// lifecycle rule to catch it.
describe('computeDocUnavailable', () => {
  const AT2 = '2026-08-18T00:00:00.000Z';
  const MULTI: RequiredDoc[] = [
    {
      key: 'facilityAgreement',
      name: 'Facility',
      multiFile: true,
      minFiles: 1,
      allowUnavailable: true,
    },
    { key: 'financials', name: 'Financials', allowUnavailable: true },
  ];
  const f = (k: string) => ({ objectKey: k, size: 1, uploadedAt: 'x' });

  it('marks a single-file doc unavailable without a stored file', () => {
    const { docs, docMeta } = computeDocUnavailable(
      { docs: {}, docMeta: {} },
      'financials',
      true,
      AT2,
      MULTI,
    );
    expect(docs.financials).toBe(true);
    expect(docMeta.financials).toEqual({ unavailable: true, at: AT2 });
  });

  it('never drops a stored single-file objectKey when marking unavailable', () => {
    const club = { docs: { financials: true }, docMeta: { financials: f('t/c/financials-1.pdf') } };
    const { docMeta } = computeDocUnavailable(club, 'financials', true, AT2, MULTI);
    expect(docMeta.financials.objectKey).toBe('t/c/financials-1.pdf');
    expect(docMeta.financials.unavailable).toBe(true);
  });

  it('never erases a multi-file doc’s files when marking unavailable', () => {
    const club = {
      docs: { facilityAgreement: true },
      docMeta: { facilityAgreement: { files: [f('a.pdf'), f('b.pdf')] } },
    };
    const { docMeta } = computeDocUnavailable(club, 'facilityAgreement', true, AT2, MULTI);
    expect(docMeta.facilityAgreement.files).toHaveLength(2);
    expect(docMeta.facilityAgreement.unavailable).toBe(true);
  });

  it('undo on a multi-file doc keeps the files and re-derives the flag from them', () => {
    const club = {
      docs: { facilityAgreement: true },
      docMeta: { facilityAgreement: { files: [f('a.pdf')], unavailable: true, at: AT2 } },
    };
    const { docs, docMeta } = computeDocUnavailable(club, 'facilityAgreement', false, AT2, MULTI);
    expect(docMeta.facilityAgreement).toEqual({ files: [f('a.pdf')] });
    // minFiles is 1, so one remaining file still satisfies it.
    expect(docs.facilityAgreement).toBe(true);
  });

  it('undo on a single-file doc with a stored upload drops only the sentinel', () => {
    const club = {
      docs: { financials: true },
      docMeta: { financials: { ...f('t/c/financials-1.pdf'), unavailable: true, at: AT2 } },
    };
    const { docs, docMeta } = computeDocUnavailable(club, 'financials', false, AT2, MULTI);
    expect(docMeta.financials).toEqual(f('t/c/financials-1.pdf'));
    expect(docs.financials).toBe(true);
  });

  it('undo with nothing stored clears the record entirely', () => {
    const club = {
      docs: { financials: true },
      docMeta: { financials: { unavailable: true, at: AT2 } },
    };
    const { docs, docMeta } = computeDocUnavailable(club, 'financials', false, AT2, MULTI);
    expect(docMeta.financials).toBeUndefined();
    expect(docs.financials).toBe(false);
  });
});
