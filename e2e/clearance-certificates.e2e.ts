import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  API_BASE,
  TENANT,
  apiHeaders,
  adminAuthHeader,
  repAuthHeader,
  signInAsAdmin,
  signInAsRep,
  dismissOnboarding,
  seedPendingClearance,
  getClubName,
  openClearancesFilteredTo,
  fetchClearance,
  RUN,
  type SeededClearance,
} from './helpers';
// The real masking rule the API applies — imported, not re-implemented, so the assertion can't
// drift from it (Playwright transpiles the TS; serial.ts only depends on node:crypto).
import { maskIdNumber } from '../packages/api/src/certificates/serial';

/**
 * Clearance transfer certificates, end to end on the REAL local stack (API :3333 with
 * LOCAL_AUTH=1 + LOCAL_UPLOADS_DIR, set by packages/api/src/local/server.ts; vite :3201):
 *
 *   operator picks the template + union contact footer → the source club's chair issues a
 *   clearance → the certificate is issued inline and viewable from BOTH club portals and the
 *   admin console → the public /verify/<serial> page shows VALID with the masked ID (never the
 *   full one) → the admin revokes it → /verify shows REVOKED, status and dates only. An admin
 *   override with "Issue transfer certificate" unticked issues none (no button; view-url 409).
 *   The verify test also drives the bare /verify reference-entry box to the same VALID page.
 *
 * The tests share state (the approved clearance and its serial), so they run in order in one
 * serial block; each still gets a fresh browser context, so each signs in as its own role.
 *
 * Cleanup (shared in-memory DB): beforeAll reads the dolphins tenant's clearanceCertTemplate +
 * orgContact and afterAll writes them back. The API can't unset either field, so an ABSENT
 * prior value is restored as its equivalent — template 'classic', orgContact {} (both render
 * identically to absent). Clearances and players are run-unique by name, like the other
 * clearance specs, and are left in place.
 */

test.describe.configure({ mode: 'serial' });

// Club pairs no other clearance spec uses as a pair — isolation is by the run-unique names anyway.
const APPROVE = { from: 'harlequins', to: 'warriors' };
const DECLINE = { from: 'crusaders', to: 'phoenix' };

const ORG_CONTACT = {
  regNo: `NPO ${RUN}`,
  address: '1 Test Street, Durban',
  phone: '031 000 0000',
  website: 'www.example.co.za',
  email: 'office@example.co.za',
};

/** x-dev-auth identity for a platform operator (tenant-independent `*` membership). */
function operatorAuthHeader(): string {
  return Buffer.from(
    JSON.stringify({
      sub: 'dev-operator',
      email: 'operator@platform.local',
      memberships: [{ tenantId: '*', role: 'operator', clubIds: [] }],
    }),
  ).toString('base64');
}

async function signInAsOperator(page: Page): Promise<void> {
  await page.goto('/');
  const role = page.locator('select.field-select').first();
  await expect(role).toBeVisible();
  await role.selectOption('operator');
  await page.getByRole('button', { name: 'Enter as operator' }).click();
}

/** Wait for the next certificate view-url POST and return its status + JSON body. */
function nextViewUrl(page: Page) {
  return page.waitForResponse(
    (r) => r.url().includes('/certificate/view-url') && r.request().method() === 'POST',
  );
}

/** The open certificate preview modal (DocPreviewModal via ClearanceCertificateModal). */
function certModal(page: Page, playerName: string) {
  return page.locator('.task-modal', { hasText: `Transfer certificate · ${playerName}` });
}

interface CertSettings {
  clearanceCertTemplate?: string;
  orgContact?: Record<string, string>;
}

async function getCertSettings(request: APIRequestContext): Promise<CertSettings> {
  const res = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: apiHeaders(operatorAuthHeader()),
  });
  expect(res.ok(), `GET /platform/tenants/${TENANT} → ${res.status()}`).toBeTruthy();
  const cfg = (await res.json()) as CertSettings;
  return { clearanceCertTemplate: cfg.clearanceCertTemplate, orgContact: cfg.orgContact };
}

// The tenant's certificate settings before this spec touched them (restored in afterAll).
let priorSettings: CertSettings | undefined;

test.beforeAll(async ({ request }) => {
  priorSettings = await getCertSettings(request);
});

test.afterAll(async ({ request }) => {
  if (!priorSettings) return;
  const res = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: apiHeaders(operatorAuthHeader()),
    data: {
      clearanceCertTemplate: priorSettings.clearanceCertTemplate ?? 'classic',
      orgContact: priorSettings.orgContact ?? {},
    },
  });
  expect(res.ok(), `restore PUT /platform/tenants/${TENANT} → ${res.status()}`).toBeTruthy();
});

// Shared across the serial block.
let approved: SeededClearance;
let approvedName = '';
let serial = '';

