/**
 * 86eyqaue6 Preview Payroll Before Publish (PR 544).
 * World "preview" [DB: previous published run]: a run is generated and published by the product, then moved to last
 * month in the DB (the product only runs the current month). Between that run and this month's draft:
 *   Hina    24,000 → 27,000 (raise drops her out of "Travel allowance", salary ≤ 25,000)   → named "no longer match"
 *   Adeel   matched "Library allowance", which is then deactivated                     → named "no longer match"
 *   Kashif  26,000 matches the new "Band allowance" (26,000–26,500)                     → named "newly matches"
 *   Untick  keeps matching Travel allowance but it is unticked by hand on this draft    → NOT named
 *   Zainab  30,000 → 32,000                                                              → change + 2,000
 *   Ayesha  45,000, tax 5 %, EOBI 370, 2 unpaid days this month                          → change − 2,850
 *   Farhana no statutory rates while income tax and EOBI are on                          → missing-rate Warning
 * The missing-salary block lives in generate.spec.ts (that world has a salary-less staff member).
 */
import { expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

const month = P.monthStart();
const MONTH = P.monthLabel(month);
const MONTH_NAME = P.monthName(month);
const PREV = P.monthStart(-1);
const PREV_NAME = P.monthName(PREV);

type S = P.Staff;
interface Data { ayesha: S; hina: S; adeel: S; kashif: S; untick: S; zainab: S; farhana: S; prevRunId: string; moveSql: string; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('preview', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: true, eobiEnabled: true });
    const zero = { incomeTaxPercent: 0, eobiPerMonth: 0 };
    const ayesha = await P.addStaff(api, { salary: 45000, incomeTaxPercent: 5, eobiPerMonth: 370, name: P.qaName('Ayesha') });
    const hina = await P.addStaff(api, { salary: 24000, ...zero, name: P.qaName('Hina') });
    const adeel = await P.addStaff(api, { salary: 20000, designationId: P.DESIGNATION.librarian, ...zero, name: P.qaName('Adeel') });
    const kashif = await P.addStaff(api, { salary: 26000, ...zero, name: P.qaName('Kashif') });
    const untick = await P.addStaff(api, { salary: 22000, ...zero, name: P.qaName('Untick') });
    const zainab = await P.addStaff(api, { salary: 30000, ...zero, name: P.qaName('Zainab') });
    const farhana = await P.addStaff(api, { salary: 35000, name: P.qaName('Farhana') });
    await P.createItem(api, { name: 'Qa Travel allowance', type: 'Incentive', amountType: 'FlatAmount', amount: 1500, appliesTo: 'BaseSalaryRange', maximumSalary: 25000 });
    const library = await P.createItem(api, { name: 'Qa Library allowance', type: 'Incentive', amountType: 'FlatAmount', amount: 1000, appliesTo: 'Designation', designationId: P.DESIGNATION.librarian });
    await P.createItem(api, { name: 'Qa Late arrival fine', type: 'Deduction', amountType: 'FlatAmount', amount: 500, appliesTo: 'NoOne' });
    const prevRunId = await P.generateAndPublish(api);
    // DB MANIPULATION: the run just published becomes last month's run.
    const moveSql = await P.moveRunToMonth(prevRunId, PREV, new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 2, 6)));
    const today = P.iso(P.karachiToday());
    await P.reviseSalary(api, hina.id, 27000, today);
    await P.reviseSalary(api, zainab.id, 32000, today);
    await P.deactivateItem(api, library);
    await P.createItem(api, { name: 'Qa Band allowance', type: 'Incentive', amountType: 'FlatAmount', amount: 800, appliesTo: 'BaseSalaryRange', minimumSalary: 26000, maximumSalary: 26500 });
    const runId = await P.generateRun(api);
    const ar = await P.rowFor(api, runId, ayesha);
    await P.absence(api, runId, ar.id, 2);
    const ur = await P.rowFor(api, runId, untick);
    const travel = (await P.figures(api, runId, ur.id)).lines.find((l) => l.label === 'Qa Travel allowance')!;
    await P.setLine(api, runId, ur.id, travel.id, false);
    return { ayesha, hina, adeel, kashif, untick, zainab, farhana, prevRunId, moveSql, runId };
  });
});

