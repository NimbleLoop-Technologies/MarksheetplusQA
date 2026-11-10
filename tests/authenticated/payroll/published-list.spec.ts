/**
 * 86eyqaue3 View the Published Payroll List (PR 544).
 * World "published": tax + EOBI on. Ayesha (Senior Teacher 45,000, tax 5 %, EOBI 370, 2 unpaid days, Conveyance +2,000,
 * fine −500) net 41,030; Bilal 38,000 (rates 0); Nadia 30,000 (rates 0, marked Left after publish). Published by the API;
 * Bilal is marked paid so the register is part paid.
 */
import { expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

const month = P.monthStart();
const MONTH = P.monthLabel(month);
interface Data { ayesha: P.Staff; bilal: P.Staff; nadia: P.Staff; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('published', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: true, eobiEnabled: true });
    const ayesha = await P.addStaff(api, { salary: 45000, designationId: P.DESIGNATION.seniorTeacher, incomeTaxPercent: 5, eobiPerMonth: 370, name: P.qaName('Ayesha') });
    const bilal = await P.addStaff(api, { salary: 38000, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Bilal') });
    const nadia = await P.addStaff(api, { salary: 30000, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Nadia') });
    await P.createItem(api, { name: 'Qa Conveyance allowance', type: 'Incentive', amountType: 'FlatAmount', amount: 2000, appliesTo: 'Designation', designationId: P.DESIGNATION.seniorTeacher });
    await P.createItem(api, { name: 'Qa Late arrival fine', type: 'Deduction', amountType: 'FlatAmount', amount: 500, appliesTo: 'NoOne' });
    const runId = await P.generateRun(api);
    const ar = await P.rowFor(api, runId, ayesha);
    const f = await P.absence(api, runId, ar.id, 2);
    await P.setLine(api, runId, ar.id, f.lines.find((l) => l.label === 'Qa Late arrival fine')!.id, true);
    await P.publishOk(api, runId);
    const br = await P.rowFor(api, runId, bilal);
    expect((await P.markPaid(api, runId, br.id)).status()).toBe(200);
    for (const s of [ayesha, bilal, nadia]) await P.waitForLedger(owner.tenantId, P.originPublish(runId, s.id));
    return { ayesha, bilal, nadia, runId };
  });
});

async function open(browser: import('@playwright/test').Browser) {
  const page = await P.openApp(browser, w, P.runPath(w.data.runId));
  const run = new PayrollRunPage(page);
  await run.expectPublishedLoaded();
  return { page, run };
}

test.describe('Published list — the screen', () => {
  test('strip and four tiles with exact labels and sub-lines; Paid + Outstanding = Total net', { tag: '@critical' }, async ({ browser }) => {
    const reg = await P.register(w.owner.api, w.data.runId);
    const { page, run } = await open(browser);
    await expect(run.publishedLine).toHaveText(/^Published by .+\. Computed with policy version 1\. Paid 1 of 3\.$/);
    expect(await run.tileLabels()).toEqual(['Total net', 'Paid', 'Outstanding', 'Statutory withheld']);
    const total = await run.tile('Total net');
    const paid = await run.tile('Paid');
    const out = await run.tile('Outstanding');
    const stat = await run.tile('Statutory withheld');
    expect(total).toEqual({ value: expect.stringMatching(P.moneyRe(41030 + 38000 + 30000)), sub: '3 staff members' });
    expect(paid).toEqual({ value: expect.stringMatching(P.moneyRe(38000)), sub: '1 staff member' });
    expect(out).toEqual({ value: expect.stringMatching(P.moneyRe(41030 + 30000)), sub: '2 staff members' });
    expect(stat).toEqual({ value: expect.stringMatching(P.moneyRe(2470)), sub: 'owed onward' });
    expect(reg.paidAmount + reg.outstandingAmount).toBe(reg.totalNet);
    await page.screenshot({ path: P.shot('published-register.png'), fullPage: true });
    await page.context().close();
  });

  test('every row reads Salary + Incentives − Deductions = Net salary', async ({ browser }) => {
    const reg = await P.register(w.owner.api, w.data.runId);
    for (const r of reg.rows) expect(r.salary! + r.incentives! - r.deductions!, r.staffName).toBe(r.net);
    const a = reg.rows.find((r) => r.staffMemberId === w.data.ayesha.id)!;
    expect([a.salary, a.incentives, a.deductions, a.net]).toEqual([45000, 2000, 5970, 41030]);
    const { page, run } = await open(browser);
    await expect(await run.cell(w.data.ayesha.name, 'Salary')).toHaveText(P.moneyRe(45000));
    await expect(await run.cell(w.data.ayesha.name, 'Incentives')).toHaveText(P.moneyRe(2000));
    await expect(await run.cell(w.data.ayesha.name, 'Deductions')).toHaveText(P.moneyRe(5970));
    await expect(await run.cell(w.data.ayesha.name, 'Net salary')).toHaveText(P.moneyRe(41030));
    await page.context().close();
  });

  test('P-PUBLISHED-COLUMNS: columns read left to right Staff member, Salary, Incentives, Deductions, Net salary, Status', async ({ browser }) => {
    const { page, run } = await open(browser);
    await page.screenshot({ path: P.shot('P-PUBLISHED-COLUMNS.png') });
    expect(await run.headers()).toEqual(['Staff member', 'Salary', 'Incentives', 'Deductions', 'Net salary', 'Status']);
    await page.context().close();
  });

  test('P-ZERO-MUTED: zero amounts render muted (Grey-500) while non-zero amounts are at full ink', async ({ browser }) => {
    const { page, run } = await open(browser);
    await page.screenshot({ path: P.shot('P-ZERO-MUTED-register.png') });
    const zero = await run.cellInk(await run.cell(w.data.bilal.name, 'Incentives'));
    const nonZero = await run.cellInk(await run.cell(w.data.ayesha.name, 'Incentives'));
    expect(zero).not.toBe(nonZero);
    await page.context().close();
  });

  test('statuses and actions: Unpaid rows have a grey "Unpaid" badge and "Mark as paid"; paid rows a "Paid" badge and "View payslip"', async ({ browser }) => {
    const { page, run } = await open(browser);
    await expect(await run.cell(w.data.ayesha.name, 'Status')).toHaveText('Unpaid');
    await expect(run.rowAction(w.data.ayesha.name, 'Mark as paid')).toBeVisible();
    await expect(await run.cell(w.data.bilal.name, 'Status')).toHaveText('Paid');
    await expect(run.rowAction(w.data.bilal.name, 'View payslip')).toBeVisible();
    await expect(run.rowAction(w.data.bilal.name, 'Mark as paid')).toHaveCount(0);
    await page.context().close();
  });

  test('"Unpaid only" narrows the list to unpaid lines; no page-level primary action', async ({ browser }) => {
    const { page, run } = await open(browser);
    await expect(run.reviewAndPublish).toHaveCount(0);
    await expect(run.publishPayroll).toHaveCount(0);
    await run.unpaidOnly.click();
    await expect(run.row(w.data.bilal.name)).toHaveCount(0);
    await expect(run.row(w.data.ayesha.name)).toBeVisible();
    await expect(run.row(w.data.nadia.name)).toBeVisible();
    await page.context().close();
  });

  test('no figure is editable: no inputs besides search, and the API refuses edits on a published run', async ({ browser }) => {
    const { page, run } = await open(browser);
    expect(await run.editableControlCount()).toBe(1); // the search box
    await page.context().close();
    const r = await P.rowFor(w.owner.api, w.data.runId, w.data.ayesha);
    expect((await P.putAbsence(w.owner.api, w.data.runId, r.id, { unpaidDays: 0 })).status()).toBe(409);
  });

  test('a staff member who left after publishing keeps an unchanged row', async () => {
    const before = await P.rowFor(w.owner.api, w.data.runId, w.data.nadia);
    const st = await P.sql(`select "Status" as s from "StaffMembers" where "Id" = ${P.q(w.data.nadia.id)}`);
    if (st[0].s !== 'Left') await P.markLeft(w.owner.api, w.data.nadia.id, P.iso(P.karachiToday()));
    const after = await P.rowFor(w.owner.api, w.data.runId, w.data.nadia);
    expect(after).toEqual(before);
  });

  test('loading shows a skeleton; load failure shows "We could not load this payroll run. Check your connection and try again." with a retry', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await page.route('**/register?*', (route) => route.abort('internetdisconnected'));
    await page.reload();
    await expect(run.text('We could not load this payroll run.')).toBeVisible({ timeout: 30_000 });
    await expect(run.text('Check your connection and try again.').first()).toBeVisible();
    await expect(run.retryButton()).toBeVisible();
    await page.screenshot({ path: P.shot('published-load-failure.png'), fullPage: true });
    await page.unroute('**/register?*');
    await run.retryButton().click();
    await run.expectPublishedLoaded();
    await page.context().close();
  });
});

