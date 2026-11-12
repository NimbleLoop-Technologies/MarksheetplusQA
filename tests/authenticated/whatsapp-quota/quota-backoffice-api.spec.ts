/**
 * PR 538 / CU-z94x8e7hp4 — back-office quota API: permissions, validation (AC2, AC7) and error handling.
 * Cycle 3 (b52eeae6): B5 follow-up z94x8ebv0r (customer / plan routes), z94x8ecp98 (AuthApp Not Found page),
 * B9 storage is opt-in (EnabledKinds, z94x8ecp90).
 * Cycle 2 (PR 554 fixes): the cycle-1 bug repros now assert the FIXED behaviour —
 *   B1 z94x8ebv0m validity bound + legacy request, B5 z94x8ebv0r malformed ids, B6 z94x8ebv0t real 403/404,
 *   B7 z94x8ebv0u blank name, B8 z94x8ebv0w unknown resource, B9 z94x8ebv0w prefs validation,
 *   S1 z94x8ebv0z customer quota, S4 z94x8ebv13 payment reference, Q4 z94x8ebv8g PastDue approval.
 * Independent tests; each creates what it needs (packages are archived, plans archived afterwards).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { AUTH_APP, BackOffice, evidencePath, newCampusOwner, quotaDb, type CampusOwner } from '../../../fixtures/quota';

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
  test('a signed-in campus owner (not an operator) is forbidden from reading back-office quota data', { tag: '@smoke' }, async () => {
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

  test('B6 z94x8ebv0t: a signed-in campus owner POSTing to approve / create package is answered 403 (not 400)', async () => {
    const session = await (await campusOwner()).authAppSession();
    try {
      const approve = await session.post(`${AUTH_APP}/backoffice/api/quota-requests/000000000000000000000000/approve`, { data: { paymentReference: 'x' }, maxRedirects: 0 });
      const create = await session.post(`${AUTH_APP}/backoffice/api/quota-packages`, { data: { quantity: 5, price: 1, validityDays: 5 }, maxRedirects: 0 });
      expect(await quotaPackageCount('QA538 never'), 'nothing was created').toBe(0);
      expect(approve.status(), `approve → ${approve.status()} ${await approve.text()}`).toBe(403);
      expect(create.status(), `create → ${create.status()} ${await create.text()}`).toBe(403);
    } finally {
      await session.dispose();
    }
  });

  test('z94x8ecp98 (B6 side effect): a browser GET of a missing AuthApp page renders the Not Found page with 404', async ({ browser }) => {
    // Cycle 2 NB3: PR 554 moved the re-execute into a UseWhen branch and missing pages answered 404 with an EMPTY
    // body. b52eeae6 keeps UseStatusCodePagesWithReExecute("/not-found") on the main pipeline and switches it off
    // per request for anything that is not a browser page load.
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      for (const path of ['/does-not-exist', '/definitely-missing-page', '/backoffice/does-not-exist', '/backoffice/definitely/missing/deep']) {
        const res = await page.goto(`${AUTH_APP}${path}`);
        expect(res?.status(), path).toBe(404);
        expect((await res!.headers())['content-type'] ?? '', path).toContain('text/html');
        await expect(page.getByRole('heading', { name: 'Not Found' }), `${path} renders the Not Found page, not a blank page`).toBeVisible();
        await expect(page.getByText('Sorry, the content you are looking for does not exist.')).toBeVisible();
        expect((await page.locator('body').innerText()).trim().length, `${path} body is not empty`).toBeGreaterThan(0);
      }
      await page.screenshot({ path: evidencePath('c3-ecp98-backoffice-missing-page-not-found.png'), fullPage: true });
      await page.goto(`${AUTH_APP}/does-not-exist`);
      await page.screenshot({ path: evidencePath('c3-ecp98-root-missing-page-not-found.png'), fullPage: true });
    } finally {
      await page.close();
    }
  });

  test('z94x8ecp98: API calls and POSTs to a missing path keep their own status and get no HTML page', async ({ playwright }) => {
    const anon = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    try {
      const html = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
      const cases: Array<[string, () => ReturnType<typeof anon.get>]> = [
        ['GET /does-not-exist Accept json', () => anon.get(`${AUTH_APP}/does-not-exist`, { headers: { Accept: 'application/json' } })],
        ['GET /does-not-exist Accept html+json', () => anon.get(`${AUTH_APP}/does-not-exist`, { headers: { Accept: 'text/html, application/json' } })],
        ['GET /backoffice/api/does-not-exist Accept html', () => anon.get(`${AUTH_APP}/backoffice/api/does-not-exist`, { headers: { Accept: html }, maxRedirects: 0 })],
        ['POST /does-not-exist Accept html', () => anon.post(`${AUTH_APP}/does-not-exist`, { headers: { Accept: html }, data: {} })],
      ];
      for (const [label, call] of cases) {
        const res = await call();
        const body = await res.text();
        expect(res.status(), label).toBeGreaterThanOrEqual(400);
        expect(body, `${label} → ${res.status()} must not be the Not Found HTML page`).not.toContain('Sorry, the content you are looking for does not exist.');
        expect(res.headers()['content-type'] ?? '', label).not.toContain('text/html');
      }
    } finally {
      await anon.dispose();
    }
    // Back-office API: an operator's API 404 is still the endpoint's own 404 (not the page).
    const res = await ops.http.get(ops.url('customers/000000000000000000000000'), { headers: { Accept: 'text/html,application/xhtml+xml' } });
    expect(res.status()).toBe(404);
    expect(await res.text()).not.toContain('Sorry, the content you are looking for does not exist.');
  });

  test('z94x8ecp98: a back-office customer page route with a malformed id is not a 500 or a blank page', async ({ browser }) => {
    // /backoffice/customers/{Id} IS a page route (CustomerDetail.razor), so it renders the page shell (200) and
    // the page's own API call answers 404. Recorded, not asserted as a Not Found page.
    const page = await browser.newPage({ ignoreHTTPSErrors: true, storageState: await ops.storageState() });
    try {
      const res = await page.goto(`${AUTH_APP}/backoffice/customers/not-an-id`);
      expect(res?.status(), 'page route').toBeLessThan(500);
      await page.waitForLoadState('networkidle').catch(() => undefined);
      expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(0);
      test.info().annotations.push({ type: 'observation', description: `/backoffice/customers/not-an-id → ${res?.status()}; body starts "${(await page.locator('main, body').first().innerText()).trim().slice(0, 160).replace(/\s+/g, ' ')}"` });
      console.log(test.info().annotations.at(-1)?.description);
      await page.screenshot({ path: evidencePath('c3-ecp98-backoffice-customer-page-malformed-id.png'), fullPage: true });
    } finally {
      await page.close();
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
    // PR 554 adds the package name to the campus contract (B7 z94x8ebv0u).
    expect(offered).toContainEqual({ id: pkg.id, quantity: 100, price: 100, validityDays: 90, name: pkg.name });
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

  test('B7 z94x8ebv0u: package validation rejects a blank name (create and update) instead of saving an empty one', async () => {
    const before = (await ops.packages()).length;
    const res = await ops.createPackage({ name: '   ', quantity: 5, price: 1, validityDays: 10 });
    const created = (await ops.packages()).filter((p) => p.name === '' && !p.isArchived);
    for (const p of created) await ops.archivePackage(p);
    expect(res.status(), `blank name accepted; ${(await ops.packages()).length - before} package(s) created`).toBe(400);
    expect((await res.json()).errors).toEqual({ name: ['Package name is required.'] });

    const pkg = await ops.newPackage(5, 1, 10);
    const update = await ops.updatePackage(pkg.id, { name: '  ', quantity: 5, price: 1, validityDays: 10, isArchived: false });
    expect(update.status()).toBe(400);
    expect((await ops.packages()).find((p) => p.id === pkg.id)?.name).toBe(pkg.name);
    await ops.archivePackage(pkg);
  });

  // B1 z94x8ebv0m: validity is bounded 1..3650 days (QuotaPackageLimits) on create and update.
  for (const [validityDays, ok] of [[1, true], [3650, true], [3651, false], [2147483647, false], [-1, false]] as const) {
    test(`B1 z94x8ebv0m: package validity ${validityDays} days is ${ok ? 'accepted' : 'rejected with the 1..3650 message'}`, async () => {
      const name = `QA538 validity ${validityDays} ${Math.random().toString(36).slice(2, 6)}`;
      const res = await ops.createPackage({ name, quantity: 5, price: 1, validityDays });
      const row = (await ops.packages()).find((p) => p.name === name);
      if (row && !row.isArchived) await ops.archivePackage(row);
      if (ok) {
        expect(res.status(), await res.text()).toBe(200);
        expect(row?.validityDays).toBe(validityDays);
      } else {
        expect(res.status(), await res.text()).toBe(400);
        expect((await res.json()).errors).toEqual({ validityDays: ['Validity must be between 1 and 3650 days.'] });
        expect(row).toBeUndefined();
      }
    });
  }

  test('B1 z94x8ebv0m: updating a package to a validity over 3650 days is rejected and leaves it unchanged', async () => {
    const pkg = await ops.newPackage(7, 1, 30);
    const res = await ops.updatePackage(pkg.id, { name: pkg.name, quantity: 7, price: 1, validityDays: 2147483647, isArchived: false });
    expect(res.status(), await res.text()).toBe(400);
    expect((await ops.packages()).find((p) => p.id === pkg.id)?.validityDays).toBe(30);
    await ops.archivePackage(pkg);
  });

  test('B1 z94x8ebv0m: approving a legacy request whose snapshot validity is huge is a 400, not a 500, and changes nothing', async () => {
    // DB PRECONDITION (own campus): a normal request's ValidityDays snapshot is rewritten to 2147483647,
    // standing in for a request created before PR 554 bounded the package validity.
    const campus = await campusOwner();
    const pkg = await ops.newPackage(7, 1, 30);
    try {
      await ensureActive(campus);
      expect((await campus.api.post('subscription/quota/requests', { data: { packageId: pkg.id } })).status()).toBe(201);
      const id = (await ops.requests('Requested')).find((r) => r.tenantId === campus.tenantId)!.id;
      await quotaDb.setRequestValidity(id, 2147483647);

      const approve = await ops.approve(id);
      const body = await approve.text();
      const after = await quotaDb.request(id);
      const addOns = (await quotaDb.allocations(campus.tenantId)).filter((a) => a.Source === 1);
      expect(approve.status(), `approve → ${approve.status()} ${body}`).toBe(400);
      expect(JSON.parse(body).errors?.validityDays).toEqual(['Validity must be between 1 and 3650 days.']);
      expect(after?.Status, 'request stays Requested (0)').toBe(0);
      expect(after?.PaymentReference ?? null).toBeNull();
      expect(addOns).toHaveLength(0);
      // Clean up: the operator rejects it so the campus has no pending request.
      expect((await ops.reject(id, 'QA538 legacy validity')).status()).toBe(200);
    } finally {
      await ops.archivePackage(pkg);
    }
  });

  test('B1 z94x8ebv0m: re-approving an already-approved legacy request with a huge validity is 409, not 500', async () => {
    // DB PRECONDITION (own campus): approve normally, then rewrite the approved request's ValidityDays.
    const campus = await campusOwner();
    const pkg = await ops.newPackage(7, 1, 30);
    try {
      await ensureActive(campus);
      expect((await campus.api.post('subscription/quota/requests', { data: { packageId: pkg.id } })).status()).toBe(201);
      const id = (await ops.requests('Requested')).find((r) => r.tenantId === campus.tenantId)!.id;
      expect((await ops.approve(id)).status()).toBe(200);
      await quotaDb.setRequestValidity(id, 2147483647);
      const again = await ops.approve(id);
      expect(again.status(), await again.text()).toBe(409);
    } finally {
      await ops.archivePackage(pkg);
    }
  });
});

let activated = false;
async function ensureActive(campus: CampusOwner) {
  if (activated) return;
  await ops.activate(await quotaDb.subscriptionId(campus.tenantId));
  activated = true;
}

test.describe('quota requests', () => {
  test('B6 z94x8ebv0t: approving / rejecting an unknown request id is 404 (not 400)', async () => {
    const unknown = '000000000000000000000000';
    const approve = await ops.approve(unknown);
    const reject = await ops.reject(unknown, 'x');
    expect(approve.status(), await approve.text()).toBe(404);
    expect(reject.status(), await reject.text()).toBe(404);
  });

  test('B5 z94x8ebv0r: a malformed request / package id is 404, not a 500', async () => {
    const approve = await ops.approve('not-an-id');
    const reject = await ops.reject('not-an-id', 'x');
    const update = await ops.updatePackage('not-an-id', { name: 'QA538 never', quantity: 1, price: 1, validityDays: 1, isArchived: false });
    expect([approve.status(), reject.status(), update.status()]).toEqual([404, 404, 404]);
  });

  // B5 follow-up, z94x8ebv0r (cycle 3, b52eeae6): the subscription and plan lookups now treat a non-ObjectId
  // as "not found". Every route gets a VALID body, so a 400 for a missing/invalid body cannot mask a 500.
  const VALID_PLAN = { name: 'QA538 never', price: 1, cycle: 'Monthly', trialDays: 1, features: [], isArchived: false, quotas: [{ resource: 0, granted: 100 }] };
  for (const bad of ['not-an-id', '123', 'zzzzzzzzzzzzzzzzzzzzzzzz', '6af2aa050404c5f70f27f33' /* 23 hex */]) {
    test(`B5 z94x8ebv0r: malformed id "${bad}" on the customer and plan routes is 404/400, never 500`, async () => {
      const id = encodeURIComponent(bad);
      const calls: Array<[string, () => ReturnType<APIRequestContext['get']>]> = [
        ['GET customers/{id}', () => ops.http.get(ops.url(`customers/${id}`))],
        ['POST customers/{id}/activate', () => ops.http.post(ops.url(`customers/${id}/activate`), { data: {} })],
        ['POST customers/{id}/extend', () => ops.http.post(ops.url(`customers/${id}/extend`), { data: { days: 1, reason: 'QA538' } })],
        ['POST customers/{id}/deactivate', () => ops.http.post(ops.url(`customers/${id}/deactivate`), { data: { reason: 'QA538' } })],
        ['POST customers/{id}/reactivate', () => ops.http.post(ops.url(`customers/${id}/reactivate`), { data: { reason: 'QA538' } })],
        ['POST customers/{id}/change-plan', () => ops.http.post(ops.url(`customers/${id}/change-plan`), { data: { planId: '000000000000000000000000', reason: 'QA538' } })],
        ['PUT plans/{id}', () => ops.http.put(ops.url(`plans/${id}`), { data: VALID_PLAN })],
      ];
      const seen: string[] = [];
      for (const [label, call] of calls) {
        const res = await call();
        seen.push(`${label} → ${res.status()}`);
        expect.soft([400, 404], `${label} → ${res.status()} ${(await res.text()).slice(0, 200)}`).toContain(res.status());
      }
      test.info().annotations.push({ type: 'statuses', description: seen.join('; ') });
      console.log(`[statuses ${bad}] ${seen.join('; ')}`);
      expect((await ops.plans()).some((p) => p.name === 'QA538 never'), 'no plan was created or renamed').toBe(false);
    });
  }

  test('B5 z94x8ebv0r: a malformed planId in a change-plan body on a REAL subscription is 404/400, and the plan is unchanged', async () => {
    const campus = await campusOwner();
    const subId = await quotaDb.subscriptionId(campus.tenantId);
    const before = await ops.customerDetail(subId);
    const res = await ops.changePlan(subId, 'not-an-id');
    expect([400, 404], `${res.status()} ${await res.text()}`).toContain(res.status());
    expect((await ops.customerDetail(subId)).planId).toBe(before.planId);
  });

  test('B5 z94x8ebv0r positive control: a valid PUT plans/{id} on a real (QA538) plan still saves', async () => {
    const name = uniquePlanName();
    expect((await ops.createPlan({ name, price: 1, cycle: 'Monthly', trialDays: 1, features: [], quotas: [{ resource: 0, granted: 100 }] })).status()).toBe(200);
    const plan = (await ops.plans()).find((p) => p.name === name)!;
    createdPlanIds.push(plan.id);
    const res = await ops.updatePlan(plan.id, { ...VALID_PLAN, name, quotas: [{ resource: 0, granted: 120 }] });
    expect(res.status(), await res.text()).toBe(200);
    expect((await ops.plans()).find((p) => p.id === plan.id)?.quotas[0].granted).toBe(120);
  });

  test('S4 z94x8ebv13: the approved list shows the payment reference the operator entered', async () => {
    const campus = await campusOwner();
    const pkg = await ops.newPackage(9, 1, 30);
    try {
      await ensureActive(campus);
      expect((await campus.api.post('subscription/quota/requests', { data: { packageId: pkg.id } })).status()).toBe(201);
      const id = (await ops.requests('Requested')).find((r) => r.tenantId === campus.tenantId)!.id;
      const ref = `QA538-REF-${Date.now().toString(36)}`;
      expect((await ops.approve(id, ref)).status()).toBe(200);
      expect((await ops.requests('Approved')).find((r) => r.id === id)).toMatchObject({ status: 'Approved', paymentReference: ref });
    } finally {
      await ops.archivePackage(pkg);
    }
  });

  test('S1 z94x8ebv0z: the back-office customer detail carries the campus WhatsApp quota', async () => {
    const campus = await campusOwner();
    await ensureActive(campus);
    const detail = await ops.customerDetail(await quotaDb.subscriptionId(campus.tenantId));
    const now = new Date();
    const own = await (await campus.api.get('subscription/quota')).json();
    expect(detail.whatsAppQuota).toMatchObject({ included: own.included, extra: own.extra, used: own.used, remaining: own.remaining, skippedThisMonth: 0 });
    expect(new Date(detail.whatsAppQuota.resetsAtUtc).toISOString()).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString());
    expect(detail.whatsAppQuota.remaining).toBe(detail.whatsAppQuota.included + detail.whatsAppQuota.extra - detail.whatsAppQuota.used);
  });

  test('Q4 z94x8ebv8g: an add-on cannot be approved for a PastDue (overdue) campus', async () => {
    // Own fresh campus; DB PRECONDITION after the request: subscriptions.CurrentPeriodEnd = now - 1 day (→ PastDue).
    const pastDue = await newCampusOwner();
    const pkg = await ops.newPackage(11, 1, 30);
    try {
      await ops.activate(await quotaDb.subscriptionId(pastDue.tenantId));
      expect((await pastDue.api.post('subscription/quota/requests', { data: { packageId: pkg.id } })).status()).toBe(201);
      const id = (await ops.requests('Requested')).find((r) => r.tenantId === pastDue.tenantId)!.id;
      await quotaDb.makePastDue(pastDue.tenantId);
      const approve = await ops.approve(id, 'QA538-PASTDUE');
      const body = await approve.text();
      expect(approve.status(), body).toBe(400);
      expect(JSON.parse(body).errors?.subscription).toEqual(['Activate or renew the campus subscription before approving extra quota.']);
      expect((await quotaDb.request(id))?.Status, 'still Requested').toBe(0);
      expect((await quotaDb.allocations(pastDue.tenantId)).filter((a) => a.Source === 1)).toHaveLength(0);
      // A PastDue campus cannot submit a new one either.
      expect((await ops.reject(id, 'QA538 past due')).status()).toBe(200);
      const again = await pastDue.api.post('subscription/quota/requests', { data: { packageId: pkg.id } });
      expect(again.status(), await again.text()).toBe(400);
    } finally {
      await ops.archivePackage(pkg);
      await pastDue.api.dispose();
    }
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

  test('B8 z94x8ebv0v: plan validation rejects an unknown metered resource', async () => {
    const name = uniquePlanName();
    const res = await ops.createPlan({ name, price: 1000, cycle: 'Monthly', trialDays: 14, features: [], quotas: [{ resource: 99, granted: 5 }] });
    const created = (await ops.plans()).find((p) => p.name === name);
    if (created) createdPlanIds.push(created.id);
    expect(res.status(), 'resource 99 is not a MeteredResource').toBe(400);
    expect((await res.json()).errors.quotas).toEqual(['Quota resource must be a defined metered resource.']);
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
    await ensureActive(campus);
    await expect.poll(async () => (await (await campus.api.get('subscription/quota')).json()).included, { timeout: 90_000, intervals: [5_000] }).toBe(250);
  });
});

