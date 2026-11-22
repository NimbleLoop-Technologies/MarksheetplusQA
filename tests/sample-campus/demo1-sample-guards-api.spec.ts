/**
 * DEMO-1 (CU-z94x8eebc9, PR 573): sample-tenant flag and outbound guards, end to end on the LOCAL stack
 * (API, Mongo, Postgres and the Worker). UI checks (banner, telemetry, invite screens) are in demo1-sample-ui.spec.ts.
 *
 * Self-seeding, serial. DB PRECONDITIONS (only on campuses this file creates, logged by name):
 *   - owner A: R (real, trial) whose tenant document has NO IsSample field (a legacy document);
 *              S (sample) and N (real) whose signup subscriptions are deleted, i.e. "no subscription".
 *   - owner B: S2, activated by the back-office operator, then flagged sample. Its subscription is kept on purpose,
 *              so the back-office and quota guards are exercised against a sample that WOULD otherwise count and bill.
 * The flag is flipped the DEMO-1 way (Mongo `tenants.IsSample = true`) and the spec then waits out the policy's
 * 1-minute "not a sample" cache in every process.
 */
import { test, expect } from '@playwright/test';
import { BackOffice, mongo, newCampusOwner, quotaDb, workerLogMentions, WA_KIND, WA_STATUS, type CampusOwner } from '../../fixtures/quota';
import { addStudent, createSchoolPolicy, familyMobile, pay, personName, q, setupSchool, sql, waitForChallans, waitReceiptProcessed, type Student } from '../../fixtures/fees';
import { addStaffWithContacts } from '../../fixtures/access-roles';
import {
  INVITES_OFF, SAMPLE_CACHE_MS, addCampus, apiFor, deleteSubscriptionOf, flagSample, jwtClaims, restLogin, restRefresh, restSwitchCampus, tenantDoc,
} from '../../fixtures/sample-campus';

test.describe.configure({ mode: 'serial' });

let A: CampusOwner;
let B: CampusOwner;
let ops: BackOffice;
let R: string;
let S: string;
let N: string;
let S2: string;
let subS2: string;
let before: { dashboard: any; customersB: number; planActive: number; planId: string; planPrice: number };
let s2Student: Student;
let s2StaffId: string;

const dashboard = async () => { const r = await ops.http.get(ops.url('dashboard')); expect(r.status()).toBe(200); return r.json(); };
const customersMatching = async (search: string) => {
  const r = await ops.http.get(ops.url(`customers?pageIndex=0&pageSize=50&search=${encodeURIComponent(search)}`));
  expect(r.status()).toBe(200);
  return (await r.json()) as { items: Array<{ subscriptionId: string }>; totalCount: number };
};
const planActiveCount = async (planId: string) => {
  const r = await ops.http.get(ops.url('plans'));
  expect(r.status()).toBe(200);
  const plan = (await r.json()).find((p: any) => p.id === planId);
  return plan.activeSubscriptions ?? plan.activeSubscriptionCount ?? plan.subscriberCount ?? plan.activeCount;
};
const outbox = async (tenantId: string, eventTypes: string[]) =>
  Number((await sql(`select count(*) from "OutboxMessages" where "TenantId" = ${q(tenantId)} and "EventType" in (${eventTypes.map(q).join(',')})`))[0][0]);
