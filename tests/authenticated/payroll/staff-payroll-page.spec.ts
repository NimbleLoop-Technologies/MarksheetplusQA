/**
 * 86eyqauej View the Staff Payroll Page (PR 544).
 * One throwaway campus walks through the month card's states in file order:
 * no policy → no active staff → no run → draft → published, plus past runs (DB-seeded older months), load states.
 * Bug ids (P-*) are the ones in /workspace/qa-cycles/pr-544/cycle-1/claude-report.md; those tests assert the SPEC and fail now.
 */
import { expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { StaffPayrollPage } from '../../../pages/payroll/StaffPayrollPage';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

const month = P.monthStart();
const MONTH = P.monthLabel(month);
let w: P.World<{ ok: true }>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world('landing', () => newCampusOwner('pay'), async () => ({ ok: true as const }));
});

const current = async () => (await w.owner.api.get('payroll-runs/current')).json();

test.describe('Staff Payroll page — month card states', () => {
  test('no policy: current month, disabled "Generate payroll", inline reason with a Policy link, no past runs table', async ({ browser }) => {
    test.skip((await current()).state !== 'NoPolicy', 'world already past the no-policy state (worker restart)');
    const page = await P.openApp(browser, w);
    const ui = new StaffPayrollPage(page);
    await ui.expectMonthCard();
    await expect(ui.monthHeading(MONTH)).toBeVisible();
    await expect(ui.stateLine).toHaveText('No payroll run yet for this month.');
    await expect(ui.generateButton).toBeDisabled();
    await expect(ui.noPolicyReason).toContainText('Set up the payroll policy before running payroll.');
    await expect(ui.policyLink).toHaveAttribute('href', /\/accounts\/staff-payroll\/policy$/);
    await expect(ui.pastRunsTable).toHaveCount(0);
    // Enforced server-side too: no run can be created without a policy.
    const res = await w.owner.api.post('payroll-runs/current');
    expect(res.status()).toBe(409);
    expect((await res.json()).message).toBe('Set up the payroll policy before running payroll.');
    await page.context().close();
  });

  test('"Policy" is a secondary outlined button, never orange, beside the primary action', async ({ browser }) => {
    const page = await P.openApp(browser, w);
    const ui = new StaffPayrollPage(page);
    await ui.expectMonthCard();
    const policyBg = await ui.backgroundColor(ui.policyButton);
    // Orange primary is a solid fill; the outlined secondary is white / transparent.
    expect(policyBg).toMatch(/rgba?\(255, 255, 255|rgba\(0, 0, 0, 0\)/);
    await page.context().close();
  });

  test('P-BREADCRUMB: the page shows the breadcrumb "Home > Account Office > Staff Payroll"', async ({ browser }) => {
    const page = await P.openApp(browser, w);
    const ui = new StaffPayrollPage(page);
    await ui.expectLoaded();
    await page.screenshot({ path: '/workspace/qa-cycles/pr-544/cycle-1/evidence/P-BREADCRUMB-landing.png' });
    await expect(ui.breadcrumb).toBeVisible();
    await expect(ui.breadcrumb).toContainText(/Home.*Account Office.*Staff Payroll/);
    await page.context().close();
  });

  test('zero active staff: empty state with a Staff Register link instead of the primary action', async ({ browser }) => {
    if ((await current()).state === 'NoPolicy') await P.publishPolicy(w.owner.api, {});
    test.skip((await current()).state !== 'NoActiveStaff', 'world already has staff (worker restart)');
    const page = await P.openApp(browser, w);
    const ui = new StaffPayrollPage(page);
    await ui.expectMonthCard();
    await expect(ui.stateLine).toContainText('No active staff members to pay. Add staff to the Staff Register first.');
    await expect(ui.staffRegisterLink).toHaveAttribute('href', '/staff/register');
    await expect(ui.generateButton).toHaveCount(0);
    await expect(ui.continueDraftButton).toHaveCount(0);
    const res = await w.owner.api.post('payroll-runs/current');
    expect(res.status(), 'no run can be created with zero Active staff').toBe(409);
    expect((await res.json()).code).toBe('NO_ACTIVE_STAFF');
    await page.context().close();
  });

  test('no run: "Generate payroll" opens this month\'s draft register in one click, no dialog', { tag: '@critical' }, async ({ browser }) => {
    if ((await current()).state === 'NoPolicy') await P.publishPolicy(w.owner.api, {});
    if ((await current()).state === 'NoActiveStaff') {
      await P.addStaff(w.owner.api, { salary: 45000, name: P.qaName('Ayesha') });
      await P.addStaff(w.owner.api, { salary: 35000, name: P.qaName('Farhana') });
    }
    test.skip((await current()).state !== 'NoRun', 'world already has a run (worker restart)');
    const page = await P.openApp(browser, w);
    const ui = new StaffPayrollPage(page);
    await ui.expectMonthCard();
    await expect(ui.stateLine).toHaveText('No payroll run yet for this month.');
    await expect(ui.generateButton).toBeEnabled();
    await ui.generateButton.click();
    await expect(page).toHaveURL(/\/accounts\/staff-payroll\/run\/[0-9a-f-]{36}$/);
    const run = new PayrollRunPage(page);
    await expect(run.title).toHaveText(`${MONTH} payroll`);
    await run.expectDraftLoaded();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.context().close();
  });

  test('draft: "N of M staff members have exceptions. Last saved …" and "Continue draft" reopens the same draft', async ({ browser }) => {
    const cur = await current();
    test.skip(cur.state !== 'Draft', `needs a draft, world is ${cur.state}`);
    const reg = await P.register(w.owner.api, cur.runId);
    if (reg.exceptionCount === 0) await P.absence(w.owner.api, cur.runId, reg.rows[0].id, 2);
    const page = await P.openApp(browser, w);
    const ui = new StaffPayrollPage(page);
    await ui.expectMonthCard();
    await expect(ui.monthHeading(MONTH)).toBeVisible();
    await expect(ui.stateLine).toHaveText(/^1 of 2 staff members have exceptions\. Last saved (just now|\d+ minutes? ago)\.$/);
    await expect(ui.generateButton).toHaveCount(0);
    await ui.continueDraftButton.click();
    await expect(page).toHaveURL(new RegExp(`/run/${cur.runId}$`));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await expect(run.summaryLine).toContainText('2 staff members. 1 at full month, 1 with exceptions.');
    await page.context().close();
  });

  test('reading the page writes no audit entry', async ({ browser }) => {
    const cur = await current();
    test.skip(!cur.runId, 'needs a run');
    const before = (await P.auditEntries(cur.runId)).length;
    const page = await P.openApp(browser, w);
    await new StaffPayrollPage(page).expectMonthCard();
    await page.reload();
    await new StaffPayrollPage(page).expectMonthCard();
    expect((await P.auditEntries(cur.runId)).length).toBe(before);
    await page.context().close();
  });

  test('published: "Published D MMM YYYY by …. Paid 0 of 2." with "View run"; the month heads the past runs table', { tag: '@critical' }, async ({ browser }) => {
    let cur = await current();
    if (cur.state === 'Draft') await P.publishOk(w.owner.api, cur.runId);
    cur = await current();
    test.skip(cur.state !== 'Published', `world is ${cur.state}`);
    const page = await P.openApp(browser, w);
    const ui = new StaffPayrollPage(page);
    await ui.expectMonthCard();
    const today = P.karachiToday().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace(/,/g, '');
    await expect(ui.stateLine).toHaveText(new RegExp(`^Published ${today} by .+\\. Paid 0 of 2\\.$`));
    await expect(ui.viewRunButton).toBeVisible();
    await expect(ui.generateButton).toHaveCount(0);
    await expect(ui.continueDraftButton).toHaveCount(0);
    const rows = await ui.pastRuns();
    expect(rows[0][0]).toBe(MONTH);
    expect(rows[0][1]).toBe(today);
    expect(rows[0][2]).toBe('2');
    const reg = await P.register(w.owner.api, cur.runId);
    expect(rows[0][3]).toMatch(P.moneyRe(reg.totalNet));
    // Generating again is not on offer and refused server-side.
    const again = await w.owner.api.post('payroll-runs/current');
    expect(again.status()).toBe(409);
    expect((await again.json()).code).toBe('ALREADY_PUBLISHED');
    await page.context().close();
  });

  test('P-PUBLISHER-NAME: the month card names the publisher by full name ("Quota Owner"), not the given name only', async ({ browser }) => {
    test.skip((await current()).state !== 'Published', 'needs the published month');
    const page = await P.openApp(browser, w);
    const ui = new StaffPayrollPage(page);
    await ui.expectMonthCard();
    await page.screenshot({ path: '/workspace/qa-cycles/pr-544/cycle-1/evidence/P-PUBLISHER-NAME-month-card.png' });
    await expect(ui.stateLine).toContainText('by Quota Owner.');
    await page.context().close();
  });
});

test.describe('Staff Payroll page — past runs', () => {
  test('past runs render newest first with Month, Published on, Staff, Total net and a "View run" per row [DB-seeded older months]', async ({ browser }) => {
    const cur = await current();
    test.skip(cur.state !== 'Published', 'needs the published month');
    // DB MANIPULATION: clone this month's published run into the two previous months (the product only runs the current month).
    const history = await (await w.owner.api.get('payroll-runs/history')).json();
    if (history.length < 3) {
      for (const offset of [-1, -2]) {
        const m = P.monthStart(offset);
        await P.clonePublishedRunToMonth(cur.runId, m, { publishedAt: new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 2, 6)) });
      }
    }
    const page = await P.openApp(browser, w);
    const ui = new StaffPayrollPage(page);
    await ui.expectMonthCard();
    expect(await ui.pastRunHeaders()).toEqual(expect.arrayContaining(['Month', 'Published on', 'Staff', 'Total net']));
    const rows = await ui.pastRuns();
    expect(rows.map((r) => r[0])).toEqual([MONTH, P.monthLabel(P.monthStart(-1)), P.monthLabel(P.monthStart(-2))]);
    // Published on for an older month: published on the 2nd of the month after it.
    const m1 = P.monthStart(-1);
    const pub = new Date(Date.UTC(m1.getUTCFullYear(), m1.getUTCMonth() + 1, 2));
    expect(rows[1][1]).toBe(pub.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace(/,/g, ''));
    await ui.viewRunLink(P.monthLabel(m1)).click();
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await expect(run.title).toHaveText(`${P.monthLabel(m1)} payroll`);
    await page.context().close();
  });
});

