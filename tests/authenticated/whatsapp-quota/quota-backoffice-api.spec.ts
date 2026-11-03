/**
 * PR 538 / CU-z94x8e7hp4 — back-office quota API: permissions, validation (AC2, AC7) and error handling.
 * Independent tests; each creates what it needs (packages are archived, plans archived afterwards).
 */
import { test, expect } from '@playwright/test';
import { AUTH_APP, BackOffice, newCampusOwner, quotaDb, type CampusOwner } from '../../../fixtures/quota';

let ops: BackOffice;
let ownerPromise: Promise<CampusOwner> | undefined;
const createdPlanIds: string[] = [];
/**
 * Lazily created: a failing test restarts the worker and re-runs beforeAll, and every owner costs two
 * OTP-limited calls (30 / 15 min / IP), so only the tests that need a campus pay for one.
 */
const campusOwner = () => (ownerPromise ??= newCampusOwner());

test.beforeAll(async () => {
  ops = await BackOffice.signIn();
});

test.afterAll(async () => {
  // Archive every plan this file created so it never shows up as assignable.
  for (const plan of (await ops.plans()).filter((p) => createdPlanIds.includes(p.id))) {
    await ops.updatePlan(plan.id, { name: plan.name, price: plan.price, cycle: plan.cycle, trialDays: plan.trialDays, features: plan.features, isArchived: true });
  }
  for (const p of (await ops.packages()).filter((p) => p.name.startsWith('QA538') && !p.isArchived)) await ops.archivePackage(p);
  await ops?.dispose();
  if (ownerPromise) await (await ownerPromise).api.dispose();
});

const uniquePlanName = () => `QA538 Plan ${Math.random().toString(36).slice(2, 8)}`;

test.describe('permissions', () => {
  test('a signed-in campus owner (not an operator) is forbidden from reading back-office quota data', async () => {
    const session = await (await campusOwner()).authAppSession();
    try {
      for (const path of ['quota-packages', 'quota-requests', 'plans']) {
        const res = await session.get(`${AUTH_APP}/backoffice/api/${path}`, { maxRedirects: 0 });
        expect([401, 403], path).toContain(res.status());
      }
    } finally {
      await session.dispose();
    }
  });

  test('a signed-in campus owner POSTing to approve / create package is answered 401/403', async () => {
    const session = await (await campusOwner()).authAppSession();
    try {
      const approve = await session.post(`${AUTH_APP}/backoffice/api/quota-requests/000000000000000000000000/approve`, { data: { paymentReference: 'x' }, maxRedirects: 0 });
      const create = await session.post(`${AUTH_APP}/backoffice/api/quota-packages`, { data: { quantity: 5, price: 1, validityDays: 5 }, maxRedirects: 0 });
      expect(await quotaPackageCount('QA538 never'), 'nothing was created').toBe(0);
      expect([401, 403], `approve → ${approve.status()} ${await approve.text()}`).toContain(approve.status());
      expect([401, 403], `create → ${create.status()} ${await create.text()}`).toContain(create.status());
    } finally {
      await session.dispose();
    }
  });

  test('an anonymous caller cannot read back-office quota data', async ({ playwright }) => {
    const anon = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    const res = await anon.get(`${AUTH_APP}/backoffice/api/quota-requests`, { maxRedirects: 0 });
    expect([302, 401, 403]).toContain(res.status());
    await anon.dispose();
  });
});

async function quotaPackageCount(name: string) {
  return (await ops.packages()).filter((p) => p.name === name).length;
}

