/**
 * 86eyqaue7 Apply Incentives and Deductions at Run Time (PR 544).
 * World "incentives": policy ÷30 with income tax ON. Library (created before the run):
 *   Conveyance allowance  flat +2,000  Designation = Senior Teacher
 *   Late arrival fine     flat −500    No one by default
 *   Ramadan bonus         flat +3,000  No one by default
 *   HOD allowance         10% +        Designation = Head of Department (matches nobody here)
 *   Uniform recovery      flat −1,000  Everyone, DEACTIVATED before the run
 *   Teaching allowance    5% +         Category = Teaching
 *   Experience bonus      10% +        Base salary ≥ 40,000
 * Staff: Ayesha (Senior Teacher, 45,000, tax 5%), Bilal (Senior Teacher, joined on the 3rd, 30,000), Nadia (Teacher,
 * 30,000), Driver (Non-teaching, 20,000).
 */
import { expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

const month = P.monthStart();
const MONTH_NAME = P.monthName(month);
const JOIN_DAY = 3;
const L = {
  conveyance: 'Qa Conveyance allowance', fine: 'Qa Late arrival fine', bonus: 'Qa Ramadan bonus', hod: 'Qa HOD allowance',
  uniform: 'Qa Uniform recovery', teaching: 'Qa Teaching allowance', experience: 'Qa Experience bonus',
};
interface Data { ayesha: P.Staff; bilal: P.Staff; nadia: P.Staff; driver: P.Staff; items: Record<string, string>; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('incentives', () => newCampusOwner('pay'), async (owner) => {
    await P.publishPolicy(owner.api, { incomeTaxEnabled: true });
    const api = owner.api;
    const ayesha = await P.addStaff(api, { salary: 45000, designationId: P.DESIGNATION.seniorTeacher, incomeTaxPercent: 5, name: P.qaName('Ayesha') });
    const bilal = await P.addStaff(api, { salary: 30000, designationId: P.DESIGNATION.seniorTeacher, joined: P.iso(P.dayOf(month, JOIN_DAY)), incomeTaxPercent: 0, name: P.qaName('Bilal') });
    const nadia = await P.addStaff(api, { salary: 30000, designationId: P.DESIGNATION.teacher, incomeTaxPercent: 0, name: P.qaName('Nadia') });
    const driver = await P.addStaff(api, { salary: 20000, designationId: P.DESIGNATION.driver, incomeTaxPercent: 0, name: P.qaName('Driver') });
    const items: Record<string, string> = {};
    items.conveyance = await P.createItem(api, { name: L.conveyance, type: 'Incentive', amountType: 'FlatAmount', amount: 2000, appliesTo: 'Designation', designationId: P.DESIGNATION.seniorTeacher });
    items.fine = await P.createItem(api, { name: L.fine, type: 'Deduction', amountType: 'FlatAmount', amount: 500, appliesTo: 'NoOne' });
    items.bonus = await P.createItem(api, { name: L.bonus, type: 'Incentive', amountType: 'FlatAmount', amount: 3000, appliesTo: 'NoOne' });
    items.hod = await P.createItem(api, { name: L.hod, type: 'Incentive', amountType: 'Percentage', amount: 10, appliesTo: 'Designation', designationId: P.DESIGNATION.headOfDepartment });
    items.uniform = await P.createItem(api, { name: L.uniform, type: 'Deduction', amountType: 'FlatAmount', amount: 1000, appliesTo: 'Everyone' });
    await P.deactivateItem(api, items.uniform);
    items.teaching = await P.createItem(api, { name: L.teaching, type: 'Incentive', amountType: 'Percentage', amount: 5, appliesTo: 'Category', category: 'Teaching' });
    items.experience = await P.createItem(api, { name: L.experience, type: 'Incentive', amountType: 'Percentage', amount: 10, appliesTo: 'BaseSalaryRange', minimumSalary: 40000 });
    const runId = await P.generateRun(api);
    return { ayesha, bilal, nadia, driver, items, runId };
  });
});

