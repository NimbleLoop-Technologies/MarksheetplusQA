/**
 * PR 538 / CU-z94x8e7hp4 — WhatsApp quota on an ACTIVE campus, end to end through the API, the
 * back office and the Worker send gate.
 *
 * Self-seeding: one fresh owner + campus for the whole file, activated by the back-office operator.
 * Serial on purpose: each step builds on the campus state of the previous one.
 *
 * Worker steps rely on DB PRECONDITIONS on that fresh campus only:
 *  - queued ScheduledWhatsAppMessage rows (Kind 1/2/3) with a valid template payload, picked up by
 *    the WhatsAppQueueScheduler (1-minute tick locally);
 *  - an add-on's expiry moved earlier / allocations' Used set to Granted to simulate exhaustion.
 */
import { test, expect } from '@playwright/test';
import {
  BackOffice, newCampusOwner, quotaDb, mongo, WA_KIND, WA_STATUS,
  type CampusOwner, type QuotaPackageRow,
} from '../../../fixtures/quota';

test.describe.configure({ mode: 'serial' });

let owner: CampusOwner;
let ops: BackOffice;
let pkg: QuotaPackageRow;
let subscriptionId: string;

const summary = async () => {
  const res = await owner.api.get('subscription/quota');
  expect(res.status()).toBe(200);
  return res.json();
};
const status = async () => (await owner.api.get('subscription/quota/status')).json();
const requestTopUp = (packageId: string) => owner.api.post('subscription/quota/requests', { data: { packageId } });
const pendingRequestId = async () => (await ops.requests('Requested')).find((r) => r.tenantId === owner.tenantId)?.id;

test.beforeAll(async () => {
  owner = await newCampusOwner();
  ops = await BackOffice.signIn();
  pkg = await ops.newPackage(100, 100, 90);
  subscriptionId = await quotaDb.subscriptionId(owner.tenantId);
});

test.afterAll(async () => {
  await ops?.archivePackage(pkg).catch(() => undefined);
  await ops?.dispose();
  await owner?.api.dispose();
});

test('AC4 + AC6: an active campus on a plan without a quota row gets the default 100 messages / month', async () => {
  await ops.activate(subscriptionId);
  // Polled: QuotaManager caches the trial entitlement for up to 60 s (see quota-activation-cache.spec.ts).
  await expect.poll(async () => (await summary()).included, { timeout: 90_000, intervals: [5_000] }).toBe(100);
  const quota = await summary();
  expect(quota).toMatchObject({ isTrial: false, isEntitled: true, included: 100, extra: 0, used: 0, remaining: 100, isExhausted: false, skippedThisMonth: 0, pendingRequest: null });
  const now = new Date();
  expect(new Date(quota.resetsAtUtc).toISOString()).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString());
});

test('AC3 + AC7: a top-up request snapshots the package and only one can be pending', async () => {
  const first = await requestTopUp(pkg.id);
  expect(first.status()).toBe(201);
  expect(await first.json()).toMatchObject({ quantity: 100, price: 100, status: 'Requested' });

  const second = await requestTopUp(pkg.id);
  expect(second.status()).toBe(409);
  expect(await second.text()).toContain('already pending');

  expect((await summary()).pendingRequest).toMatchObject({ quantity: 100, price: 100, status: 'Requested' });
  expect(await pendingRequestId()).toBeTruthy();
});

test('AC3: approving grants an add-on once; approving twice is 409 and grants nothing more', async () => {
  const id = (await pendingRequestId())!;
  const ok = await ops.approve(id);
  expect(ok.status(), await ok.text()).toBe(200);
  const again = await ops.approve(id);
  expect(again.status()).toBe(409);

  const addOns = (await quotaDb.allocations(owner.tenantId)).filter((a) => a.Source === 1);
  expect(addOns).toHaveLength(1);
  expect(addOns[0]).toMatchObject({ Granted: 100, Used: 0 });
  const quota = await summary();
  expect(quota).toMatchObject({ included: 100, extra: 100, remaining: 200, pendingRequest: null });
});

test('reject: a reason is required, rejecting twice is 409, and a rejected request cannot be approved', async () => {
  expect((await requestTopUp(pkg.id)).status()).toBe(201);
  const id = (await pendingRequestId())!;
  expect((await ops.reject(id, '  ')).status()).toBe(400);
  expect((await ops.reject(id, 'QA538 no payment received')).status()).toBe(200);
  expect((await ops.reject(id, 'again')).status()).toBe(409);
  expect((await ops.approve(id)).status()).toBe(400);
  expect((await summary()).extra, 'a rejected request grants nothing').toBe(100);
});

