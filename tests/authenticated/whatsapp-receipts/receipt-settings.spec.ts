/**
 * PR 555 / CU-z94x8e9yhj — WhatsApp fee receipts: the "Fee receipt" notification toggle (AC3, PO rule:
 * WhatsApp notifications are OFF by default for every campus, new and existing; the user enables them; an
 * inline note next to the toggles says WhatsApp credits are paid).
 *
 * Self-seeding, serial, ONE fresh campus. Its preference document is rewritten between tests to stand in for
 * the shapes an existing campus can have at release (DB PRECONDITIONS on that campus only, Mongo
 * `campusnotificationpreferences`):
 *   - none (brand-new campus),
 *   - opt-in document saved before PR 555: `{EnabledKinds: [1, 2]}` (Result + Dues switched on),
 *   - legacy pre-opt-in documents: `{DisabledKinds: []}` and `{DisabledKinds: [1]}` (no EnabledKinds).
 */
import { test, expect, type Page } from '@playwright/test';
import { evidencePath, mongo, newCampusOwner, quotaDb, signInToWebApp, WA_KIND, WEBAPP, type CampusOwner } from '../../../fixtures/quota';
import { CampusNotificationSettings } from '../../../pages/setup/CampusNotificationSettings';

test.use({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial' });

const FEE_RECEIPT = 'Fee receipt';
const FEE_RECEIPT_DESCRIPTION = 'Sent to parents after a fee payment is recorded.';
const PAID_NOTE = /uses one paid credit from your campus's WhatsApp quota\. Notifications stay off until you switch them on/;

let owner: CampusOwner;
let page: Page;

test.beforeAll(async ({ browser }) => {
  owner = await newCampusOwner('qa555s');
  page = await browser.newPage({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
  await signInToWebApp(page, owner);
});

test.afterAll(async () => {
  await owner?.api.dispose();
  await page?.close();
});

type Item = { kind: number; label: string; description: string; enabled: boolean };
const items = async (): Promise<Item[]> => {
  const res = await owner.api.get('campus/notification-preferences');
  expect(res.status()).toBe(200);
  return (await res.json()).items;
};
const enabledOf = async () => Object.fromEntries((await items()).map((i) => [i.kind, i.enabled]));
/** DB PRECONDITION (own campus only): replaces the campus's preference document. */
const replacePreference = async (doc: Record<string, unknown> | null) => {
  const t = JSON.stringify(owner.tenantId);
  await mongo(`db.campusnotificationpreferences.deleteMany({TenantId: ${t}})`);
  if (doc) {
    await mongo(`db.campusnotificationpreferences.insertOne(Object.assign({ _id: new ObjectId(), TenantId: ${t}, CreatedBy: 'qa555', CreatedDate: new Date() }, ${JSON.stringify(doc)}))`);
  }
};
const paidNote = (p: Page) => p.locator('[data-whatsapp-notifications] [data-notifications-paid-note]');
const kindRow = (p: Page, kind: number) => p.locator(`[data-whatsapp-notifications] [data-notification-kind="${kind}"]`);

test('AC3: GET preferences lists "Fee receipt" (kind 6) with its description, OFF on a brand-new campus', async () => {
  expect(await quotaDb.notificationPreference(owner.tenantId), 'no preference document yet').toBeNull();
  const list = await items();
  expect(list.map((i) => i.kind)).toEqual([WA_KIND.ResultPublished, WA_KIND.FeePaymentReceipt, WA_KIND.PendingDues]);
  expect(list.find((i) => i.kind === WA_KIND.FeePaymentReceipt)).toEqual({
    kind: WA_KIND.FeePaymentReceipt, label: FEE_RECEIPT, description: FEE_RECEIPT_DESCRIPTION, enabled: false,
  });
  expect(list.every((i) => !i.enabled)).toBe(true);
});

test('AC3: Campus Settings shows the "Fee receipt" toggle OFF with the paid-credits note inline, no dialog', async () => {
  const settings = new CampusNotificationSettings(page);
  await settings.open();
  await expect(settings.toggle(FEE_RECEIPT)).toBeVisible();
  await expect(settings.toggle(FEE_RECEIPT)).not.toBeChecked();
  await expect(kindRow(page, WA_KIND.FeePaymentReceipt)).toContainText(FEE_RECEIPT_DESCRIPTION);
  await expect(kindRow(page, WA_KIND.FeePaymentReceipt).locator('[data-toggle-caption]')).toHaveText('Off');
  await expect(paidNote(page)).toBeVisible();
  await expect(paidNote(page)).toContainText(PAID_NOTE);
  // The note sits in the same card as the toggles, directly above them (inline, not a dialog or another page).
  const noteBox = (await paidNote(page).boundingBox())!;
  const toggleBox = (await kindRow(page, WA_KIND.FeePaymentReceipt).boundingBox())!;
  expect(toggleBox.y).toBeGreaterThan(noteBox.y);
  expect(toggleBox.y - (noteBox.y + noteBox.height)).toBeLessThan(250);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('[data-whatsapp-notifications]').screenshot({ path: evidencePath('ac3-new-campus-fee-receipt-off.png') });
});

test('AC3: an existing campus that had switched Result + Dues ON ({EnabledKinds:[1,2]}) reads Fee receipt OFF (API and UI)', async () => {
  await replacePreference({ EnabledKinds: [WA_KIND.ResultPublished, WA_KIND.PendingDues] });
  expect(await enabledOf()).toEqual({ [WA_KIND.ResultPublished]: true, [WA_KIND.FeePaymentReceipt]: false, [WA_KIND.PendingDues]: true });
  const settings = new CampusNotificationSettings(page);
  await page.reload();
  await settings.open();
  await expect(settings.toggle('Result published')).toBeChecked();
  await expect(settings.toggle('Fee dues')).toBeChecked();
  await expect(settings.toggle(FEE_RECEIPT)).not.toBeChecked();
  await page.locator('[data-whatsapp-notifications]').screenshot({ path: evidencePath('ac3-existing-campus-1-2-on-fee-receipt-off.png') });
});

test('AC3: legacy pre-opt-in documents ({DisabledKinds: []} / {DisabledKinds: [1]}) read Fee receipt OFF', async () => {
  for (const disabled of [[], [WA_KIND.ResultPublished]]) {
    await replacePreference({ DisabledKinds: disabled });
    const enabled = await enabledOf();
    expect(enabled[WA_KIND.FeePaymentReceipt], `legacy DisabledKinds=${JSON.stringify(disabled)}`).toBe(false);
    expect(Object.values(enabled).every((e) => !e)).toBe(true);
  }
});

test('R2: a client that does not know Fee receipt (PUT disabledKinds=[1], the pre-PR page body) must not switch Fee receipt ON', async () => {
  test.fail(true, 'R2 open: UpdateNotificationPreferences stores the complement of DisabledKinds');
  // State before: an existing campus with Result + Dues ON and Fee receipt OFF.
  await replacePreference({ EnabledKinds: [WA_KIND.ResultPublished, WA_KIND.PendingDues] });
  // A Campus Settings page loaded before the deploy (two toggles) sends every OFF toggle; the user switches Result OFF.
  const put = await owner.api.put('campus/notification-preferences', { data: { disabledKinds: [WA_KIND.ResultPublished] } });
  expect(put.status()).toBe(200);
  const doc = await quotaDb.notificationPreference(owner.tenantId);
  console.log(`[R2] stored after PUT disabledKinds=[1]: ${JSON.stringify(doc?.EnabledKinds)}`);
  // Correct: the user never touched Fee receipt, so it stays OFF (no paid credits spent without consent).
  expect((await enabledOf())[WA_KIND.FeePaymentReceipt], 'Fee receipt silently switched ON').toBe(false);
});

test('AC3: switching Fee receipt ON in the UI saves EnabledKinds with 6 only and survives a reload; OFF again removes it', async () => {
  await replacePreference(null);
  const settings = new CampusNotificationSettings(page);
  await page.reload();
  await settings.open();
  await settings.setEnabled(FEE_RECEIPT, true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await quotaDb.notificationPreference(owner.tenantId)).toMatchObject({ EnabledKinds: [WA_KIND.FeePaymentReceipt] });
  await page.reload();
  await settings.open();
  await expect(settings.toggle(FEE_RECEIPT)).toBeChecked();
  await expect(settings.toggle('Result published')).not.toBeChecked();
  await expect(settings.toggle('Fee dues')).not.toBeChecked();
  await expect(kindRow(page, WA_KIND.FeePaymentReceipt).locator('[data-toggle-caption]')).toHaveText('On');
  await page.locator('[data-whatsapp-notifications]').screenshot({ path: evidencePath('ac3-fee-receipt-on-after-reload.png') });

  await settings.setEnabled(FEE_RECEIPT, false);
  expect(await quotaDb.notificationPreference(owner.tenantId)).toMatchObject({ EnabledKinds: [] });
});

test('edge: PUT preferences with an unknown / non-metered kind is a 400, not a 500', async () => {
  for (const body of [{ disabledKinds: [99] }, { disabledKinds: [WA_KIND.StaffInvite] }, { disabledKinds: null }, { disabledKinds: ['abc'] }, {}]) {
    const res = await owner.api.put('campus/notification-preferences', { data: body });
    expect(res.status(), `PUT ${JSON.stringify(body)}`).toBe(400);
  }
  const ok = await owner.api.put('campus/notification-preferences', { data: { disabledKinds: [6, 6, 1, 2] } });
  expect(ok.status()).toBe(200);
  expect(Object.values(await enabledOf()).every((e) => !e)).toBe(true);
});