async function openPreview(browser: import('@playwright/test').Browser) {
  const page = await P.openApp(browser, w, P.runPath(w.data.runId));
  const run = new PayrollRunPage(page);
  await run.expectDraftLoaded();
  await run.reviewAndPublish.click();
  await run.expectPreviewLoaded();
  return { page, run };
}

test.describe('Preview — the screen', () => {
  test('four tiles with the exact labels and sub-lines; earnings + incentives − deductions = total net; statutory only in the Deductions sub-line', { tag: '@critical' }, async ({ browser }) => {
    const api = await (await P.preview(w.owner.api, w.data.runId)).json();
    const { page, run } = await openPreview(browser);
    expect(await run.tileLabels()).toEqual(['Total earnings', 'Incentives', 'Deductions', 'Total net']);
    const earn = await run.tile('Total earnings');
    expect(earn.value).toMatch(P.moneyRe(api.totalEarnings));
    expect(earn.sub).toBe('7 staff members');
    expect((await run.tile('Incentives')).sub).toBe('allowances and bonuses');
    const ded = await run.tile('Deductions');
    expect(ded.value).toMatch(P.moneyRe(api.deductions));
    expect(ded.sub).toMatch(new RegExp(`^includes ${P.moneyRe(api.statutory).source} statutory$`));
    const net = await run.tile('Total net');
    expect(net.sub).toBe('payable this month');
    expect(net.value).toMatch(P.moneyRe(api.totalNet));
    expect(api.totalEarnings + api.incentives - api.deductions).toBe(api.totalNet);
    await page.screenshot({ path: P.shot('preview-screen.png'), fullPage: true });
    await page.context().close();
  });

  test('the change column: signed amount against the last published run, "No change" in grey, no Success/Danger colours', async ({ browser }) => {
    const { page, run } = await openPreview(browser);
    await run.pagination.waitFor();
    const d = w.data;
    const expected: [S, RegExp | string][] = [
      [d.ayesha, P.moneyRe(2850, '− ')], [d.zainab, P.moneyRe(2000, '+ ')], [d.hina, P.moneyRe(1500, '+ ')],
      [d.adeel, P.moneyRe(1000, '− ')], [d.kashif, P.moneyRe(800, '+ ')], [d.untick, P.moneyRe(1500, '− ')], [d.farhana, 'No change'],
    ];
    const header = (await run.headers()).find((h) => h.startsWith('Change from'))!;
    expect(header).toBeTruthy();
    const colors = new Set<string>();
    for (const [s, text] of expected) {
      const cell = await run.cell(s.name, header);
      await expect(cell).toHaveText(text);
      if (text !== 'No change') colors.add(await run.cellInk(cell));
    }
    expect(colors.size, 'every signed delta in one neutral ink').toBe(1);
    const [ink] = [...colors];
    const [r, g, b] = ink.match(/\d+/g)!.map(Number);
    expect(Math.abs(r - g) < 30 && Math.abs(g - b) < 40, `delta ink ${ink} is grey/black, not green or red`).toBe(true);
    const noChange = await run.cellInk(await run.cell(d.farhana.name, header));
    expect(noChange, '"No change" is lighter (Grey-500) than a delta').not.toBe(ink);
    await page.context().close();
  });

  test('P-PREVIEW-MONTH-COPY: strip, change header and note name the previous month as in the spec ("October", not "October 2026")', async ({ browser }) => {
    const { page, run } = await openPreview(browser);
    await expect(run.previewStrip).toHaveText(`Preview for ${MONTH}`);
    await page.screenshot({ path: P.shot('P-PREVIEW-MONTH-COPY.png'), fullPage: true });
    await expect(run.text(`Nothing is published yet. Check the change against ${PREV_NAME} before you publish.`)).toBeVisible();
    expect(await run.headers()).toContain(`Change from ${PREV_NAME}`);
    await page.context().close();
  });

  test('P-IRREVERSIBILITY-POSITION: the irreversibility line renders above the pagination footer with the exact copy', async ({ browser }) => {
    const { page, run } = await openPreview(browser);
    await expect(run.irreversibilityLine).toBeVisible();
    const line = await run.box(run.irreversibilityLine);
    const pager = await run.box(run.pagination);
    expect(line.y, 'line sits above the pagination footer').toBeLessThan(pager.y);
    await page.context().close();
  });

  test('P-PREVIEW-SEARCH: search and filter are hidden on the Preview; "Publish payroll" is the only orange element', async ({ browser }) => {
    const { page, run } = await openPreview(browser);
    expect(await run.buttonsFilledLike(run.publishPayroll)).toBe(1);
    await expect(run.exceptionsOnly).toHaveCount(0);
    await page.screenshot({ path: P.shot('P-PREVIEW-SEARCH.png'), fullPage: true });
    await expect(run.previewSearch).toHaveCount(0);
    await page.context().close();
  });

  test('"Back to draft" returns to the register with every exception intact; opening the Preview writes no audit entry', async ({ browser }) => {
    const before = (await P.auditEntries(w.data.runId)).length;
    const { page, run } = await openPreview(browser);
    await run.backToDraft.click();
    await run.expectDraftLoaded();
    await run.searchFor(w.data.ayesha.name);
    await expect(await run.cell(w.data.ayesha.name, 'Exceptions')).toHaveText('2 unpaid days');
    expect((await P.auditEntries(w.data.runId)).length).toBe(before);
    await page.context().close();
  });

  test('compute failure: inline Danger alert "We could not compute this payroll. Check your connection and try again." with Retry; the draft is untouched', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await page.route('**/preview', (route) => route.abort('internetdisconnected'));
    await run.reviewAndPublish.click();
    await expect(run.text('We could not compute this payroll. Check your connection and try again.')).toBeVisible();
    await page.screenshot({ path: P.shot('preview-compute-failure.png'), fullPage: true });
    await page.unroute('**/preview');
    await run.retryButton().click();
    await run.expectPreviewLoaded();
    await page.context().close();
  });
});