test('an archived package is hidden from campuses and cannot be requested (400)', async () => {
  const archived = await ops.newPackage(50, 60, 30);
  await ops.archivePackage(archived);
  const list = await (await owner.api.get('subscription/quota/packages')).json();
  expect(list.map((p: { id: string }) => p.id)).not.toContain(archived.id);
  const res = await requestTopUp(archived.id);
  expect(res.status()).toBe(400);
  expect(await res.text()).toContain('The selected package is not available.');
});

test('AC9: disabling "Fee dues" skips fee WhatsApps with DisabledByCampus; results still send', async () => {
  const prefs = await (await owner.api.get('campus/notification-preferences')).json();
  expect(prefs.items.map((i: { kind: number; enabled: boolean }) => [i.kind, i.enabled])).toEqual([[WA_KIND.ResultPublished, true], [WA_KIND.PendingDues, true]]);

  expect((await owner.api.put('campus/notification-preferences', { data: { disabledKinds: [WA_KIND.PendingDues] } })).status()).toBe(200);
  const after = await (await owner.api.get('campus/notification-preferences')).json();
  expect(after.items.find((i: { kind: number }) => i.kind === WA_KIND.PendingDues).enabled).toBe(false);

  const dues = await quotaDb.queueWhatsApp(owner.tenantId, WA_KIND.PendingDues);
  const result = await quotaDb.queueWhatsApp(owner.tenantId, WA_KIND.ResultPublished);
  const duesRow = await quotaDb.waitProcessed(dues);
  const resultRow = await quotaDb.waitProcessed(result);
  expect(duesRow).toMatchObject({ Status: WA_STATUS.Skipped, SkipReason: 'DisabledByCampus', QuotaAllocationId: null });
  expect(resultRow).toMatchObject({ Status: WA_STATUS.Sent });

  // The first metered send of the month lazily creates the plan allocation and charges it.
  const plan = (await quotaDb.allocations(owner.tenantId)).find((a) => a.Source === 0);
  expect(plan).toMatchObject({ Granted: 100, Used: 1 });
  expect((await summary()).used).toBe(1);
});

test('release on failure: a row that cannot be sent after reserving gives its credit back', async () => {
  const usedBefore = (await quotaDb.allocations(owner.tenantId)).reduce((n, a) => n + a.Used, 0);
  const key = await quotaDb.queueWhatsApp(owner.tenantId, WA_KIND.ResultPublished);
  await mongo(`db.scheduledwhatsappmessages.updateOne({DedupeKey: ${JSON.stringify(key)}}, {$set: {MessageJson: '{not json'}})`);
  const row = await quotaDb.waitProcessed(key);
  expect(row).toMatchObject({ Status: WA_STATUS.Skipped, SkipReason: 'BadPayload', QuotaAllocationId: null });
  const usedAfter = (await quotaDb.allocations(owner.tenantId)).reduce((n, a) => n + a.Used, 0);
  expect(usedAfter).toBe(usedBefore);
});

test('AC5 + AC8 + AC10: when every allocation is used up, metered sends are skipped, exempt kinds still send, and the alert status turns on', async () => {
  await quotaDb.setUsed(owner.tenantId, 0, 'granted');
  await quotaDb.setUsed(owner.tenantId, 1, 'granted');
  expect((await summary())).toMatchObject({ remaining: 0, isExhausted: true });
  // No message has been skipped yet, so the layout alert stays off until one is.
  expect(await status()).toEqual({ isExhausted: false, skippedThisMonth: 0 });

  const metered = await quotaDb.queueWhatsApp(owner.tenantId, WA_KIND.ResultPublished);
  const exempt = await quotaDb.queueWhatsApp(owner.tenantId, WA_KIND.StaffInvite);
  const meteredRow = await quotaDb.waitProcessed(metered);
  const exemptRow = await quotaDb.waitProcessed(exempt);
  expect(meteredRow).toMatchObject({ Status: WA_STATUS.Skipped, SkipReason: 'QuotaExhausted', QuotaAllocationId: null });
  expect(exemptRow).toMatchObject({ Status: WA_STATUS.Sent, QuotaAllocationId: null });

  expect(await status()).toEqual({ isExhausted: true, skippedThisMonth: 1 });
  expect(await summary()).toMatchObject({ remaining: 0, isExhausted: true, skippedThisMonth: 1 });
});

test('AC10: approving a new add-on clears the exhausted status (the alert goes away)', async () => {
  expect((await requestTopUp(pkg.id)).status()).toBe(201);
  expect((await ops.approve((await pendingRequestId())!)).status()).toBe(200);
  expect(await status()).toEqual({ isExhausted: false, skippedThisMonth: 1 });
  expect(await summary()).toMatchObject({ isExhausted: false, remaining: 100 });
});
