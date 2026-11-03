/**
 * PR 538 — Quotas README: "The earliest-expiring live allocation with headroom is charged first."
 * QuotaManager.TryReserveAsync always charges the month's PLAN allocation first, so an add-on that
 * expires before month end is left unused while the plan credit (which would roll over anyway) is spent.
 *
 * Self-seeding: fresh campus, activated, one approved add-on. DB PRECONDITION on that campus only:
 * the add-on's ExpiresAtUtc is moved to now + 2 days (i.e. before the plan allocation's month end).
 */
import { test, expect } from '@playwright/test';
import { BackOffice, newCampusOwner, quotaDb, WA_KIND, WA_STATUS, type CampusOwner, type QuotaPackageRow } from '../../../fixtures/quota';

let owner: CampusOwner;
let ops: BackOffice;
let pkg: QuotaPackageRow;

test.beforeAll(async () => {
  owner = await newCampusOwner();
  ops = await BackOffice.signIn();
  pkg = await ops.newPackage(100, 100, 90);
  await ops.activate(await quotaDb.subscriptionId(owner.tenantId));
  const req = await owner.api.post('subscription/quota/requests', { data: { packageId: pkg.id } });
  expect(req.status()).toBe(201);
  const id = (await ops.requests('Requested')).find((r) => r.tenantId === owner.tenantId)!.id;
  expect((await ops.approve(id)).status()).toBe(200);
});

test.afterAll(async () => {
  await ops?.archivePackage(pkg).catch(() => undefined);
  await ops?.dispose();
  await owner?.api.dispose();
});

test('an add-on expiring before month end is charged before the monthly plan allocation', async () => {
  await quotaDb.setAddOnExpiry(owner.tenantId, new Date(Date.now() + 2 * 24 * 3600e3));
  const key = await quotaDb.queueWhatsApp(owner.tenantId, WA_KIND.ResultPublished);
  const row = await quotaDb.waitProcessed(key);
  expect(row.Status).toBe(WA_STATUS.Sent);

  const allocations = await quotaDb.allocations(owner.tenantId);
  const addOn = allocations.find((a) => a.Source === 1)!;
  const plan = allocations.find((a) => a.Source === 0)!;
  expect(new Date(addOn.ExpiresAtUtc).getTime()).toBeLessThan(new Date(plan.ExpiresAtUtc).getTime());
  expect(row.QuotaAllocationId, 'charged allocation (the add-on expires first)').toBe(addOn._id);
});
