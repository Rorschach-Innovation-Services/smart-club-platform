/**
 * Platform operator API client (src/api.ts platform* functions).
 *
 * Pins the request shapes against the shipped /platform/* route contracts: path,
 * method, JSON body, and the auth header riding along (same request() pipeline as
 * the rest of the client — only the fetch boundary is stubbed). Also pins the
 * presigned-POST logo upload: plain fetch (no auth header), all policy fields
 * present, and the file part LAST — S3 ignores form fields after the file, so a
 * trailing file is the only valid ordering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  platformListTenants,
  platformCreateTenant,
  platformGetTenant,
  platformUpdateTenant,
  platformAddAdmin,
  platformLogoUploadUrl,
  platformDnsSheet,
  uploadLogoToS3,
  setTokenProvider,
} from './api';

const okResponse = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body });

const lastCall = () =>
  (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [
    string,
    { method: string; headers: Record<string, string>; body?: string },
  ];

beforeEach(() => {
  (globalThis as any).window ??= { location: { origin: 'http://localhost' } };
  globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;
  setTokenProvider(async () => 'test-token');
});

describe('platform client URL construction', () => {
  it('GET /platform/tenants, authed', async () => {
    await platformListTenants();
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost/platform/tenants');
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe('Bearer test-token');
  });

  it('POST /platform/tenants carries slug, branding and deadline', async () => {
    await platformCreateTenant({
      slug: 'sharks',
      branding: { name: 'Sharks Cricket Union' },
      submissionDeadline: '2026-09-30',
    });
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost/platform/tenants');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body!)).toEqual({
      slug: 'sharks',
      branding: { name: 'Sharks Cricket Union' },
      submissionDeadline: '2026-09-30',
    });
  });

  it('GET / PUT /platform/tenants/:slug', async () => {
    await platformGetTenant('sharks');
    expect(lastCall()[0]).toBe('http://localhost/platform/tenants/sharks');

    await platformUpdateTenant('sharks', { submissionDeadline: '2026-10-31' });
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost/platform/tenants/sharks');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body!)).toEqual({ submissionDeadline: '2026-10-31' });
  });

  it('POST …/admins wraps the email; POST …/logo-upload wraps the contentType', async () => {
    await platformAddAdmin('sharks', 'chair@sharks.co.za');
    let [url, init] = lastCall();
    expect(url).toBe('http://localhost/platform/tenants/sharks/admins');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body!)).toEqual({ email: 'chair@sharks.co.za' });

    await platformLogoUploadUrl('sharks', 'image/png');
    [url, init] = lastCall();
    expect(url).toBe('http://localhost/platform/tenants/sharks/logo-upload');
    expect(JSON.parse(init.body!)).toEqual({ contentType: 'image/png' });
  });

  it('GET …/dns', async () => {
    await platformDnsSheet('sharks');
    expect(lastCall()[0]).toBe('http://localhost/platform/tenants/sharks/dns');
  });

  it('URL-encodes a hostile slug instead of splicing raw path segments', async () => {
    await platformGetTenant('a/b');
    expect(lastCall()[0]).toBe('http://localhost/platform/tenants/a%2Fb');
  });
});

describe('uploadLogoToS3 (presigned POST)', () => {
  it('POSTs multipart form data to the grant URL with the file part LAST and no auth header', async () => {
    const post = {
      url: 'https://bucket.s3.af-south-1.amazonaws.com/',
      fields: { key: 'branding/sharks/logo-abc.png', 'Content-Type': 'image/png', Policy: 'p' },
      objectKey: 'branding/sharks/logo-abc.png',
      publicUrl: 'https://assets.example/branding/sharks/logo-abc.png',
    };
    await uploadLogoToS3(post, new Blob(['png-bytes'], { type: 'image/png' }));
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [
      string,
      { method: string; body: FormData; headers?: Record<string, string> },
    ];
    expect(url).toBe(post.url);
    expect(init.method).toBe('POST');
    expect(init.headers).toBeUndefined(); // plain fetch — no bearer/x-tenant
    const keys = [...init.body.keys()];
    expect(keys).toEqual(['key', 'Content-Type', 'Policy', 'file']);
    expect(keys.at(-1)).toBe('file');
  });

  it('surfaces a non-2xx S3 response as an ApiError with the status', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 403,
    });
    await expect(
      uploadLogoToS3(
        { url: 'https://s3/', fields: {}, objectKey: 'k', publicUrl: 'u' },
        new Blob(['x']),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