test.describe('notification preferences API (AC8, AC9)', () => {
  for (const kinds of [[3], [5], [99], [3, 5, 99], [1, 3]]) {
    test(`B9 z94x8ebv0w: disabling kinds ${JSON.stringify(kinds)} is rejected (only metered kinds 1, 2) and nothing is stored`, async () => {
      const owner = await campusOwner();
      const before = await quotaDb.notificationPreference(owner.tenantId);
      const res = await owner.api.put('campus/notification-preferences', { data: { disabledKinds: kinds } });
      const body = await res.text();
      expect(res.status(), `PUT ${JSON.stringify(kinds)} → ${res.status()} ${body}`).toBe(400);
      expect(JSON.parse(body).errors?.DisabledKinds).toEqual(['Only metered notification kinds may be disabled.']);
      expect(await quotaDb.notificationPreference(owner.tenantId)).toEqual(before);
    });
  }

  for (const [label, data] of [['a body without disabledKinds', {}], ['disabledKinds: null', { disabledKinds: null }]] as const) {
    test(`B9 z94x8ebv0w: ${label} is a ValidationProblem, not a generic error`, async () => {
      const owner = await campusOwner();
      const res = await owner.api.put('campus/notification-preferences', { data });
      expect(res.status()).toBe(400);
      expect(await res.json(), 'ValidationProblem naming the field').toHaveProperty('errors.DisabledKinds');
    });
  }

  test('B9 z94x8ebv0w: a valid save is committed before the 200 (read-after-write sees it) and duplicates collapse', async () => {
    const owner = await campusOwner();
    const res = await owner.api.put('campus/notification-preferences', { data: { disabledKinds: [2, 2] } });
    expect(res.status(), await res.text()).toBe(200);
    // Opt-in storage since b52eeae6 (z94x8ecp90): the request still names the OFF kinds; the document stores
    // the complement as EnabledKinds and carries no DisabledKinds.
    const doc = await quotaDb.notificationPreference(owner.tenantId);
    expect(doc?.EnabledKinds).toEqual([1]);
    expect(doc).not.toHaveProperty('DisabledKinds');
    const items = (await (await owner.api.get('campus/notification-preferences')).json()).items;
    expect(items.map((i: { kind: number; enabled: boolean }) => [i.kind, i.enabled])).toEqual([[1, true], [2, false]]);
    // Leave the campus OFF again (the default).
    expect((await owner.api.put('campus/notification-preferences', { data: { disabledKinds: [1, 2] } })).status()).toBe(200);
    expect((await quotaDb.notificationPreference(owner.tenantId))?.EnabledKinds).toEqual([]);
  });
});
