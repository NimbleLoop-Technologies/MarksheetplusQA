/**
 * 86eyqaue8 Record Leave and Absence Exceptions (PR 544).
 * World "absence": policy ÷30, Sunday off, sandwich off, no library items, statutory off.
 * World "rules": three policy variants on one tenant (working-days basis → proration off → sandwich on). Each variant
 * needs its own current-month draft, so the previous draft is moved to an old month in the DB first
 * (DB MANIPULATION — only frees the current month; the tested run is always created by the product).
 */
import { expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

const month = P.monthStart();
const MONTH_NAME = P.monthName(month);
const DIM = P.daysInMonth(month);
const LEFT_DAY = 5;

interface Data { ayesha: P.Staff; farhana: P.Staff; capped: P.Staff; spare: P.Staff; leaver: P.Staff; noSalary: P.Staff; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('absence', () => newCampusOwner('pay'), async (owner) => {
    await P.publishPolicy(owner.api, {});
    const ayesha = await P.addStaff(owner.api, { salary: 45000, name: P.qaName('Ayesha') });
    const farhana = await P.addStaff(owner.api, { salary: 35000, name: P.qaName('Farhana') });
    const capped = await P.addStaff(owner.api, { salary: 30000, name: P.qaName('Wholemonth') });
    const spare = await P.addStaff(owner.api, { salary: 40000, name: P.qaName('Spare') });
    const leaver = await P.addStaff(owner.api, { salary: 24000, name: P.qaName('Sana') });
    await P.markLeft(owner.api, leaver.id, P.iso(P.dayOf(month, LEFT_DAY)));
    const noSalary = await P.addStaff(owner.api, { salary: 26000, name: P.qaName('Nosalary') });
    await P.hideSalary(noSalary.id); // DB MANIPULATION: salary not set
    const runId = await P.generateRun(owner.api);
    return { ayesha, farhana, capped, spare, leaver, noSalary, runId };
  });
});

const rowId = async (s: P.Staff) => (await P.rowFor(w.owner.api, w.data.runId, s)).id;

test.describe('Absence — the panel', () => {
  test('"Add exception" expands the row: unpaid absence, incentives and deductions, live net; the action reads "Collapse"; no Save or Cancel', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    const s = w.data.spare;
    await run.openRow(s.name);
    await expect(run.rowAction(s.name, 'Collapse')).toBeVisible();
    await expect(run.panelText('Unpaid absence')).toBeVisible();
    await expect(run.panelText('Incentives and deductions')).toBeVisible();
    await expect(run.panelText(`Net for ${MONTH_NAME}`)).toBeVisible();
    await expect(run.panelNet()).toHaveText(P.moneyRe(s.salary));
    await expect(run.unpaidDays).toBeVisible();
    await expect(run.panelText('Sandwich leave is off, so a day count is enough.')).toBeVisible();
    await expect(run.panelText('No incentives or deductions have been defined yet.')).toBeVisible();
    const names = (await run.panelButtons().allInnerTexts()).map((t) => t.trim());
    expect(names).not.toContain('Save');
    expect(names).not.toContain('Cancel');
    await run.rowAction(s.name, 'Collapse').click();
    await expect(run.panel).toHaveCount(0);
    await expect(run.rowAction(s.name, 'Add exception')).toBeVisible();
    await page.context().close();
  });

  test('P-PANEL-IN-PLACE: the row expands in place, directly beneath its own row, with the register visible above and below', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    const s = w.data.ayesha;
    await run.openRow(s.name);
    await page.screenshot({ path: P.shot('P-PANEL-IN-PLACE-panel-below-pagination.png'), fullPage: true });
    const rowBox = await run.box(run.row(s.name));
    const panelBox = await run.box(run.panel);
    const pagerBox = await run.box(run.pagination);
    expect(panelBox.y, 'panel starts right under its row').toBeLessThan(rowBox.y + rowBox.height + 40);
    expect(panelBox.y, 'panel sits above the pagination footer').toBeLessThan(pagerBox.y);
    await page.context().close();
  });
});

