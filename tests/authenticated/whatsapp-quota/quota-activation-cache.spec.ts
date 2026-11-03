/**
 * PR 538 — BUG REPRO: right after the back office activates a campus, GET subscription/quota reports
 * Included 0 / Remaining 0 / IsExhausted true for up to 60 s, because QuotaManager caches the trial
 * entitlement (quota-entitlement:{tenant}:{resource}, 60 s) while GetQuotaSummary computes IsEntitled fresh.
 */
import { test, expect } from '@playwright/test';
import { BackOffice, newCampusOwner, quotaDb, type CampusOwner } from '../../../fixtures/quota';

let owner: CampusOwner;
let ops: BackOffice;

test.beforeAll(async () => {
  owner = await newCampusOwner();
  ops = await BackOffice.signIn();
});

test.afterAll(async () => {
  await ops?.dispose();
  await owner?.api.dispose();
});

test('a campus that just got activated sees its plan allowance at once (not "0 remaining, exhausted")', async () => {
  // The owner looks at the quota while still on trial (this primes the entitlement cache)...
  expect(await (await owner.api.get('subscription/quota')).json()).toMatchObject({ isTrial: true, included: 0 });
  // ...then the operator activates the subscription and the owner reloads the Subscription page.
  await ops.activate(await quotaDb.subscriptionId(owner.tenantId));
  const quota = await (await owner.api.get('subscription/quota')).json();
  expect(quota.isEntitled).toBe(true);
  expect(quota, 'Included/Remaining right after activation').toMatchObject({ included: 100, remaining: 100, isExhausted: false });
});