test.describe('quota packages (AC7)', () => {
  test('a package of 100 messages for Rs. 100 can be created and is offered to campuses', async () => {
    const pkg = await ops.newPackage(100, 100, 90);
    expect(pkg).toMatchObject({ quantity: 100, price: 100, validityDays: 90, isArchived: false });
    const offered = await (await (await campusOwner()).api.get('subscription/quota/packages')).json();
    expect(offered).toContainEqual({ id: pkg.id, quantity: 100, price: 100, validityDays: 90 });
    await ops.archivePackage(pkg);
  });

  for (const [label, body, field] of [
    ['zero quantity', { quantity: 0, price: 1, validityDays: 10 }, 'quantity'],
    ['negative quantity', { quantity: -5, price: 1, validityDays: 10 }, 'quantity'],
    ['negative price', { quantity: 5, price: -1, validityDays: 10 }, 'price'],
    ['zero validity', { quantity: 5, price: 1, validityDays: 0 }, 'validityDays'],
  ] as const) {
    test(`package validation rejects ${label}`, async () => {
      const res = await ops.createPackage({ name: 'QA538 never', ...body });
      expect(res.status()).toBe(400);
      expect((await res.json()).errors).toHaveProperty(field);
      expect(await quotaPackageCount('QA538 never')).toBe(0);
    });
  }

  test('package validation rejects a non-numeric quantity with 400', async () => {
    const res = await ops.createPackage({ name: 'QA538 never', quantity: 'abc', price: 1, validityDays: 10 });
    expect(res.status()).toBe(400);
  });

  test('package validation rejects a blank name instead of saving an empty one', async () => {
    const before = (await ops.packages()).length;
    const res = await ops.createPackage({ name: '   ', quantity: 5, price: 1, validityDays: 10 });
    const created = (await ops.packages()).filter((p) => p.name === '' && !p.isArchived);
    for (const p of created) await ops.archivePackage(p);
    expect(res.status(), `blank name accepted; ${(await ops.packages()).length - before} package(s) created`).toBe(400);
  });

  test('a package with an absurd validity is either rejected or can be approved (no 500)', async () => {
    const res = await ops.createPackage({ name: 'QA538 huge validity', quantity: 7, price: 1, validityDays: 2147483647 });
    if (res.status() === 400) return; // validation added: fine
    expect(res.status()).toBe(200);
    const pkg = (await ops.packages()).find((p) => p.name === 'QA538 huge validity' && !p.isArchived)!;

    // An active campus requests it and the operator approves.
    const campus = await campusOwner();
    try {
      await ops.activate(await quotaDb.subscriptionId(campus.tenantId));
      expect((await campus.api.post('subscription/quota/requests', { data: { packageId: pkg.id } })).status()).toBe(201);
      const id = (await ops.requests('Requested')).find((r) => r.tenantId === campus.tenantId)!.id;
      const approve = await ops.approve(id);
      const status = (await ops.requests()).find((r) => r.id === id)?.status;
      const addOns = (await quotaDb.allocations(campus.tenantId)).filter((a) => a.Source === 1);
      expect(approve.status(), `approve → ${approve.status()}; request now ${status}; add-on allocations: ${addOns.length}`).toBe(200);
      expect(addOns).toHaveLength(1);
    } finally {
      await ops.archivePackage(pkg);
    }
  });
});

test.describe('quota requests', () => {
  test('approving / rejecting an unknown request id is 404', async () => {
    const unknown = '000000000000000000000000';
    const approve = await ops.approve(unknown);
    const reject = await ops.reject(unknown, 'x');
    expect(approve.status(), await approve.text()).toBe(404);
    expect(reject.status(), await reject.text()).toBe(404);
  });

  test('a malformed request / package id is a client error, not a 500', async () => {
    const approve = await ops.approve('not-an-id');
    const reject = await ops.reject('not-an-id', 'x');
    const update = await ops.updatePackage('not-an-id', { quantity: 1, price: 1, validityDays: 1, isArchived: false });
    expect([approve.status(), reject.status(), update.status()]).toEqual([404, 404, 404]);
  });

  test('the request list can be filtered by status', async () => {
    const all = await ops.requests();
    const requested = await ops.requests('Requested');
    expect(requested.every((r) => r.status === 'Requested')).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(requested.length);
  });
});