test.describe('Absence — the count input (sandwich off)', () => {
  test('a decimal, a negative and a count above the days in the month are blocked inline with the exact copy, and the net does not recompute', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    const s = w.data.spare;
    await run.openRow(s.name);
    await run.setUnpaidDays('2.5');
    await expect(run.panelText('Enter a whole number of days.')).toBeVisible();
    await run.setUnpaidDays('-1');
    await expect(run.panelText('Enter a whole number of days.')).toBeVisible();
    await run.setUnpaidDays(String(DIM + 1));
    await expect(run.panelText(`${MONTH_NAME} has ${DIM} days. Enter ${DIM} or fewer.`)).toBeVisible();
    await expect(run.panelNet()).toHaveText(P.moneyRe(s.salary));
    expect((await P.rowFor(w.owner.api, w.data.runId, s)).unpaidDays, 'nothing was saved').toBe(0);
    await page.context().close();
  });

  test('2 unpaid days on PKR 45,000 (÷30) deduct PKR 3,000: panel net, Net cell, "2 unpaid days" badge and summary line update; it saves itself', { tag: '@critical' }, async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    const s = w.data.ayesha;
    const before = await P.register(w.owner.api, w.data.runId);
    const hadException = (await P.rowFor(w.owner.api, w.data.runId, s)).exception !== 'None';
    await run.openRow(s.name);
    await run.setUnpaidDays('2');
    await expect(run.panelNet()).toHaveText(P.moneyRe(42000));
    await expect(await run.cell(s.name, `Net for ${MONTH_NAME}`)).toHaveText(P.moneyRe(42000));
    await expect(await run.cell(s.name, 'Exceptions')).toHaveText('2 unpaid days');
    const expectedExceptions = before.exceptionCount + (hadException ? 0 : 1);
    await expect(run.summaryLine).toContainText(`${before.totalStaff} staff members. ${before.totalStaff - expectedExceptions} at full month, ${expectedExceptions} with exceptions.`);
    await expect.poll(async () => (await P.rowFor(w.owner.api, w.data.runId, s)).net).toBe(42000);
    await page.context().close();
  });

  test('1 unpaid day on PKR 35,000 deducts PKR 1,167 (rounded once) and the badge is singular "1 unpaid day"', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    const s = w.data.farhana;
    await run.openRow(s.name);
    await run.setUnpaidDays('1');
    await expect(run.panelNet()).toHaveText(P.moneyRe(33833));
    await expect(await run.cell(s.name, 'Exceptions')).toHaveText('1 unpaid day');
    await expect.poll(async () => (await P.rowFor(w.owner.api, w.data.runId, s)).net).toBe(33833);
    await page.context().close();
  });

  test('clearing the count returns the row to "Full month"; correcting a mistyped 20 to 2 restores the net at once', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    const s = w.data.spare;
    await run.openRow(s.name);
    await run.setUnpaidDays('20');
    await expect(run.panelNet()).toHaveText(P.moneyRe(40000 - P.round0((40000 * 20) / 30)));
    await run.setUnpaidDays('2');
    await expect(run.panelNet()).toHaveText(P.moneyRe(40000 - P.round0((40000 * 2) / 30)));
    await run.setUnpaidDays('');
    await expect(await run.cell(s.name, 'Exceptions')).toHaveText('Full month');
    await expect(run.panelNet()).toHaveText(P.moneyRe(40000));
    await expect.poll(async () => (await P.rowFor(w.owner.api, w.data.runId, s)).exception).toBe('None');
    await page.context().close();
  });
});