const row = (s: P.Staff) => P.rowFor(w.owner.api, w.data.runId, s);
const fig = async (s: P.Staff) => P.figures(w.owner.api, w.data.runId, (await row(s)).id);
const line = (f: P.Figures, label: string) => f.lines.find((l) => l.label === label);

test.describe('Incentives — the listing model', () => {
  test('a matching rule is listed ticked, "No one by default" listed unticked, a non-matching or Inactive item is not listed', { tag: '@critical' }, async () => {
    const a = await fig(w.data.ayesha);
    expect(a.lines.map((l) => [l.label, l.isApplied])).toEqual([
      [L.conveyance, true], [L.fine, false], [L.bonus, false], [L.teaching, true], [L.experience, true],
    ]);
    expect(line(a, L.hod), 'rule exists and does not match').toBeUndefined();
    expect(line(a, L.uniform), 'Inactive before the run').toBeUndefined();
    const d = await fig(w.data.driver);
    expect(d.lines.map((l) => [l.label, l.isApplied]), 'nothing rule-driven: only the No-one-by-default items, unticked').toEqual([[L.fine, false], [L.bonus, false]]);
  });

  test('the panel shows percentage items as their rupee figure, and unticked amounts in grey', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    const s = w.data.ayesha;
    await run.openRow(s.name);
    await expect(run.lineCheckbox(L.conveyance)).toBeChecked();
    await expect(run.lineCheckbox(L.fine)).not.toBeChecked();
    await expect(run.lineCheckbox(L.bonus)).not.toBeChecked();
    await expect(run.lineCheckbox(L.hod)).toHaveCount(0);
    await expect(run.lineCheckbox(L.uniform)).toHaveCount(0);
    expect(await run.lineAmountText(L.teaching)).toMatch(P.moneyRe(2250, '+ '));
    expect(await run.lineAmountText(L.experience)).toMatch(P.moneyRe(4500, '+ '));
    await expect(run.lineRow(L.teaching)).not.toContainText('%');
    expect(await run.lineAmountText(L.fine)).toMatch(P.moneyRe(500, '− '));
    expect(await run.lineAmountColor(L.fine), 'unticked amount is grey, unlike a ticked one').not.toBe(await run.lineAmountColor(L.conveyance));
    await page.screenshot({ path: P.shot('incentives-panel-listing.png'), fullPage: true });
    await page.context().close();
  });
});

