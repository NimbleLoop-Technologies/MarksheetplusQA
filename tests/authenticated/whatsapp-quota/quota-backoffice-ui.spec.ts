/**
 * PR 538 / CU-z94x8e7hp4 — back-office Plans form, WhatsApp monthly limit input (AC2).
 * BUG REPRO: an out-of-range number shows in the field with no error and the plan is saved with the
 * last valid value instead. Creates one plan and archives it.
 */
import { test, expect } from '@playwright/test';
import { BackOfficePlansPage } from '../../../pages/backoffice/BackOfficePlansPage';
import { AUTH_APP, BackOffice } from '../../../fixtures/quota';

let ops: BackOffice;
test.beforeAll(async () => { ops = await BackOffice.signIn(); });
test.afterAll(async () => { await ops?.dispose(); });

test('AC2: the plan form refuses an out-of-range WhatsApp limit instead of silently saving another value', async ({ browser }) => {
  // Signed in with the operator's API session cookie: the login form is not what this test is about.
  const opsPage = await browser.newPage({ ignoreHTTPSErrors: true, storageState: await ops.storageState() });
  const plans = new BackOfficePlansPage(opsPage, AUTH_APP);
  const name = `QA538 Overflow ${Date.now().toString(36)}`;
  try {
    await plans.open();
    await plans.startNewPlan(name, 100);
    await plans.typeQuota('500');
    await plans.typeQuota('99999999999');
    await expect(plans.quotaInput()).toHaveValue('99999999999');
    await plans.create();
    // Either the form says the value is invalid, or the plan must not have been saved with a different number.
    const saved = (await ops.plans()).find((p) => p.name === name);
    if (saved) {
      await ops.updatePlan(saved.id, { name, price: saved.price, cycle: saved.cycle, trialDays: saved.trialDays, features: saved.features, isArchived: true });
    }
    expect(saved?.quotas[0].granted, `saved limit for input 99999999999; visible errors: ${JSON.stringify(await plans.errors())}`).toBeUndefined();
  } finally {
    await opsPage.close();
  }
});