test.describe('Absence — computation and validation (API)', () => {
  test('every day of the month unpaid caps the deduction at the salary: net PKR 0, never negative', async () => {
    const fig = await P.absence(w.owner.api, w.data.runId, await rowId(w.data.capped), DIM);
    expect(fig.net).toBe(0);
    expect(fig.exception).toBe('UnpaidDays');
  });

  test('boundaries: 0 and empty are full month, the month length is allowed, one more / negative / decimal / text are refused (4xx, never 500)', async () => {
    const id = await rowId(w.data.spare);
    const cases: [unknown, number, string | null][] = [
      [0, 200, null],
      [null, 200, null],
      [DIM, 200, null],
      [DIM + 1, 400, `${MONTH_NAME} has ${DIM} days. Enter ${DIM} or fewer.`],
      [-1, 400, 'Enter a whole number of days.'],
      [2.5, 400, null],
      ['abc', 400, null],
    ];
    const log: string[] = [];
    for (const [value, status, message] of cases) {
      const res = await P.putAbsence(w.owner.api, w.data.runId, id, { unpaidDays: value });
      const body = await res.text();
      log.push(`PUT absence unpaidDays=${JSON.stringify(value)} -> ${res.status()} ${body.slice(0, 160)}`);
      expect(res.status(), `unpaidDays=${JSON.stringify(value)}: ${body.slice(0, 200)}`).toBe(status);
      if (message) expect(JSON.parse(body).errors.UnpaidDays).toContain(message);
    }
    await P.saveEvidence('absence-boundaries.txt', log.join('\n'));
    const fig = await P.absence(w.owner.api, w.data.runId, id, 0);
    expect(fig.exception).toBe('None');
    expect(fig.net).toBe(40000);
  });

  test('a staff member marked Left during the month: absence is refused and the panel input is read-only', async ({ browser }) => {
    const res = await P.putAbsence(w.owner.api, w.data.runId, await rowId(w.data.leaver), { unpaidDays: 1 });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('STAFF_LEFT');
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.openRow(w.data.leaver.name);
    await expect(run.unpaidDays).toBeDisabled();
    await expect(run.panelText(/^Left \d+ \w{3}\. Days after leaving are not payable\.$/)).toBeVisible();
    // One-offs stay available for a leaver.
    await expect(run.addOneOffLink()).toBeVisible();
    await page.context().close();
  });

  test('a staff member with no salary: the input is disabled with "Set this staff member\'s salary before recording absence." and a link to their profile [DB: salary hidden]', async ({ browser }) => {
    const res = await P.putAbsence(w.owner.api, w.data.runId, await rowId(w.data.noSalary), { unpaidDays: 1 });
    expect(res.status()).toBe(409);
    expect((await res.json()).message).toBe("Set this staff member's salary before recording absence.");
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.searchFor(w.data.noSalary.name);
    await run.openRow(w.data.noSalary.name);
    await expect(run.panelText("Set this staff member's salary before recording absence.")).toBeVisible();
    await expect(run.unpaidDays).toHaveCount(0);
    await expect(run.openProfileLink()).toBeVisible();
    await page.context().close();
  });

  test('unknown and malformed row ids answer 404, never 500', async () => {
    for (const id of ['00000000-0000-0000-0000-000000000000', 'garbage']) {
      const res = await P.putAbsence(w.owner.api, w.data.runId, id, { unpaidDays: 1 });
      expect(res.status(), id).toBe(404);
    }
    const res = await P.putAbsence(w.owner.api, 'garbage', await rowId(w.data.spare), { unpaidDays: 1 });
    expect(res.status()).toBe(404);
  });

  test('recording absence writes no audit entry per change (captured at publish instead)', async () => {
    const before = (await P.auditEntries(w.data.runId)).length;
    const id = await rowId(w.data.spare);
    await P.absence(w.owner.api, w.data.runId, id, 1);
    await P.absence(w.owner.api, w.data.runId, id, 0);
    expect((await P.auditEntries(w.data.runId)).length).toBe(before);
  });
});

// ── Policy variants ─────────────────────────────────────────────────────────────────────────────
interface Rules { wd: { staff: P.Staff; runId: string }; noPro?: { staff: P.Staff; runId: string; moveSql: string }; sandwich?: { staff: P.Staff; runId: string; moveSql: string } }
let r: P.World<Rules>;

async function freshVariant(policy: P.PolicySeed, salary: number, label: string) {
  // DB MANIPULATION: move the current-month draft to an old month so the product can create a new one.
  const cur = await (await r.owner.api.get('payroll-runs/current')).json();
  const moveSql = cur.runId ? await P.moveRunToMonth(cur.runId, P.monthStart(label === 'noPro' ? -12 : -13)) : '';
  await P.publishPolicy(r.owner.api, policy);
  const staff = await P.addStaff(r.owner.api, { salary, name: P.qaName(label === 'noPro' ? 'Noproration' : 'Sandwich') });
  const runId = await P.generateRun(r.owner.api);
  return { staff, runId, moveSql };
}

