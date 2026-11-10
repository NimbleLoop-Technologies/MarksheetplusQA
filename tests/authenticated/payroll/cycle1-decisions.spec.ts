/**
 * PR 544 — behaviours decided by the PO after cycle 1 (Umair, 10 Nov 2026).
 * World "decisions" [DB: previous published run moved to last month]:
 *   Ayesha 30,000 is in last month's published run; Nadia joins on the 1st of this month (not in that run).
 *   This month's draft is generated with both.
 * P-PREVIEW-NEW-HIRE: a staff member not in the last published run reads "New" in the change column, not "+ PKR X".
 * P-PUBLISH-MISSING-POLICY [DB: the run's policy is hidden from the tenant for one request, then restored]:
 *   publishing must answer a 4xx validation error with a clear message, never 500.
 */
import { expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

const month = P.monthStart();
const PREV = P.monthStart(-1);
interface Data { ayesha: P.Staff; nadia: P.Staff; runId: string; prevRunId: string }
let w: P.World<Data>;


test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  w = await P.world<Data>('decisions', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: false, eobiEnabled: false });
    const ayesha = await P.addStaff(api, { salary: 30000, name: P.qaName('Ayesha') });
    const prevRunId = await P.generateAndPublish(api);
    // DB MANIPULATION: the run just published becomes last month's run.
    await P.moveRunToMonth(prevRunId, PREV, new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 2, 6)));
    const nadia = await P.addStaff(api, { salary: 28000, name: P.qaName('Nadia'), joined: P.iso(month) });
    const runId = await P.generateRun(api);
    return { ayesha, nadia, runId, prevRunId };
  });
});

test('P-PREVIEW-NEW-HIRE: a staff member who was not in the last published run reads "New" in the change column, not "+ PKR X"', async ({ browser }) => {
  const rows = await P.previewRows(w.owner.api, w.data.runId);
  await P.saveEvidence('P-PREVIEW-NEW-HIRE-api.txt', JSON.stringify(rows, null, 1).slice(0, 3000));
  const page = await P.openApp(browser, w, P.runPath(w.data.runId));
  const run = new PayrollRunPage(page);
  await run.expectDraftLoaded();
  await run.reviewAndPublish.click();
  await run.expectPreviewLoaded();
  await run.pagination.waitFor();
  const header = (await run.headers()).find((h) => h.startsWith('Change from'))!;
  expect(header, 'a change column exists because a previous run is published').toBeTruthy();
  await expect(await run.cell(w.data.ayesha.name, header)).toHaveText('No change');
  const cell = await run.cell(w.data.nadia.name, header);
  await page.screenshot({ path: P.shot('P-PREVIEW-NEW-HIRE.png'), fullPage: true });
  await expect(cell).toHaveText('New');
  await page.context().close();
});

test('P-PUBLISH-MISSING-POLICY: a run whose policy cannot be found is refused with a 4xx validation error and a clear message, never 500 [DB]', async () => {
  const [{ policyId }] = await P.sql<{ policyId: string }>(`select "PayrollPolicyId" as "policyId" from "PayrollRuns" where "Id" = ${P.q(w.data.runId)}`);
  // DB MANIPULATION: hide the policy from this tenant (tenant query filter), publish, then restore it.
  const hide = `update "PayrollPolicies" set "TenantId" = 'qa-hidden-' || "TenantId" where "Id" = ${P.q(policyId)} and "TenantId" = ${P.q(w.owner.tenantId)};`;
  const restore = `update "PayrollPolicies" set "TenantId" = ${P.q(w.owner.tenantId)} where "Id" = ${P.q(policyId)};`;
  await P.sqlExec(hide);
  let status = 0; let text = '';
  try {
    const res = await P.publish(w.owner.api, w.data.runId);
    status = res.status(); text = await res.text();
  } finally {
    await P.sqlExec(restore);
  }
  await P.saveEvidence('P-PUBLISH-MISSING-POLICY.txt', `SQL (hide): ${hide}\nPOST /payroll-runs/${w.data.runId}/publish -> ${status}\n${text.slice(0, 800)}\nSQL (restore): ${restore}`);
  expect((await P.register(w.owner.api, w.data.runId)).status, 'the run stays a draft').toBe('Draft');
  expect(status, text).toBeGreaterThanOrEqual(400);
  expect(status, text).toBeLessThan(500);
  expect(text).toMatch(/policy/i);
});