const familyDb = async (statement: string) => sql(statement, 'mp-familyapp-db');

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  A = await newCampusOwner('qa573a');
  R = A.tenantId;
  S = await addCampus(A, 'Sample');
  N = await addCampus(A, 'Noplan');
  B = await newCampusOwner('qa573b');
  S2 = B.tenantId;
  ops = await BackOffice.signIn();
  subS2 = await quotaDb.subscriptionId(S2);
  await ops.activate(subS2);

  console.log('[DB SETUP] A/S and A/N: delete the signup subscription (a sample school has none; N is the real no-plan control)');
  await deleteSubscriptionOf(S);
  await deleteSubscriptionOf(N);
  console.log('[DB SETUP] A/R: remove the IsSample field (legacy tenant document from before DEMO-1)');
  await flagSample(R, 'unset');

  // Back-office baseline with S2 still a real, active customer.
  const detail = await ops.customerDetail(subS2);
  const planId = detail.planId ?? detail.plan?.id;
  const plans = await (await ops.http.get(ops.url('plans'))).json();
  const plan = plans.find((p: any) => p.id === planId) ?? plans.find((p: any) => p.name === (detail.planName ?? detail.plan));
  before = { dashboard: await dashboard(), customersB: (await customersMatching(B.email)).totalCount, planActive: await planActiveCount(plan.id), planId: plan.id, planPrice: plan.price };
  console.log(`[baseline] dashboard=${JSON.stringify({ ...before.dashboard, recentActivity: undefined })} customersB=${before.customersB} planActive=${before.planActive} price=${before.planPrice}`);

  console.log('[DB SETUP] S and S2: IsSample = true (the DEMO-1 ops step)');
  await flagSample(S);
  await flagSample(S2);
  await new Promise((r) => setTimeout(r, SAMPLE_CACHE_MS));
  await B.refreshToken();
});

test.afterAll(async () => {
  await ops?.dispose();
  await A?.api.dispose();
  await B?.api.dispose();
});

test('AC1: IsSample is stored on the tenant, null/absent means real, and campuses/mine reports it per campus', async () => {
  expect((await tenantDoc(S)).IsSample).toBe(true);
  expect((await tenantDoc(S2)).IsSample).toBe(true);
  expect(await tenantDoc(N)).toHaveProperty('IsSample', null);
  expect(Object.keys(await tenantDoc(R))).not.toContain('IsSample');
  const mine = await (await A.api.get('campuses/mine')).json();
  const flags = Object.fromEntries(mine.campuses.map((c: any) => [c.tenantId, c.isSample]));
  expect(flags).toEqual({ [R]: false, [S]: true, [N]: false });
});

test('AC6: Login, SwitchCampus and RefreshToken let a sample with no subscription in, with is_sample and no subscription claims', async () => {
  const login = await restLogin(A);
  expect(login.status).toBe(200);
  const toS = await restSwitchCampus(login.body.accessToken, S);
  expect(toS.status, JSON.stringify(toS.body)).toBe(200);
  const sClaims = jwtClaims(toS.body.accessToken);
  expect(sClaims).toMatchObject({ tenant: S, is_sample: 'true' });
  expect(sClaims).not.toHaveProperty('subscription_status');

  const toR = await restSwitchCampus(toS.body.accessToken, R);
  expect(toR.status).toBe(200);
  const rClaims = jwtClaims(toR.body.accessToken);
  expect(rClaims).toMatchObject({ tenant: R, subscription_status: 'trialing' });
  expect(rClaims).not.toHaveProperty('is_sample');

  // Real campus without a subscription: no is_sample (the client then routes it to the plan screen).
  const toN = await restSwitchCampus(toR.body.accessToken, N);
  expect(toN.status).toBe(200);
  expect(jwtClaims(toN.body.accessToken)).not.toHaveProperty('is_sample');
  expect(jwtClaims(toN.body.accessToken)).not.toHaveProperty('subscription_status');

  const backToS = await restSwitchCampus(toN.body.accessToken, S);
  expect(backToS.status).toBe(200);
  const refreshed = await restRefresh(backToS.body.refreshToken, S);
  expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
  expect(jwtClaims(refreshed.body.accessToken)).toMatchObject({ tenant: S, is_sample: 'true' });

  // SwitchCampus persisted S as the default campus: a fresh login lands on the sample.
  const relogin = await restLogin(A);
  expect(relogin.status).toBe(200);
  expect(jwtClaims(relogin.body.accessToken)).toMatchObject({ tenant: S, is_sample: 'true' });

  // S2 keeps an ACTIVE subscription, yet as a sample it gets no subscription claims either.
  const b = await restLogin(B);
  expect(b.status).toBe(200);
  const bClaims = jwtClaims(b.body.accessToken);
  expect(bClaims).toMatchObject({ tenant: S2, is_sample: 'true' });
  expect(bClaims).not.toHaveProperty('subscription_status');

  // Leave A on R for the UI spec's starting point? No: the UI spec sets its own default. Restore R here.
  expect((await restSwitchCampus(relogin.body.accessToken, R)).status).toBe(200);
});

