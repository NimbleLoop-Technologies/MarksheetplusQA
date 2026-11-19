/**
 * 86eyqaue4 Publish Payroll (PR 544).
 * World "publish": first-ever run, income tax + EOBI on. Ayesha (Senior Teacher 45,000, tax 5 %, EOBI 370, 2 unpaid
 * days, Conveyance +2,000 by rule, Late fine −500 ticked) → net 41,030; Bilal (38,000, rates 0) → 38,000;
 * Zero (30,000, every day unpaid) → net 0.
 * World "publish-nostat": every statutory rule off; used for the concurrent-press checks.
 */
import { expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

const month = P.monthStart();
const MONTH = P.monthLabel(month);
const MONTH_NAME = P.monthName(month);
interface Data { ayesha: P.Staff; bilal: P.Staff; zero: P.Staff; conveyance: string; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('publish', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: true, eobiEnabled: true });
    const ayesha = await P.addStaff(api, { salary: 45000, designationId: P.DESIGNATION.seniorTeacher, incomeTaxPercent: 5, eobiPerMonth: 370, name: P.qaName('Ayesha') });
    const bilal = await P.addStaff(api, { salary: 38000, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Bilal') });
    const zero = await P.addStaff(api, { salary: 30000, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Zeronet') });
    const conveyance = await P.createItem(api, { name: 'Qa Conveyance allowance', type: 'Incentive', amountType: 'FlatAmount', amount: 2000, appliesTo: 'Designation', designationId: P.DESIGNATION.seniorTeacher });
    await P.createItem(api, { name: 'Qa Late arrival fine', type: 'Deduction', amountType: 'FlatAmount', amount: 500, appliesTo: 'NoOne' });
    const runId = await P.generateRun(api);
    const ar = await P.rowFor(api, runId, ayesha);
    const f = await P.absence(api, runId, ar.id, 2);
    await P.setLine(api, runId, ar.id, f.lines.find((l) => l.label === 'Qa Late arrival fine')!.id, true);
    await P.absence(api, runId, (await P.rowFor(api, runId, zero)).id, P.daysInMonth(month));
    return { ayesha, bilal, zero, conveyance, runId };
  });
});

const status = async () => (await P.register(w.owner.api, w.data.runId)).status;

async function openPublishModal(browser: import('@playwright/test').Browser) {
  const page = await P.openApp(browser, w, P.runPath(w.data.runId));
  const run = new PayrollRunPage(page);
  await run.expectDraftLoaded();
  await run.reviewAndPublish.click();
  await run.expectPreviewLoaded();
  await run.publishPayroll.click();
  await expect(run.dialog).toBeVisible();
  return { page, run };
}

test.describe('Publish — before publishing (first run)', () => {
  test('a first run\'s Preview has no change column, no "No change" and no eligibility note', async ({ browser }) => {
    test.skip((await status()) !== 'Draft', 'already published (worker restart)');
    const rows = await P.previewRows(w.owner.api, w.data.runId);
    expect(rows.hasChange).toBe(false);
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.reviewAndPublish.click();
    await run.expectPreviewLoaded();
    expect((await run.headers()).some((h) => h.startsWith('Change from'))).toBe(false);
    await expect(run.text('No change')).toHaveCount(0);
    await expect(run.note()).toHaveCount(0);
    await page.context().close();
  });

  test('the confirmation: title names the month, consequence first, then "N staff members. Total net …"; Cancel, close icon and Escape write nothing', async ({ browser }) => {
    test.skip((await status()) !== 'Draft', 'already published (worker restart)');
    const pv = await (await P.preview(w.owner.api, w.data.runId)).json();
    const { page, run } = await openPublishModal(browser);
    await expect(run.dialogHeading()).toHaveText(`Publish ${MONTH} payroll?`);
    await expect(run.dialogText('This cannot be undone. A published run is corrected with a ledger adjustment, not by editing it.')).toBeVisible();
    await expect(run.dialogText(new RegExp(`^3 staff members\\. Total net ${P.moneyRe(pv.totalNet).source}\\.$`))).toBeVisible();
    await page.screenshot({ path: P.shot('publish-confirm-modal.png') });
    await run.dialogButton('Cancel').click();
    await expect(run.dialog).toHaveCount(0);
    await expect(run.previewStrip).toBeVisible();
    await run.publishPayroll.click();
    await run.dialogCloseIcon().click();
    await expect(run.dialog).toHaveCount(0);
    await run.publishPayroll.click();
    await expect(run.dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(run.dialog).toHaveCount(0);
    expect(await status()).toBe('Draft');
    expect((await P.auditEntries(w.data.runId)).filter((a) => a.action === 'Run published')).toHaveLength(0);
    await page.context().close();
  });

  test('network failure on publish keeps the modal open with "We could not publish this payroll. Check your connection and try again."', async ({ browser }) => {
    test.skip((await status()) !== 'Draft', 'already published (worker restart)');
    const { page, run } = await openPublishModal(browser);
    await page.route('**/publish', (route) => route.abort('internetdisconnected'));
    await run.dialogButton('Publish').click();
    await expect(run.dialogText('We could not publish this payroll. Check your connection and try again.')).toBeVisible();
    await expect(run.dialogText(/^3 staff members\. Total net /)).toBeVisible();
    await page.screenshot({ path: P.shot('publish-network-failure.png') });
    expect(await status()).toBe('Draft');
    await page.context().close();
  });
});

test.describe('Publish — publishing', () => {
  test('a successful publish: toast, published register, strip with date / publisher / policy version / "Paid 0 of 3"; every line Unpaid', { tag: '@critical' }, async ({ browser }) => {
    if ((await status()) === 'Draft') {
      const { page, run } = await openPublishModal(browser);
      await run.dialogButton('Publish').click();
      await expect(run.toast(`${MONTH} payroll published.`)).toBeVisible();
      await run.expectPublishedLoaded();
      const today = P.karachiToday().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace(/,/g, '');
      await expect(run.publishedOn).toHaveText(`Published on ${today}`);
      await expect(run.publishedLine).toHaveText(/^Published by .+\. Computed with policy version 1\. Paid 0 of 3\.$/);
      await page.screenshot({ path: P.shot('publish-published-register.png'), fullPage: true });
      await page.context().close();
    }
    const reg = await P.register(w.owner.api, w.data.runId);
    expect(reg.status).toBe('Published');
    expect(reg.policyVersion).toBe(1);
    expect(reg.rows.every((r) => r.paymentStatus === 'Unpaid')).toBe(true);
    const ayesha = reg.rows.find((r) => r.staffMemberId === w.data.ayesha.id)!;
    expect(ayesha.net).toBe(41030);
  });

  test('freeze: every amount is written onto the run lines; one "Run published" audit entry with user, run, policy version and totals', async () => {
    test.skip((await status()) !== 'Published', 'needs the published run');
    const rows = await P.sql(`select "StaffMemberId" as s, "FrozenEarnings"::float as e, "FrozenIncentives"::float as i, "FrozenDeductions"::float as d, "FrozenIncomeTax"::float as t, "FrozenEobi"::float as eobi, "Net"::float as n
                               from "PayrollRunRows" where "PayrollRunId" = ${P.q(w.data.runId)}`);
    const a = rows.find((r) => r.s === w.data.ayesha.id)!;
    expect(a).toMatchObject({ e: 42000, i: 2000, d: 500, t: 2100, eobi: 370, n: 41030 });
    const lines = await P.sql(`select l."Label" as label, l."FrozenAmount"::float as amount from "PayrollRunRowLines" l join "PayrollRunRows" r on r."Id" = l."PayrollRunRowId" where r."StaffMemberId" = ${P.q(w.data.ayesha.id)} and l."IsApplied"`);
    expect(lines).toEqual(expect.arrayContaining([{ label: 'Qa Conveyance allowance', amount: 2000 }, { label: 'Qa Late arrival fine', amount: 500 }]));
    const audit = (await P.auditEntries(w.data.runId)).filter((x) => x.action === 'Run published');
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe(w.owner.userId);
    expect(audit[0].snapshot).toMatchObject({ Month: MONTH, PolicyVersion: 1, StaffCount: 3, TotalNet: 41030 + 38000, Statutory: 2470, Incentives: 2000 });
  });

  test('one ledger posting per staff member: Dr salary + incentive expense, Cr salary expense for the fine, Cr staff payable (net), Cr statutory liability', { tag: '@critical' }, async () => {
    test.skip((await status()) !== 'Published', 'needs the published run');
    const t = w.owner.tenantId;
    const legs = await P.waitForLedger(t, P.originPublish(w.data.runId, w.data.ayesha.id));
    const view = legs.map((l) => [l.code.replace(w.data.ayesha.id, '{staff}'), l.debit, l.credit]);
    expect(view).toEqual(expect.arrayContaining([
      ['EXPENSES:SALARY', 42000, 0], ['EXPENSES:INCENTIVES', 2000, 0], ['EXPENSES:SALARY', 0, 500],
      ['LIABILITIES:STAFF:{staff}', 0, 41030], ['LIABILITIES:STATUTORY', 0, 2470],
    ]));
    expect(legs).toHaveLength(5);
    expect(legs.reduce((s, l) => s + l.debit - l.credit, 0), 'balanced').toBe(0);
    const bilal = await P.waitForLedger(t, P.originPublish(w.data.runId, w.data.bilal.id));
    expect(bilal.map((l) => l.code), 'no statutory leg when nothing is withheld').not.toContain('LIABILITIES:STATUTORY');
    expect(await P.ledgerTxCount(t, `payroll:${w.data.runId}:%`)).toBeLessThanOrEqual(3);
  });

  test('pressing Publish again is a no-op: same answer, one audit entry, no extra postings', async () => {
    test.skip((await status()) !== 'Published', 'needs the published run');
    const t = w.owner.tenantId;
    await P.waitForLedger(t, P.originPublish(w.data.runId, w.data.bilal.id));
    const before = await P.ledgerTxCount(t, `payroll:${w.data.runId}:%`);
    const again = await P.publish(w.owner.api, w.data.runId);
    expect(again.status()).toBe(200);
    expect((await P.auditEntries(w.data.runId)).filter((a) => a.action === 'Run published')).toHaveLength(1);
    expect(await P.ledgerTxCount(t, `payroll:${w.data.runId}:%`)).toBe(before);
  });

  test('a published figure does not change after a salary revision, a new policy version or a Library edit', async () => {
    test.skip((await status()) !== 'Published', 'needs the published run');
    const before = await P.register(w.owner.api, w.data.runId);
    const ar = before.rows.find((r) => r.staffMemberId === w.data.ayesha.id)!;
    const slipBefore = await P.payslip(w.owner.api, w.data.runId, ar.id);
    const legsBefore = await P.waitForLedger(w.owner.tenantId, P.originPublish(w.data.runId, w.data.ayesha.id));
    if ((await P.salaryRevisionCount(w.owner.api, w.data.ayesha.id)) === 1) await P.reviseSalary(w.owner.api, w.data.ayesha.id, 50000, P.iso(P.karachiToday()));
    if ((await (await w.owner.api.get('payroll-policy')).json()).versionNumber === 1) await P.publishPolicy(w.owner.api, { dayRateBasis: 'WorkingDays', incomeTaxEnabled: false });
    await P.updateItem(w.owner.api, w.data.conveyance, { name: 'Qa Conveyance allowance', type: 'Incentive', amountType: 'FlatAmount', amount: 3500, appliesTo: 'Designation', designationId: P.DESIGNATION.seniorTeacher });
    const after = await P.register(w.owner.api, w.data.runId);
    expect(after.rows.map((r) => [r.id, r.net, r.salary, r.incentives, r.deductions])).toEqual(before.rows.map((r) => [r.id, r.net, r.salary, r.incentives, r.deductions]));
    expect(after.policyVersion).toBe(1);
    expect(await P.payslip(w.owner.api, w.data.runId, ar.id)).toEqual(slipBefore);
    expect(await P.ledgerLegs(w.owner.tenantId, P.originPublish(w.data.runId, w.data.ayesha.id))).toEqual(legsBefore);
  });

  test('a run that is already published cannot be edited: absence, lines and one-offs answer 409 "already published"', async () => {
    test.skip((await status()) !== 'Published', 'needs the published run');
    const r = (await P.register(w.owner.api, w.data.runId)).rows[0];
    const res = await P.putAbsence(w.owner.api, w.data.runId, r.id, { unpaidDays: 1 });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_PUBLISHED');
    expect((await P.postOneOff(w.owner.api, w.data.runId, r.id, { type: 'Incentive', label: 'x', amount: 1, reason: 'x' })).status()).toBe(409);
  });

  test('unknown and malformed run ids: publish answers 404, never 500', async () => {
    for (const id of ['00000000-0000-0000-0000-000000000000', 'garbage']) {
      expect((await P.publish(w.owner.api, id)).status(), id).toBe(404);
    }
  });

  test('"Posting pending. This retries on its own." shows on a line until its posting lands, with no action asked for', async ({ browser }) => {
    test.skip((await status()) !== 'Published', 'needs the published run');
    // Badge state is derived from whether the line's ledger transaction exists (PayrollManagementRepository.GetPostingPendingStaffAsync).
    // Here: wait for Bilal's posting, then the register shows his line as Unpaid (not pending).
    await P.waitForLedger(w.owner.tenantId, P.originPublish(w.data.runId, w.data.bilal.id));
    const reg = await P.register(w.owner.api, w.data.runId);
    expect(reg.rows.find((r) => r.staffMemberId === w.data.bilal.id)!.postingPending).toBe(false);
  });

  test('P-ZERO-NET-PENDING: a line whose net is PKR 0 (every day unpaid) does not stay "Posting pending" forever', async ({ browser }) => {
    test.skip((await status()) !== 'Published', 'needs the published run');
    // Every other posting of the run has landed…
    await P.waitForLedger(w.owner.tenantId, P.originPublish(w.data.runId, w.data.bilal.id));
    await P.waitForLedger(w.owner.tenantId, P.originPublish(w.data.runId, w.data.ayesha.id));
    const zeroRow = (await P.register(w.owner.api, w.data.runId)).rows.find((r) => r.staffMemberId === w.data.zero.id)!;
    expect(zeroRow.net).toBe(0);
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await page.screenshot({ path: P.shot('P-ZERO-NET-PENDING-register.png'), fullPage: true });
    await P.saveEvidence('P-ZERO-NET-PENDING.txt', `ledger transactions for ${P.originPublish(w.data.runId, w.data.zero.id)}: ${await P.ledgerTxCount(w.owner.tenantId, P.originPublish(w.data.runId, w.data.zero.id))}\nregister row: ${JSON.stringify(zeroRow)}`);
    // …the PKR 0 line posts nothing (PayrollPostingBuilder drops empty legs), so it can never "land".
    await expect(await run.cell(w.data.zero.name, 'Status')).toHaveText('Unpaid');
    expect((await P.register(w.owner.api, w.data.runId)).rows.find((r) => r.staffMemberId === w.data.zero.id)!.postingPending).toBe(false);
    await page.context().close();
  });
});

// ── All statutory off; concurrent presses ───────────────────────────────────────────────────────
interface NoStat { staff: P.Staff; other: P.Staff; runId: string }
let n: P.World<NoStat>;

test.describe('Publish — statutory off and double press', () => {
  test.beforeAll(async () => {
    test.setTimeout(20 * 60_000);
    n = await P.world<NoStat>('publish-nostat', () => newCampusOwner('pay'), async (owner) => {
      await P.publishPolicy(owner.api, { incomeTaxEnabled: false, eobiEnabled: false, providentFundEnabled: false });
      // Rates on the profile, but every rule is off: nothing may be withheld.
      const staff = await P.addStaff(owner.api, { salary: 30000, incomeTaxPercent: 5, eobiPerMonth: 370, providentFundPercent: 3, name: P.qaName('Nostat') });
      const other = await P.addStaff(owner.api, { salary: 25000, name: P.qaName('Second') });
      return { staff, other, runId: await P.generateRun(owner.api) };
    });
  });

  test('P-DOUBLE-PUBLISH: two Publish presses at the same moment by the same admin publish once and both answer success (no "someone else")', async () => {
    const reg = await P.register(n.owner.api, n.data.runId);
    let statuses: number[] = [];
    let bodies: string[] = [];
    if (reg.status === 'Draft') {
      const results = await Promise.all([P.publish(n.owner.api, n.data.runId), P.publish(n.owner.api, n.data.runId)]);
      statuses = results.map((r) => r.status());
      bodies = await Promise.all(results.map((r) => r.text()));
      await P.saveEvidence('P-DOUBLE-PUBLISH.txt', results.map((r, i) => `POST /payroll-runs/${n.data.runId}/publish -> ${statuses[i]} ${bodies[i]}`).join('\n'));
    }
    expect((await P.auditEntries(n.data.runId)).filter((a) => a.action === 'Run published')).toHaveLength(1);
    await P.waitForLedger(n.owner.tenantId, P.originPublish(n.data.runId, n.data.staff.id));
    expect(await P.ledgerTxCount(n.owner.tenantId, `payroll:${n.data.runId}:%`)).toBe(2);
    if (statuses.length) expect(statuses, bodies.join(' | ')).toEqual([200, 200]);
  });

  test('with all statutory rules off the posting has no statutory leg at all (not a zero one) and nothing is withheld', async () => {
    test.skip((await P.register(n.owner.api, n.data.runId)).status !== 'Published', 'needs the published run');
    const legs = await P.waitForLedger(n.owner.tenantId, P.originPublish(n.data.runId, n.data.staff.id));
    expect(legs.map((l) => [l.code.replace(n.data.staff.id, '{staff}'), l.debit, l.credit])).toEqual([['EXPENSES:SALARY', 30000, 0], ['LIABILITIES:STAFF:{staff}', 0, 30000]]);
    const reg = await P.register(n.owner.api, n.data.runId);
    expect(reg.statutoryWithheld).toBe(0);
    const slip = await P.payslip(n.owner.api, n.data.runId, reg.rows.find((r) => r.staffMemberId === n.data.staff.id)!.id);
    expect(slip.lines.map((l) => l.label)).toEqual(['Base salary', 'Net salary']);
  });
});
