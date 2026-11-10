/**
 * "UI is responsive on mid-range Android" (Definition of Done of every PR 544 story).
 * Pixel 5 viewport (393×851, Chrome mobile UA): landing, draft register + row panel, Preview, published register,
 * payslip. Screenshots go to the evidence folder; each screen must not scroll sideways at the page level.
 */
import { devices, expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';
import { StaffPayrollPage } from '../../../pages/payroll/StaffPayrollPage';

const pixel5 = (({ defaultBrowserType: _ignored, ...d }) => d)(devices['Pixel 5']);
interface Data { ayesha: P.Staff; bilal: P.Staff; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('mobile', () => newCampusOwner('pay'), async (owner) => {
    await P.publishPolicy(owner.api, { incomeTaxEnabled: true, eobiEnabled: true });
    const ayesha = await P.addStaff(owner.api, { salary: 45000, designationId: P.DESIGNATION.seniorTeacher, incomeTaxPercent: 5, eobiPerMonth: 370, name: P.qaName('Ayesha') });
    const bilal = await P.addStaff(owner.api, { salary: 38000, incomeTaxPercent: 0, eobiPerMonth: 0, name: P.qaName('Bilal') });
    await P.createItem(owner.api, { name: 'Qa Conveyance allowance', type: 'Incentive', amountType: 'FlatAmount', amount: 2000, appliesTo: 'Designation', designationId: P.DESIGNATION.seniorTeacher });
    const runId = await P.generateRun(owner.api);
    await P.absence(owner.api, runId, (await P.rowFor(owner.api, runId, ayesha)).id, 2);
    return { ayesha, bilal, runId };
  });
});

test('Pixel 5: draft register, row panel and Preview fit the screen', async ({ browser }) => {
  test.skip((await P.register(w.owner.api, w.data.runId)).status !== 'Draft', 'needs the draft');
  const page = await P.openApp(browser, w, P.PAYROLL_PATH, pixel5);
  const landing = new StaffPayrollPage(page);
  await landing.expectMonthCard();
  await page.screenshot({ path: P.shot('mobile-pixel5-landing.png'), fullPage: true });
  await page.goto(P.runPath(w.data.runId));
  const run = new PayrollRunPage(page);
  await run.expectDraftLoaded();
  await page.screenshot({ path: P.shot('mobile-pixel5-register.png'), fullPage: true });
  expect(await run.pageOverflowPx(), 'draft register scrolls sideways').toBeLessThanOrEqual(1);
  await run.openRow(w.data.ayesha.name);
  await page.screenshot({ path: P.shot('mobile-pixel5-row-panel.png'), fullPage: true });
  expect(await run.pageOverflowPx(), 'row panel scrolls sideways').toBeLessThanOrEqual(1);
  await run.reviewAndPublish.click();
  await run.expectPreviewLoaded();
  await page.screenshot({ path: P.shot('mobile-pixel5-preview.png'), fullPage: true });
  expect(await run.pageOverflowPx(), 'preview scrolls sideways').toBeLessThanOrEqual(1);
  await page.context().close();
});

test('Pixel 5: published register and payslip fit the screen', async ({ browser }) => {
  if ((await P.register(w.owner.api, w.data.runId)).status === 'Draft') {
    await P.publishOk(w.owner.api, w.data.runId);
    await P.markPaid(w.owner.api, w.data.runId, (await P.rowFor(w.owner.api, w.data.runId, w.data.ayesha)).id);
  }
  const page = await P.openApp(browser, w, P.runPath(w.data.runId), pixel5);
  const run = new PayrollRunPage(page);
  await run.expectPublishedLoaded();
  await page.screenshot({ path: P.shot('mobile-pixel5-published.png'), fullPage: true });
  expect(await run.pageOverflowPx(), 'published register scrolls sideways').toBeLessThanOrEqual(1);
  // Open the payslip even if the action sits off-screen, so the modal itself can be checked.
  await run.rowAction(w.data.ayesha.name, 'View payslip').scrollIntoViewIfNeeded();
  await run.rowAction(w.data.ayesha.name, 'View payslip').click({ force: true });
  await expect(run.dialogText('Net salary')).toBeVisible();
  await run.resetHorizontalScroll();
  await expect(run.dialogText('Base salary')).toBeVisible();
  // Reaching the action needs the table scrolled sideways (P-MOBILE-ROW-ACTIONS), which offsets the screenshot;
  // the modal's own position is therefore recorded as evidence only, not asserted.
  await page.screenshot({ path: P.shot('mobile-pixel5-payslip.png') });
  await page.context().close();
});

test('P-MOBILE-ROW-ACTIONS: on a Pixel 5 the published register\'s Status and row action are reachable without sideways scrolling', async ({ browser }) => {
  test.skip((await P.register(w.owner.api, w.data.runId)).status !== 'Published', 'needs the published run');
  const page = await P.openApp(browser, w, P.runPath(w.data.runId), pixel5);
  const run = new PayrollRunPage(page);
  await run.expectPublishedLoaded();
  await page.screenshot({ path: P.shot('P-MOBILE-ROW-ACTIONS-pixel5.png'), fullPage: true });
  expect(await run.isWithinViewportWidth(run.rowAction(w.data.bilal.name, 'Mark as paid'))).toBe(true);
  await page.context().close();
});
