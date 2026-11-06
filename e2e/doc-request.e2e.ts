import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  API_BASE,
  TENANT,
  RUN,
  adminAuthHeader,
  apiHeaders,
  signInAsAdmin,
  uniqueIdNumber,
} from './helpers';

/**
 * Player document requests end to end: the union admin filters the player register to two
 * run-unique players (one with an email, one with no contact details), ticks both and sends
 * "Request ID document". The modal previews 1 reachable / 1 skipped and then reports Sent +
 * Skipped; the reachable row shows "ID doc requested". The player opens their `/d/<token>` link,
 * uploads a PNG and sees the done state; the console then shows the ID document and the
 * indicator is gone; the link re-opened says "Already completed". A second request's link dies
 * when the document arrives through the console instead.
 *
 * Same technique as squad-request.e2e.ts: the token is never logged or stored, so the spec reads
 * the request id + expiry from dynalite and signs the token the way doc-requests.ts does.
 */
test.describe.configure({ mode: 'serial' });

const CLUB = 'berea';
const LINK_SECRET = 'local-dev-captains-report-link-secret'; // env.ts LOCAL_AUTH fallback
const TAG = `Dq${RUN}`; // spec-unique: RUN alone is shared by every spec in a run
const REACH = `${TAG}Reach`;
const NOCONTACT = `${TAG}None`;
const PNG = {
  name: 'id.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
};

const ddbModule = () =>
  createRequire(path.resolve('packages/api/package.json'))(
    '@aws-sdk/client-dynamodb',
  ) as typeof import('@aws-sdk/client-dynamodb');

const ddbClient = () => {
  const { DynamoDBClient } = ddbModule();
  return new DynamoDBClient({
    endpoint: 'http://localhost:4567',
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
};

async function createPlayer(
  request: APIRequestContext,
  lastName: string,
  contact: { email?: string },
): Promise<{ naturalKey: string }> {
  const res = await request.post(`${API_BASE}/clubs/${CLUB}/players`, {
    headers: apiHeaders(adminAuthHeader()),
    data: {
      firstName: 'Test',
      lastName,
      idType: 'passport',
      idNumber: uniqueIdNumber(),
      dob: '1980-06-15',
      race: 'African',
      gender: 'Male',
      nationality: 'Zimbabwean',
      cell: '0821234567',
      ...(contact.email ? { email: contact.email } : {}),
      team: 'premier',
      district: 'Durban Central',
    },
  });
  expect(res.ok(), `create ${lastName} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { naturalKey: string };
}

/** The admin form requires a cell; strip it in the DB to model a player with no contact. */
async function removeContact(naturalKey: string) {
  const { UpdateItemCommand } = ddbModule();
  await ddbClient().send(
    new UpdateItemCommand({
      TableName: 'SmartClubLocal',
      Key: { pk: { S: `TENANT#${TENANT}#CLUB#${CLUB}` }, sk: { S: `PLAYER#${naturalKey}` } },
      UpdateExpression: 'REMOVE cell, email',
    }),
  );
}

/** Mint the player's current link exactly as doc-requests.ts does (test-only). */
async function mintDocLink(naturalKey: string): Promise<string> {
  const { GetItemCommand } = ddbModule();
  const item = await ddbClient().send(
    new GetItemCommand({
      TableName: 'SmartClubLocal',
      Key: { pk: { S: `TENANT#${TENANT}#DOCREQ` }, sk: { S: `DOCREQ#${naturalKey}#idDoc` } },
    }),
  );
  const requestId = item.Item?.requestId?.S;
  const expires = item.Item?.linkExpiresAt?.S;
  expect(requestId, 'the request exists').toBeTruthy();
  const payload = Buffer.from(
    JSON.stringify({ t: TENANT, q: requestId, e: Math.floor(Date.parse(expires!) / 1000) }),
  ).toString('base64url');
  const sig = createHmac('sha256', LINK_SECRET)
    .update(`docreq-link.v1.${payload}`)
    .digest('base64url');
  return `${payload}.${sig}`;
}

let reach: { naturalKey: string };
let token: string;