test('operator sets the certificate template and union contact footer', async ({
  page,
  request,
}) => {
  await signInAsOperator(page);
  await page.goto(`/platform/tenants/${TENANT}`);

  const card = page.locator('.card', { hasText: 'Clearance certificate' });
  await expect(card).toBeVisible();
  await card.locator('select').selectOption('confirmation');
  await card.getByPlaceholder('e.g. NPO 123-456').fill(ORG_CONTACT.regNo);
  await card.getByPlaceholder('Street, suburb, city').fill(ORG_CONTACT.address);
  await card.getByPlaceholder('031 000 0000').fill(ORG_CONTACT.phone);
  await card.getByPlaceholder('www.example.co.za').fill(ORG_CONTACT.website);
  await card.getByPlaceholder('office@example.co.za').fill(ORG_CONTACT.email);
  const saveBtn = card.getByRole('button', { name: 'Save certificate settings' });
  await saveBtn.click();
  // Saved ⇒ the form is no longer dirty.
  await expect(saveBtn).toBeDisabled();

  const cfg = await getCertSettings(request);
  expect(cfg.clearanceCertTemplate).toBe('confirmation');
  expect(cfg.orgContact).toEqual(ORG_CONTACT);
});

test('source club chair issues a clearance and views its certificate inline', async ({
  page,
  request,
}) => {
  approvedName = `CertApprove-${RUN}`;
  approved = await seedPendingClearance(request, { ...APPROVE, name: approvedName });
  const toName = await getClubName(request, APPROVE.to);

  await signInAsRep(page, APPROVE.from);
  await page.goto(`/club/${APPROVE.from}/clearances`);
  await dismissOnboarding(page);

  const card = page.locator('.clr-card', { hasText: approved.playerName });
  await expect(card).toBeVisible();
  // No certificate while pending.
  await expect(card.getByRole('button', { name: 'View certificate' })).toHaveCount(0);

  await card.getByRole('button', { name: /Fees cleared/ }).click();
  await expect(card.locator('.clr-check.on')).toHaveCount(1);
  await card.getByRole('button', { name: /Misconduct cleared/ }).click();
  await expect(card.locator('.clr-check.on')).toHaveCount(2);
  await card.getByRole('button', { name: `Issue clearance to ${toName}` }).click();

  // Resolved card now offers the certificate.
  const resolved = page.locator('.clr-card.resolved', { hasText: approved.playerName });
  const view = resolved.getByRole('button', { name: 'View certificate' });
  await expect(view).toBeVisible();

  const viewUrlResponse = nextViewUrl(page);
  await view.click();
  const resp = await viewUrlResponse;
  expect(resp.status(), 'club view-url').toBe(200);
  const body = (await resp.json()) as { viewUrl: string; serial: string; template: string };
  expect(body.serial).toMatch(/^SC-TRF-/);
  // The operator's template choice drove issuance.
  expect(body.template).toBe('confirmation');
  serial = body.serial;

  const modal = certModal(page, approved.playerName);
  await expect(modal).toBeVisible();
  await expect(modal).toContainText(`Certificate ${serial}`);
  await expect(modal.locator('iframe')).toHaveAttribute('src', body.viewUrl);

  // Both rows carry the pointer (the admin list reads the canonical).
  const after = (await fetchClearance(request, approved.id)) as SeededClearance & {
    certificateMeta?: { serial: string };
  };
  expect(after?.status).toBe('approved');
  expect(after?.certificateMeta?.serial).toBe(serial);
});

test('destination club also sees and opens the certificate', async ({ page }) => {
  expect(serial, 'depends on the approval test').not.toBe('');
  await signInAsRep(page, APPROVE.to);
  await page.goto(`/club/${APPROVE.to}/clearances`);
  await dismissOnboarding(page);

  const card = page.locator('.clr-card', { hasText: approved.playerName });
  await expect(card).toBeVisible();
  const viewUrlResponse = nextViewUrl(page);
  await card.getByRole('button', { name: 'View certificate' }).click();
  const resp = await viewUrlResponse;
  expect(resp.status(), 'destination view-url').toBe(200);
  expect(((await resp.json()) as { serial: string }).serial).toBe(serial);
  await expect(certModal(page, approved.playerName).locator('iframe')).toBeVisible();
});

test('the public verify page shows VALID with the masked ID only', async ({ page }) => {
  expect(serial, 'depends on the approval test').not.toBe('');
  // Public: no sign-in.
  await page.goto(`/verify/${serial}`);

  await expect(page.getByText('Valid certificate', { exact: true })).toBeVisible();
  await expect(page.getByText('Confirm these details match the certificate')).toBeVisible();
  await expect(page.getByText(approved.playerName, { exact: true })).toBeVisible();
  await expect(page.getByText(maskIdNumber(approved.idNumber), { exact: true })).toBeVisible();
  await expect(page.getByText(serial, { exact: true })).toBeVisible();
  // POPIA: the full ID number appears nowhere on the public page.
  await expect(page.locator('body')).not.toContainText(approved.idNumber);

  // Typing the reference off the paper: bare /verify → reference box → the same VALID page.
  await page.getByRole('link', { name: 'Check another certificate' }).click();
  await expect(page).toHaveURL(/\/verify$/);
  await expect(page.getByRole('heading', { name: 'Check a certificate' })).toBeVisible();
  await page.getByLabel('Certificate reference').fill(serial);
  await page.getByRole('button', { name: 'Check certificate' }).click();
  await expect(page).toHaveURL(new RegExp(`/verify/${serial}$`));
  await expect(page.getByText('Valid certificate', { exact: true })).toBeVisible();
  await expect(page.getByText(approved.playerName, { exact: true })).toBeVisible();
});