test('AC7: a sample never shows WhatsApp quota (status and summary are empty even on an activated subscription)', async () => {
  const status = await (await B.api.get('subscription/quota/status')).json();
  expect(status).toEqual({ isExhausted: false, skippedThisMonth: 0 });
  const summary = await (await B.api.get('subscription/quota')).json();
  expect(summary).toMatchObject({ included: 0, extra: 0, used: 0, remaining: 0, isExhausted: false, isTrial: false, isEntitled: false, skippedThisMonth: 0, allocations: [], pendingRequest: null });
  // Control: the real trial campus R still reads its normal summary.
  const login = await restLogin(A);
  const rApi = await apiFor(login.body.accessToken);
  const rSummary = await (await rApi.get('subscription/quota')).json();
  expect(rSummary.isTrial).toBe(true);
  await rApi.dispose();
});

test('AC8: the sample S2 leaves back-office customers, trial/active counts, MRR and plan counts', async () => {
  const after = await dashboard();
  expect(after.totalCustomers).toBe(before.dashboard.totalCustomers - 1);
  expect(after.activeCustomers).toBe(before.dashboard.activeCustomers - 1);
  expect(after.active).toBe(before.dashboard.active - 1);
  expect(after.onTrial).toBe(before.dashboard.onTrial);
  expect(Number(after.mrr)).toBeCloseTo(Number(before.dashboard.mrr) - Number(before.planPrice), 2);
  expect(before.customersB).toBe(1);
  expect((await customersMatching(B.email)).totalCount).toBe(0);
  for (const status of ['Active', 'Trialing', 'Trial', 'PastDue']) {
    const r = await ops.http.get(ops.url(`customers?pageIndex=0&pageSize=200&status=${status}&search=${encodeURIComponent(B.email)}`));
    if (r.status() === 200) expect((await r.json()).totalCount, `status filter ${status}`).toBe(0);
  }
  expect(await planActiveCount(before.planId)).toBe(before.planActive - 1);
  // Control: owner A's real trial campus is still a listed customer.
  expect((await customersMatching(A.email)).totalCount).toBe(1);
});

test('AC4: staff invite and resend are refused with the friendly message and create no invite', async () => {
  const staff = await addStaffWithContacts(B.api, { first: 'Sample', phone: familyMobile(), email: `qa573-staff+${Date.now()}@testenv.local` });
  s2StaffId = staff.id;
  for (const path of [`staff/${staff.id}/app-access/invite`, `staff/${staff.id}/app-access/invite/resend`]) {
    const res = await B.api.post(path);
    const text = await res.text();
    expect(res.status(), `${path}: ${text}`).toBe(400);
    expect(text).toContain(INVITES_OFF);
  }
  const invites = await mongo(`print((db.getCollectionNames().includes('staffinvites') ? db.staffinvites : db.StaffInvites).countDocuments({ StaffMemberId: ${JSON.stringify(staff.id)} }))`);
  expect(invites).toBe('0');
});

test('AC4: parent invite, resend and regenerate are refused (409, friendly message), status says no code can be issued, nothing is created', async () => {
  const school = await setupSchool(B, 1);
  s2Student = await addStudent(B, { name: personName('Sample'), classId: school.classes[0].id, fatherName: personName('Father'), fatherMobile: familyMobile() });
  for (const action of ['invite', 'resend', 'regenerate']) {
    const res = await B.api.post(`students/${s2Student.id}/parent-family/${action}`);
    const text = await res.text();
    expect(res.status(), `${action}: ${text}`).toBe(409);
    expect(text).toContain(INVITES_OFF);
  }
  const status = await (await B.api.get(`students/${s2Student.id}/parent-family`)).json();
  expect(status.canIssueCode).toBe(false);
  expect(await mongo(`print(db.studentfamilylinkinvites.countDocuments({ $or: [{ TenantId: ${JSON.stringify(S2)} }, { StudentId: ${JSON.stringify(s2Student.id)} }] }))`)).toBe('0');
  const waInvites = await mongo(`print(db.scheduledwhatsappmessages.countDocuments({ TenantId: ${JSON.stringify(S2)}, Kind: { $in: [${WA_KIND.StaffInvite}, ${WA_KIND.ParentLinkInvite}] }, Status: { $ne: ${WA_STATUS.Skipped} } }))`);
  expect(waInvites).toBe('0');
});