test.describe('Preview — warnings and the eligibility note', () => {
  test('a missing statutory rate warns above the totals (and above the note), naming the staff member, and does not block', async ({ browser }) => {
    const res = await P.preview(w.owner.api, w.data.runId);
    expect(res.status()).toBe(200);
    expect((await res.json()).missingRate.map((x: { name: string }) => x.name)).toEqual([w.data.farhana.name]);
    const { page, run } = await openPreview(browser);
    const warning = run.alert('1 staff member has no rate for a deduction that is switched on. No amount will be deducted from them.');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(w.data.farhana.name);
    const wBox = await run.box(warning);
    expect(wBox.y).toBeLessThan((await run.box(run.note())).y);
    expect(wBox.y).toBeLessThan((await run.box(run.firstTile())).y);
    await page.context().close();
  });

  test('the note names who no longer matches and who newly matches; hand-unticked and "No one by default" items are not named; it is neutral', async ({ browser }) => {
    const api = await (await P.preview(w.owner.api, w.data.runId)).json();
    const d = w.data;
    expect(api.noLongerMatch.map((x: { name: string }) => x.name).sort()).toEqual([d.adeel.name, d.hina.name].sort());
    expect(api.newlyMatch.map((x: { name: string }) => x.name)).toEqual([d.kashif.name]);
    const { page, run } = await openPreview(browser);
    const note = run.note();
    await expect(note).toContainText(`2 staff members no longer match an incentive they received in`);
    await expect(note).toContainText(`1 staff member newly matches an incentive:`);
    await expect(note).not.toContainText(d.untick.name);
    await expect(note).not.toContainText(d.ayesha.name);
    // Neutral: an informational note, not an alert; it sits above the totals; publishing is still offered.
    expect(await note.getAttribute('role')).toBe('note');
    expect((await run.box(note)).y).toBeLessThan((await run.box(run.firstTile())).y);
    await expect(run.publishPayroll).toBeEnabled();
    await page.context().close();
  });

  test('P-NAMES-UNREADABLE: staff names in the eligibility note and the statutory Warning are readable (contrast ≥ 4.5:1)', async ({ browser }) => {
    const { page, run } = await openPreview(browser);
    await page.screenshot({ path: P.shot('P-NAMES-UNREADABLE-preview-alerts.png') });
    const results: string[] = [];
    for (const name of [w.data.hina.name, w.data.farhana.name]) {
      const ratio = await run.contrastRatio(run.nameLink(name));
      results.push(`${name}: ${ratio.toFixed(2)}:1`);
    }
    await P.saveEvidence('P-NAMES-UNREADABLE-contrast.txt', results.join('\n'));
    for (const name of [w.data.hina.name, w.data.farhana.name]) {
      expect(await run.contrastRatio(run.nameLink(name)), `${name} text contrast`).toBeGreaterThanOrEqual(4.5);
    }
    await page.context().close();
  });

  test('a name in the note links to that staff member\'s row on the draft', async ({ browser }) => {
    const { page, run } = await openPreview(browser);
    await run.noteName(w.data.hina.name).click();
    await run.expectDraftLoaded();
    await expect(run.panel).toBeVisible();
    await expect(run.row(w.data.hina.name)).toBeVisible();
    await expect(run.rowAction(w.data.hina.name, 'Collapse')).toBeVisible();
    await page.context().close();
  });
});