test.describe('Absence — policy variants', () => {
  test.beforeAll(async () => {
    test.setTimeout(20 * 60_000);
    r = await P.world<Rules>('rules', () => newCampusOwner('pay'), async (owner) => {
      await P.publishPolicy(owner.api, { dayRateBasis: 'WorkingDays', weeklyOffDays: ['Sun'] });
      const staff = await P.addStaff(owner.api, { salary: 50000, name: P.qaName('Workingdays') });
      return { wd: { staff, runId: await P.generateRun(owner.api) } };
    });
  });

  test('working-days basis: the day rate is salary ÷ (calendar days − weekly offs) of this month', async () => {
    const id = (await P.rowFor(r.owner.api, r.data.wd.runId, r.data.wd.staff)).id;
    let sundays = 0;
    for (let d = 1; d <= DIM; d++) if (P.dayOf(month, d).getUTCDay() === 0) sundays++;
    const working = DIM - sundays;
    const fig = await P.absence(r.owner.api, r.data.wd.runId, id, 2);
    expect(fig.net).toBe(50000 - P.round0((50000 * 2) / working));
  });

  test('proration off: recorded absence produces no deduction and no warning', async () => {
    if (!r.data.noPro) {
      r.data.noPro = await freshVariant({ prorationEnabled: false }, 40000, 'noPro');
      await P.persistWorld('rules', r.data);
    }
    const id = (await P.rowFor(r.owner.api, r.data.noPro.runId, r.data.noPro.staff)).id;
    const fig = await P.absence(r.owner.api, r.data.noPro.runId, id, 3);
    expect(fig.unpaidDays).toBe(3);
    expect(fig.net).toBe(40000);
  });

  test('sandwich on: a month calendar with the Sundays helper; Saturday + Monday makes Sunday unpaid too (3 days)', { tag: '@critical' }, async ({ browser }) => {
    if (!r.data.sandwich) {
      if (!r.data.noPro) { r.data.noPro = await freshVariant({ prorationEnabled: false }, 40000, 'noPro'); await P.persistWorld('rules', r.data); }
      r.data.sandwich = await freshVariant({ sandwichLeaveEnabled: true, weeklyOffDays: ['Sun'] }, 30000, 'sandwich');
      await P.persistWorld('rules', r.data);
    }
    const { staff, runId } = r.data.sandwich;
    // First Saturday of the month that has a Monday after it in the same month.
    let sat = 1;
    while (P.dayOf(month, sat).getUTCDay() !== 6) sat++;
    const page = await P.openApp(browser, r, P.runPath(runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.openRow(staff.name);
    await expect(run.panelText('Sundays between two unpaid days also count as unpaid.')).toBeVisible();
    await expect(run.unpaidDays).toHaveCount(0);
    await run.calendarDay(sat).click();
    await expect.poll(async () => (await P.rowFor(r.owner.api, runId, staff)).unpaidDays).toBe(1);
    await run.calendarDay(sat + 2).click();
    await expect(run.panelText(/^3 unpaid days, including 1 weekly off day between your dates$/)).toBeVisible();
    await expect.poll(async () => (await P.rowFor(r.owner.api, runId, staff)).unpaidDays).toBe(3);
    await expect(run.panelNet()).toHaveText(P.moneyRe(30000 - 3000));
    await page.screenshot({ path: P.shot('absence-sandwich-calendar.png'), fullPage: true });
    // Clicking a selected date deselects it (dates are a set).
    await run.calendarDay(sat + 2).click();
    await expect.poll(async () => (await P.rowFor(r.owner.api, runId, staff)).unpaidDays).toBe(1);
    await page.context().close();
  });

  test('sandwich on (API): dates outside the payroll month are refused with "Select dates in <Month> only."; duplicates collapse', async () => {
    test.skip(!r.data.sandwich, 'needs the sandwich variant (runs after the UI test)');
    const { staff, runId } = r.data.sandwich!;
    const id = (await P.rowFor(r.owner.api, runId, staff)).id;
    const outside = P.iso(P.dayOf(P.monthStart(1), 1));
    const res = await P.putAbsence(r.owner.api, runId, id, { unpaidDates: [outside] });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(`Select dates in ${MONTH_NAME} only.`);
    const d = P.iso(P.dayOf(month, 2));
    const dup = await P.putAbsence(r.owner.api, runId, id, { unpaidDates: [d, d, d] });
    expect(dup.status()).toBe(200);
    expect((await dup.json()).unpaidDays).toBe(1);
  });
});