test('AC5: a sample student stages no learner provisioning or snapshot event and no family-plane row, even after the backfill sweep', async () => {
  test.setTimeout(5 * 60_000);
  // Control: a student added on the real campus R is provisioned.
  const login = await restLogin(A);
  const rApi = await apiFor(login.body.accessToken);
  const rOwner = { ...A, api: rApi, tenantId: R } as CampusOwner;
  const rSchool = await setupSchool(rOwner, 1);
  const rStudent = await addStudent(rOwner, { name: personName('Real'), classId: rSchool.classes[0].id, fatherName: personName('Father'), fatherMobile: familyMobile() });
  await expect.poll(() => outbox(R, ['LearnerProvisionRequestedEvent']), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => Number((await familyDb(`select count(*) from "LearnerEnrollments" where "SchoolTenantId" = ${q(R)} and "StudentId" = ${q(rStudent.id)}`))[0][0]), { timeout: 120_000, intervals: [5_000] }).toBe(1);
  await rApi.dispose();

  // Sample: two sweeps later (LearnerProvisioning sweep = 1 minute) still nothing.
  await new Promise((r) => setTimeout(r, 130_000));
  expect(await outbox(S2, ['LearnerProvisionRequestedEvent', 'StudentProfileSnapshotEvent'])).toBe(0);
  expect(Number((await familyDb(`select count(*) from "LearnerEnrollments" where "SchoolTenantId" = ${q(S2)}`))[0][0])).toBe(0);
  expect(Number((await familyDb(`select count(*) from "LearnerFeeStatements" where "SchoolTenantId" = ${q(S2)}`))[0][0])).toBe(0);
  // The register events a sample still emits are acked, not retried or dead-lettered.
  await expect.poll(async () => Number((await sql(`select count(*) from "OutboxMessages" where "TenantId" = ${q(S2)} and "ProcessedOn" is null`))[0][0]), { timeout: 90_000 }).toBe(0);
});

test('AC2 + AC5: a payment on the sample queues the fee receipt already Skipped SampleTenant (no Meta call, no credit) and stages no fee statement', async () => {
  test.setTimeout(8 * 60_000);
  const prefs = await B.api.put('campus/notification-preferences', { data: { disabledKinds: [], knownKinds: [WA_KIND.ResultPublished, WA_KIND.FeePaymentReceipt, WA_KIND.PendingDues] } });
  expect(prefs.status(), await prefs.text()).toBe(200);
  await createSchoolPolicy(B, { tuition: 1500 });
  await waitForChallans(S2, 1, `c."FamilyId" = ${q(s2Student.familyId)}`);
  const res = await pay(B.api, s2Student.familyId, 200);
  expect(res.status(), await res.text()).toBe(200);
  const receipt = await res.json();
  const row = await waitReceiptProcessed(S2, receipt.paymentId);
  expect(row).toMatchObject({ Kind: WA_KIND.FeePaymentReceipt, Status: WA_STATUS.Skipped, SkipReason: 'SampleTenant', QuotaAllocationId: null });
  // Pending-dues rows from the challan run (if the fan-out produced any) are Skipped SampleTenant too.
  const dues = JSON.parse(await mongo(`print(EJSON.stringify(db.scheduledwhatsappmessages.find({ TenantId: ${JSON.stringify(S2)}, Kind: ${WA_KIND.PendingDues} }, { Status: 1, SkipReason: 1 }).toArray()))`));
  console.log(`[pending dues rows for S2] ${JSON.stringify(dues)}`);
  for (const d of dues) expect(d).toMatchObject({ Status: WA_STATUS.Skipped, SkipReason: 'SampleTenant' });
  expect(await quotaDb.creditsUsed(S2)).toBe(0);
  expect(await workerLogMentions(S2).then((l) => l.filter((x) => x.includes('FAKE WhatsApp')))).toEqual([]);
  expect(await outbox(S2, ['FamilyFeeStatementChangedEvent'])).toBe(0);
  expect(Number((await familyDb(`select count(*) from "LearnerFeeStatements" where "SchoolTenantId" = ${q(S2)}`))[0][0])).toBe(0);
});