test.describe('Preview — blocking checks', () => {
  test('a negative net blocks with "Deductions are larger than earnings for 1 staff member. Reduce a deduction to continue." and the name; the draft stays intact', async ({ browser }) => {
    const s = w.data.zainab;
    const r = await P.rowFor(w.owner.api, w.data.runId, s);
    let f = await P.figures(w.owner.api, w.data.runId, r.id);
    let big = f.lines.find((l) => l.label === 'Qa Over-recovery');
    if (!big) { f = await P.oneOff(w.owner.api, w.data.runId, r.id, { type: 'Deduction', label: 'Qa Over-recovery', amount: 32000, reason: 'Force a negative net' }); big = f.lines.find((l) => l.label === 'Qa Over-recovery')!; }
    const fine = f.lines.find((l) => l.label === 'Qa Late arrival fine')!;
    await P.setLine(w.owner.api, w.data.runId, r.id, big.id, true);
    await P.setLine(w.owner.api, w.data.runId, r.id, fine.id, true);
    try {
      const page = await P.openApp(browser, w, P.runPath(w.data.runId));
      const run = new PayrollRunPage(page);
      await run.expectDraftLoaded();
      await run.reviewAndPublish.click();
      const alert = run.text('Deductions are larger than earnings for 1 staff member. Reduce a deduction to continue.');
      await expect(alert).toBeVisible();
      await expect(run.nameLink(s.name)).toBeVisible();
      await expect(run.previewStrip).toHaveCount(0);
      await run.searchFor(w.data.ayesha.name);
      await expect(await run.cell(w.data.ayesha.name, 'Exceptions')).toHaveText('2 unpaid days');
      await page.screenshot({ path: P.shot('preview-blocked-negative-net.png'), fullPage: true });
      // Publish is refused server-side for the same reason.
      const pub = await P.publish(w.owner.api, w.data.runId);
      expect(pub.status()).toBe(409);
      expect((await pub.json()).code).toBe('PREVIEW_BLOCKED');
      await page.context().close();
    } finally {
      await P.setLine(w.owner.api, w.data.runId, r.id, big.id, false);
      await P.setLine(w.owner.api, w.data.runId, r.id, fine.id, false);
    }
  });
});