test.describe('Incentives — computation', () => {
  test('two matching percentage items each compute on the same base and do not compound; statutory is on the base only', async () => {
    const r = await P.breakdown(w.owner.api, w.data.runId, (await row(w.data.ayesha)).id);
    const applied = Object.fromEntries(r.lines.filter((l: P.Line) => l.isApplied).map((l: P.Line) => [l.label, l.amount]));
    expect(applied[L.teaching]).toBe(2250);
    expect(applied[L.experience]).toBe(4500);
    expect(r.incomeTax).toBe(2250);
    // Only applied lines count; a one-off added later in this file may add to it, so compute from the breakdown.
    const extra = r.lines.filter((l: P.Line) => l.isApplied && l.isOneOff).reduce((s: number, l: P.Line) => s + (l.type === 'Incentive' ? l.amount : -l.amount), 0);
    const ticked = r.lines.filter((l: P.Line) => l.isApplied && !l.isOneOff).reduce((s: number, l: P.Line) => s + (l.type === 'Incentive' ? l.amount : -l.amount), 0);
    expect(r.net).toBe(45000 + ticked + extra - 2250);
  });

  test('a mid-month joiner: the flat allowance applies in full, the percentage moves with the prorated base', async () => {
    const f = await fig(w.data.bilal);
    const paidDays = Math.min(30, P.daysInMonth(month) - JOIN_DAY + 1);
    const base = P.round0((30000 * paidDays) / 30);
    expect(line(f, L.conveyance)!.amount).toBe(2000);
    expect(line(f, L.teaching)!.amount).toBe(P.round0(base * 0.05));
    expect(line(f, L.experience), 'salary range rule does not match 30,000').toBeUndefined();
    expect(f.net).toBe(base + 2000 + P.round0(base * 0.05));
  });

  test('ticking a "No one by default" fine lowers the net by its amount in panel, Net cell and storage; unticking restores it', async ({ browser }) => {
    const s = w.data.nadia;
    const start = await fig(s);
    if (line(start, L.fine)!.isApplied) await P.setLine(w.owner.api, w.data.runId, start.rowId, line(start, L.fine)!.id, false);
    const base = (await fig(s)).net!;
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.openRow(s.name);
    await run.lineCheckbox(L.fine).check();
    await expect(run.panelNet()).toHaveText(P.moneyRe(base - 500));
    await expect(await run.cell(s.name, `Net for ${MONTH_NAME}`)).toHaveText(P.moneyRe(base - 500));
    await expect.poll(async () => (await fig(s)).net).toBe(base - 500);
    await run.lineCheckbox(L.fine).uncheck();
    await expect(run.panelNet()).toHaveText(P.moneyRe(base));
    await expect.poll(async () => (await fig(s)).net).toBe(base);
    await page.context().close();
  });

  test('an incentive does not move statutory: income tax stays 5% of the base when a PKR 2,000 one-off incentive is added', async () => {
    const id = (await row(w.data.ayesha)).id;
    const before = await P.breakdown(w.owner.api, w.data.runId, id);
    await P.oneOff(w.owner.api, w.data.runId, id, { type: 'Incentive', label: 'Qa Exam duty', amount: 2000, reason: 'Invigilated the mock exams' });
    const after = await P.breakdown(w.owner.api, w.data.runId, id);
    expect(after.incomeTax).toBe(before.incomeTax);
    expect(after.incomeTax).toBe(2250);
    expect(after.net).toBe(before.net + 2000);
  });

  test('a negative net is allowed while editing and blocked at preview, naming the staff member', async () => {
    const s = w.data.driver;
    const f0 = await fig(s);
    let big = f0.lines.find((l) => l.isOneOff && l.label === 'Qa Damage recovery');
    if (!big) {
      const res = await P.postOneOff(w.owner.api, w.data.runId, f0.rowId, { type: 'Deduction', label: 'Qa Damage recovery', amount: 20000, reason: 'Van repair agreed' });
      expect(res.status()).toBe(201);
      big = (await res.json()).lines.find((l: P.Line) => l.label === 'Qa Damage recovery');
    }
    await P.setLine(w.owner.api, w.data.runId, f0.rowId, big!.id, true);
    const f = await P.setLine(w.owner.api, w.data.runId, f0.rowId, line(f0, L.fine)!.id, true);
    expect(f.net).toBe(-500);
    const pv = await P.preview(w.owner.api, w.data.runId);
    expect(pv.status()).toBe(409);
    const body = await pv.json();
    expect(body.code).toBe('PREVIEW_BLOCKED');
    expect(body.negativeNet.map((x: { name: string }) => x.name)).toEqual([s.name]);
    // Restore so later preview tests in other files are unaffected.
    await P.setLine(w.owner.api, w.data.runId, f0.rowId, big!.id, false);
    await P.setLine(w.owner.api, w.data.runId, f0.rowId, line(f0, L.fine)!.id, false);
  });
});

