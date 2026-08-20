/**
 * readUploadObject's offline seam: a `local/` objectKey with LOCAL_UPLOADS_DIR set reads
 * straight off disk, no S3 client ever invoked — this is what lets int tests build an
 * xlsx fixture and exercise a parse route with no real bucket.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { readUploadObject } = await import('../src/uploads.js');

describe('readUploadObject — local/ + LOCAL_UPLOADS_DIR offline seam', () => {
  let dir: string;
  const prevEnv = process.env.LOCAL_UPLOADS_DIR;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'uploads-test-'));
    process.env.LOCAL_UPLOADS_DIR = dir;
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.LOCAL_UPLOADS_DIR;
    else process.env.LOCAL_UPLOADS_DIR = prevEnv;
  });

  test('reads the file at LOCAL_UPLOADS_DIR/<rest of the key>', async () => {
    const target = path.join(dir, 'foo.txt');
    await writeFile(target, 'hello world');
    const buf = await readUploadObject('local/foo.txt');
    assert.equal(buf.toString('utf8'), 'hello world');
  });

  test('a nested local/ key resolves under the same directory', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'nested'), { recursive: true });
    await writeFile(path.join(dir, 'nested', 'bar.txt'), 'nested content');
    const buf = await readUploadObject('local/nested/bar.txt');
    assert.equal(buf.toString('utf8'), 'nested content');
  });

  test('a `..` traversal key is rejected before touching the filesystem', async () => {
    await assert.rejects(
      () => readUploadObject('local/../../etc/passwd'),
      /invalid upload object key/,
    );
  });

  test('a key with a disallowed character is rejected before touching the filesystem', async () => {
    await assert.rejects(
      () => readUploadObject('local/weird\0name.txt'),
      /invalid upload object key/,
    );
  });
});
