/**
 * PR 538 / CU-z94x8e7hp4 — WhatsApp quota in the school WebApp and the back office (AC1, AC2, AC3,
 * AC6, AC9, AC10). Cycle 2: Q1 z94x8ebv8f (alert as soon as Remaining = 0, on the next load or in-app
 * navigation) and cycle-1 B10 (alert gone after approval on in-app navigation). Sign-in goes through
 * signInToWebApp (cycle-1 LoginPage timeout fix). Self-seeding: one fresh owner + campus per file, signed in through the UI.
 * The exhausted state is a DB PRECONDITION on that campus (quotaDb.simulateExhausted), so these
 * specs do not wait on Worker ticks; quota-active-campus.spec.ts covers the real Worker path.
 */
import { test, expect, type Page } from '@playwright/test';
import { SubscriptionQuotaCard } from '../../../pages/setup/SubscriptionQuotaCard';
import { CampusNotificationSettings } from '../../../pages/setup/CampusNotificationSettings';
import { QuotaShellNotice } from '../../../pages/setup/QuotaShellNotice';
import { BackOffice, newCampusOwner, quotaDb, signInToWebApp, WEBAPP, type CampusOwner, type QuotaPackageRow } from '../../../fixtures/quota';

test.use({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial' });

let owner: CampusOwner;
let ops: BackOffice;
let pkg: QuotaPackageRow;
let page: Page;

test.beforeAll(async ({ browser }) => {
  owner = await newCampusOwner();
  ops = await BackOffice.signIn();
  pkg = await ops.newPackage(150, 120, 60);
  page = await browser.newPage({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
  await signInToWebApp(page, owner);
});

test.afterAll(async () => {
  await ops?.archivePackage(pkg).catch(() => undefined);
  await ops?.dispose();
  await owner?.api.dispose();
  await page?.close();
});

test('AC1 + AC6: the trial Subscription page says WhatsApp is not available and offers no top-up', async () => {
  const quota = new SubscriptionQuotaCard(page);
  await quota.open();
  await expect(quota.trialNotice()).toHaveText('WhatsApp notifications are not available on trial plans.');
  await expect(quota.requestButton()).toHaveCount(0);
});

test('AC9: each notification kind has its own toggle and the choice persists', async () => {
  const settings = new CampusNotificationSettings(page);
  await settings.open();
  // Default-agnostic (the default itself is covered by notifications-default-off.spec.ts): flip each toggle
  // independently and check the choice survives a reload and reaches the API.
  await settings.setEnabled('Result published', true);
  await settings.setEnabled('Fee dues', false);
  await page.reload();
  await settings.open();
  await expect(settings.toggle('Fee dues')).not.toBeChecked();
  await expect(settings.toggle('Result published')).toBeChecked();
  const prefs = await (await owner.api.get('campus/notification-preferences')).json();
  expect(prefs.items.map((i: { kind: number; enabled: boolean }) => [i.kind, i.enabled])).toEqual([[1, true], [6, false], [2, false]]);
  await settings.setEnabled('Fee dues', true);
});

test('AC6: after activation the card shows included / extra / used / remaining and the reset date', async () => {
  await ops.activate(await quotaDb.subscriptionId(owner.tenantId));
  // QuotaManager caches the entitlement for 60 s (see quota-activation-cache.spec.ts).
  await expect.poll(async () => (await (await owner.api.get('subscription/quota')).json()).included, { timeout: 90_000, intervals: [5_000] }).toBe(100);
  const quota = new SubscriptionQuotaCard(page);
  await quota.open();
  expect(await quota.stats()).toEqual({ included: 100, extra: 0, used: 0, remaining: 100 });
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  await expect(quota.card).toContainText(`Monthly quota resets on ${reset}.`);
});

test('AC3: the owner requests a package from the card and sees it pending', async () => {
  const quota = new SubscriptionQuotaCard(page);
  await quota.open();
  await quota.requestPackage(pkg);
  await expect(quota.pendingNotice()).toHaveText('A request for 150 messages (Rs 120) is pending approval.');
  await expect(quota.requestButton()).toHaveCount(0);
});

test('AC3 + AC6: once approved the add-on shows as extra quota with its expiry', async () => {
  const id = (await ops.requests('Requested')).find((r) => r.tenantId === owner.tenantId)!.id;
  expect((await ops.approve(id)).status()).toBe(200);
  const quota = new SubscriptionQuotaCard(page);
  await quota.open();
  expect(await quota.stats()).toEqual({ included: 100, extra: 150, used: 0, remaining: 250 });
  await expect(quota.addOnsHeading()).toBeVisible();
});

test('Q1 z94x8ebv8f: the alert shows as soon as Remaining reaches 0, before any message was skipped', async () => {
  // DB PRECONDITION (own campus): every allocation Used = Granted, NO skipped rows.
  await quotaDb.simulateExhausted(owner.tenantId, 100, 0);
  expect(await (await owner.api.get('subscription/quota/status')).json()).toEqual({ isExhausted: true, skippedThisMonth: 0 });
  await page.goto('/');
  const shell = new QuotaShellNotice(page);
  await expect(shell.notice).toBeVisible({ timeout: 30_000 });
  await expect(shell.notice).toContainText('WhatsApp quota exhausted.');
  await expect(shell.notice).not.toContainText('not sent this month');
  await expect(shell.requestLink()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('q1-alert-at-remaining-zero.png') });
});

test('AC10: an exhausted quota shows a non-dismissible alert whose button leads to the request', async () => {
  await quotaDb.simulateExhausted(owner.tenantId, 100, 2);
  await page.goto('/');
  const shell = new QuotaShellNotice(page);
  await expect(shell.notice).toBeVisible({ timeout: 30_000 });
  await expect(shell.notice).toContainText('WhatsApp quota exhausted — 2 messages not sent this month.');
  await expect(shell.closeButtons()).toHaveCount(0);
  await shell.requestLink().click();
  await expect(page).toHaveURL(/\/setup\/subscription$/);
  const quota = new SubscriptionQuotaCard(page);
  await quota.expectLoaded();
  await expect(quota.skippedNotice()).toHaveText('2 messages could not be sent this month because the quota was exhausted.');
  expect((await quota.stats()).remaining).toBe(0);
  await expect(quota.requestButton()).toBeVisible();
});

test('AC10: after a top-up is approved the alert is gone (full reload)', async () => {
  const quota = new SubscriptionQuotaCard(page);
  await quota.requestPackage(pkg);
  const id = (await ops.requests('Requested')).find((r) => r.tenantId === owner.tenantId)!.id;
  expect((await ops.approve(id)).status()).toBe(200);
  await page.goto('/');
  const shell = new QuotaShellNotice(page);
  await expect(shell.homeHeading()).toBeVisible({ timeout: 30_000 });
  await expect(shell.notice).toHaveCount(0);
});

test('AC10: the alert does not outlive an approval while the user keeps navigating in the app', async () => {
  await quotaDb.simulateExhausted(owner.tenantId, 100, 1);
  await page.goto('/');
  const shell = new QuotaShellNotice(page);
  await expect(shell.notice).toBeVisible({ timeout: 30_000 });

  // In-app only from here on: the notice's link → Subscription → request → (operator approves) → Home.
  await shell.requestLink().click();
  const quota = new SubscriptionQuotaCard(page);
  await quota.expectLoaded();
  await quota.requestPackage(pkg);
  const id = (await ops.requests('Requested')).find((r) => r.tenantId === owner.tenantId)!.id;
  expect((await ops.approve(id)).status()).toBe(200);
  await shell.goHomeInApp();
  await expect(shell.homeHeading()).toBeVisible();
  await expect(shell.notice, 'stale "quota exhausted" alert after the add-on was approved').toHaveCount(0);
});

test('Q1 z94x8ebv8f: an exhaustion that happens mid-session shows on the next in-app navigation (no reload)', async () => {
  // State from the previous test: the add-on was approved, the alert is gone. Exhaust again (no new skips)
  // while the user sits on Home, then navigate in-app.
  const shell = new QuotaShellNotice(page);
  await expect(shell.notice).toHaveCount(0);
  await quotaDb.simulateExhausted(owner.tenantId, 100, 0);
  await page.getByRole('link', { name: 'Setup' }).first().click();
  await expect(shell.notice, 'alert after an in-app navigation').toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: test.info().outputPath('q1-alert-after-spa-navigation.png') });
});