test.describe('plan quotas (AC2, AC4)', () => {
  test('a new plan saves its own WhatsApp monthly limit', async () => {
    const name = uniquePlanName();
    const res = await ops.createPlan({ name, price: 1000, cycle: 'Monthly', trialDays: 14, features: [], quotas: [{ resource: 0, granted: 250 }] });
    expect(res.status(), await res.text()).toBe(200);
    const plan = (await ops.plans()).find((p) => p.name === name)!;
    createdPlanIds.push(plan.id);
    expect(plan.quotas).toEqual([{ resource: 0, label: 'WhatsApp messages / month', granted: 250 }]);
  });

  test('a plan created without quotas defaults to 100 messages / month', async () => {
    const name = uniquePlanName();
    expect((await ops.createPlan({ name, price: 1000, cycle: 'Monthly', trialDays: 14, features: [] })).status()).toBe(200);
    const plan = (await ops.plans()).find((p) => p.name === name)!;
    createdPlanIds.push(plan.id);
    expect(plan.quotas[0].granted).toBe(100);
  });

  test('a zero limit is allowed (0 messages / month)', async () => {
    const name = uniquePlanName();
    expect((await ops.createPlan({ name, price: 1000, cycle: 'Monthly', trialDays: 14, features: [], quotas: [{ resource: 0, granted: 0 }] })).status()).toBe(200);
    const plan = (await ops.plans()).find((p) => p.name === name)!;
    createdPlanIds.push(plan.id);
    expect(plan.quotas[0].granted).toBe(0);
  });

  for (const [label, quotas, expectedError] of [
    ['a negative limit', [{ resource: 0, granted: -1 }], 'Quota allowances must be 0 or greater.'],
    ['a duplicated resource', [{ resource: 0, granted: 5 }, { resource: 0, granted: 6 }], 'Each metered resource may appear only once.'],
  ] as const) {
    test(`plan validation rejects ${label}`, async () => {
      const name = uniquePlanName();
      const res = await ops.createPlan({ name, price: 1000, cycle: 'Monthly', trialDays: 14, features: [], quotas });
      expect(res.status()).toBe(400);
      expect((await res.json()).errors.quotas).toEqual([expectedError]);
      expect((await ops.plans()).some((p) => p.name === name)).toBe(false);
    });
  }

  test('plan validation rejects an unknown metered resource', async () => {
    const name = uniquePlanName();
    const res = await ops.createPlan({ name, price: 1000, cycle: 'Monthly', trialDays: 14, features: [], quotas: [{ resource: 99, granted: 5 }] });
    const created = (await ops.plans()).find((p) => p.name === name);
    if (created) createdPlanIds.push(created.id);
    expect(res.status(), 'resource 99 is not a MeteredResource').toBe(400);
  });

  test('a campus on a plan with its own limit gets that limit as this month\'s allowance', async () => {
    const name = uniquePlanName();
    expect((await ops.createPlan({ name, price: 1000, cycle: 'Monthly', trialDays: 14, features: [], quotas: [{ resource: 0, granted: 250 }] })).status()).toBe(200);
    const plan = (await ops.plans()).find((p) => p.name === name)!;
    createdPlanIds.push(plan.id);

    // Before the month's first send there is no plan allocation yet, so the summary shows the plan's allowance.
    const campus = await campusOwner();
    const subId = await quotaDb.subscriptionId(campus.tenantId);
    const change = await ops.changePlan(subId, plan.id);
    expect(change.status(), await change.text()).toBe(200);
    await ops.activate(subId);
    await expect.poll(async () => (await (await campus.api.get('subscription/quota')).json()).included, { timeout: 90_000, intervals: [5_000] }).toBe(250);
  });
});

test.describe('notification preferences API (AC8, AC9)', () => {
  test('only metered kinds can be disabled: invite kinds and unknown kinds are rejected', async () => {
    const owner = await campusOwner();
    const res = await owner.api.put('campus/notification-preferences', { data: { disabledKinds: [3, 5, 99] } });
    const stored = await (await owner.api.get('campus/notification-preferences')).json();
    await owner.api.put('campus/notification-preferences', { data: { disabledKinds: [] } });
    expect(res.status(), `PUT [3,5,99] → ${res.status()}; GET items after: ${JSON.stringify(stored.items)}`).toBe(400);
  });

  test('a body without disabledKinds is a validation problem, not a generic error', async () => {
    const owner = await campusOwner();
    const res = await owner.api.put('campus/notification-preferences', { data: {} });
    expect(res.status()).toBe(400);
    expect(await res.json(), 'ValidationProblem naming the field').toHaveProperty('errors.DisabledKinds');
  });
});
