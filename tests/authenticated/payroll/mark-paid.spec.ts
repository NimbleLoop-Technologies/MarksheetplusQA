/**
 * 86eyqaudz Mark a Staff Member as Paid (PR 544).
 * World "paid": tax + EOBI on. Ayesha (45,000, tax 5 %, EOBI 370) net 42,380; Bilal 38,000; Sana (24,000, left on the
 * 5th) prorated; Driver 20,000. The first test publishes and immediately pays Driver while his posting is pending.
 */
import { expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

const month = P.monthStart();
const MONTH = P.monthLabel(month);
interface Data { ayesha: P.Staff; bilal: P.Staff; sana: P.Staff; driver: P.Staff; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('paid', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: true, eobiEnabled: true });
    const ayesha = await P.addStaff(api, { salary: 45000, incomeTaxPercent: 5, eobiPerMonth: 370, name: P.qaName('Ayesha') });
    const bilal = await P.addStaff(api, { salary: 38000, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Bilal') });
    const sana = await P.addStaff(api, { salary: 24000, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Sana') });
    await P.markLeft(api, sana.id, P.iso(P.dayOf(month, 5)));
    const driver = await P.addStaff(api, { salary: 20000, designationId: P.DESIGNATION.driver, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Driver') });
    return { ayesha, bilal, sana, driver, runId: await P.generateRun(api) };
  });
});

const row = (s: P.Staff) => P.rowFor(w.owner.api, w.data.runId, s);
const paidAudit = async (s: P.Staff) => (await P.auditEntries(w.data.runId)).filter((a) => a.action === 'Staff paid' && a.snapshot.StaffMemberId === s.id);

test.describe('Mark as paid — integrity', () => {
  test('marking paid is refused on a draft, and allowed on a line whose publish posting is still pending', async () => {
    const reg = await P.register(w.owner.api, w.data.runId);
    if (reg.status === 'Draft') {
      const draftTry = await P.markPaid(w.owner.api, w.data.runId, (await row(w.data.driver)).id);
      expect(draftTry.status()).toBe(409);
      expect((await draftTry.json()).code).toBe('NOT_PUBLISHED');
      await P.publishOk(w.owner.api, w.data.runId);
      const r = await row(w.data.driver);
      const pendingAtPayment = r.postingPending;
      const res = await P.markPaid(w.owner.api, w.data.runId, r.id);
      expect(res.status()).toBe(200);
      await P.saveEvidence('mark-paid-while-pending.txt', `postingPending when paid: ${pendingAtPayment}\nPOST paid -> ${res.status()} ${await res.text()}`);
    }
    // Both postings land, in order, whatever the timing.
    await P.waitForLedger(w.owner.tenantId, P.originPublish(w.data.runId, w.data.driver.id));
    const legs = await P.waitForLedger(w.owner.tenantId, P.originPaid(w.data.runId, w.data.driver.id));
    expect(legs.map((l) => [l.code.replace(w.data.driver.id, '{staff}'), l.debit, l.credit])).toEqual([['LIABILITIES:STAFF:{staff}', 20000, 0], ['ASSETS:CASH', 0, 20000]]);
    expect(await P.accountBalance(w.owner.tenantId, `LIABILITIES:STAFF:${w.data.driver.id}`)).toBe(0);
  });

  test('two presses at the same moment write one posting, one status change and one audit entry', async () => {
    const r = await row(w.data.bilal);
    if (r.paymentStatus === 'Unpaid') {
      const results = await Promise.all([P.markPaid(w.owner.api, w.data.runId, r.id), P.markPaid(w.owner.api, w.data.runId, r.id)]);
      const lines = await Promise.all(results.map(async (x) => `${x.status()} ${await x.text()}`));
      await P.saveEvidence('mark-paid-double-press.txt', lines.join('\n'));
      results.forEach((x) => expect([200, 409]).toContain(x.status()));
    }
    await P.waitForLedger(w.owner.tenantId, P.originPaid(w.data.runId, w.data.bilal.id));
    expect(await P.ledgerTxCount(w.owner.tenantId, P.originPaid(w.data.runId, w.data.bilal.id))).toBe(1);
    expect(await paidAudit(w.data.bilal)).toHaveLength(1);
    expect((await row(w.data.bilal)).paymentStatus).toBe('Paid');
    // A later press is a no-op.
    expect((await P.markPaid(w.owner.api, w.data.runId, r.id)).status()).toBe(200);
    expect(await paidAudit(w.data.bilal)).toHaveLength(1);
  });

  test('a staff member who has left can still be marked paid', async () => {
    const r = await row(w.data.sana);
    expect((await P.markPaid(w.owner.api, w.data.runId, r.id)).status()).toBe(200);
    expect((await row(w.data.sana)).paymentStatus).toBe('Paid');
  });

  test('unknown and malformed ids answer 404, never 500', async () => {
    expect((await P.markPaid(w.owner.api, w.data.runId, '00000000-0000-0000-0000-000000000000')).status()).toBe(404);
    expect((await P.markPaid(w.owner.api, 'garbage', 'garbage')).status()).toBe(404);
  });
});

test.describe('Mark as paid — the confirmation', () => {
  test('the modal names the person and the amount; Cancel, the close icon and Escape leave the line Unpaid', async ({ browser }) => {
    test.skip((await row(w.data.ayesha)).paymentStatus !== 'Unpaid', 'Ayesha already paid (worker restart)');
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    const s = w.data.ayesha;
    await run.rowAction(s.name, 'Mark as paid').click();
    await expect(run.dialogHeading()).toHaveText(`Mark ${s.name} as paid?`);
    await expect(run.dialogText(new RegExp(`^${P.moneyRe(42380).source}, recorded as paid today\\. This posts to the Ledger and cannot be undone\\.$`))).toBeVisible();
    await expect(run.dialogText(`Net salary for ${MONTH}.`)).toBeVisible();
    await page.screenshot({ path: P.shot('mark-paid-modal.png') });
    await run.dialogButton('Cancel').click();
    await expect(run.dialog).toHaveCount(0);
    await run.rowAction(s.name, 'Mark as paid').click();
    await run.dialogCloseIcon().click();
    await expect(run.dialog).toHaveCount(0);
    await run.rowAction(s.name, 'Mark as paid').click();
    await page.keyboard.press('Escape');
    await expect(run.dialog).toHaveCount(0);
    expect((await row(s)).paymentStatus).toBe('Unpaid');
    expect(await paidAudit(s)).toHaveLength(0);
    await page.context().close();
  });

  test('network failure keeps the modal open with "We could not record this payment. Check your connection and try again." and the line Unpaid', async ({ browser }) => {
    test.skip((await row(w.data.ayesha)).paymentStatus !== 'Unpaid', 'Ayesha already paid');
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await run.rowAction(w.data.ayesha.name, 'Mark as paid').click();
    await page.route('**/paid', (route) => route.abort('internetdisconnected'));
    await run.dialogButton('Mark as paid').click();
    await expect(run.dialogText('We could not record this payment. Check your connection and try again.')).toBeVisible();
    await page.screenshot({ path: P.shot('mark-paid-network-failure.png') });
    expect((await row(w.data.ayesha)).paymentStatus).toBe('Unpaid');
    await page.context().close();
  });

  test('confirming: badge "Paid", action "View payslip", toast, tiles and strip count update; Dr staff payable / Cr cash; statutory untouched; one audit entry', { tag: '@critical' }, async ({ browser }) => {
    const s = w.data.ayesha;
    await P.waitForLedger(w.owner.tenantId, P.originPublish(w.data.runId, s.id));
    const statBefore = await P.accountBalance(w.owner.tenantId, 'LIABILITIES:STATUTORY');
    const before = await P.register(w.owner.api, w.data.runId);
    if ((await row(s)).paymentStatus === 'Unpaid') {
      const page = await P.openApp(browser, w, P.runPath(w.data.runId));
      const run = new PayrollRunPage(page);
      await run.expectPublishedLoaded();
      await run.rowAction(s.name, 'Mark as paid').click();
      await run.dialogButton('Mark as paid').click();
      await expect(run.toast(`${s.name} marked as paid.`)).toBeVisible();
      await expect(await run.cell(s.name, 'Status')).toHaveText('Paid');
      await expect(run.rowAction(s.name, 'View payslip')).toBeVisible();
      await expect(run.publishedLine).toContainText(`Paid ${before.paidCount + 1} of 4.`);
      expect((await run.tile('Paid')).value).toMatch(P.moneyRe(before.paidAmount + 42380));
      expect((await run.tile('Outstanding')).value).toMatch(P.moneyRe(before.outstandingAmount - 42380));
      await page.context().close();
    }
    const after = await P.register(w.owner.api, w.data.runId);
    expect(after.paidAmount + after.outstandingAmount).toBe(after.totalNet);
    const paidOn = await P.sql(`select "PaidOnUtc" at time zone 'Asia/Karachi' as d from "PayrollRunRows" where "StaffMemberId" = ${P.q(s.id)} and "PayrollRunId" = ${P.q(w.data.runId)}`);
    expect(String(paidOn[0].d).slice(0, 10)).toBe(P.iso(P.karachiToday()));
    const legs = await P.waitForLedger(w.owner.tenantId, P.originPaid(w.data.runId, s.id));
    expect(legs.map((l) => [l.code.replace(s.id, '{staff}'), l.debit, l.credit])).toEqual([['LIABILITIES:STAFF:{staff}', 42380, 0], ['ASSETS:CASH', 0, 42380]]);
    expect(await P.accountBalance(w.owner.tenantId, 'LIABILITIES:STATUTORY')).toBe(statBefore);
    const audit = await paidAudit(s);
    expect(audit).toHaveLength(1);
    expect(audit[0].snapshot).toMatchObject({ StaffName: s.name, Amount: 42380 });
    expect(audit[0].actor).toBe(w.owner.userId);
  });

  test('a paid line offers no way back to Unpaid', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await expect(run.rowAction(w.data.ayesha.name, 'Mark as paid')).toHaveCount(0);
    expect((await run.row(w.data.ayesha.name).innerText()).toLowerCase()).not.toContain('unpaid');
    await page.context().close();
  });

  test('the last payment closes the month: "Paid 4 of 4", Outstanding PKR 0, every badge Paid', async ({ browser }) => {
    for (const r of (await P.register(w.owner.api, w.data.runId)).rows.filter((x) => x.paymentStatus === 'Unpaid')) {
      expect((await P.markPaid(w.owner.api, w.data.runId, r.id)).status()).toBe(200);
    }
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await expect(run.publishedLine).toContainText('Paid 4 of 4.');
    expect((await run.tile('Outstanding')).value).toMatch(P.moneyRe(0));
    await run.unpaidOnly.click();
    await expect(run.emptyState('Every staff member is paid.')).toBeVisible();
    await page.context().close();
  });
});