test.describe('Published list — spec gaps', () => {
  test('P-CURRENCY: money renders as "PKR" + thousand separator, as specified', async ({ browser }) => {
    const { page, run } = await open(browser);
    await page.screenshot({ path: P.shot('P-CURRENCY-published-tiles.png') });
    expect((await run.tile('Total net')).value).toBe(`PKR ${(41030 + 38000 + 30000).toLocaleString('en-US')}`);
    await page.context().close();
  });

  test('P-PRINT-EXPORT: Print and Export render as utility outlined buttons', async ({ browser }) => {
    const { page, run } = await open(browser);
    await expect(run.printButton).toBeVisible();
    await expect(run.exportButton).toBeVisible();
    await page.context().close();
  });

  test('P-CORRECTION-LINK: the correction path is a sentence with an inline link, not a button', async ({ browser }) => {
    const { page, run } = await open(browser);
    await expect(run.correctionLine).toBeVisible();
    await expect(run.postAdjustment).toBeVisible();
    await page.screenshot({ path: P.shot('P-CORRECTION-LINK.png') });
    expect(await run.tagName(run.postAdjustment)).toBe('a');
    const line = await run.box(run.correctionLine);
    expect(line.y, 'the correction line sits above the pagination footer').toBeLessThan((await run.box(run.pagination)).y);
    await page.context().close();
  });

  test('P-EMPTY-SEARCH-COPY: a search with no match shows "No staff members match your search." with the term echoed', async ({ browser }) => {
    const { page, run } = await open(browser);
    await run.searchFor('zzqqxx');
    await expect(run.emptyState(/No staff members match/)).toBeVisible();
    await page.screenshot({ path: P.shot('P-EMPTY-SEARCH-COPY.png') });
    await expect(run.emptyState('No staff members match your search.')).toBeVisible();
    await expect(run.text(/zzqqxx/).first()).toBeVisible();
    await page.context().close();
  });
});