test.describe('Incentives — the one-off form', () => {
  test('"+ Add a one-off" reveals Type (Incentive by default), Label, Amount, Reason; empty submit shows every field\'s exact copy', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.openRow(w.data.nadia.name);
    await run.addOneOffLink().click();
    await expect(run.oneOffType('Incentive')).toBeChecked();
    await expect(run.oneOffType('Deduction')).not.toBeChecked();
    await run.oneOffSubmit().click();
    await expect(run.panelText('Enter a label so this line is explainable later.')).toBeVisible();
    await expect(run.panelText('Enter an amount.')).toBeVisible();
    await expect(run.panelText('Enter a reason. A one-off without one cannot be explained at year end.')).toBeVisible();
    await run.fillOneOff({ label: 'x'.repeat(41), amount: '0', reason: 'ok' });
    await run.oneOffSubmit().click();
    await expect(run.panelText('Use 40 characters or fewer.')).toBeVisible();
    await expect(run.panelText('Enter an amount above zero.')).toBeVisible();
    await run.fillOneOff({ label: 'Qa Too much', amount: '30001' });
    await run.oneOffSubmit().click();
    await expect(run.panelText('An amount cannot be larger than the monthly salary.')).toBeVisible();
    // Cancel closes the form and discards what was typed.
    await run.oneOffCancel().click();
    await expect(run.oneOffField('Label')).toHaveCount(0);
    await run.addOneOffLink().click();
    await expect(run.oneOffField('Label')).toHaveValue('');
    await expect(run.oneOffField('Amount (PKR)')).toHaveValue('');
    await page.context().close();
  });

  test('a saved one-off joins the list ticked, shows its reason and moves the net (deduction "Broken laptop screen" PKR 4,000)', { tag: '@critical' }, async ({ browser }) => {
    const s = w.data.nadia;
    const before = await fig(s);
    const already = before.lines.filter((l) => l.label === 'Qa Broken laptop screen').length;
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.openRow(s.name);
    await run.addOneOffLink().click();
    await run.fillOneOff({ type: 'Deduction', label: 'Qa Broken laptop screen', amount: '4000', reason: 'Agreed repayment over one month' });
    await run.oneOffSubmit().click();
    await expect(run.oneOffField('Label')).toHaveCount(0);
    await expect(run.panelText('Agreed repayment over one month').first()).toBeVisible();
    await expect(run.panelNet()).toHaveText(P.moneyRe(before.net! - 4000));
    const after = await fig(s);
    const added = after.lines.filter((l) => l.label === 'Qa Broken laptop screen');
    expect(added).toHaveLength(already + 1);
    expect(added[added.length - 1]).toMatchObject({ isApplied: true, isOneOff: true, type: 'Deduction', amount: 4000, reason: 'Agreed repayment over one month' });
    await page.context().close();
  });

  test('network failure while adding a one-off keeps the form open with its values and turns the strip Warning', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.openRow(w.data.driver.name);
    await run.addOneOffLink().click();
    await run.fillOneOff({ type: 'Incentive', label: 'Qa Offline bonus', amount: '1500', reason: 'Typed while offline' });
    await page.route('**/one-offs', (route) => route.abort('internetdisconnected'));
    await run.oneOffSubmit().click();
    await expect(run.saveFailed).toContainText('Not saved. Check your connection.');
    await expect(run.oneOffField('Label')).toHaveValue('Qa Offline bonus');
    await expect(run.oneOffField('Amount (PKR)')).toHaveValue('1500');
    await expect(run.oneOffField('Reason')).toHaveValue('Typed while offline');
    await page.screenshot({ path: P.shot('incentives-oneoff-network-failure.png'), fullPage: true });
    expect((await fig(w.data.driver)).lines.find((l) => l.label === 'Qa Offline bonus'), 'nothing half-written').toBeUndefined();
    await page.context().close();
  });

  test('API boundaries: amount 1 / = salary accepted, 0 / salary+1 refused; label 40/41; reason 120/121; bad type; never 500', async () => {
    const s = w.data.driver;
    const id = (await row(s)).id;
    const base = { type: 'Incentive', label: 'Qa Boundary', amount: 1, reason: 'Boundary check' };
    const cases: [Record<string, unknown>, number, string | null][] = [
      [{ amount: 1 }, 201, null],
      [{ amount: 20000 }, 201, null],
      [{ amount: 0 }, 400, 'Enter an amount above zero.'],
      [{ amount: -5 }, 400, 'Enter an amount above zero.'],
      [{ amount: 20001 }, 400, 'An amount cannot be larger than the monthly salary.'],
      [{ amount: null }, 400, 'Enter an amount.'],
      [{ label: 'L'.repeat(40) }, 201, null],
      [{ label: 'L'.repeat(41) }, 400, 'Use 40 characters or fewer.'],
      [{ label: '   ' }, 400, 'Enter a label so this line is explainable later.'],
      [{ reason: 'R'.repeat(120) }, 201, null],
      [{ reason: 'R'.repeat(121) }, 400, 'Use 120 characters or fewer.'],
      [{ reason: '' }, 400, 'Enter a reason. A one-off without one cannot be explained at year end.'],
      [{ type: 'Bonus' }, 400, null],
      [{ amount: 'abc' }, 400, null],
    ];
    const log: string[] = [];
    for (const [patch, status, message] of cases) {
      const res = await P.postOneOff(w.owner.api, w.data.runId, id, { ...base, ...patch });
      const text = await res.text();
      log.push(`POST one-off ${JSON.stringify(patch).slice(0, 60)} -> ${res.status()} ${text.slice(0, 140)}`);
      expect(res.status(), `${JSON.stringify(patch).slice(0, 80)}: ${text.slice(0, 200)}`).toBe(status);
      if (message) expect(text).toContain(message);
    }
    await P.saveEvidence('incentives-oneoff-boundaries.txt', log.join('\n'));
    // Untick what the boundary run added so the Driver's net is back to base for other tests.
    const f = await fig(s);
    for (const l of f.lines.filter((x) => x.isOneOff && x.isApplied)) await P.setLine(w.owner.api, w.data.runId, f.rowId, l.id, false);
  });

  test('duplicate one-offs (same label) are allowed and listed separately', async () => {
    const id = (await row(w.data.nadia)).id;
    const before = (await fig(w.data.nadia)).lines.filter((l) => l.label === 'Qa Same label').length;
    await P.oneOff(w.owner.api, w.data.runId, id, { type: 'Deduction', label: 'Qa Same label', amount: 100, reason: 'First' });
    const f = await P.oneOff(w.owner.api, w.data.runId, id, { type: 'Deduction', label: 'Qa Same label', amount: 100, reason: 'Second' });
    expect(f.lines.filter((l) => l.label === 'Qa Same label')).toHaveLength(before + 2);
  });

  test('unknown run / row / line ids answer 404, never 500', async () => {
    const id = (await row(w.data.nadia)).id;
    expect((await P.postOneOff(w.owner.api, 'garbage', id, { type: 'Incentive', label: 'x', amount: 1, reason: 'x' })).status()).toBe(404);
    expect((await P.postOneOff(w.owner.api, w.data.runId, '00000000-0000-0000-0000-000000000000', { type: 'Incentive', label: 'x', amount: 1, reason: 'x' })).status()).toBe(404);
    const res = await w.owner.api.put(`payroll-runs/${w.data.runId}/rows/${id}/lines/not-a-line`, { data: { isApplied: true } });
    expect(res.status()).toBe(404);
  });
});

test.describe('Incentives — Library changes mid-draft', () => {
  test('editing a Library item\'s amount or retiring it mid-draft does not move the draft', async () => {
    const before = await fig(w.data.ayesha);
    await P.updateItem(w.owner.api, w.data.items.conveyance, { name: L.conveyance, type: 'Incentive', amountType: 'FlatAmount', amount: 2500, appliesTo: 'Designation', designationId: P.DESIGNATION.seniorTeacher });
    await w.owner.api.post(`payroll-items/${w.data.items.bonus}/deactivate`);
    const after = await fig(w.data.ayesha);
    expect(line(after, L.conveyance)!.amount).toBe(2000);
    expect(line(after, L.bonus), 'a retired item stays on rows that already carry it').toBeTruthy();
    expect(after.net).toBe(before.net);
  });
});
