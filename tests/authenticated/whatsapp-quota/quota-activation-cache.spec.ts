/**
 * PR 538 cycle-1 B2 (not filed as a subtask) — 60 s entitlement cache after activation.
 *
 * Cycle 3 (b52eeae6): the PO accepted the 60 s activation-cache lag as a KNOWN LIMITATION. Since the
 * z94x8ecp9c fix, GetQuotaStatus only reports "exhausted" when the campus had credit or a message was skipped,
 * so the cached "Trialing" balance (included 0) no longer turns the shell alert on: the false banner is gone and
 * stays asserted. The Subscription summary (GET subscription/quota) can still show included 0 / remaining 0 for
 * up to 60 s; that lag is recorded as a `known-limitation` annotation, not a failure.
 *
 * PR 554 made GET subscription/quota/status check the subscription FRESH, but QuotaManager.GetBalanceAsync
 * still reads the entitlement through the 60 s cache (quota-entitlement:{tenant}:{resource}). Before the
 * month's first send there is no plan allocation document, so a cached "Trialing" entitlement makes the
 * balance 0 → Remaining 0 → IsExhausted true. Since PR 554 the shell shows the alert at Remaining 0
 * (Q1 z94x8ebv8f), so a campus that was JUST activated would see a false "WhatsApp quota exhausted." banner.
 *
 * Each test uses its own fresh trial campus; the trial read primes the cache, the operator activates, and
 * the owner reloads within a few seconds (well inside 60 s).
 */
import { test, expect } from '@playwright/test';
import { BackOffice, newCampusOwner, quotaDb, signInToWebApp, type CampusOwner } from '../../../fixtures/quota';
import { QuotaShellNotice } from '../../../pages/setup/QuotaShellNotice';
import { SubscriptionQuotaCard } from '../../../pages/setup/SubscriptionQuotaCard';

test.use({ ignoreHTTPSErrors: true });

let ops: BackOffice;
const owners: CampusOwner[] = [];

test.beforeAll(async () => {
  ops = await BackOffice.signIn();
});

test.afterAll(async () => {
  await ops?.dispose();
  for (const o of owners) await o.api.dispose();
});

test('B2 (known limitation): right after activation the alert status is not exhausted; the summary catches up within 60 s', async () => {
  const owner = await newCampusOwner();
  owners.push(owner);
  // The owner looks at the quota while still on trial (this primes the entitlement cache)...
  expect(await (await owner.api.get('subscription/quota')).json()).toMatchObject({ isTrial: true, included: 0 });
  expect(await (await owner.api.get('subscription/quota/status')).json()).toEqual({ isExhausted: false, skippedThisMonth: 0 });
  // ...then the operator activates the subscription and the owner reloads the Subscription page.
  await ops.activate(await quotaDb.subscriptionId(owner.tenantId));
  const activatedAt = Date.now();
  const quota = await (await owner.api.get('subscription/quota')).json();
  const status = await (await owner.api.get('subscription/quota/status')).json();
  const elapsed = Math.round((Date.now() - activatedAt) / 1000);
  expect(quota.isEntitled).toBe(true);
  expect(status, `layout status ${elapsed}s after activation (drives the shell alert)`).toEqual({ isExhausted: false, skippedThisMonth: 0 });
  if (quota.included !== 100) {
    { const a = {
      type: 'known-limitation',
      description: `PO-accepted 60 s activation cache: summary ${elapsed}s after activation = included ${quota.included}, remaining ${quota.remaining}, isExhausted ${quota.isExhausted}`,
    }; test.info().annotations.push(a); console.log(`[${a.type}] ${a.description}`); }
  }
  // Within the accepted window the summary catches up.
  await expect.poll(async () => (await (await owner.api.get('subscription/quota')).json()).included, { timeout: 90_000, intervals: [5_000] }).toBe(100);
});

test('B2: the owner does not get a false "WhatsApp quota exhausted" banner right after activation', async ({ page }) => {
  const owner = await newCampusOwner();
  owners.push(owner);
  await signInToWebApp(page, owner);
  // Trial: the Subscription page reads subscription/quota (primes the cache in the RestApi).
  const card = new SubscriptionQuotaCard(page);
  await card.open();
  await expect(card.trialNotice()).toBeVisible();

  await ops.activate(await quotaDb.subscriptionId(owner.tenantId));
  await page.goto('/');
  const shell = new QuotaShellNotice(page);
  await expect(shell.homeHeading()).toBeVisible({ timeout: 30_000 });
  // The shell reads subscription/quota/status after the layout renders; give it time to show (or not).
  await page.waitForResponse((r) => r.url().includes('subscription/quota/status'), { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);
  if (await shell.notice.count()) {
    await page.screenshot({ path: test.info().outputPath('b2-false-exhausted-banner.png'), fullPage: true });
  }
  await expect(shell.notice, 'false "WhatsApp quota exhausted." banner seconds after activation').toHaveCount(0);
});
