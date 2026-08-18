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
    return readFile(`${localDir}/${objectKey.slice('local/'.length)}`);
  }
  const bucket = process.env.UPLOADS_BUCKET!;
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}
