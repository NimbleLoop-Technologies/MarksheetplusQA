/**
 * PR 561 (CU-86ey2erpk UI migration, QA fixes by Dan, head c0ce541d) — branch cycle 1.
 * z94x8ecvet: POS tender choice at normal size (inline radios, sentence case).
 * z94x8eb5wf: custom subjects listed as read-only rows with a "Custom" badge; rename = remove + add.
 * z94x8eber8 #2: a struck-off student's profile header names the class they left, as the Admission Register does.
 * Runs as the seeded CI owner (authenticated project); every test makes its own class / student / item.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import path from 'node:path';
import { createClass, ownerApi, profile, quickAddStudent, stockedItem, strikeOff, subjectsView, letters } from '../../../fixtures/ui-migration';

const EVIDENCE = process.env.QA_EVIDENCE_DIR;
const shot = async (page: Page, name: string, target?: Locator) => {
  if (!EVIDENCE) return;
  await (target ?? page).screenshot({ path: path.join(EVIDENCE, `${name}.png`) });
};

async function openPayment(page: Page, itemName: string, sku: string): Promise<Locator> {
  await page.goto('/bookshop/point-of-sale');
  await page.locator('[data-action="new-sale"]').click();
  const search = page.locator('#pos-search');
  await search.fill(sku);
  await page.getByRole('option', { name: new RegExp(itemName, 'i') }).first().click();
  await page.locator('[data-pos-cart-trigger]').click();
  await page.locator('[data-pos-cart]').getByRole('button', { name: 'Take payment' }).click();
  const drawer = page.locator('[data-pos-drawer="payment"]');
  await expect(drawer.locator('[data-payment-body]')).toBeVisible();
  return drawer;
}

test.describe('PR 561 — z94x8ecvet POS tender size', () => {
  test('ECVET-TENDER-SIZE: Cash / Charge to fee account are normal-size inline radios in sentence case @smoke', async ({ page }) => {
    const api = await ownerApi();
    const item = await stockedItem(api);
    const drawer = await openPayment(page, item.name, item.sku);
    const cash = drawer.getByRole('radio', { name: 'Cash', exact: true });
    const fee = drawer.getByRole('radio', { name: 'Charge to fee account', exact: true });
    await expect(cash).toBeChecked();
    await expect(fee).not.toBeChecked();
    for (const id of ['pos-tender-cash', 'pos-tender-fee-account']) {
      const label = drawer.locator(`label[for="${id}"]`);
      await expect(label).toBeVisible();
      expect(await label.evaluate((el) => getComputedStyle(el).textTransform)).not.toBe('uppercase');
    }
    await expect(drawer.locator('label[for="pos-tender-cash"]')).toHaveText('Cash');
    await expect(drawer.locator('label[for="pos-tender-fee-account"]')).toHaveText('Charge to fee account');
    // Normal size: the whole choice is one short line, not two half-width tiles.
    const group = drawer.locator('#pos-tender').or(drawer.locator('fieldset').filter({ has: cash })).first();
    const body = await drawer.locator('[data-payment-body]').boundingBox();
    const cashBox = await drawer.locator('label[for="pos-tender-cash"]').boundingBox();
    const feeBox = await drawer.locator('label[for="pos-tender-fee-account"]').boundingBox();
    expect(cashBox!.height, 'Cash label height').toBeLessThan(40);
    expect(feeBox!.height, 'Fee label height').toBeLessThan(40);
    expect(Math.abs(cashBox!.y - feeBox!.y), 'both on one row').toBeLessThan(8);
    expect(cashBox!.width + feeBox!.width, 'not stretched across the drawer').toBeLessThan(body!.width * 0.8);
    expect(await drawer.locator('[data-payment-body] [class*="grid-cols"]').count()).toBe(0);
    await shot(page, 'ecvet-desktop-cash', drawer);
    // Switching works: fee account asks to link a student, Cash brings the amount back.
    await drawer.locator('label[for="pos-tender-fee-account"]').click();
    await expect(fee).toBeChecked();
    await expect(drawer.locator('[data-fee-needs-student]')).toBeVisible();
    await expect(drawer.locator('#amountReceived')).toHaveCount(0);
    await shot(page, 'ecvet-desktop-fee', drawer);
    await drawer.locator('label[for="pos-tender-cash"]').click();
    await expect(cash).toBeChecked();
    await expect(drawer.locator('#amountReceived')).toBeVisible();
    void group;
    await api.dispose();
  });

  test('ECVET-CASH-SALE: a cash sale still completes from the inline tender', async ({ page }) => {
    const api = await ownerApi();
    const item = await stockedItem(api, 250);
    const drawer = await openPayment(page, item.name, item.sku);
    await drawer.locator('[data-action="exact-amount"]').click();
    await drawer.locator('[data-action="confirm-sale"]').click();
    await expect(page.locator('[data-pos-modal="sale-complete"]')).toBeVisible({ timeout: 20_000 });
    await api.dispose();
  });

  test('ECVET-FEE-SALE: Charge to fee account with a linked student completes the sale', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const pupil = await quickAddStudent(api, cls.id);
    const item = await stockedItem(api, 200);
    const drawer = await openPayment(page, item.name, item.sku);
    await drawer.locator('label[for="pos-tender-fee-account"]').click();
    await expect(drawer.locator('[data-fee-needs-student]')).toBeVisible();
    await drawer.locator('[data-action="back-to-cart"]').click();
    await page.locator('[data-pos-cart] [data-action="link-student"]').click();
    const link = page.locator('[data-pos-modal="link-student"]');
    await link.locator('#studentAdmissionNumber').fill(pupil.admissionId);
    await expect(link.locator('[data-resolved-student]')).toBeVisible({ timeout: 15_000 });
    await link.locator('[data-action="confirm-link-student"]').click();
    await expect(link.locator('#studentAdmissionNumber')).toBeHidden();
    const cart = page.locator('[data-pos-cart]');
    if (!(await cart.getByRole('button', { name: 'Take payment' }).isVisible())) await page.locator('[data-pos-cart-trigger]').click();
    await cart.getByRole('button', { name: 'Take payment' }).click();
    await expect(drawer.locator('[data-payment-body]')).toBeVisible();
    await drawer.locator('label[for="pos-tender-fee-account"]').click();
    await expect(drawer.locator('[data-fee-student]')).toContainText(pupil.fullName);
    await shot(page, 'ecvet-fee-linked', drawer);
    await drawer.locator('[data-action="confirm-sale"]').click();
    await expect(page.locator('[data-pos-modal="sale-complete"]')).toBeVisible({ timeout: 20_000 });
    await api.dispose();
  });

  test('ECVET-KEYBOARD: arrow keys move between the two tenders', async ({ page }) => {
    const api = await ownerApi();
    const item = await stockedItem(api);
    const drawer = await openPayment(page, item.name, item.sku);
    const cash = drawer.getByRole('radio', { name: 'Cash', exact: true });
    await cash.focus();
    await page.keyboard.press('ArrowRight');
    await expect(drawer.getByRole('radio', { name: 'Charge to fee account', exact: true })).toBeChecked();
    await page.keyboard.press('ArrowLeft');
    await expect(cash).toBeChecked();
    await api.dispose();
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
    test('ECVET-PHONE: on a 375 px phone both tenders fit on screen and can be tapped', async ({ page }) => {
      const api = await ownerApi();
      const item = await stockedItem(api);
      await page.goto('/bookshop/point-of-sale');
      await page.locator('[data-action="new-sale"]').click();
      await page.locator('#pos-search').fill(item.sku);
      await page.getByRole('option', { name: new RegExp(item.name, 'i') }).first().click();
      await page.locator('[data-pos-cart-trigger]').click();
      await page.locator('[data-pos-cart]').getByRole('button', { name: 'Take payment' }).click();
      const drawer = page.locator('[data-pos-drawer="payment"]');
      await expect(drawer.locator('[data-payment-body]')).toBeVisible();
      const fee = drawer.locator('label[for="pos-tender-fee-account"]');
      const box = await fee.boundingBox();
      expect(box!.x + box!.width, 'fits the 375 px screen').toBeLessThanOrEqual(375);
      await shot(page, 'ecvet-phone');
      await fee.tap();
      await expect(drawer.getByRole('radio', { name: 'Charge to fee account', exact: true })).toBeChecked();
      await api.dispose();
    });
  });
});

async function openSubjects(page: Page, className: string): Promise<Locator> {
  await page.goto('/classrooms/classes');
  // Search first: the register pages at 25 rows and every test adds a class to the shared seeded campus.
  await page.getByPlaceholder('Search classes or sections').fill(className);
  await page.getByRole('button', { name: `Subjects of ${className}`, exact: false }).first().click();
  const modal = page.locator('#class-subjects-modal');
  await expect(modal.locator('[data-subjects-body]')).toBeVisible();
  await expect(modal.locator('[data-subjects-skeleton]')).toHaveCount(0);
  return modal;
}
const rowByName = (modal: Locator, name: string) => modal.locator('li[data-subject-row]').filter({ hasText: name });

test.describe('PR 561 — z94x8eb5wf custom subjects', () => {
  test('EB5WF-CUSTOM-ROW: an added custom subject is a plain row with a Custom pill, saved and shown the same on reopen @smoke', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const modal = await openSubjects(page, cls.name);
    const custom = `Robotics ${letters(4)}`;
    await modal.locator('#subject-new').fill(custom);
    await modal.locator('[data-action="add-subject"]').click();
    const row = rowByName(modal, custom);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-subject-kind', /custom/i);
    await expect(row.locator('input')).toHaveCount(0);
    await expect(row).toContainText('Custom');
    await expect(row.getByRole('button', { name: /remove/i })).toBeVisible();
    // No subject in the list is an editable field any more; the only text box is "Add a subject".
    await expect(modal.locator('li[data-subject-row] input[type="text"], li[data-subject-row] input:not([type])')).toHaveCount(0);
    await expect(modal.locator('#subject-new')).toHaveValue('');
    await page.waitForTimeout(400);
    await shot(page, 'eb5wf-added', modal);
    await modal.locator('[data-action="save-subjects"]').click();
    await expect(modal).toBeHidden({ timeout: 15_000 });
    const saved = await subjectsView(api, cls.id);
    expect(saved.map((s) => s.name.toLowerCase())).toContain(custom.toLowerCase());
    const again = await openSubjects(page, cls.name);
    const reopened = rowByName(again, custom);
    await expect(reopened).toHaveCount(1);
    await expect(reopened).toContainText('Custom');
    await expect(reopened.locator('input')).toHaveCount(0);
    await page.waitForTimeout(400);
    await shot(page, 'eb5wf-reopened', again);
    await api.dispose();
  });

  test('EB5WF-DEFAULT-BADGE: default rows keep "Default for grade N", custom rows say Custom', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const modal = await openSubjects(page, cls.name);
    const custom = `Chess ${letters(4)}`;
    await modal.locator('#subject-new').fill(custom);
    await modal.locator('#subject-new').press('Enter');
    await expect(rowByName(modal, custom)).toHaveCount(1);
    const listed = modal.locator('li[data-subject-row]:not([data-subject-kind="suggested"])');
    const kinds = await listed.evaluateAll((els) => els.map((e) => [e.getAttribute('data-subject-kind'), e.textContent?.trim()]));
    for (const [kind, text] of kinds) {
      if (kind === 'default') expect(text).toContain('Default for grade 8');
      if (kind === 'custom') { expect(text).toContain('Custom'); expect(text).not.toContain('Default for grade'); }
    }
    await api.dispose();
  });

  test('EB5WF-RENAME: rename = remove and add again; duplicates are refused case-insensitively', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const modal = await openSubjects(page, cls.name);
    const wrong = `Robotcs ${letters(4)}`;
    await modal.locator('#subject-new').fill(wrong);
    await modal.locator('[data-action="add-subject"]').click();
    await expect(rowByName(modal, wrong)).toHaveCount(1);
    // Duplicate (other case) refused.
    await modal.locator('#subject-new').fill(wrong.toUpperCase());
    await modal.locator('[data-action="add-subject"]').click();
    await expect(rowByName(modal, wrong)).toHaveCount(1);
    await expect(modal.getByText(/already/i)).toBeVisible();
    await modal.locator('#subject-new').fill('');
    await rowByName(modal, wrong).getByRole('button', { name: /remove/i }).click();
    await expect(rowByName(modal, wrong)).toHaveCount(0);
    const right = wrong.replace('Robotcs', 'Robotics');
    await modal.locator('#subject-new').fill(right);
    await modal.locator('[data-action="add-subject"]').click();
    await expect(rowByName(modal, right)).toHaveCount(1);
    await modal.locator('[data-action="save-subjects"]').click();
    await expect(modal).toBeHidden({ timeout: 15_000 });
    const names = (await subjectsView(api, cls.id)).map((s) => s.name.toLowerCase());
    expect(names).toContain(right.toLowerCase());
    expect(names).not.toContain(wrong.toLowerCase());
    await api.dispose();
  });
  test('EB5WF-DISCARD: an added custom subject is dirty; Cancel asks to discard and nothing is saved', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const before = (await subjectsView(api, cls.id)).map((x) => x.name).sort();
    const modal = await openSubjects(page, cls.name);
    const custom = `Pottery ${letters(4)}`;
    await modal.locator('#subject-new').fill(custom);
    await modal.locator('[data-action="add-subject"]').click();
    await expect(rowByName(modal, custom)).toHaveCount(1);
    await modal.locator('[data-action="cancel-subjects"]').click();
    const discard = page.getByRole('button', { name: 'Discard', exact: true }).locator('visible=true').first();
    await expect(discard).toBeVisible();
    await discard.click();
    await expect(modal.locator('[data-subjects-body]')).toBeHidden({ timeout: 10_000 });
    expect((await subjectsView(api, cls.id)).map((x) => x.name).sort()).toEqual(before);
    await api.dispose();
  });

  test('EB5WF-REMOVE-DEFAULT: a default subject is still removable (R4-1) and the save drops it', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const modal = await openSubjects(page, cls.name);
    const firstDefault = modal.locator('li[data-subject-kind="default"]').first();
    await expect(firstDefault).toBeVisible();
    const name = (await firstDefault.locator('span').first().innerText()).trim();
    await firstDefault.getByRole('button', { name: /remove/i }).click();
    await expect(rowByName(modal, name)).toHaveCount(0);
    await modal.locator('[data-action="save-subjects"]').click();
    await expect(modal.locator('[data-subjects-body]')).toBeHidden({ timeout: 15_000 });
    expect((await subjectsView(api, cls.id)).map((x) => x.name.toLowerCase())).not.toContain(name.toLowerCase());
    await api.dispose();
  });
});

test.describe('PR 561 — z94x8eber8 #2 struck-off student keeps the class name on the profile', () => {
  test('EBER8-LAST-CLASS: profile header shows the class left, as the Admission Register does; the student stays unplaced @smoke', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const pupil = await quickAddStudent(api, cls.id);
    await strikeOff(api, pupil.id);
    // The struck-off history row is written from the register outbox (worker), so the label can lag the strike-off by a few seconds.
    const t0 = Date.now();
    await expect.poll(async () => (await profile(api, pupil.id)).lastClassSection ?? null, { timeout: 60_000, intervals: [500, 1000, 2000] }).not.toBeNull();
    test.info().annotations.push({ type: 'lastClassSection lag ms', description: String(Date.now() - t0) });
    const p = await profile(api, pupil.id);
    expect(p.classId ?? null).toBeNull();
    expect(p.sectionId ?? null).toBeNull();
    expect(p.lastClassSection, 'lastClassSection on GET profile').toBeTruthy();
    expect(String(p.lastClassSection).toLowerCase()).toBe(`${cls.name}-${cls.grade} (a)`.toLowerCase());
    await page.goto(`/registrar/students/${pupil.id}`);
    const header = page.getByText(new RegExp(`^${cls.name}-${cls.grade} \\(A\\)$`, 'i'));
    await expect(header.first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Not placed in a class', { exact: true }).and(page.locator(':not(option)'))).toHaveCount(0);
    await shot(page, 'eber8-profile-header');
    // The Admission Register shows the same class for the struck-off student.
    const list = await api.get('students');
    const row = ((await list.json()) as any[]).find((s) => s.id === pupil.id);
    expect(row, 'struck-off student in GET /students').toBeTruthy();
    expect(String(row.classSection ?? '').toLowerCase()).toBe(String(p.lastClassSection).toLowerCase());
    expect(row.classId).toBe(cls.id);
    await api.dispose();
  });

  test('EBER8-SAVE-STAYS-UNPLACED: editing a struck-off profile and saving keeps the student out of the class', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const pupil = await quickAddStudent(api, cls.id);
    await strikeOff(api, pupil.id);
    await expect.poll(async () => (await profile(api, pupil.id)).lastClassSection ?? null, { timeout: 60_000 }).not.toBeNull();
    await page.goto(`/registrar/students/${pupil.id}`);
    await expect(page.getByText(new RegExp(`^${cls.name}-${cls.grade} \\(A\\)$`, 'i')).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#profile-basic-class')).toBeDisabled();
    await expect(page.locator('#profile-basic-class')).toHaveValue('');
    const email = page.locator('#profile-basic-email');
    await email.fill(`qa561.${Date.now()}@testenv.local`);
    await email.press("Tab");
    await page.locator('[data-action="save-basic"]').click();
    await expect(page.locator('[data-action="save-basic"]')).toBeDisabled({ timeout: 15_000 });
    const after = await profile(api, pupil.id);
    expect(after.email).toContain('qa561.');
    expect(after.classId ?? null).toBeNull();
    expect(after.sectionId ?? null).toBeNull();
    expect(after.status).toBe(1);
    expect(String(after.lastClassSection).toLowerCase()).toBe(`${cls.name}-${cls.grade} (a)`.toLowerCase());
    // The class roster does not get the student back.
    const reg = await api.get('attendance-register/today', { params: { sectionId: cls.sectionId } });
    if (reg.status() === 200) expect(((await reg.json()).students as any[]).map((x) => x.studentId)).not.toContain(pupil.id);
    await page.reload();
    await expect(page.getByText(new RegExp(`^${cls.name}-${cls.grade} \\(A\\)$`, 'i')).first()).toBeVisible({ timeout: 20_000 });
    await api.dispose();
  });


  // C1-STRIKE-OFF-STALE (cycle 1 finding): the profile reads itself again ~200 ms after its own strike-off (A35), before the
  // worker has written the struck-off register entry that lastClassSection comes from, so the header stays "Not placed in a class".
  test('EBER8-STRIKE-OFF-IN-UI (C1-STRIKE-OFF-STALE): struck off from the profile itself, the header names the class left without a reload @smoke', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const pupil = await quickAddStudent(api, cls.id);
    await page.goto(`/registrar/students/${pupil.id}`);
    await expect(page.getByText(/Section A/).first()).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-action="strike-off"]').click();
    const modal = page.locator('[data-strike-off-body]');
    await expect(modal).toBeVisible();
    await modal.getByRole('radio').first().check();
    await page.locator('[data-action="confirm-strike-off"]').click();
    await expect(modal).toBeHidden({ timeout: 15_000 });
    const label = page.getByText(new RegExp(`^${cls.name}-${cls.grade} \\(A\\)$`, 'i')).first();
    await expect(label, 'header names the class left after the in-page strike-off (no reload)').toBeVisible({ timeout: 10_000 });
    await api.dispose();
  });

  test('EBER8-PLACED: a placed student keeps "class · Section A"; no lastClassSection', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const pupil = await quickAddStudent(api, cls.id);
    const p = await profile(api, pupil.id);
    expect(p.lastClassSection ?? null).toBeNull();
    await page.goto(`/registrar/students/${pupil.id}`);
    await expect(page.getByText(/Section A/).first()).toBeVisible({ timeout: 20_000 });
    await api.dispose();
  });
});
