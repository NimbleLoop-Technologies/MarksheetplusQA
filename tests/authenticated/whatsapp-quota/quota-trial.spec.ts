/**
 * PR 538 / CU-z94x8e7hp4 — WhatsApp quota on a TRIAL campus (AC1, AC3 guard, AC6 API contract).
 * Self-seeding: a fresh owner + trial campus per file.
 */
import { test, expect } from '@playwright/test';
import { AUTH_APP, BackOffice, newCampusOwner, type CampusOwner, type QuotaPackageRow } from '../../../fixtures/quota';

let owner: CampusOwner;
let ops: BackOffice;
let pkg: QuotaPackageRow;

test.beforeAll(async () => {
  owner = await newCampusOwner();
  ops = await BackOffice.signIn();
  pkg = await ops.newPackage(100, 100);
});

test.afterAll(async () => {
  await ops?.archivePackage(pkg).catch(() => undefined);
  await ops?.dispose();
  await owner?.api.dispose();
});

test('AC1: a trial campus has a zero WhatsApp limit and is not entitled', async () => {
  const res = await owner.api.get('subscription/quota');
  expect(res.status()).toBe(200);
  const quota = await res.json();
  expect(quota).toMatchObject({ isTrial: true, isEntitled: false, included: 0, extra: 0, used: 0, remaining: 0, isExhausted: false });
  expect(quota.allocations).toEqual([]);
});

test('AC1: the layout quota status for a trial campus is not exhausted (no alert)', async () => {
  const res = await owner.api.get('subscription/quota/status');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ isExhausted: false, skippedThisMonth: 0 });
});

test('AC3: a trial campus can list packages but a top-up request is refused with 400', async () => {
  const list = await owner.api.get('subscription/quota/packages');
  expect(list.status()).toBe(200);
  expect((await list.json()).map((p: { id: string }) => p.id)).toContain(pkg.id);

  const res = await owner.api.post('subscription/quota/requests', { data: { packageId: pkg.id } });
  expect(res.status()).toBe(400);
  expect(await res.text()).toContain('Trial campuses cannot request extra quota.');
});

test('top-up request validation: empty package id is a validation problem', async () => {
  const res = await owner.api.post('subscription/quota/requests', { data: { packageId: '' } });
  expect(res.status()).toBe(400);
  expect((await res.json()).errors).toHaveProperty('PackageId');
});

test('S2 z94x8ebv10: the plan / pricing page shows the monthly WhatsApp allowance', async ({ browser }) => {
  const session = await owner.authAppSession();
  const page = await browser.newPage({ ignoreHTTPSErrors: true, storageState: await session.storageState() });
  try {
    await page.goto(`${AUTH_APP}/subscription/plan`);
    await expect(page.getByText('100 WhatsApp notifications / month')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Available on the paid subscription, after the trial.')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('s2-pricing-whatsapp-allowance.png'), fullPage: true });
  } finally {
    await page.close();
    await session.dispose();
  }
});
