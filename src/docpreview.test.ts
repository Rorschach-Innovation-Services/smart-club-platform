import { describe, it, expect } from 'vitest';
import { resolvePreviewSource, docFileMeta, docPreviewKind, DOC_FORMAT_MIME } from './data';

// The preview source decision is the riskiest part of the doc-preview feature: it must
// never substitute the demo sample for a real (or real-but-fileless) production document.
describe('resolvePreviewSource', () => {
  it('real S3 upload in production → real', () => {
    expect(
      resolvePreviewSource({ objectKey: 'dolphins/club/constitution-x.pdf', size: 100 }, false),
    ).toBe('real');
  });

  it('local/demo mode with no docMeta (sample club) → demo', () => {
    expect(resolvePreviewSource(undefined, true)).toBe('demo');
  });

  it('admin override (marked compliant, no objectKey) in production → none, not the sample', () => {
    expect(resolvePreviewSource({ markedCompliant: true }, false)).toBe('none');
  });

  it('empty objectKey in production → none', () => {
    expect(resolvePreviewSource({ objectKey: '', size: 0 }, false)).toBe('none');
  });

  it('local/ dev key in local mode → real (dev:local upload sink serves actual bytes)', () => {
    expect(resolvePreviewSource({ objectKey: 'local/constitution.pdf' }, true)).toBe('real');
  });

  it('local/ dev key in production → none (not a real S3 object)', () => {
    expect(resolvePreviewSource({ objectKey: 'local/constitution.pdf' }, false)).toBe('none');
  });
});

describe('docFileMeta', () => {
  it('derives filename, size, and a metaText line for a real upload', () => {
    const r = docFileMeta({
      objectKey: 'dolphins/club/agm-abc.pdf',
      size: 1_200_000,
      uploadedAt: '2026-05-14',
    });
    expect(r.real).toBe(true);
    expect(r.fileName).toBe('agm-abc.pdf');
    expect(r.sizeMB).toBe('1.2 MB');
    expect(r.metaText).toContain('agm-abc.pdf');
    expect(r.metaText).toContain('1.2 MB');
  });

  it('returns no file fields for an override or absent meta', () => {
    expect(docFileMeta({ markedCompliant: true }).real).toBe(false);
    expect(docFileMeta(undefined).real).toBe(false);
    expect(docFileMeta(undefined).metaText).toBe('');
  });

  it('isPdf delegates to docPreviewKind', () => {
    expect(docFileMeta({ objectKey: 'a/b.pdf', contentType: DOC_FORMAT_MIME.pdf }).isPdf).toBe(
      true,
    );
    expect(docFileMeta({ objectKey: 'a/b.xlsx', contentType: DOC_FORMAT_MIME.xlsx }).isPdf).toBe(
      false,
    );
  });
});

describe('docPreviewKind', () => {
  it('maps each format by its exact contentType', () => {
    expect(docPreviewKind({ contentType: DOC_FORMAT_MIME.pdf })).toBe('pdf');
    expect(docPreviewKind({ contentType: DOC_FORMAT_MIME.docx })).toBe('docx');
    expect(docPreviewKind({ contentType: DOC_FORMAT_MIME.doc })).toBe('word-legacy');
    expect(docPreviewKind({ contentType: DOC_FORMAT_MIME.xls })).toBe('sheet');
    expect(docPreviewKind({ contentType: DOC_FORMAT_MIME.xlsx })).toBe('sheet');
    expect(docPreviewKind({ contentType: DOC_FORMAT_MIME.ods })).toBe('sheet');
    expect(docPreviewKind({ contentType: 'image/jpeg' })).toBe('image');
    expect(docPreviewKind({ contentType: 'image/png' })).toBe('image');
  });

  it('falls back to the objectKey extension when contentType is missing (legacy uploads)', () => {
    expect(docPreviewKind({ objectKey: 't/c/agm.pdf' })).toBe('pdf');
    expect(docPreviewKind({ objectKey: 't/c/roster.DOCX' })).toBe('docx');
    expect(docPreviewKind({ objectKey: 't/c/exco.doc' })).toBe('word-legacy');
    expect(docPreviewKind({ objectKey: 't/c/members.xls' })).toBe('sheet');
    expect(docPreviewKind({ objectKey: 't/c/members.xlsx' })).toBe('sheet');
    expect(docPreviewKind({ objectKey: 't/c/members.ods' })).toBe('sheet');
    expect(docPreviewKind({ objectKey: 't/c/id.jpeg' })).toBe('image');
    expect(docPreviewKind({ objectKey: 't/c/id.PNG' })).toBe('image');
  });

  it('a recognised contentType wins over the extension', () => {
    expect(docPreviewKind({ objectKey: 'x/y.pdf', contentType: DOC_FORMAT_MIME.xlsx })).toBe(
      'sheet',
    );
  });

  it('an unrecognised contentType falls through to the objectKey extension', () => {
    expect(docPreviewKind({ contentType: 'application/octet-stream', objectKey: 'x.xlsx' })).toBe(
      'sheet',
    );
  });

  it('unrecognised types and empty meta are unknown', () => {
    // unrecognised contentType, no objectKey to fall through to
    expect(docPreviewKind({ contentType: 'application/zip' })).toBe('unknown');
    expect(docPreviewKind({ objectKey: 't/c/data.csv' })).toBe('unknown');
    expect(docPreviewKind({ objectKey: 'noextension' })).toBe('unknown');
    expect(docPreviewKind({})).toBe('unknown');
    expect(docPreviewKind(undefined)).toBe('unknown');
  });
});
