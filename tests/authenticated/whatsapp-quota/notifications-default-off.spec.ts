/**
 * PR 538 — WhatsApp notifications are opt-in and the school is told credits are paid (z94x8e7hp4).
 * Cycle 3 retest of the PR 554 fix b52eeae6:
 *   z94x8ecp90 (high) — OFF by default for NEW and EXISTING campuses; an unsaved setting = off; the school
 *                       enables a kind explicitly; saving writes EnabledKinds and drops the legacy DisabledKinds.
 *   z94x8ecp94 (high) — an INLINE note next to the toggles says WhatsApp credits are paid. It is visible
 *                       without any click, and switching a toggle ON opens NO confirm dialog (PO decision).
 *
 * Self-seeding, serial, two fresh campuses:
 *   - "new"    — never saves its preferences until the explicit-enable step.
 *   - "legacy" — stands in for an EXISTING campus at release. DB PRECONDITION: a preference document in the
 *                pre-opt-in shape `{TenantId, DisabledKinds: []}` (old model: "every kind on") is inserted
 *                straight into Mongo right after the campus is created (quotaDb.insertLegacyPreference).
 * Worker checks also use DB PRECONDITIONS on those two campuses only: queued ScheduledWhatsAppMessage rows,
 * written as the result / fee producers would.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  BackOffice, evidencePath, newCampusOwner, quotaDb, signInToWebApp, WA_KIND, WA_STATUS, WEBAPP, type CampusOwner,
} from '../../../fixtures/quota';
import { CampusNotificationSettings } from '../../../pages/setup/CampusNotificationSettings';

test.use({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial' });

const PAID_TITLE = 'WhatsApp credits are paid';
const PAID_NOTE = /uses one paid credit from your campus's WhatsApp quota\. Notifications stay off until you switch them on/;
const ALL_OFF = [[WA_KIND.ResultPublished, false], [WA_KIND.PendingDues, false]];

let fresh: CampusOwner;
let legacy: CampusOwner;
let ops: BackOffice;
let page: Page;

test.beforeAll(async ({ browser }) => {
  fresh = await newCampusOwner();
  legacy = await newCampusOwner();
  await quotaDb.insertLegacyPreference(legacy.tenantId, []);
  ops = await BackOffice.signIn();
  page = await browser.newPage({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
  await signInToWebApp(page, fresh);
});

test.afterAll(async () => {
  await ops?.dispose();
  await fresh?.api.dispose();
  await legacy?.api.dispose();
  await page?.close();
});

const prefs = async (owner: CampusOwner) => {
  const res = await owner.api.get('campus/notification-preferences');
  expect(res.status()).toBe(200);
  return ((await res.json()).items as Array<{ kind: number; enabled: boolean }>).map((i) => [i.kind, i.enabled]);
};
const paidNote = (p: Page) => p.locator('[data-whatsapp-notifications] [data-notifications-paid-note]');

test('z94x8ecp90 (a): a brand-new campus reads every WhatsApp notification OFF (no document = off)', async () => {
  expect(await quotaDb.notificationPreference(fresh.tenantId), 'no preference document yet').toBeNull();
  expect(await prefs(fresh)).toEqual(ALL_OFF);
});

test('z94x8ecp90 (b): an EXISTING campus with a legacy {DisabledKinds: []} ("all on" in the old model) reads all OFF', async () => {
  const doc = await quotaDb.notificationPreference(legacy.tenantId);
  expect(doc, 'DB precondition in place').toMatchObject({ DisabledKinds: [] });
  expect(doc).not.toHaveProperty('EnabledKinds');
  expect(await prefs(legacy)).toEqual(ALL_OFF);
});

test('z94x8ecp90 (a) + z94x8ecp94: Campus Settings shows the toggles OFF and the paid-credits note with no interaction', async () => {
  const settings = new CampusNotificationSettings(page);
  await settings.open();
  await expect(settings.toggle('Result published')).not.toBeChecked();
  await expect(settings.toggle('Fee dues')).not.toBeChecked();
  // Visible on load: nothing was clicked on this page.
  await expect(paidNote(page)).toBeVisible();
  await expect(paidNote(page)).toContainText(PAID_TITLE);
  await expect(paidNote(page)).toContainText(PAID_NOTE);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('[data-whatsapp-notifications]').screenshot({ path: evidencePath('c3-ecp90-ecp94-new-campus-toggles-off-paid-note.png') });
});

test('z94x8ecp90 (b): the existing campus also shows both toggles OFF in Campus Settings', async ({ browser }) => {
  const legacyPage = await browser.newPage({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
  try {
    await signInToWebApp(legacyPage, legacy);
    const settings = new CampusNotificationSettings(legacyPage);
    await settings.open();
    await expect(settings.toggle('Result published')).not.toBeChecked();
    await expect(settings.toggle('Fee dues')).not.toBeChecked();
    await expect(paidNote(legacyPage)).toBeVisible();
    await legacyPage.locator('[data-whatsapp-notifications]').screenshot({ path: evidencePath('c3-ecp90-legacy-campus-toggles-off.png') });
    // Only reading the page must not rewrite the legacy document.
    expect(await quotaDb.notificationPreference(legacy.tenantId)).toMatchObject({ DisabledKinds: [] });
  } finally {
    await legacyPage.close();
  }
});

test('z94x8ecp90 (a) + (b): the Worker skips Result and Fee messages for both active campuses and charges nothing', async () => {
  test.setTimeout(12 * 60_000);
  for (const owner of [fresh, legacy]) await ops.activate(await quotaDb.subscriptionId(owner.tenantId));
  for (const owner of [fresh, legacy]) {
    await expect.poll(async () => (await (await owner.api.get('subscription/quota')).json()).included, { timeout: 90_000, intervals: [5_000] }).toBe(100);
  }
  // Wait out the Worker's 60 s entitlement cache so a skip can only be the toggle, not "TrialAccount".
  await page.waitForTimeout(65_000);

  const keys = {
    freshResult: await quotaDb.queueWhatsApp(fresh.tenantId, WA_KIND.ResultPublished),
    freshDues: await quotaDb.queueWhatsApp(fresh.tenantId, WA_KIND.PendingDues),
    legacyResult: await quotaDb.queueWhatsApp(legacy.tenantId, WA_KIND.ResultPublished),
    legacyDues: await quotaDb.queueWhatsApp(legacy.tenantId, WA_KIND.PendingDues),
  };
  for (const [label, key] of Object.entries(keys)) {
    const row = await quotaDb.waitProcessed(key);
    expect(row, label).toMatchObject({ Status: WA_STATUS.Skipped, SkipReason: 'DisabledByCampus', QuotaAllocationId: null });
  }
  expect(await quotaDb.creditsUsed(fresh.tenantId), 'credits used, new campus').toBe(0);
  expect(await quotaDb.creditsUsed(legacy.tenantId), 'credits used, existing campus').toBe(0);
  expect(await quotaDb.notificationPreference(fresh.tenantId), 'the new campus still never saved').toBeNull();
});

test('z94x8ecp94 + z94x8ecp90 (c): switching Result published ON in the UI opens no dialog, saves EnabledKinds, and the next result is sent and charged', async () => {
  test.setTimeout(10 * 60_000);
  const settings = new CampusNotificationSettings(page);
  await settings.open();
  await settings.setEnabled('Result published', true);
  // No confirm dialog, before or after the save; the inline note is still there.
  await page.waitForTimeout(1_000);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(settings.toggle('Result published')).toBeChecked();
  await expect(settings.toggle('Fee dues')).not.toBeChecked();
  await expect(paidNote(page)).toBeVisible();
  await page.locator('[data-whatsapp-notifications]').screenshot({ path: evidencePath('c3-ecp94-enable-result-no-dialog.png') });

  const doc = await quotaDb.notificationPreference(fresh.tenantId);
  expect(doc).toMatchObject({ EnabledKinds: [WA_KIND.ResultPublished] });
  expect(doc).not.toHaveProperty('DisabledKinds');
  expect(await prefs(fresh)).toEqual([[WA_KIND.ResultPublished, true], [WA_KIND.PendingDues, false]]);

  // The existing campus saves too (the body the page sends: the kinds left OFF); the legacy list is removed.
  expect((await legacy.api.put('campus/notification-preferences', { data: { disabledKinds: [WA_KIND.PendingDues] } })).status()).toBe(200);
  const legacyDoc = await quotaDb.notificationPreference(legacy.tenantId);
  expect(legacyDoc).toMatchObject({ EnabledKinds: [WA_KIND.ResultPublished] });
  expect(legacyDoc, 'first opt-in save drops the legacy DisabledKinds').not.toHaveProperty('DisabledKinds');

  const freshResult = await quotaDb.queueWhatsApp(fresh.tenantId, WA_KIND.ResultPublished);
  const freshDues = await quotaDb.queueWhatsApp(fresh.tenantId, WA_KIND.PendingDues);
  const legacyResult = await quotaDb.queueWhatsApp(legacy.tenantId, WA_KIND.ResultPublished);
  const sent = await quotaDb.waitProcessed(freshResult);
  expect(sent.Status, `new campus Result → ${sent.Status} ${sent.SkipReason}`).toBe(WA_STATUS.Sent);
  expect(sent.QuotaAllocationId).toBeTruthy();
  expect(await quotaDb.waitProcessed(freshDues)).toMatchObject({ Status: WA_STATUS.Skipped, SkipReason: 'DisabledByCampus' });
  expect((await quotaDb.waitProcessed(legacyResult)).Status, 'existing campus Result after its explicit save').toBe(WA_STATUS.Sent);
  expect(await quotaDb.creditsUsed(fresh.tenantId), 'one credit for the one sent result').toBe(1);
  expect(await quotaDb.creditsUsed(legacy.tenantId)).toBe(1);
});

test('z94x8ecp90 (d): switching Result published back OFF in the UI stops the next result again', async () => {
  test.setTimeout(10 * 60_000);
  const settings = new CampusNotificationSettings(page);
  await settings.open();
  await settings.setEnabled('Result published', false);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await settings.open();
  await expect(settings.toggle('Result published')).not.toBeChecked();
  const doc = await quotaDb.notificationPreference(fresh.tenantId);
  expect(doc).toMatchObject({ EnabledKinds: [] });
  expect(doc).not.toHaveProperty('DisabledKinds');
  expect(await prefs(fresh)).toEqual(ALL_OFF);

  const row = await quotaDb.waitProcessed(await quotaDb.queueWhatsApp(fresh.tenantId, WA_KIND.ResultPublished));
  expect(row).toMatchObject({ Status: WA_STATUS.Skipped, SkipReason: 'DisabledByCampus', QuotaAllocationId: null });
  expect(await quotaDb.creditsUsed(fresh.tenantId), 'nothing more charged').toBe(1);
});
