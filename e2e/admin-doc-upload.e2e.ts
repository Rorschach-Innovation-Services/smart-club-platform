import { test, expect, type Page } from '@playwright/test';
import {
  API_BASE,
  TENANT,
  adminAuthHeader,
  apiHeaders,
  dismissOnboarding,
  signInAsAdmin,
  signInAsRep,
} from './helpers';

/**
 * Admin compliance uploads on a club's behalf (admin club detail → Compliance documents):
 * Upload a single-file doc (→ Replace), Add file twice on a multi-file doc and Remove one; the
 * club's rep then sees the admin-uploaded file; the server stamps the upload as the admin's and
 * still enforces the doc's accepted file types. Berea starts with no documents in the demo seed.
 */
test.describe.configure({ mode: 'serial' });

const CLUB = 'berea';
const PDF = {
  name: 'e2e-doc.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'),
};
const adminHeaders = apiHeaders(adminAuthHeader());

function docRow(page: Page, name: RegExp) {
  return page.locator('.doc-row', { hasText: name });
}

test('an admin uploads, adds and removes compliance documents for a club', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto(`/admin/clubs/${CLUB}`);
  const card = page.locator('.card', { hasText: 'Compliance documents' });
  await expect(card).toBeVisible();

  // Single-file doc: Upload → Replace.
  const constitution = card.locator('.doc-row', { hasText: /Club constitution/i });
  await expect(constitution.getByRole('button', { name: 'Upload' })).toBeVisible();
  await constitution.locator('input[type="file"]').setInputFiles(PDF);
  await expect(page.locator('.toast', { hasText: /constitution uploaded/i })).toBeVisible();
  await expect(constitution.getByRole('button', { name: 'Replace' })).toBeVisible();
  await expect(constitution).toHaveClass(/\buploaded\b/);

  // Multi-file doc: Add file twice → two entries with View + Remove; Remove one.
  const sg = card.locator('.doc-row', { hasText: /Safeguarding/i });
  await sg.locator('input[type="file"]').setInputFiles(PDF);
  await expect(sg.getByRole('button', { name: 'View' })).toHaveCount(1);
  await sg.locator('input[type="file"]').setInputFiles({ ...PDF, name: 'e2e-doc-2.pdf' });
  await expect(sg.getByRole('button', { name: 'View' })).toHaveCount(2);
  await expect(sg.getByRole('button', { name: 'Remove' })).toHaveCount(2);

  await sg.getByRole('button', { name: 'Remove' }).first().click();
  const confirm = page.locator('.fix-confirm-box');
  await expect(confirm).toContainText('Remove this file?');
  await confirm.getByRole('button', { name: 'Yes, remove' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'File removed' })).toBeVisible();
  await expect(sg.getByRole('button', { name: 'View' })).toHaveCount(1);
});

test("the club's rep sees the admin-uploaded constitution", async ({ page }) => {
  await signInAsRep(page, CLUB);
  await page.goto(`/club/${CLUB}/documents`);
  await dismissOnboarding(page);
  const row = docRow(page, /Club constitution/i);
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/\buploaded\b/);
  await expect(row).toContainText('uploaded');
});

test('the server stamps admin uploads and still enforces accepted file types', async ({
  request,
}) => {
  const res = await request.get(`${API_BASE}/clubs/${CLUB}`, { headers: adminHeaders });
  expect(res.ok()).toBeTruthy();
  const club = (await res.json()) as {
    docMeta?: Record<string, { uploadedByRole?: string; files?: { uploadedByRole?: string }[] }>;
  };
  expect(club.docMeta?.constitution?.uploadedByRole).toBe('admin');
  expect(club.docMeta?.safeguarding?.files?.[0]?.uploadedByRole).toBe('admin');

  const bad = await request.patch(`${API_BASE}/clubs/${CLUB}/docs/constitution`, {
    headers: adminHeaders,
    data: {
      objectKey: `local/${TENANT}/${CLUB}/e2e-bad.exe`,
      size: 100,
      contentType: 'application/x-msdownload',
    },
  });
  expect(bad.status(), await bad.text()).toBe(400);
  expect(await bad.json()).toMatchObject({
    error: expect.stringContaining('file type not accepted'),
  });
});
