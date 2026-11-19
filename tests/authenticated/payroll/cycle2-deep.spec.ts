/**
 * PR 544 cycle 2 — deeper checks on the cycle-1 fixes and the flows they touch.
 * World "deep": no statutory; 52 staff (more than one 50-line register page) incl. Ayesha 30,000 and Zero 20,000
 * (every day unpaid -> net 0); a Payroll See-only member "viewer" [DB: role assignment switched to the custom role].
 *  - P-DISCARD-DRAFT flow (z94x8ecrp8): confirm copy, Discard returns the month to "Generate payroll", the next Generate
 *    makes a fresh draft, a published run cannot be discarded (409).
 *  - P-FRACTIONAL-AMOUNT UI (z94x8ecrnh): the one-off form shows "Enter a whole number of rupees." for 0.5.
 *  - P-ZERO-NET-PENDING (z94x8ecrnt): the net-0 line reads Unpaid (not "Posting pending") and can be marked paid.
 *  - P-PRINT-EXPORT (z94x8ecrnf): Export downloads every staff line (52, across register pages); Print renders all lines.
 *  - P-PAYSLIP-UNPAID for See-only (z94x8ecrne): "View payslip" on an Unpaid line; no Export without the Export permission.
 *  - Race: Publish and Discard pressed at the same moment never delete a published run and never answer 500.
 */
import { expect, test, request as pwRequest } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { newCampusOwner, REST_API } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';
import { StaffPayrollPage } from '../../../pages/payroll/StaffPayrollPage';

const month = P.monthStart();
const DAYS = P.daysInMonth(month);
interface Cred { phone: string; password: string }
interface Data { ayesha: P.Staff; zero: P.Staff; staffCount: number; viewer: Cred; firstRunId: string; runId?: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('deep', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: false, eobiEnabled: false });
    const ayesha = await P.addStaff(api, { salary: 30000, name: P.qaName('Ayesha') });
    const zero = await P.addStaff(api, { salary: 20000, name: P.qaName('Zero') });
    for (let i = 0; i < 49; i++) await P.addStaff(api, { salary: 10000 + i * 100 });
    const m = await P.inviteMember(owner, { customRoleId: await P.createPayrollSeeOnlyRole(api) });
    const { identifier, password } = m.credentials();
    await m.api.dispose();
    // 2 + 49 + the invited viewer's own staff record = 52 staff lines.
    return { ayesha, zero, staffCount: 52, viewer: { phone: identifier, password }, firstRunId: await P.generateRun(api) };
  });
});

const current = async () => (await w.owner.api.get('payroll-runs/current')).json();
const viewerWorld = () => ({ owner: { credentials: () => ({ identifier: w.data.viewer.phone, password: w.data.viewer.password }) }, statePath: w.statePath.replace('-ui.json', '-viewer-ui.json') });

