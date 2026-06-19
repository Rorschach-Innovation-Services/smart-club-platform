import { describe, it, expect } from 'vitest';
import { resolvePreviewSource, docFileMeta } from './data';

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

  it('local/ dev key in demo mode → demo', () => {
    expect(resolvePreviewSource({ objectKey: 'local/constitution.pdf' }, true)).toBe('demo');
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
});