test.beforeAll(async ({ request }) => {
  reach = await createPlayer(request, REACH, { email: `docreq-${RUN}@example.com` });
  const none = await createPlayer(request, NOCONTACT, {});
  await removeContact(none.naturalKey);
});

test('an admin requests ID documents from selected players', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/admin/players');
  await page.getByLabel('Search players').fill(TAG);
  const rows = page.locator('table.tbl tbody tr');
  // The search is fuzzy, so other run-unique players may be listed too: tick only ours.
  await page.getByLabel(`Select Test ${REACH}`).check();
  await page.getByLabel(`Select Test ${NOCONTACT}`).check();
  await expect(page.locator('.doc-request-toolbar')).toContainText('2 selected');
  await page.getByRole('button', { name: 'Request ID document' }).click();

  const modal = page.getByRole('dialog');
  await expect(modal.locator('.doc-request-preview')).toContainText('1 will be sent a link');
  await expect(modal.locator('.doc-request-preview')).toContainText(
    '1 will be skipped — no email or cell on file',
  );
  await modal.getByRole('button', { name: 'Send to 1 player' }).click();

  const results = modal.locator('.doc-request-result');
  await expect(results).toHaveCount(2);
  await expect(results.filter({ hasText: REACH })).toContainText('Sent');
  await expect(results.filter({ hasText: NOCONTACT })).toContainText('no contact details');
  await modal.getByRole('button', { name: 'Done' }).click();

  await expect(rows.filter({ hasText: REACH }).locator('.doc-requested-badge')).toContainText(
    'ID doc requested',
  );
  await expect(rows.filter({ hasText: NOCONTACT }).locator('.doc-requested-badge')).toHaveCount(0);
});

test('the player uploads through their link; the console shows the document', async ({ page }) => {
  token = await mintDocLink(reach.naturalKey);
  await page.goto(`/d/${token}`);
  await expect(page.getByRole('heading', { name: /Hi Test/ })).toBeVisible();
  await page.getByLabel('Upload your ID document').setInputFiles(PNG);
  await expect(page.getByText('Thank you — your document is uploaded')).toBeVisible();

  await signInAsAdmin(page);
  await page.goto('/admin/players');
  await page.getByLabel('Search players').fill(REACH);
  const row = page.locator('table.tbl tbody tr', { hasText: REACH });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.doc-requested-badge')).toHaveCount(0);
  await row.click();
  await expect(page.getByRole('button', { name: /View ID document/ })).toBeVisible();

  // The link is spent.
  await page.goto(`/d/${token}`);
  await expect(page.getByText('Already completed')).toBeVisible();
});

test('a console upload kills a pending link', async ({ page, request }) => {
  // A fresh request (the earlier one completed) …
  const send = await request.post(`${API_BASE}/admin/doc-requests`, {
    headers: apiHeaders(adminAuthHeader()),
    data: {
      players: [{ clubId: CLUB, naturalKey: reach.naturalKey }],
      docKey: 'idDoc',
      idempotencyKey: `e2e-${RUN}-second`,
    },
  });
  expect(send.ok(), await send.text()).toBeTruthy();
  const second = await mintDocLink(reach.naturalKey);
  expect(second).not.toBe(token);
  await page.goto(`/d/${second}`);
  await expect(page.getByLabel('Upload your ID document')).toBeAttached();

  // … then the document arrives through the console instead.
  const patch = await request.patch(
    `${API_BASE}/clubs/${CLUB}/players/${encodeURIComponent(reach.naturalKey)}/id-doc`,
    {
      headers: apiHeaders(adminAuthHeader()),
      data: {
        objectKey: `local/${TENANT}/${CLUB}/console-${RUN}.png`,
        size: 68,
        contentType: 'image/png',
      },
    },
  );
  expect(patch.ok(), await patch.text()).toBeTruthy();
  await page.reload();
  await expect(page.getByText('Already completed')).toBeVisible();
});

test('a tampered link is invalid', async ({ page }) => {
  await page.goto(`/d/${token.slice(0, -3)}abc`);
  await expect(page.getByText("This link isn't valid")).toBeVisible();
});
