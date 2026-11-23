/**
 * PR 581 / ClickUp z94x8eeerp (payroll, cycle 2) — AC5 regression check of the published-run "Post an adjustment" flow.
 * PR 581 only touches the draft row panel's one-off form, but the adjustment modal is the other payroll form with a
 * Type-style radio group (Pay more / Recover). Light check: both directions still post from the UI, no HTTP 5xx.
 * Own throwaway campus: publishing freezes the tenant's one run for the month.
 */
import { expect, test, type Response } from '@playwright/test';
import path from 'node:path';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

interface Data { zara: P.Staff; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('pr581-adjust', () => newCampusOwner('pay'), async (owner) => {
    await P.publishPolicy(owner.api, {});
    const zara = await P.addStaff(owner.api, { salary: 36000, incomeTaxPercent: 0, name: P.qaName('Zara') });
    const runId = await P.generateRun(owner.api);
    // One one-off through the API before publishing, so the published register carries a one-off line.
    const row = await P.rowFor(owner.api, runId, zara);
    await P.oneOff(owner.api, runId, row.id, { type: 'Deduction', label: 'Qa Pre publish', amount: 300, reason: 'Seeded before publish' });
    await P.publishOk(owner.api, runId);
    return { zara, runId };
  });
});

const adjustments = (staffId: string) => P.sql<{ direction: string; amount: number; reason: string }>(`select "Direction" as direction, "Amount"::float as amount, "Reason" as reason from "PayrollAdjustments" where "PayrollRunId" = ${P.q(w.data.runId)} and "StaffMemberId" = ${P.q(staffId)} order by "PostedAtUtc"`);

test('published run: "Pay more" and "Recover" adjustments still post from the UI with no HTTP 5xx', { tag: '@critical' }, async ({ browser }) => {
  const fiveXX: string[] = [];
  const posts: string[] = [];
  const page = await P.openApp(browser, w, P.runPath(w.data.runId), { viewport: { width: 1280, height: 800 } });
  page.on('response', (r: Response) => {
    if (r.status() >= 500) fiveXX.push(`${r.request().method()} ${r.url()} → ${r.status()}`);
    if (r.request().method() === 'POST' && /\/adjustments$/.test(r.url())) posts.push(String(r.status()));
  });
  const run = new PayrollRunPage(page);
  await run.expectPublishedLoaded();
  const s = w.data.zara;
  for (const [direction, amount] of [['Pay more', '800'], ['Recover', '250']] as const) {
    const reason = `Qa PR581 ${direction} check`;
    await run.postAdjustment.click();
    await run.adjustmentStaff().selectOption({ label: s.name });
    // A real click on the option's label (no force) — the modal's radio group must still be operable.
    await run.dialog.getByText(direction, { exact: true }).click();
    await expect(run.adjustmentDirection(direction)).toBeChecked();
    await run.fillAdjustment({ amount, reason });
    if (direction === 'Recover') await page.screenshot({ path: path.join(P.EVIDENCE_DIR, 'pr581-adjustment-recover-filled.png') });
    await run.dialogButton('Post adjustment').click();
    await expect(run.toast(`Adjustment posted for ${s.name}.`)).toBeVisible({ timeout: 15_000 });
    await expect(run.dialog).toHaveCount(0);
  }
  const rows = await adjustments(s.id);
  expect(rows.map((r) => [r.direction, r.amount, r.reason])).toEqual([
    ['Pay more', 800, 'Qa PR581 Pay more check'],
    ['Recover', 250, 'Qa PR581 Recover check'],
  ]);
  expect(posts).toEqual(['200', '200']);
  // The one-off made before publishing is frozen on the payslip as a deduction.
  const row = await P.rowFor(w.owner.api, w.data.runId, s);
  const slip = await P.payslip(w.owner.api, w.data.runId, row.id);
  P.saveEvidence('pr581-adjustment-probe.txt', `adjustments (SQL): ${JSON.stringify(rows, null, 2)}\nPOST /adjustments statuses: ${posts.join(', ')}\npayslip lines: ${JSON.stringify(slip.lines, null, 2)}\n5xx: ${JSON.stringify(fiveXX)}\n`);
  expect(slip.lines.some((l) => l.label === 'Qa Pre publish')).toBe(true);
  expect(fiveXX, 'no HTTP 5xx').toEqual([]);
  await page.screenshot({ path: path.join(P.EVIDENCE_DIR, 'pr581-adjustment-posted.png') });
  await page.context().close();
});
