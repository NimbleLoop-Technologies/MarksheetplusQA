/**
 * 86eyqaudw Post a Payroll Adjustment (PR 544).
 * World "adjust": tax + EOBI on. Ayesha (45,000, tax 5 %, EOBI 370) net 42,380, marked paid; Bilal 38,000 (rates 0);
 * Sana 24,000 left on the 5th. The first test checks the draft has no adjustment path, then publishes.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

const month = P.monthStart();
const MONTH = P.monthLabel(month);
const MONTH_NAME = P.monthName(month);
interface Data { ayesha: P.Staff; bilal: P.Staff; sana: P.Staff; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('adjust', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: true, eobiEnabled: true });
    const ayesha = await P.addStaff(api, { salary: 45000, incomeTaxPercent: 5, eobiPerMonth: 370, name: P.qaName('Ayesha') });
    const bilal = await P.addStaff(api, { salary: 38000, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Bilal') });
    const sana = await P.addStaff(api, { salary: 24000, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Sana') });
    await P.markLeft(api, sana.id, P.iso(P.dayOf(month, 5)));
    return { ayesha, bilal, sana, runId: await P.generateRun(api) };
  });
});

const sid = () => randomUUID().replace(/-/g, '');
const adjustments = (staffId: string) => P.sql(`select "Direction" as direction, "Amount"::float as amount, "Reason" as reason, "SubmissionId" as submission from "PayrollAdjustments" where "PayrollRunId" = ${P.q(w.data.runId)} and "StaffMemberId" = ${P.q(staffId)} order by "PostedAtUtc"`);
async function ensurePublished() {
  if ((await P.register(w.owner.api, w.data.runId)).status === 'Draft') {
    await P.publishOk(w.owner.api, w.data.runId);
    await P.markPaid(w.owner.api, w.data.runId, (await P.rowFor(w.owner.api, w.data.runId, w.data.ayesha)).id);
  }
  for (const s of [w.data.ayesha, w.data.bilal]) await P.waitForLedger(w.owner.tenantId, P.originPublish(w.data.runId, s.id));
}

test.describe('Adjustment — entry points', () => {
  test('no adjustment path exists on a draft (UI has no link, API refuses with "A draft is edited directly…")', async ({ browser }) => {
    test.skip((await P.register(w.owner.api, w.data.runId)).status !== 'Draft', 'already published (worker restart)');
    const res = await P.postAdjustment(w.owner.api, w.data.runId, { staffMemberId: w.data.bilal.id, direction: 'PayMore', amount: 100, reason: 'Draft try' });
    expect(res.status()).toBe(409);
    expect((await res.json()).message).toBe('A draft is edited directly. Adjustments are for published runs.');
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await expect(run.postAdjustment).toHaveCount(0);
    await page.context().close();
  });

  test('from the correction line: empty staff, "Pay more" default, the "does not change the run" line, and every field\'s exact copy', async ({ browser }) => {
    await ensurePublished();
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await run.postAdjustment.click();
    await expect(run.dialogHeading()).toHaveText(`Post an adjustment to ${MONTH}`);
    await expect(run.adjustmentDirection('Pay more')).toBeChecked();
    await expect(run.dialogText(`This does not change the ${MONTH_NAME} run. It posts a separate entry against this staff member.`)).toBeVisible();
    expect((await run.adjustmentStaffOptions()).sort()).toEqual([w.data.ayesha.name, w.data.bilal.name, w.data.sana.name].sort());
    await run.dialogButton('Post adjustment').click();
    await expect(run.dialogText('Choose the staff member this adjustment is for.')).toBeVisible();
    await expect(run.dialogText('Enter an amount.')).toBeVisible();
    await expect(run.dialogText('Enter a reason. An adjustment without one cannot be explained at year end.')).toBeVisible();
    await run.fillAdjustment({ staff: w.data.bilal.name, amount: '0', reason: 'x'.repeat(201) });
    await run.dialogButton('Post adjustment').click();
    await expect(run.dialogText('Enter an amount above zero.')).toBeVisible();
    await expect(run.dialogText('Use 200 characters or fewer.')).toBeVisible();
    await run.fillAdjustment({ amount: '38001', reason: 'Too big' });
    await run.dialogButton('Post adjustment').click();
    await expect(run.dialogText('An amount cannot be larger than the monthly salary. Post two adjustments if it genuinely is.')).toBeVisible();
    await page.screenshot({ path: P.shot('adjustment-validation.png') });
    expect(await adjustments(w.data.bilal.id)).toHaveLength(0);
    await page.context().close();
  });

  test('Cancel, the close icon and Escape dismiss without posting', async ({ browser }) => {
    await ensurePublished();
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    for (const how of ['cancel', 'icon', 'escape']) {
      await run.postAdjustment.click();
      await run.fillAdjustment({ staff: w.data.bilal.name, amount: '100', reason: `Dismissed by ${how}` });
      if (how === 'cancel') await run.dialogButton('Cancel').click();
      else if (how === 'icon') await run.dialogCloseIcon().click();
      else await page.keyboard.press('Escape');
      await expect(run.dialog).toHaveCount(0);
    }
    expect(await adjustments(w.data.bilal.id)).toHaveLength(0);
    await page.context().close();
  });

  test('from a payslip, the staff member is pre-selected', async ({ browser }) => {
    await ensurePublished();
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await run.rowAction(w.data.ayesha.name, 'View payslip').click();
    await run.dialogButton('Post an adjustment').click();
    await expect(run.dialogTitled(`Post an adjustment to ${MONTH}`)).toBeVisible();
    await expect(run.adjustmentStaff()).toHaveValue(w.data.ayesha.id);
    await page.context().close();
  });
});

test.describe('Adjustment — posting', () => {
  test('"Pay more" on a paid line: toast names the staff member; Dr salary expense, Cr staff payable; run and status unchanged; statutory untouched; audited with the reason', { tag: '@critical' }, async ({ browser }) => {
    await ensurePublished();
    const s = w.data.ayesha;
    const before = await P.register(w.owner.api, w.data.runId);
    const statBefore = await P.accountBalance(w.owner.tenantId, 'LIABILITIES:STATUTORY');
    const reason = 'Fuel allowance unticked in error at run time';
    if (!(await adjustments(s.id)).some((a) => a.reason === reason)) {
      const page = await P.openApp(browser, w, P.runPath(w.data.runId));
      const run = new PayrollRunPage(page);
      await run.expectPublishedLoaded();
      await run.postAdjustment.click();
      await run.fillAdjustment({ staff: s.name, direction: 'Pay more', amount: '2000', reason });
      await run.dialogButton('Post adjustment').click();
      await expect(run.toast(`Adjustment posted for ${s.name}.`)).toBeVisible();
      await expect(run.dialog).toHaveCount(0);
      await expect(await run.cell(s.name, 'Status')).toHaveText('Paid');
      await page.context().close();
    }
    const adj = (await adjustments(s.id)).find((a) => a.reason === reason)!;
    expect(adj).toMatchObject({ direction: 'Pay more', amount: 2000 });
    const legs = await P.waitForLedger(w.owner.tenantId, P.originAdjustment(w.data.runId, adj.submission));
    expect(legs.map((l) => [l.code.replace(s.id, '{staff}'), l.debit, l.credit])).toEqual([['EXPENSES:SALARY', 2000, 0], ['LIABILITIES:STAFF:{staff}', 0, 2000]]);
    const after = await P.register(w.owner.api, w.data.runId);
    expect(after.rows.map((r) => [r.id, r.net, r.paymentStatus])).toEqual(before.rows.map((r) => [r.id, r.net, r.paymentStatus]));
    expect(await P.accountBalance(w.owner.tenantId, 'LIABILITIES:STATUTORY')).toBe(statBefore);
    // Her ledger account shows PKR 2,000 more owed (she was paid, so it went to 0 first).
    await P.waitForLedger(w.owner.tenantId, P.originPaid(w.data.runId, s.id));
    expect(await P.accountBalance(w.owner.tenantId, `LIABILITIES:STAFF:${s.id}`)).toBe(2000);
    const audit = (await P.auditEntries(w.data.runId)).filter((a) => a.action === 'Adjustment posted' && a.snapshot.Reason === reason);
    expect(audit).toHaveLength(1);
    expect(audit[0].snapshot).toMatchObject({ StaffMemberId: s.id, Direction: 'PayMore', Amount: 2000, Month: MONTH });
  });

  test('"Recover" debits staff payable and credits salary expense', async () => {
    await ensurePublished();
    const s = w.data.bilal;
    let adj = (await adjustments(s.id)).find((a) => a.reason === 'Two unpaid days recorded after the run was published');
    if (!adj) {
      const res = await P.postAdjustment(w.owner.api, w.data.runId, { staffMemberId: s.id, direction: 'Recover', amount: 3000, reason: 'Two unpaid days recorded after the run was published' });
      expect(res.status()).toBe(200);
      adj = (await adjustments(s.id)).find((a) => a.reason === 'Two unpaid days recorded after the run was published')!;
    }
    const legs = await P.waitForLedger(w.owner.tenantId, P.originAdjustment(w.data.runId, adj.submission));
    expect(legs.map((l) => [l.code.replace(s.id, '{staff}'), l.debit, l.credit])).toEqual([['LIABILITIES:STAFF:{staff}', 3000, 0], ['EXPENSES:SALARY', 0, 3000]]);
  });

  test('a double press of the same submission posts once; a deliberate second submission posts again', async () => {
    await ensurePublished();
    const s = w.data.bilal;
    const before = (await adjustments(s.id)).length;
    const submission = sid();
    const body = { staffMemberId: s.id, direction: 'PayMore', amount: 150, reason: 'Double press check', submissionId: submission };
    const results = await Promise.all([P.postAdjustment(w.owner.api, w.data.runId, body), P.postAdjustment(w.owner.api, w.data.runId, body)]);
    await P.saveEvidence('adjustment-double-press.txt', (await Promise.all(results.map(async (r) => `${r.status()} ${await r.text()}`))).join('\n'));
    results.forEach((r) => expect(r.status()).toBe(200));
    expect((await adjustments(s.id)).length).toBe(before + 1);
    await P.waitForLedger(w.owner.tenantId, P.originAdjustment(w.data.runId, submission));
    expect(await P.ledgerTxCount(w.owner.tenantId, P.originAdjustment(w.data.runId, submission))).toBe(1);
    const second = await P.postAdjustment(w.owner.api, w.data.runId, { ...body, submissionId: sid() });
    expect(second.status()).toBe(200);
    expect((await adjustments(s.id)).length).toBe(before + 2);
  });

  test('a staff member who has left can be adjusted', async () => {
    await ensurePublished();
    const res = await P.postAdjustment(w.owner.api, w.data.runId, { staffMemberId: w.data.sana.id, direction: 'PayMore', amount: 500, reason: 'Final settlement top-up' });
    expect(res.status()).toBe(200);
  });

  test('a closed month can be adjusted [DB: run cloned into last month]', async () => {
    await ensurePublished();
    let prev = (await P.sql<{ id: string }>(`select "Id" as id from "PayrollRuns" where "TenantId" = ${P.q(w.owner.tenantId)} and "Month" = ${P.q(P.iso(P.monthStart(-1)))}::timestamptz`))[0]?.id;
    if (!prev) prev = (await P.clonePublishedRunToMonth(w.data.runId, P.monthStart(-1))).runId;
    const res = await P.postAdjustment(w.owner.api, prev, { staffMemberId: w.data.bilal.id, direction: 'PayMore', amount: 700, reason: 'Late correction to last month' });
    expect(res.status(), await res.text()).toBe(200);
  });

  test('network failure keeps the modal open with "We could not post this adjustment. Check your connection and try again." and every value', async ({ browser }) => {
    await ensurePublished();
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await run.postAdjustment.click();
    await run.fillAdjustment({ staff: w.data.bilal.name, direction: 'Recover', amount: '250', reason: 'Typed while offline' });
    await page.route('**/adjustments', (route) => route.abort('internetdisconnected'));
    await run.dialogButton('Post adjustment').click();
    await expect(run.dialogText('We could not post this adjustment. Check your connection and try again.')).toBeVisible();
    await expect(run.adjustmentStaff()).toHaveValue(w.data.bilal.id);
    await expect(run.adjustmentDirection('Recover')).toBeChecked();
    await expect(run.adjustmentField('Amount (PKR)')).toHaveValue('250');
    await expect(run.adjustmentField('Reason')).toHaveValue('Typed while offline');
    await page.screenshot({ path: P.shot('adjustment-network-failure.png') });
    expect((await adjustments(w.data.bilal.id)).some((a) => a.reason === 'Typed while offline')).toBe(false);
    await page.context().close();
  });

  test('API boundaries: amount 1 / = salary accepted, 0 / salary+1 refused, reason 200/201, staff not on the run, bad direction; never 500', async () => {
    await ensurePublished();
    const s = w.data.bilal;
    const base = { staffMemberId: s.id, direction: 'PayMore', amount: 1, reason: 'Boundary' };
    const cases: [Record<string, unknown>, number, string | null][] = [
      [{ amount: 1 }, 200, null],
      [{ amount: 38000 }, 200, null],
      [{ amount: 0 }, 400, 'Enter an amount above zero.'],
      [{ amount: 38001 }, 400, 'An amount cannot be larger than the monthly salary. Post two adjustments if it genuinely is.'],
      [{ amount: null }, 400, 'Enter an amount.'],
      [{ reason: 'R'.repeat(200) }, 200, null],
      [{ reason: 'R'.repeat(201) }, 400, 'Use 200 characters or fewer.'],
      [{ reason: ' ' }, 400, 'Enter a reason. An adjustment without one cannot be explained at year end.'],
      [{ staffMemberId: '' }, 400, 'Choose the staff member this adjustment is for.'],
      [{ staffMemberId: '00000000-0000-0000-0000-000000000000' }, 400, 'Choose the staff member this adjustment is for.'],
      [{ staffMemberId: 'garbage' }, 400, 'Choose the staff member this adjustment is for.'],
      [{ direction: 'Refund' }, 400, null],
      [{ amount: 'abc' }, 400, null],
    ];
    const log: string[] = [];
    for (const [patch, status, message] of cases) {
      const res = await P.postAdjustment(w.owner.api, w.data.runId, { ...base, ...patch });
      const text = await res.text();
      log.push(`POST adjustment ${JSON.stringify(patch).slice(0, 70)} -> ${res.status()} ${text.slice(0, 160)}`);
      expect(res.status(), `${JSON.stringify(patch).slice(0, 80)}: ${text.slice(0, 200)}`).toBe(status);
      if (message) expect(text).toContain(message);
    }
    expect((await P.postAdjustment(w.owner.api, 'garbage', base)).status()).toBe(404);
    await P.saveEvidence('adjustment-boundaries.txt', log.join('\n'));
  });

  test('P-RECOVER-CAP: Recover follows the same rule as Pay more — 1 to the monthly salary — before and after payment, not "what the run owes"', async () => {
    await ensurePublished();
    // 86eyqaudw Field Specifications: Amount "1 to the staff member's monthly salary"; the only refusal is
    // "An amount cannot be larger than the monthly salary. Post two adjustments if it genuinely is."
    // Sana (salary 24,000, left on the 5th, net ~4,000, Unpaid) and Ayesha (salary 45,000, net 42,380, Paid).
    const log: string[] = [];
    const post = async (s: P.Staff, amount: number) => {
      const res = await P.postAdjustment(w.owner.api, w.data.runId, { staffMemberId: s.id, direction: 'Recover', amount, reason: `Recover ${amount} (rule check)` });
      const text = await res.text();
      log.push(`Recover ${amount} for ${s.name} (salary ${s.salary}) -> ${res.status()} ${text.slice(0, 220)}`);
      return { status: res.status(), text };
    };
    const unpaidAboveNet = await post(w.data.sana, 5000);      // above what the run owes, within salary, line Unpaid
    const paidAboveNet = await post(w.data.ayesha, 45000);     // = salary: above the frozen net (+ any pay-mores), line Paid
    const aboveSalary = await post(w.data.sana, 24001);        // above salary: the one refusal the story specifies
    await P.saveEvidence('P-RECOVER-CAP.txt', log.join('\n'));
    expect(aboveSalary.status).toBe(400);
    expect(aboveSalary.text).toContain('An amount cannot be larger than the monthly salary. Post two adjustments if it genuinely is.');
    expect(unpaidAboveNet.status, unpaidAboveNet.text).toBe(200);
    expect(paidAboveNet.status, paidAboveNet.text).toBe(200);
  });

  test('P-ADJ-ERROR-COPY: a refused adjustment shows the server\'s reason in the modal, not "Check your connection"', async ({ browser }) => {
    await ensurePublished();
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    // The server's validation refusal (same ProblemDetails shape the API returns for an Amount error).
    const REASON = 'QA: the server refused this adjustment for a stated reason.';
    await page.route('**/adjustments', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 400, contentType: 'application/problem+json', body: JSON.stringify({ type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1', title: 'One or more validation errors occurred.', status: 400, errors: { Amount: [REASON] } }) })
      : route.continue());
    await run.postAdjustment.click();
    await run.fillAdjustment({ staff: w.data.sana.name, direction: 'Recover', amount: '1000', reason: 'Server refusal from the UI' });
    await run.dialogButton('Post adjustment').click();
    await expect(run.dialogText(/We could not post this adjustment|QA: the server refused/)).toBeVisible();
    await page.screenshot({ path: P.shot('P-ADJ-ERROR-COPY.png') });
    await expect(run.dialogText(REASON)).toBeVisible();
    await page.context().close();
  });

  test('P-ADJ-REGISTER: the adjustment appears in the Incentives & Deductions Register', async ({ browser }) => {
    await ensurePublished();
    const page = await P.openApp(browser, w, '/accounts/staff-payroll/incentives-and-deductions');
    const run = new PayrollRunPage(page);
    await expect(run.title).toBeVisible();
    await page.screenshot({ path: P.shot('P-ADJ-REGISTER-library-page.png'), fullPage: true });
    await expect(run.text('Fuel allowance unticked in error at run time')).toBeVisible();
    await page.context().close();
  });
});
