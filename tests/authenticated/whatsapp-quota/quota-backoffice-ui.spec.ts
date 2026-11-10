/**
 * PR 538 / CU-z94x8e7hp4 — back-office forms (AC2, AC7). Cycle 2 retests of PR 554 fixes:
 *  - B4 z94x8ebv0q: Plans form "WhatsApp messages / month" — overflow, decimal and empty input must show
 *    "Enter a whole number between 0 and 2,147,483,647." and must NOT save another value; the error clears
 *    once the value is fixed.
 *  - B1 z94x8ebv0m / B7 z94x8ebv0u: Quota-packages form has a "Package name" field (required) and bounds
 *    validity to 1..3650 days.
 * Plans / packages created here are archived.
 */
import { test, expect, type Page } from '@playwright/test';
import { BackOfficePlansPage } from '../../../pages/backoffice/BackOfficePlansPage';
import { AUTH_APP, BackOffice } from '../../../fixtures/quota';

const QUOTA_ERROR = 'Enter a whole number between 0 and 2,147,483,647.';

let ops: BackOffice;
let opsPage: Page;
test.beforeAll(async ({ browser }) => {
  ops = await BackOffice.signIn();
  // Signed in with the operator's API session cookie: the login form is not what this file is about.
  opsPage = await browser.newPage({ ignoreHTTPSErrors: true, storageState: await ops.storageState() });
});
test.afterAll(async () => {
  for (const p of (await ops.plans()).filter((p) => p.name.startsWith('QA538 UI') && !p.isArchived)) {
    await ops.updatePlan(p.id, { name: p.name, price: p.price, cycle: p.cycle, trialDays: p.trialDays, features: p.features, isArchived: true });
  }
  for (const p of (await ops.packages()).filter((p) => p.name.startsWith('QA538 UI') && !p.isArchived)) await ops.archivePackage(p);
  await opsPage?.close();
  await ops?.dispose();
});

for (const [label, typed] of [['an out-of-range number', '99999999999'], ['a decimal', '1.5'], ['an empty field', '']] as const) {
  test(`B4 z94x8ebv0q: the plan form refuses ${label} for the WhatsApp limit instead of saving another value`, async () => {
    const plans = new BackOfficePlansPage(opsPage, AUTH_APP);
    const name = `QA538 UI Plan ${Date.now().toString(36)}`;
    await plans.open();
    await plans.startNewPlan(name, 100);
    await plans.typeQuota('500');
    await plans.typeQuota(typed);
    await plans.create();
    await expect(plans.modal.getByText(QUOTA_ERROR), 'field error').toBeVisible();
    await expect(plans.modal, 'modal stays open').toBeVisible();
    expect((await ops.plans()).find((p) => p.name === name), 'nothing saved').toBeUndefined();
    if (label === 'an out-of-range number') await opsPage.screenshot({ path: test.info().outputPath('b4-plan-quota-overflow-error.png') });

    // Fixing the value clears the error and saves exactly what was typed.
    await plans.typeQuota('250');
    await expect(plans.modal.getByText(QUOTA_ERROR)).toHaveCount(0);
    await plans.create();
    await expect(plans.modal).toBeHidden({ timeout: 15_000 });
    expect((await ops.plans()).find((p) => p.name === name)?.quotas[0].granted).toBe(250);
  });
}

test('B4 z94x8ebv0q: a negative WhatsApp limit shows the error and the stale message goes away once fixed', async () => {
  const plans = new BackOfficePlansPage(opsPage, AUTH_APP);
  const name = `QA538 UI Plan neg ${Date.now().toString(36)}`;
  await plans.open();
  await plans.startNewPlan(name, 100);
  await plans.typeQuota('-1');
  await plans.create();
  await expect(plans.modal.getByText(QUOTA_ERROR)).toBeVisible();
  await plans.typeQuota('0');
  await expect(plans.modal.getByText(QUOTA_ERROR)).toHaveCount(0);
  await expect(plans.modal.getByText('Quota allowances must be 0 or greater.')).toHaveCount(0);
  await plans.modal.getByRole('button', { name: 'Cancel' }).click();
});

test.describe('quota package form', () => {
  const modal = () => opsPage.getByRole('dialog', { name: /New package|Edit package/ });
  const open = async () => {
    await opsPage.goto(`${AUTH_APP}/backoffice/quota-packages`);
    await expect(opsPage.getByRole('heading', { name: 'Quota packages', level: 1 })).toBeVisible({ timeout: 30_000 });
    await opsPage.getByRole('button', { name: 'New package' }).click();
    await expect(modal()).toBeVisible();
  };
  const fill = async (name: string, quantity: string, price: string, validity: string) => {
    await modal().getByRole('textbox', { name: 'Package name' }).fill(name);
    await modal().getByRole('spinbutton', { name: 'Quantity (messages)' }).fill(quantity);
    await modal().getByRole('spinbutton', { name: 'Price (PKR)' }).fill(price);
    await modal().getByRole('spinbutton', { name: 'Validity (days)' }).fill(validity);
  };

  test('B7 z94x8ebv0u: the package form asks for a name and refuses a blank one', async () => {
    await open();
    await fill('   ', '10', '10', '30');
    await modal().getByRole('button', { name: 'Create' }).click();
    await expect(modal().getByText('Package name is required.')).toBeVisible();
    await modal().getByRole('button', { name: 'Cancel' }).click();
  });

  for (const validity of ['0', '3651', '99999999999']) {
    test(`B1 z94x8ebv0m: the package form refuses a validity of ${validity} days`, async () => {
      const name = `QA538 UI Pkg ${validity} ${Date.now().toString(36)}`;
      await open();
      await fill(name, '10', '10', validity);
      await modal().getByRole('button', { name: 'Create' }).click();
      await expect(modal().getByText('Validity must be between 1 and 3650 days.')).toBeVisible();
      if (validity === '3651') await opsPage.screenshot({ path: test.info().outputPath('b1-package-validity-3651-error.png') });
      expect((await ops.packages()).find((p) => p.name === name)).toBeUndefined();
      await modal().getByRole('button', { name: 'Cancel' }).click();
    });
  }

  test('B7 z94x8ebv0u: a named package is listed with its name and offered to campuses under it', async () => {
    const name = `QA538 UI Pkg named ${Date.now().toString(36)}`;
    await open();
    await fill(name, '25', '50', '3650');
    await modal().getByRole('button', { name: 'Create' }).click();
    await expect(modal()).toBeHidden({ timeout: 15_000 });
    const row = (await ops.packages()).find((p) => p.name === name);
    expect(row).toMatchObject({ quantity: 25, price: 50, validityDays: 3650 });
    await expect(opsPage.getByRole('row', { name: new RegExp(row!.name.replace('QA538', 'Qa538').split(' ')[0], 'i') }).first()).toBeVisible();
  });
});