test('AC2: Pending result/dues rows written outside the queue are Skipped SampleTenant by the sender before any Meta call or quota claim', async () => {
  test.setTimeout(8 * 60_000);
  const keys = [await quotaDb.queueWhatsApp(S2, WA_KIND.ResultPublished), await quotaDb.queueWhatsApp(S2, WA_KIND.PendingDues)];
  for (const key of keys) {
    const row = await quotaDb.waitProcessed(key);
    expect(row).toMatchObject({ Status: WA_STATUS.Skipped, SkipReason: 'SampleTenant', QuotaAllocationId: null });
    expect(await workerLogMentions(key).then((l) => l.filter((x) => x.includes('FAKE WhatsApp')))).toEqual([]);
  }
  expect(await quotaDb.creditsUsed(S2)).toBe(0);
});

test('AC3: the sample owner\'s welcome email is Skipped SampleTenant; a real (legacy-document) campus\'s welcome is still sent', async () => {
  test.setTimeout(5 * 60_000);
  const row = async (userId: string) => JSON.parse(await mongo(`print(EJSON.stringify(db.scheduledemails.findOne({ DedupeKey: 'welcome-trial:' + ${JSON.stringify(userId)} }), {relaxed: true}))`));
  expect((await row(B.userId)).TenantId).toBe(S2);
  expect((await row(A.userId)).TenantId).toBe(R);
  console.log('[DB SETUP] welcome-email rows of A and B: SendAfterUtc moved to the past so the 1-minute send pass picks them up now');
  await mongo(`db.scheduledemails.updateMany({ DedupeKey: { $in: ['welcome-trial:' + ${JSON.stringify(B.userId)}, 'welcome-trial:' + ${JSON.stringify(A.userId)}] }, Status: 0 }, { $set: { SendAfterUtc: new Date(Date.now() - 60000) } })`);
  await expect.poll(async () => (await row(B.userId)).Status, { timeout: 180_000, intervals: [5_000] }).not.toBe(0);
  expect(await row(B.userId)).toMatchObject({ Status: 3, SkipReason: 'SampleTenant', SentAtUtc: null, SentToAddress: null });
  await expect.poll(async () => (await row(A.userId)).Status, { timeout: 180_000, intervals: [5_000] }).not.toBe(0);
  expect((await row(A.userId)).SentAtUtc, 'real campus welcome sent').toBeTruthy();
});

// Last on purpose: cycle 1 found this open (B1), and a failure here must not stop the serial chain above.
test('AC7: a sample cannot request a paid WhatsApp top-up (no billing request reaches the back office)', async () => {
  const pkg = await ops.newPackage(10, 10, 30);
  try {
    const res = await B.api.post('subscription/quota/requests', { data: { packageId: pkg.id } });
    const body = await res.text();
    const queued = (await ops.requests('Requested')).filter((r) => r.tenantId === S2);
    console.log(`[top-up from sample] HTTP ${res.status()} ${body.slice(0, 300)} → back-office requests for S2: ${queued.length}`);
    expect(queued, `top-up request from a sample school reached the back office (HTTP ${res.status()})`).toHaveLength(0);
    expect(res.status()).toBeLessThan(500);
  } finally {
    // Clean up our own throwaway request so later back-office specs see an empty queue.
    for (const r of (await ops.requests('Requested')).filter((x) => x.tenantId === S2)) await ops.reject(r.id, 'QA573 cleanup').catch(() => undefined);
    await ops.archivePackage(pkg).catch(() => undefined);
  }
});
