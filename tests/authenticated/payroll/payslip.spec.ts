/**
 * 86eyqaue1 View Payslip Details (PR 544).
 * World "payslip": tax + EOBI on. Ayesha: base 45,000, 2 unpaid days, "Qa Fuel allowance" +2,000 (rule), "Qa Late
 * arrival fine" −500 (ticked), tax 5 %, EOBI 370 → 41,030 (the ticket's own example). Bilal: 38,000, no rates (tax and
 * EOBI on, no rate → no statutory line). Sana: 24,000, left on the 5th. Dup: two one-off deductions with the same label.
 * Paid lines: Ayesha, Bilal, Sana, Dup. Unpaid line: Zara.
 */
import { expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

const month = P.monthStart();
const MONTH = P.monthLabel(month);
const LEFT_DAY = 5;
interface Data { ayesha: P.Staff; bilal: P.Staff; sana: P.Staff; dup: P.Staff; zara: P.Staff; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('payslip', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: true, eobiEnabled: true });
    const ayesha = await P.addStaff(api, { salary: 45000, designationId: P.DESIGNATION.seniorTeacher, incomeTaxPercent: 5, eobiPerMonth: 370, name: P.qaName('Ayesha') });
    const bilal = await P.addStaff(api, { salary: 38000, name: P.qaName('Bilal') });
    const sana = await P.addStaff(api, { salary: 24000, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Sana') });
    await P.markLeft(api, sana.id, P.iso(P.dayOf(month, LEFT_DAY)));
    const dup = await P.addStaff(api, { salary: 30000, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Dup') });
    const zara = await P.addStaff(api, { salary: 28000, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Zara') });
    await P.createItem(api, { name: 'Qa Fuel allowance', type: 'Incentive', amountType: 'FlatAmount', amount: 2000, appliesTo: 'Designation', designationId: P.DESIGNATION.seniorTeacher });
    await P.createItem(api, { name: 'Qa Late arrival fine', type: 'Deduction', amountType: 'FlatAmount', amount: 500, appliesTo: 'NoOne' });
    const runId = await P.generateRun(api);
    const ar = await P.rowFor(api, runId, ayesha);
    const f = await P.absence(api, runId, ar.id, 2);
    await P.setLine(api, runId, ar.id, f.lines.find((l) => l.label === 'Qa Late arrival fine')!.id, true);
    const dr = await P.rowFor(api, runId, dup);
    await P.oneOff(api, runId, dr.id, { type: 'Deduction', label: 'Qa Canteen', amount: 300, reason: 'First week' });
    await P.oneOff(api, runId, dr.id, { type: 'Deduction', label: 'Qa Canteen', amount: 200, reason: 'Second week' });
    await P.publishOk(api, runId);
    for (const s of [ayesha, bilal, sana, dup]) await P.markPaid(api, runId, (await P.rowFor(api, runId, s)).id);
    return { ayesha, bilal, sana, dup, zara, runId };
  });
});

const slip = async (s: P.Staff) => P.payslip(w.owner.api, w.data.runId, (await P.rowFor(w.owner.api, w.data.runId, s)).id);
const sum = (lines: { amount: number; kind: string }[]) =>
  lines.filter((l) => l.kind !== 'Net').reduce((t, l) => t + (l.kind === 'Subtraction' ? -l.amount : l.amount), 0);

test.describe('Payslip — content', () => {
  test('the ticket\'s example: lines in computation order, statutory naming rate and base, EOBI flat; lines sum to the net', { tag: '@critical' }, async () => {
    const s = await slip(w.data.ayesha);
    expect(s.staffName).toBe(w.data.ayesha.name);
    expect(s.month).toBe(MONTH);
    expect(s.lines).toEqual([
      { label: 'Base salary', amount: 45000, kind: 'Base' },
      { label: 'Unpaid leave, 2 days', amount: 3000, kind: 'Subtraction' },
      { label: 'Qa Fuel allowance', amount: 2000, kind: 'Addition' },
      { label: 'Qa Late arrival fine', amount: 500, kind: 'Subtraction' },
      { label: 'Income tax, 5% of PKR 42,000', amount: 2100, kind: 'Subtraction' },
      { label: 'EOBI', amount: 370, kind: 'Subtraction' },
      { label: 'Net salary', amount: 41030, kind: 'Net' },
    ]);
    expect(sum(s.lines)).toBe(41030);
  });

  test('a base-only payslip is not padded: "Base salary" and "Net salary" only, no PKR 0 line (statutory on but no rate)', async () => {
    const s = await slip(w.data.bilal);
    expect(s.lines).toEqual([{ label: 'Base salary', amount: 38000, kind: 'Base' }, { label: 'Net salary', amount: 38000, kind: 'Net' }]);
  });

  test('a mid-month leaver: the base reads the full salary and an unpaid line covers the days after the last working day', async () => {
    const s = await slip(w.data.sana);
    const dim = P.daysInMonth(month);
    const paid = P.round0((24000 * LEFT_DAY) / 30);
    expect(s.lines).toEqual([
      { label: 'Base salary', amount: 24000, kind: 'Base' },
      { label: `Unpaid leave, ${dim - LEFT_DAY} days`, amount: 24000 - paid, kind: 'Subtraction' },
      { label: 'Net salary', amount: paid, kind: 'Net' },
    ]);
  });

  test('duplicate one-off labels show as two lines, in the order added', async () => {
    const s = await slip(w.data.dup);
    expect(s.lines.filter((l) => l.label === 'Qa Canteen').map((l) => l.amount)).toEqual([300, 200]);
    expect(sum(s.lines)).toBe(s.lines.at(-1)!.amount);
  });

  test('reading a payslip writes no audit entry; the breakdown is available for an unpaid line through the API', async () => {
    const before = (await P.auditEntries(w.data.runId)).length;
    const s = await slip(w.data.zara);
    expect(s.lines.at(-1)).toEqual({ label: 'Net salary', amount: 28000, kind: 'Net' });
    expect((await P.auditEntries(w.data.runId)).length).toBe(before);
  });
});

test.describe('Payslip — the modal', () => {
  test('opens over the register with "Name, Month", signed lines, the net larger beneath a rule; Close returns to the same row', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await run.searchFor(w.data.ayesha.name);
    await run.rowAction(w.data.ayesha.name, 'View payslip').click();
    await expect(run.dialogHeading()).toHaveText(`${w.data.ayesha.name}, ${MONTH}`);
    await expect(run.dialogText('Net salary')).toBeVisible();
    const lines = await run.dialogLines();
    expect(lines[0]).toMatch(new RegExp(`^Base salary ${P.moneyRe(45000).source}$`));
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^Unpaid leave, 2 days ${P.moneyRe(3000, '− ').source}$`)));
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^Qa Fuel allowance ${P.moneyRe(2000, '+ ').source}$`)));
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^Income tax, 5% of PKR 42,000 ${P.moneyRe(2100, '− ').source}$`)));
    expect(lines.at(-1)).toMatch(new RegExp(`^Net salary ${P.moneyRe(41030).source}$`));
    expect(await run.netFontSize()).toBeGreaterThan(await run.lineFontSize());
    await page.screenshot({ path: P.shot('payslip-modal.png') });
    await run.dialogButton('Close').first().click(); // the footer "Close" (the icon is the second one)
    await expect(run.dialog).toHaveCount(0);
    await expect(run.search).toHaveValue(w.data.ayesha.name);
    await expect(run.row(w.data.ayesha.name)).toBeVisible();
    await page.context().close();
  });

  test('the modal offers no print, no download and no edit', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await run.rowAction(w.data.bilal.name, 'View payslip').click();
    await expect(run.dialogButton('Close').first()).toBeVisible();
    for (const name of ['Print', 'Download', 'Edit']) await expect(run.dialogButton(name)).toHaveCount(0);
    await page.context().close();
  });

  test('PO decision (t28u): for a Payroll Edit holder the footer offers "Post an adjustment" before "Close"', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await run.rowAction(w.data.bilal.name, 'View payslip').click();
    await expect(run.dialogButton('Close').first()).toBeVisible();
    const labels = (await page.getByRole('dialog').getByRole('button').allInnerTexts()).map((t) => t.trim());
    await P.saveEvidence('payslip-footer-order.txt', JSON.stringify(labels));
    const adjust = labels.indexOf('Post an adjustment');
    expect(adjust, `footer actions ${JSON.stringify(labels)}`).toBeGreaterThanOrEqual(0);
    expect(adjust, 'Post an adjustment comes before Close').toBeLessThan(labels.lastIndexOf('Close'));
    await page.context().close();
  });

  test('loading and failure: "We could not load this payslip. Check your connection and try again." with a retry inside the modal', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await page.route('**/payslip', (route) => route.abort('internetdisconnected'));
    await run.rowAction(w.data.bilal.name, 'View payslip').click();
    await expect(run.dialogText('We could not load this payslip.')).toBeVisible();
    await expect(run.dialogText(/^Check your connection and try again\.$/).first()).toBeVisible();
    await page.screenshot({ path: P.shot('payslip-load-failure.png') });
    await page.unroute('**/payslip');
    await run.dialogRetry().click();
    await expect(run.dialogText('Net salary')).toBeVisible();
    await page.context().close();
  });

  test('P-PAYSLIP-UNPAID: "View payslip" is available on an unpaid line too', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await run.searchFor(w.data.zara.name);
    await expect(await run.cell(w.data.zara.name, 'Status')).toHaveText(/Unpaid|Posting pending/);
    await page.screenshot({ path: P.shot('P-PAYSLIP-UNPAID-row.png') });
    await expect(run.rowAction(w.data.zara.name, 'View payslip')).toBeVisible();
    await page.context().close();
  });
});
