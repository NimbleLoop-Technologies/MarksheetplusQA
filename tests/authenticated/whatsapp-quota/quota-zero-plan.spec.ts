/**
 * PR 538 — z94x8ecp9c (normal), cycle 3 retest of PR 554 fix b52eeae6: a campus on a plan with 0 WhatsApp
 * messages / month must not see the "WhatsApp quota exhausted." alert just for being on that plan.
 * GetQuotaStatus now reports exhausted only when the campus had credit and used it all, or a message was
 * already skipped for lack of quota. PO: once a message is really skipped for quota, the alert may show.
 * (The "used all its credit → alert" half, Q1 z94x8ebv8f, is covered in quota-ui.spec.ts / quota-active-campus.spec.ts.)
 *
 * Self-seeding, serial: one QA538 plan with `granted: 0` (archived afterwards), one fresh campus moved onto
 * it and activated. DB PRECONDITION: a queued Result row on that campus (as the result producer writes it).
 */
import { test, expect, type Page } from '@playwright/test';
import {
  BackOffice, evidencePath, newCampusOwner, quotaDb, signInToWebApp, WA_KIND, WA_STATUS, WEBAPP, type CampusOwner,
} from '../../../fixtures/quota';
import { QuotaShellNotice } from '../../../pages/setup/QuotaShellNotice';
import { SubscriptionQuotaCard } from '../../../pages/setup/SubscriptionQuotaCard';

test.use({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial' });

let owner: CampusOwner;
let ops: BackOffice;
let page: Page;
let planId: string;

const status = async () => (await owner.api.get('subscription/quota/status')).json();
const summary = async () => (await owner.api.get('subscription/quota')).json();

/** Loads Home and waits for the shell's quota-status call, so "no alert" is not just "not rendered yet". */
async function homeAfterStatus(p: Page) {
  const statusCall = p.waitForResponse((r) => r.url().includes('subscription/quota/status'), { timeout: 30_000 }).catch(() => undefined);
  await p.goto('/');
  const shell = new QuotaShellNotice(p);
  await expect(shell.homeHeading()).toBeVisible({ timeout: 30_000 });
  await statusCall;
  await p.waitForTimeout(1_500);
  return shell;
}

test.beforeAll(async ({ browser }) => {
  ops = await BackOffice.signIn();
  const name = `QA538 Zero ${Math.random().toString(36).slice(2, 8)}`;
  const created = await ops.createPlan({ name, price: 500, cycle: 'Monthly', trialDays: 14, features: [], quotas: [{ resource: 0, granted: 0 }] });
  expect(created.status(), await created.text()).toBe(200);
  planId = (await ops.plans()).find((p) => p.name === name)!.id;

  owner = await newCampusOwner();
  const subId = await quotaDb.subscriptionId(owner.tenantId);
  const change = await ops.changePlan(subId, planId);
  expect(change.status(), await change.text()).toBe(200);
  await ops.activate(subId);
  // Wait out the 60 s entitlement cache (known limitation) so every read below sees the active 0-message plan.
  await new Promise((r) => setTimeout(r, 65_000));
  page = await browser.newPage({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
  await signInToWebApp(page, owner);
});

test.afterAll(async () => {
  const plan = (await ops.plans()).find((p) => p.id === planId);
  if (plan) await ops.updatePlan(plan.id, { name: plan.name, price: plan.price, cycle: plan.cycle, trialDays: plan.trialDays, features: plan.features, quotas: plan.quotas.map((q) => ({ resource: q.resource, granted: q.granted })), isArchived: true });
  await ops?.dispose();
  await owner?.api.dispose();
  await page?.close();
});

test('z94x8ecp9c: an active campus on a 0-message plan is not "exhausted" and sees no alert', async () => {
  const quota = await summary();
  expect(quota, 'summary on the 0-message plan').toMatchObject({ isTrial: false, isEntitled: true, included: 0, extra: 0, used: 0, remaining: 0, skippedThisMonth: 0 });
  { const a = { type: 'observation', description: `GET subscription/quota.isExhausted on a 0-message plan = ${quota.isExhausted} (GetQuotaSummary was not changed by b52eeae6)` }; test.info().annotations.push(a); console.log(`[${a.type}] ${a.description}`); }
  expect(await status(), 'layout status (drives the shell alert)').toEqual({ isExhausted: false, skippedThisMonth: 0 });

  const shell = await homeAfterStatus(page);
  await expect(shell.notice, 'no "WhatsApp quota exhausted." alert for a plan that simply has no WhatsApp allowance').toHaveCount(0);
  await page.screenshot({ path: evidencePath('c3-ecp9c-zero-plan-no-banner.png') });

  const card = new SubscriptionQuotaCard(page);
  await card.open();
  expect(await card.stats()).toEqual({ included: 0, extra: 0, used: 0, remaining: 0 });
  await page.screenshot({ path: evidencePath('c3-ecp9c-zero-plan-subscription-card.png'), fullPage: true });
});

test('z94x8ecp9c: once a message is really skipped for quota on the 0-message plan, the alert shows (accepted by PO)', async () => {
  test.setTimeout(10 * 60_000);
  // Opt in first (notifications are OFF by default), otherwise the row is skipped as DisabledByCampus.
  expect((await owner.api.put('campus/notification-preferences', { data: { disabledKinds: [WA_KIND.PendingDues] } })).status()).toBe(200);
  const row = await quotaDb.waitProcessed(await quotaDb.queueWhatsApp(owner.tenantId, WA_KIND.ResultPublished));
  expect(row).toMatchObject({ Status: WA_STATUS.Skipped, SkipReason: 'QuotaExhausted', QuotaAllocationId: null });
  expect(await status()).toEqual({ isExhausted: true, skippedThisMonth: 1 });

  const shell = await homeAfterStatus(page);
  await expect(shell.notice).toBeVisible();
  await expect(shell.notice).toContainText('WhatsApp quota exhausted — 1 message not sent this month.');
  await page.screenshot({ path: evidencePath('c3-ecp9c-zero-plan-banner-after-skip.png') });
});