test('admin views, then revokes the certificate; verify shows REVOKED only', async ({
  page,
  request,
}) => {
  expect(serial, 'depends on the approval test').not.toBe('');
  await signInAsAdmin(page);
  await openClearancesFilteredTo(page, approvedName);

  const card = page.locator('.clr-card', { hasText: approved.playerName });
  await expect(card).toBeVisible();

  // View from the console.
  const viewUrlResponse = nextViewUrl(page);
  await card.getByRole('button', { name: 'View certificate' }).click();
  const resp = await viewUrlResponse;
  expect(resp.status(), 'admin view-url').toBe(200);
  expect(((await resp.json()) as { serial: string }).serial).toBe(serial);
  const modal = certModal(page, approved.playerName);
  await expect(modal.locator('iframe')).toBeVisible();
  await modal.locator('.task-modal-close').click();
  await expect(modal).toHaveCount(0);

  // Revoke: the confirm stays disabled until a reason is given.
  await card.getByRole('button', { name: 'Revoke certificate' }).click();
  const dialog = page.locator('.fix-confirm-box');
  await expect(dialog).toBeVisible();
  const yes = dialog.getByRole('button', { name: 'Yes, revoke certificate' });
  await expect(yes).toBeDisabled();
  await dialog
    .getByPlaceholder('Reason (required — recorded against your name)')
    .fill('Issued against the wrong player record');
  await yes.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'transfer certificate revoked' })).toBeVisible();

  // Revoked badge; no second revoke.
  await expect(card).toContainText('Certificate revoked');
  await expect(card.getByRole('button', { name: 'Revoke certificate' })).toHaveCount(0);

  // Viewing now yields the revoked notice (410), not the PDF.
  const revokedResponse = nextViewUrl(page);
  await card.getByRole('button', { name: 'View certificate' }).click();
  expect((await revokedResponse).status()).toBe(410);
  await expect(certModal(page, approved.playerName)).toContainText('Certificate revoked');
  await expect(certModal(page, approved.playerName).locator('iframe')).toHaveCount(0);

  // Public page: status + dates only — no player or club data for a revoked certificate.
  const verify = await request.get(`${API_BASE}/verify/${serial}`);
  expect(verify.ok()).toBeTruthy();
  expect(((await verify.json()) as { status: string }).status).toBe('revoked');
  await page.goto(`/verify/${serial}`);
  await expect(page.getByText('Certificate revoked', { exact: true })).toBeVisible();
  await expect(page.getByText('Date revoked')).toBeVisible();
  await expect(page.getByText('Confirm these details match the certificate')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(approved.playerName);
  await expect(page.locator('body')).not.toContainText(approved.idNumber);
});

test('an override with "Issue transfer certificate" unticked issues no certificate', async ({
  page,
  request,
}) => {
  const name = `CertDecline-${RUN}`;
  const clr = await seedPendingClearance(request, { ...DECLINE, name });

  await signInAsAdmin(page);
  await openClearancesFilteredTo(page, name);
  const card = page.locator('.clr-card', { hasText: clr.playerName });
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Override & approve' }).click();
  const dialog = page.locator('.fix-confirm-box');
  await expect(dialog).toBeVisible();
  const box = dialog.getByRole('checkbox', { name: /Issue transfer certificate/ });
  await expect(box).toBeChecked();
  await box.uncheck();
  await dialog.getByRole('button', { name: 'Yes, issue clearance' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(card.locator('.clr-resolved-bar')).toContainText('Union override');
  await expect(card.getByRole('button', { name: 'View certificate' })).toHaveCount(0);

  const after = (await fetchClearance(request, clr.id)) as SeededClearance & {
    certificateMeta?: unknown;
    certificateDeclined?: boolean;
  };
  expect(after?.status).toBe('admin-override');
  expect(after?.certificateDeclined).toBe(true);
  expect(after?.certificateMeta).toBeUndefined();

  // Neither side can mint one lazily either.
  await expectViewUrl409(request, clr);
});

async function expectViewUrl409(request: APIRequestContext, clr: SeededClearance) {
  const admin = await request.post(`${API_BASE}/admin/clearances/${clr.id}/certificate/view-url`, {
    headers: apiHeaders(adminAuthHeader()),
    data: { fromClubId: clr.fromClubId },
  });
  expect(admin.status(), await admin.text()).toBe(409);
  const dest = await request.post(
    `${API_BASE}/clubs/${clr.toClubId}/clearances/${clr.id}/certificate/view-url`,
    { headers: apiHeaders(repAuthHeader(clr.toClubId)) },
  );
  expect(dest.status(), await dest.text()).toBe(409);
}