test.describe.serial('Cycle 2 — deeper checks', () => {
  test('P-DISCARD-DRAFT flow: confirm copy, Discard returns the month to "Generate payroll", Generate makes a fresh draft', async ({ browser }) => {
    const cur = await current();
    test.skip(cur.state !== 'Draft' || (!!w.data.runId && cur.runId === w.data.runId), 'already discarded (worker restart)');
    const page = await P.openApp(browser, w);
    const ui = new StaffPayrollPage(page);
    await ui.expectMonthCard();
    await ui.discardDraftButton.click();
    const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).first();
    await expect(dialog).toContainText('Discard this draft?');
    await expect(dialog).toContainText('Every exception you entered will be lost.');
    await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeVisible();
    await page.screenshot({ path: P.shot('c2-discard-confirm.png') });
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    expect((await current()).state).toBe('Draft');
    await ui.discardDraftButton.click();
    await page.getByRole('dialog').or(page.getByRole('alertdialog')).first().getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(ui.generateButton).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: P.shot('c2-discard-after.png') });
    expect((await current()).state).toBe('NoRun');
    expect((await w.owner.api.get(`payroll-runs/${w.data.firstRunId}/register?pageSize=50`)).status()).toBe(404);
    await ui.generateButton.click();
    await expect(page).toHaveURL(/\/run\//, { timeout: 30_000 });
    const after = await current();
    expect(after.state).toBe('Draft');
    expect(after.runId).not.toBe(w.data.firstRunId);
    w.data.runId = after.runId;
    await P.persistWorld('deep', w.data);
    await page.context().close();
  });

  test('P-FRACTIONAL-AMOUNT UI: the one-off form refuses 0.5 with "Enter a whole number of rupees."', async ({ browser }) => {
    const runId = w.data.runId ?? (await current()).runId;
    test.skip((await P.register(w.owner.api, runId)).status !== 'Draft', 'already published');
    const page = await P.openApp(browser, w, P.runPath(runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.searchFor(w.data.ayesha.name);
    await run.openRow(w.data.ayesha.name);
    // Cycle 3: with the register searched the panel re-renders a moment after it opens and resets the one-off form
    // (C3-PANEL-AFTER-SEARCH). Let it settle, then open the form, so this test keeps checking the whole-rupee rule
    // (z94x8ecrnh) on its own.
    await page.waitForTimeout(4000);
    await run.addOneOffLink().click();
    if (!(await run.oneOffField('Label').isVisible({ timeout: 2000 }).catch(() => false))) await run.addOneOffLink().click();
    await run.fillOneOff({ type: 'Incentive', label: 'Qa Half rupee', amount: '0.5', reason: 'Fraction from the form' });
    await run.oneOffSubmit().click();
    await expect(run.panelText('Enter a whole number of rupees.')).toBeVisible();
    await page.screenshot({ path: P.shot('c2-oneoff-fraction-ui.png'), fullPage: true });
    const f = await P.figures(w.owner.api, runId, (await P.rowFor(w.owner.api, runId, w.data.ayesha)).id);
    expect(f.lines.find((l) => l.label === 'Qa Half rupee'), 'nothing saved').toBeUndefined();
    await page.context().close();
  });

  test('P-ZERO-NET-PENDING: the net-0 line reads Unpaid (not "Posting pending") after publishing and can be marked paid', async ({ browser }) => {
    const runId = w.data.runId ?? (await current()).runId;
    if ((await P.register(w.owner.api, runId)).status === 'Draft') {
      await P.absence(w.owner.api, runId, (await P.rowFor(w.owner.api, runId, w.data.zero)).id, DAYS);
      await P.publishOk(w.owner.api, runId);
    }
    await P.waitForLedger(w.owner.tenantId, P.originPublish(runId, w.data.ayesha.id));
    const zeroRow = await P.rowFor(w.owner.api, runId, w.data.zero);
    expect(zeroRow.net).toBe(0);
    const page = await P.openApp(browser, w, P.runPath(runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await run.searchFor(w.data.zero.name);
    await expect(await run.cell(w.data.zero.name, 'Status')).toHaveText(/Unpaid/);
    await expect(run.text(/Posting pending/)).toHaveCount(0);
    await page.context().close();
    const paid = await P.markPaid(w.owner.api, runId, zeroRow.id);
    const text = await paid.text();
    await P.saveEvidence('c2-zero-net-mark-paid.txt', `mark paid net-0 line -> ${paid.status()} ${text.slice(0, 300)}\nledger tx for paid: ${await P.ledgerTxCount(w.owner.tenantId, P.originPaid(runId, w.data.zero.id))}`);
    expect(paid.status(), text).toBeLessThan(300);
    expect((await P.rowFor(w.owner.api, runId, w.data.zero)).paymentStatus).toBe('Paid');
  });

  test('P-PRINT-EXPORT: Export downloads every staff line across register pages; Print renders every line', async ({ browser }) => {
    const runId = w.data.runId ?? (await current()).runId;
    const page = await P.openApp(browser, w, P.runPath(runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), run.exportButton.click()]);
    expect(download.suggestedFilename()).toBe(`payroll-${P.iso(month).slice(0, 7)}.csv`);
    const file = P.shot('c2-export.csv');
    await download.saveAs(file);
    const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    expect(lines[0]).toBe('Staff member,Designation,Salary,Incentives,Deductions,Net salary,Status');
    expect(lines.length - 1, 'one line per staff member').toBe(w.data.staffCount);
    expect(lines.some((l) => l.startsWith(`${w.data.ayesha.name},`) && l.includes(',30000,'))).toBe(true);
    expect(lines.some((l) => l.startsWith(`${w.data.zero.name},`) && l.endsWith(',0,Paid'))).toBe(true);
    // Print: the app copies the print host into a new window (or prints in place); either way every line is there.
    const popupP = page.waitForEvent('popup', { timeout: 15_000 }).catch(() => null);
    await page.evaluate(() => { (window as any).print = () => {}; });
    await run.printButton.click();
    const popup = await popupP;
    const target = popup ?? page;
    if (popup) { await popup.evaluate(() => { (window as any).print = () => {}; }).catch(() => {}); await popup.waitForLoadState().catch(() => {}); }
    const printRows = target.locator('[data-print-row]');
    await expect(printRows).toHaveCount(w.data.staffCount, { timeout: 15_000 });
    await (popup ?? page).emulateMedia({ media: 'print' });
    await (popup ?? page).screenshot({ path: P.shot('c2-print.png'), fullPage: true });
    await P.saveEvidence('c2-print-export.txt', `export ${download.suggestedFilename()}: ${lines.length - 1} lines\nprint via ${popup ? 'popup window' : 'same page'}: ${await printRows.count()} rows`);
    if (popup) await popup.close();
    await page.context().close();
  });

  test('P-PAYSLIP-UNPAID (See-only): "View payslip" on an Unpaid line; Print shown, Export and the correction path hidden', async ({ browser }) => {
    const runId = w.data.runId ?? (await current()).runId;
    const page = await P.openApp(browser, viewerWorld(), P.runPath(runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await run.searchFor(w.data.ayesha.name);
    await expect(await run.cell(w.data.ayesha.name, 'Status')).toHaveText(/Unpaid/);
    await expect(run.rowAction(w.data.ayesha.name, 'View payslip')).toBeVisible();
    await expect(run.rowAction(w.data.ayesha.name, 'Mark as paid')).toHaveCount(0);
    await expect(run.printButton).toBeVisible();
    await expect(run.exportButton).toHaveCount(0);
    await expect(run.postAdjustment).toHaveCount(0);
    await run.rowAction(w.data.ayesha.name, 'View payslip').click();
    await expect(run.dialogText('Net salary')).toBeVisible();
    await expect(run.dialog.getByRole('button', { name: 'Post an adjustment' })).toHaveCount(0);
    await page.screenshot({ path: P.shot('c2-viewer-payslip-unpaid.png') });
    await page.context().close();
  });

  test('a published run cannot be discarded (409, run intact)', async () => {
    const runId = w.data.runId ?? (await current()).runId;
    const res = await w.owner.api.delete(`payroll-runs/${runId}`);
    const text = await res.text();
    await P.saveEvidence('c2-discard-published.txt', `DELETE published run -> ${res.status()} ${text}`);
    expect(res.status()).toBe(409);
    expect(text).toContain('A published run cannot be discarded.');
    expect((await P.register(w.owner.api, runId)).status).toBe('Published');
  });

  test('P-C2-PUBLISH-DISCARD-RACE: Publish and Discard at the same moment never delete a published run and never answer 500', async () => {
    test.setTimeout(10 * 60_000);
    const api = w.owner.api;
    const log: string[] = [];
    for (let i = 1; i <= 6; i++) {
      // Free the current month: move the published run back i months (DB MANIPULATION, logged).
      const cur = await current();
      if (cur.state === 'Published') log.push(await P.moveRunToMonth(cur.runId, P.monthStart(-i)));
      const runId = await P.generateRun(api);
      const [pub, del] = await Promise.all([api.post(`payroll-runs/${runId}/publish`), api.delete(`payroll-runs/${runId}`)]);
      const reg = await api.get(`payroll-runs/${runId}/register?pageSize=1`);
      const regStatus = reg.status() === 200 ? (await reg.json()).status : `HTTP ${reg.status()}`;
      const rows = await P.sql<{ n: number }>(`select count(*)::int as n from "PayrollRunRows" where "PayrollRunId" = ${P.q(runId)}`);
      log.push(`#${i} publish -> ${pub.status()} ${(await pub.text()).slice(0, 160)} | discard -> ${del.status()} ${(await del.text()).slice(0, 160)} | run now: ${regStatus}, rows ${rows[0].n}`);
      if (pub.status() === 200) {
        expect.soft(regStatus, 'a run that answered "published" still exists').toBe('Published');
        expect.soft(rows[0].n).toBe(w.data.staffCount);
      }
      expect.soft(pub.status(), log.at(-1)).not.toBe(500);
      expect.soft(del.status(), log.at(-1)).not.toBe(500);
    }
    await P.saveEvidence('c2-race-publish-discard.txt', log.join('\n'));
  });
});
