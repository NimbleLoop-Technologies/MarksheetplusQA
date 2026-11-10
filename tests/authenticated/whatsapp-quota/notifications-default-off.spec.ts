/**
 * PR 538 cycle 2 — NEW acceptance criteria from Umair (2026-11-10), z94x8e7hp4:
 *   N1. WhatsApp notifications are OFF by default for all users (new and existing campuses).
 *   N2. The user must explicitly enable WhatsApp notifications (no implicit enable).
 *   N3. The UI says WhatsApp credits are paid, at least when enabling them.
 *
 * These specs assert the REQUIRED behaviour, so they fail until it is built. At PR 554 head the model is
 * opt-OUT: CampusNotificationPreference.DisabledKinds, and a campus with no preference document is
 * "all enabled" (NotificationsRepository.IsNotificationKindEnabledAsync, "D7: missing document = all enabled").
 * Existing campuses have no document either, so they take the same code path as the brand-new campus here.
 *
 * Self-seeding: one fresh owner + campus, serial. The campus is never saved to before the Worker check so
 * that check sees a campus that "never touched the settings". DB PRECONDITION: queued
 * ScheduledWhatsAppMessage rows on this campus (as the result/fee producers would write them).
 */
import { test, expect, type Page } from '@playwright/test';
import { BackOffice, newCampusOwner, quotaDb, signInToWebApp, WA_KIND, WA_STATUS, type CampusOwner } from '../../../fixtures/quota';
import { CampusNotificationSettings } from '../../../pages/setup/CampusNotificationSettings';

test.use({ ignoreHTTPSErrors: true });

/** Copy that tells the school WhatsApp messages cost money / use paid credits. */
const PAID_NOTICE = /paid|credits?|charg|cost|purchase|per message|billed/i;

let owner: CampusOwner;
let ops: BackOffice;
let page: Page;

test.beforeAll(async ({ browser }) => {
  owner = await newCampusOwner();
  ops = await BackOffice.signIn();
  page = await browser.newPage({ ignoreHTTPSErrors: true });
  await signInToWebApp(page, owner);
});

test.afterAll(async () => {
  await ops?.dispose();
  await owner?.api.dispose();
  await page?.close();
});

const prefs = async () => {
  const res = await owner.api.get('campus/notification-preferences');
  expect(res.status()).toBe(200);
  return (await res.json()).items as Array<{ kind: number; label: string; enabled: boolean }>;
};

test('N1 + N2 + N3: WhatsApp notifications are off until the school explicitly enables them, with a paid-credits notice', async () => {
  // One flow on one campus, soft assertions: every criterion is checked and reported even when an earlier one fails.
  test.setTimeout(12 * 60_000);
  await test.step('N1: a brand-new campus has every WhatsApp notification OFF (API default)', async () => {
    expect.soft(await quotaDb.notificationPreference(owner.tenantId), 'no preference document yet').toBeNull();
    const items = await prefs();
    expect.soft(items.map((i) => [i.kind, i.enabled]), 'GET campus/notification-preferences on a campus that never saved').toEqual([
      [WA_KIND.ResultPublished, false],
      [WA_KIND.PendingDues, false],
    ]);
  });

  await test.step('N1: Campus Settings shows the WhatsApp toggles OFF on a brand-new campus', async () => {
    const settings = new CampusNotificationSettings(page);
    await settings.open();
    await page.locator('[data-whatsapp-notifications]').screenshot({ path: test.info().outputPath('newac-campus-settings-default.png') });
    await expect.soft(settings.toggle('Result published')).not.toBeChecked();
    await expect.soft(settings.toggle('Fee dues')).not.toBeChecked();
  });

  await test.step('N3: the WhatsApp notifications section says the messages use paid credits', async () => {
    const settings = new CampusNotificationSettings(page);
    await settings.open();
    await expect.soft(page.locator('[data-whatsapp-notifications]'), 'paid-credits notice in the WhatsApp notifications section').toContainText(PAID_NOTICE);
  });

  await test.step('N1 + N2: the Worker does not send a metered WhatsApp for an active campus that never enabled them', async () => {
    await ops.activate(await quotaDb.subscriptionId(owner.tenantId));
    // Wait out the 60 s entitlement cache so a skip can only be the toggle, not "TrialAccount".
    await expect.poll(async () => (await (await owner.api.get('subscription/quota')).json()).included, { timeout: 90_000, intervals: [5_000] }).toBe(100);
    await page.waitForTimeout(65_000);
    expect.soft(await quotaDb.notificationPreference(owner.tenantId), 'campus still never saved its preferences').toBeNull();

    const result = await quotaDb.queueWhatsApp(owner.tenantId, WA_KIND.ResultPublished);
    const dues = await quotaDb.queueWhatsApp(owner.tenantId, WA_KIND.PendingDues);
    const resultRow = await quotaDb.waitProcessed(result);
    const duesRow = await quotaDb.waitProcessed(dues);
    const used = (await quotaDb.allocations(owner.tenantId)).reduce((n, a) => n + a.Used, 0);
    expect.soft([resultRow.Status, resultRow.SkipReason], `Result row → status ${resultRow.Status} ${resultRow.SkipReason}; credits used ${used}`).toEqual([WA_STATUS.Skipped, 'DisabledByCampus']);
    expect.soft([duesRow.Status, duesRow.SkipReason], `Fee row → status ${duesRow.Status} ${duesRow.SkipReason}`).toEqual([WA_STATUS.Skipped, 'DisabledByCampus']);
    expect.soft(used, 'no paid credit spent without consent').toBe(0);
  });

  await test.step('N2 + N3: enabling a WhatsApp notification is an explicit choice that warns about paid credits first', async () => {
    const settings = new CampusNotificationSettings(page);
    await settings.open();
    const toggle = settings.toggle('Result published');
    // Make sure it is OFF first (the default may still be ON at this head); the save is the user's own.
    if (await toggle.isChecked()) await settings.setEnabled('Result published', false);
    await toggle.click();
    // A confirmation dialog or an inline notice about paid credits must appear when switching ON.
    const dialog = page.getByRole('dialog');
    const warned = page.locator('[data-whatsapp-notifications]').getByText(PAID_NOTICE).or(dialog.getByText(PAID_NOTICE));
    const shown = await warned.first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
    await page.screenshot({ path: test.info().outputPath('newac-enable-result-published.png'), fullPage: true });
    // Leave the campus with Result published explicitly ON (confirm the dialog if there is one).
    if (await dialog.count()) await dialog.getByRole('button', { name: /enable|confirm|continue|yes|ok/i }).first().click().catch(() => undefined);
    expect.soft(shown, 'paid-credits warning when enabling a WhatsApp notification').toBe(true);
  });

  await test.step('N2: once the owner explicitly enables Result published, results are sent (and charged)', async () => {
    const put = await owner.api.put('campus/notification-preferences', { data: { disabledKinds: [WA_KIND.PendingDues] } });
    expect(put.status()).toBe(200);
    const items = await prefs();
    expect(items.find((i) => i.kind === WA_KIND.ResultPublished)?.enabled).toBe(true);
    const result = await quotaDb.queueWhatsApp(owner.tenantId, WA_KIND.ResultPublished);
    const row = await quotaDb.waitProcessed(result);
    expect(row.Status).toBe(WA_STATUS.Sent);
    expect(row.QuotaAllocationId).toBeTruthy();
  });
});
