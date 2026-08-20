/**
 * Shared upload-object read helper (self-serve onboarding). The roster/committee
 * intake parsers read a club's already-uploaded compliance document straight from
 * storage (member databases + committee docs are already in S3 per club via the
 * doc-intake step) — no re-upload, no CORS needed. Lives in its own module, not
 * index.ts, so a future route file can import it without pulling in the whole Hono app.
 */
import { readFile } from 'node:fs/promises';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

/** Same charset/`..` screen as the `/local-uploads/*` routes' LOCAL_UPLOAD_KEY_RE in
 *  index.ts (kept as its own copy here — index.ts imports THIS module, so importing
 *  back would be circular). Applied to every objectKey before it's ever concatenated
 *  onto LOCAL_UPLOADS_DIR, not just the ones that arrive via the `/local-uploads/*`
 *  HTTP routes — a stored `local/...` docMeta key read through any other path (roster/
 *  committee parse, doc view-url, etc) gets the exact same traversal guard. */
const OBJECT_KEY_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Read a stored upload's raw bytes.
 *
 * Mirrors the existing `local/` no-S3 dev sentinel (see `assertOwnObjectKey` in
 * index.ts): when `objectKey` starts with `local/` AND the `LOCAL_UPLOADS_DIR` env var
 * is set, the file is read from that directory instead of S3 — an offline-test seam so
 * int tests can build an xlsx fixture on disk, reference it via a `local/...` objectKey,
 * and exercise the parse routes with no real bucket. Any other objectKey (or a `local/`
 * one with no `LOCAL_UPLOADS_DIR` configured, i.e. a real deploy) reads UPLOADS_BUCKET.
 */
export async function readUploadObject(objectKey: string): Promise<Buffer> {
  const localDir = process.env.LOCAL_UPLOADS_DIR;
  if (objectKey.startsWith('local/') && localDir) {
    const key = objectKey.slice('local/'.length);
    if (key.includes('..') || !OBJECT_KEY_RE.test(key)) {
      throw new Error(`invalid upload object key: ${objectKey}`);
    }
    return readFile(`${localDir}/${key}`);
  }
  const bucket = process.env.UPLOADS_BUCKET!;
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}
