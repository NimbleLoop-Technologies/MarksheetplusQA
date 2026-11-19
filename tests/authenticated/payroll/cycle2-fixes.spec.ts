/**
 * PR 544 cycle 2 — bugs filed in cycle 1 that had no spec of their own.
 * World "cycle2": no statutory. Ayesha 30,000, Bilal 25,000. Draft generated for the current month.
 *  - P-FRACTIONAL-AMOUNT (z94x8ecrnh): one-off and adjustment amounts are whole rupees (0.5 refused, 1 accepted).
 *  - P-REMINDER (z94x8ecrnm): in the last 3 days of the month a payroll editor whose month is not published sees the
 *    month-end notice, and its action opens Staff Payroll; outside month-end, and after publishing, it is absent.
 *    The browser clock is fixed with page.clock (the notice reads the browser's local date).
 *  - P-ADJ-REGISTER content (z94x8ecrnn): applied incentives/one-offs and adjustments are listed in the register page.
 */
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';

const month = P.monthStart();
const MONTH = P.monthLabel(month);
interface Data { ayesha: P.Staff; bilal: P.Staff; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  w = await P.world<Data>('cycle2', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: false, eobiEnabled: false });
    const ayesha = await P.addStaff(api, { salary: 30000, name: P.qaName('Ayesha') });
    const bilal = await P.addStaff(api, { salary: 25000, name: P.qaName('Bilal') });
    return { ayesha, bilal, runId: await P.generateRun(api) };
  });
});

const isDraft = async () => (await P.register(w.owner.api, w.data.runId)).status === 'Draft';
// The last day of this month at noon in Karachi, and the 10th (outside the 3-day window).
const monthEnd = () => new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), P.daysInMonth(month), 7));
const midMonth = () => new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 10, 7));
async function openAt(browser: import('@playwright/test').Browser, at: Date): Promise<Page> {
  // Sign in on the real clock (the OIDC tokens are checked against it), then move the browser clock and navigate
  // inside the SPA: the shell re-reads the reminder on every navigation.
  const page = await P.openApp(browser, w, '/');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
  await page.clock.setFixedTime(at);
  await page.evaluate(() => (window as any).Blazor.navigateTo('/accounts/staff-payroll/incentives-and-deductions'));
  await expect(page).toHaveURL(/incentives-and-deductions/);
  return page;
}
const reminder = (page: Page) => page.locator('[data-payroll-reminder-notice]');

test.describe.serial('Cycle 2 — fixes without a cycle-1 spec', () => {
  test('P-FRACTIONAL-AMOUNT: a one-off amount must be whole rupees (0.5 and 100.5 refused, 1 accepted)', async () => {
    test.skip(!(await isDraft()), 'already published (worker restart)');
    const row = await P.rowFor(w.owner.api, w.data.runId, w.data.bilal);
    const log: string[] = [];
    for (const amount of [0.5, 100.5]) {
      const res = await P.postOneOff(w.owner.api, w.data.runId, row.id, { type: 'Incentive', label: 'QA fraction', amount, reason: 'Fraction check' });
      const text = await res.text();
      log.push(`one-off ${amount} -> ${res.status()} ${text.slice(0, 200)}`);
      expect(res.status(), text).toBe(400);
      expect(text).toContain('Enter a whole number of rupees.');
    }
    const ok = await P.postOneOff(w.owner.api, w.data.runId, row.id, { type: 'Incentive', label: 'QA one rupee', amount: 1, reason: 'Whole rupee' });
    log.push(`one-off 1 -> ${ok.status()}`);
    expect(ok.status()).toBeLessThan(300);
    const f = await P.figures(w.owner.api, w.data.runId, row.id);
    log.push(`net after = ${f.net}`);
    expect(Number.isInteger(f.net)).toBe(true);
    await P.saveEvidence('P-FRACTIONAL-AMOUNT-oneoff.txt', log.join('\n'));
  });

  test('P-REMINDER: month-end notice shows for an unpublished month and opens Staff Payroll; absent mid-month', async ({ browser }) => {
    test.skip(!(await isDraft()), 'already published (worker restart)');
    const mid = await openAt(browser, midMonth());
    await expect(mid.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
    await mid.waitForTimeout(3000);
    await expect(reminder(mid)).toHaveCount(0);
    await mid.context().close();

    const page = await openAt(browser, monthEnd());
    await expect(reminder(page)).toBeVisible({ timeout: 30_000 });
    await expect(reminder(page)).toContainText(`Month-end: payroll for ${MONTH} is not published yet.`);
    await page.screenshot({ path: P.shot('P-REMINDER-month-end.png') });
    await page.locator('[data-payroll-reminder-open]').first().click();
    await expect(page).toHaveURL(new RegExp(`${P.PAYROLL_PATH}$`));
    await expect(page.getByRole('heading', { name: 'Staff Payroll', level: 1 })).toBeVisible();
    await page.context().close();
  });

  test('P-FRACTIONAL-AMOUNT: an adjustment amount must be whole rupees; P-REMINDER: gone once published', async ({ browser }) => {
    if (await isDraft()) await P.publishOk(w.owner.api, w.data.runId);
    const base = { staffMemberId: w.data.ayesha.id, direction: 'PayMore', reason: 'Fraction check' };
    const frac = await P.postAdjustment(w.owner.api, w.data.runId, { ...base, amount: 0.5, submissionId: randomUUID().replace(/-/g, '') });
    const text = await frac.text();
    await P.saveEvidence('P-FRACTIONAL-AMOUNT-adjustment.txt', `adjustment 0.5 -> ${frac.status()} ${text.slice(0, 300)}`);
    expect(frac.status(), text).toBe(400);
    expect(text).toContain('Enter a whole number of rupees.');

    const page = await openAt(browser, monthEnd());
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    await expect(reminder(page)).toHaveCount(0);
    await page.context().close();
  });

  test('P-ADJ-REGISTER: applied one-offs and posted adjustments are listed in the Incentives & Deductions Register', async ({ browser }) => {
    if (await isDraft()) await P.publishOk(w.owner.api, w.data.runId);
    const reason = `QA register ${Date.now()}`;
    const res = await P.postAdjustment(w.owner.api, w.data.runId, { staffMemberId: w.data.ayesha.id, direction: 'Recover', amount: 1500, reason, submissionId: randomUUID().replace(/-/g, '') });
    expect(res.status(), await res.text()).toBe(200);
    const page = await P.openApp(browser, w, '/accounts/staff-payroll/incentives-and-deductions');
    await page.getByRole('link', { name: /register/i }).or(page.locator('[data-action="register"]')).first().click();
    await expect(page).toHaveURL(/incentives-and-deductions\/register/);
    await expect(page.getByRole('heading', { name: 'Incentives & deductions register' })).toBeVisible();
    await expect(page.locator('[data-register-table]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-register-table]')).toContainText(reason);
    await expect(page.locator('[data-register-table]')).toContainText('QA one rupee');
    await page.screenshot({ path: P.shot('c2-register-page.png'), fullPage: true });
    await page.context().close();
  });
});