test.describe('Staff Payroll page — loading and load failure', () => {
  test('P-LANDING-SKELETON: skeleton blocks render for the month card while it loads', async ({ browser }) => {
    const page = await P.openApp(browser, w);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/payroll-runs/current', async (route) => { await gate; await route.continue(); });
    await page.reload();
    const ui = new StaffPayrollPage(page);
    await expect(ui.loadingSkeleton.or(ui.heading)).toBeVisible({ timeout: 30_000 }).catch(() => undefined);
    await page.screenshot({ path: '/workspace/qa-cycles/pr-544/cycle-1/evidence/P-LANDING-SKELETON-blank-while-loading.png' });
    await expect(ui.loadingSkeleton).toBeVisible({ timeout: 10_000 });
    release();
    await ui.expectMonthCard();
    await expect(ui.loadingSkeleton).toHaveCount(0);
    await page.context().close();
  });

  test('P-LANDING-LOAD-COPY: load failure shows "We could not load payroll. Check your connection and try again." with Retry', async ({ browser }) => {
    const page = await P.openApp(browser, w);
    await page.route('**/payroll-runs/current', (route) => route.abort('internetdisconnected'));
    await page.reload();
    const ui = new StaffPayrollPage(page);
    await expect(ui.loadError()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: '/workspace/qa-cycles/pr-544/cycle-1/evidence/P-LANDING-LOAD-COPY.png' });
    // The rest of Account Office stays usable.
    await expect(ui.navLink()).toBeVisible();
    await expect(ui.retryControl()).toBeVisible();
    // The retry control recovers once the connection is back.
    await page.unroute('**/payroll-runs/current');
    await ui.retryControl().click();
    await ui.expectMonthCard();
    await page.route('**/payroll-runs/current', (route) => route.abort('internetdisconnected'));
    await page.reload();
    await expect(ui.loadError()).toBeVisible({ timeout: 30_000 });
    // Spec copy: one sentence + a "Retry" link. Today: "We couldn't load payroll." + "Try again" button.
    await expect(ui.loadError()).toContainText('We could not load payroll. Check your connection and try again.');
    await expect(ui.retry()).toBeVisible();
    await page.context().close();
  });
});
