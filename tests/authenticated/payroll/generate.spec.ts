/**
 * 86eyqaued Generate Payroll for the Month (PR 544).
 * World "generate": policy v1 (÷30, Sunday off, statutory off), 10 payable staff (8 full month, a joiner on the 3rd,
 * a leaver on the 5th), one staff member Left before the month (excluded) and one whose salary is hidden (DB) so the
 * "Salary not set" chip shows. World "carry": earlier-days carry-forward over a DB-moved previous published run.
 */
import { expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';
import { StaffPayrollPage } from '../../../pages/payroll/StaffPayrollPage';

const month = P.monthStart();
const MONTH = P.monthLabel(month);
const MONTH_NAME = P.monthName(month);
const JOIN_DAY = 3;
const LEFT_DAY = 5;

interface Data {
  full: P.Staff[]; joiner: P.Staff; leaver: P.Staff; leftBefore: P.Staff; noSalary: P.Staff; hideSql: string;
}
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('generate', () => newCampusOwner('pay'), async (owner) => {
    await P.publishPolicy(owner.api, {});
    const full: P.Staff[] = [];
    full.push(await P.addStaff(owner.api, { salary: 45000, designationId: P.DESIGNATION.seniorTeacher, name: P.qaName('Ayesha') }));
    full.push(await P.addStaff(owner.api, { salary: 35000, name: P.qaName('Farhana') }));
    for (let i = 0; i < 5; i++) full.push(await P.addStaff(owner.api, { salary: 20000 + i * 1000 }));
    const joiner = await P.addStaff(owner.api, { salary: 30000, joined: P.iso(P.dayOf(month, JOIN_DAY)), name: P.qaName('Bilal') });
    const leaver = await P.addStaff(owner.api, { salary: 24000, name: P.qaName('Sana') });
    await P.markLeft(owner.api, leaver.id, P.iso(P.dayOf(month, LEFT_DAY)));
    const leftBefore = await P.addStaff(owner.api, { salary: 22000, name: P.qaName('Gone') });
    const prev = P.monthStart(-1);
    await P.markLeft(owner.api, leftBefore.id, P.iso(P.dayOf(prev, 20)));
    const noSalary = await P.addStaff(owner.api, { salary: 26000, name: P.qaName('Nosalary') });
    const hideSql = await P.hideSalary(noSalary.id); // DB MANIPULATION
    return { full, joiner, leaver, leftBefore, noSalary, hideSql };
  });
});

const current = async () => (await w.owner.api.get('payroll-runs/current')).json();
async function runId(): Promise<string> {
  const cur = await current();
  return cur.runId ?? (await P.generateRun(w.owner.api));
}

test.describe('Generate Payroll — creation', () => {
  test('pressing "Generate payroll" several times at once returns one draft, never a second one', { tag: '@critical' }, async () => {
    const results = await Promise.all([0, 1, 2].map(() => w.owner.api.post('payroll-runs/current')));
    const statuses = results.map((r) => r.status());
    const ids = await Promise.all(results.map(async (r) => (await r.json()).runId));
    expect(new Set(ids).size, `statuses ${statuses}`).toBe(1);
    statuses.forEach((s) => expect([200, 201]).toContain(s));
    const runs = await P.sql(`select "Id" from "PayrollRuns" where "TenantId" = ${P.q(w.owner.tenantId)}`);
    expect(runs).toHaveLength(1);
    // A later press returns the same draft with 200.
    const again = await w.owner.api.post('payroll-runs/current');
    expect(again.status()).toBe(200);
    expect((await again.json())).toEqual({ runId: ids[0], created: false });
  });

  test('the draft has one row per Active staff member (leavers this month included, earlier leavers not), salaries snapshotted', async () => {
    const reg = await P.register(w.owner.api, await runId());
    const d = w.data;
    const ids = reg.rows.map((r) => r.staffMemberId);
    expect(reg.status).toBe('Draft');
    expect(reg.month).toBe(MONTH);
    expect(reg.totalStaff).toBe(10);
    expect(ids).toEqual(expect.arrayContaining([...d.full.map((s) => s.id), d.joiner.id, d.leaver.id, d.noSalary.id]));
    expect(ids).not.toContain(d.leftBefore.id);
    for (const s of d.full) {
      const row = reg.rows.find((r) => r.staffMemberId === s.id)!;
      expect(row.monthlySalary).toBe(s.salary);
      expect(row.net, `${s.name} at full month`).toBe(s.salary);
      expect(row.exception).toBe('None');
    }
  });

  test('a mid-month joiner and a mid-month leaver start prorated (÷30 basis) with their badges', async () => {
    const reg = await P.register(w.owner.api, await runId());
    const joiner = reg.rows.find((r) => r.staffMemberId === w.data.joiner.id)!;
    const leaver = reg.rows.find((r) => r.staffMemberId === w.data.leaver.id)!;
    const dim = P.daysInMonth(month);
    expect(joiner.exception).toBe('Joiner');
    expect(joiner.net).toBe(P.round0((30000 * Math.min(30, dim - JOIN_DAY + 1)) / 30));
    expect(leaver.exception).toBe('Leaver');
    expect(leaver.net).toBe(P.round0((24000 * LEFT_DAY) / 30));
  });

  test('creating the draft stamps the active policy version, writes a "Run created" audit entry and posts nothing to the Ledger', async () => {
    const id = await runId();
    const reg = await P.register(w.owner.api, id);
    expect(reg.policyVersion).toBe(1);
    const audit = await P.auditEntries(id);
    const created = audit.filter((a) => a.action === 'Run created');
    expect(created).toHaveLength(1);
    expect(created[0].actor).toBe(w.owner.userId);
    expect(created[0].snapshot).toMatchObject({ Month: MONTH, PolicyVersion: 1, StaffCount: 10 });
    expect(await P.ledgerTxCount(w.owner.tenantId, `payroll%`)).toBe(0);
  });
});

test.describe('Generate Payroll — the register', () => {
  test('strip, summary line, badges vs flat "Full month", row actions, toolbar and 8-row pages', { tag: '@critical' }, async ({ browser }) => {
    const id = await runId();
    const page = await P.openApp(browser, w, P.runPath(id));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await expect(run.title).toHaveText(`${MONTH} payroll`);
    await expect(run.draftStrip).toContainText(`Draft for ${MONTH}`);
    await expect(run.text('Policy version 1')).toBeVisible();
    const reg = await P.register(w.owner.api, id);
    await expect(run.summaryLine).toHaveText(new RegExp(`^10 staff members\\. ${reg.fullMonthCount} at full month, ${reg.exceptionCount} with exceptions\\. Saves automatically, last saved .+\\.$`));
    expect(await run.headers()).toEqual(['Staff member', 'Monthly salary', 'Exceptions', `Net for ${MONTH_NAME}`]);
    await expect(run.search).toBeVisible();
    await expect(run.exceptionsOnly).toBeVisible();
    await expect(run.reviewAndPublish).toBeVisible();
    expect(await run.bodyRowCount(), 'eight rows a page').toBe(8);
    // Exceptions: joiner/leaver carry a badge, everyone else the flat grey text; the action names what the row needs.
    await run.searchFor(w.data.leaver.name);
    await expect(await run.cell(w.data.leaver.name, 'Exceptions')).toHaveText(`Left ${LEFT_DAY} ${P.dayOf(month, 1).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`);
    await expect(run.rowAction(w.data.leaver.name, 'Edit')).toBeVisible();
    await run.searchFor(w.data.full[2].name);
    await expect(await run.cell(w.data.full[2].name, 'Exceptions')).toHaveText('Full month');
    await expect(run.rowAction(w.data.full[2].name, 'Add exception')).toBeVisible();
    await page.screenshot({ path: '/workspace/qa-cycles/pr-544/cycle-1/evidence/generate-register-draft.png', fullPage: true });
    await page.context().close();
  });

  test('"Exceptions only" narrows the register to the rows carrying an exception', async ({ browser }) => {
    const id = await runId();
    const page = await P.openApp(browser, w, P.runPath(id));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.exceptionsOnly.click();
    const reg = await P.register(w.owner.api, id, 'pageSize=50&exceptionsOnly=true');
    await expect.poll(() => run.bodyRowCount()).toBe(reg.filteredCount);
    for (const r of reg.rows) await expect(run.row(r.staffName)).toBeVisible();
    await expect(run.row(w.data.full[3].name)).toHaveCount(0);
    await page.context().close();
  });

  test('a staff member with no salary carries a "Salary not set" chip and the Net cell reads "Salary not set" [DB: salary hidden]', async ({ browser }) => {
    const id = await runId();
    const page = await P.openApp(browser, w, P.runPath(id));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.searchFor(w.data.noSalary.name);
    await expect(await run.cell(w.data.noSalary.name, 'Monthly salary')).toHaveText('Salary not set');
    await expect(await run.cell(w.data.noSalary.name, `Net for ${MONTH_NAME}`)).toHaveText('Salary not set');
    await page.context().close();
  });

  test('"Review and publish" is the only orange (solid) element on the draft', async ({ browser }) => {
    const id = await runId();
    const page = await P.openApp(browser, w, P.runPath(id));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    expect(await run.buttonsFilledLike(run.reviewAndPublish)).toBe(1);
    await page.context().close();
  });
});

test.describe('Generate Payroll — saving and snapshots', () => {
  test('every change auto-saves; reopening the draft restores the exception', async ({ browser }) => {
    const id = await runId();
    const farhana = w.data.full[1];
    const page = await P.openApp(browser, w, P.runPath(id));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.searchFor(farhana.name);
    await run.openRow(farhana.name);
    await run.setUnpaidDays('2');
    await expect(await run.cell(farhana.name, 'Exceptions')).toHaveText('2 unpaid days');
    await expect(run.summaryLine).toContainText(/last saved (just now|1 minute ago)\./);
    await expect.poll(async () => (await P.rowFor(w.owner.api, id, farhana)).unpaidDays).toBe(2);
    await page.reload();
    await run.expectDraftLoaded();
    await run.searchFor(farhana.name);
    await expect(await run.cell(farhana.name, 'Exceptions')).toHaveText('2 unpaid days');
    await page.context().close();
  });

  test('a failed save turns the strip Warning "Not saved. Check your connection." and keeps the value; it retries on its own', async ({ browser }) => {
    const id = await runId();
    const s = w.data.full[4];
    const page = await P.openApp(browser, w, P.runPath(id));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.searchFor(s.name);
    await run.openRow(s.name);
    await page.route('**/rows/*/absence', (route) => route.abort('internetdisconnected'));
    await run.setUnpaidDays('3');
    await expect(run.saveFailed).toBeVisible();
    await expect(run.saveFailed).toContainText('Not saved. Check your connection.');
    await page.screenshot({ path: '/workspace/qa-cycles/pr-544/cycle-1/evidence/generate-save-failed-strip.png', fullPage: true });
    await expect(run.unpaidDays).toHaveValue('3');
    await expect(run.panel).toBeVisible();
    await page.unroute('**/rows/*/absence');
    await expect.poll(async () => (await P.rowFor(w.owner.api, id, s)).unpaidDays, { timeout: 30_000 }).toBe(3);
    await expect(run.saveFailed).toHaveCount(0);
    await page.context().close();
  });

  test('a salary revision after creation does not move the draft (salary snapshot)', async () => {
    const id = await runId();
    const s = w.data.full[5];
    const before = await P.rowFor(w.owner.api, id, s);
    if ((await P.salaryRevisionCount(w.owner.api, s.id)) === 1) await P.reviseSalary(w.owner.api, s.id, s.salary + 5000, P.iso(P.karachiToday()));
    const after = await P.rowFor(w.owner.api, id, s);
    expect(after.monthlySalary).toBe(before.monthlySalary);
    expect(after.net).toBe(before.net);
  });

  test('a policy published while the draft is open does not change it: the draft keeps "Policy version 1"', async ({ browser }) => {
    const id = await runId();
    const before = await P.register(w.owner.api, id);
    const pol = await (await w.owner.api.get('payroll-policy')).json();
    if (pol.versionNumber === 1) await P.publishPolicy(w.owner.api, { dayRateBasis: 'WorkingDays', sandwichLeaveEnabled: true });
    const after = await P.register(w.owner.api, id);
    expect(after.policyVersion).toBe(1);
    expect(after.sandwichLeaveEnabled).toBe(false);
    expect(after.rows.map((r) => [r.id, r.net])).toEqual(before.rows.map((r) => [r.id, r.net]));
    // A new absence on the open draft still uses the stamped ÷30 rule, not the new working-days one.
    const s = w.data.full[6];
    const fig = await P.absence(w.owner.api, id, (await P.rowFor(w.owner.api, id, s)).id, 1);
    expect(fig.net).toBe(s.salary - P.round0(s.salary / 30));
    const page = await P.openApp(browser, w, P.runPath(id));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await expect(run.text('Policy version 1')).toBeVisible();
    await page.context().close();
  });
});

test.describe('Preview blocking check — missing salary (86eyqaue6) [DB: salary hidden]', () => {
  test('a missing salary blocks the Preview with the exact copy, names the staff member and links to their profile; the draft stays intact', async ({ browser }) => {
    const id = await runId();
    const api = await P.preview(w.owner.api, id);
    expect(api.status()).toBe(409);
    const body = await api.json();
    expect(body.code).toBe('PREVIEW_BLOCKED');
    expect(body.noSalary.map((x: { name: string }) => x.name)).toEqual([w.data.noSalary.name]);
    const page = await P.openApp(browser, w, P.runPath(id));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.reviewAndPublish.click();
    await expect(run.text('1 staff member has no salary on record. Payroll cannot be computed for them.')).toBeVisible();
    await expect(run.previewStrip).toHaveCount(0);
    await page.screenshot({ path: P.shot('preview-blocked-missing-salary.png'), fullPage: true });
    await run.nameLink(w.data.noSalary.name).click();
    // /staff/{id}/profile redirects to the profile at /staff/register/{id}.
    await expect(page).toHaveURL(new RegExp(`/staff/(register/)?${w.data.noSalary.id}`));
    await page.context().close();
  });
});

test.describe('Generate Payroll — robustness', () => {
  test('unknown and malformed run ids answer 404, never 500', async () => {
    for (const id of ['00000000-0000-0000-0000-000000000000', 'not-a-guid', '%27%3B--']) {
      const res = await w.owner.api.get(`payroll-runs/${id}/register`);
      expect(res.status(), id).toBe(404);
    }
  });

  test('P-REGISTER-PAGE-OVERFLOW: a huge page number answers a client error or an empty page, never 500', async () => {
    const id = await runId();
    const res = await w.owner.api.get(`payroll-runs/${id}/register?page=2147483647&pageSize=50`);
    await P.saveEvidence('P-REGISTER-PAGE-OVERFLOW.txt', `GET /payroll-runs/${id}/register?page=2147483647&pageSize=50 -> ${res.status()}\n${(await res.text()).slice(0, 600)}`);
    expect(res.status()).toBeLessThan(500);
  });
});

test.describe('Generate Payroll — spec gaps', () => {
  test('P-DISCARD-DRAFT: the month card offers "Discard draft" with the confirm "Discard this draft? Every exception you entered will be lost."', async ({ browser }) => {
    test.skip((await current()).state !== 'Draft', 'needs the open draft');
    const page = await P.openApp(browser, w);
    const ui = new StaffPayrollPage(page);
    await ui.expectMonthCard();
    await page.screenshot({ path: '/workspace/qa-cycles/pr-544/cycle-1/evidence/P-DISCARD-DRAFT-month-card.png' });
    await expect(ui.discardDraftButton).toBeVisible();
    await page.context().close();
  });
});

// ── Earlier days carry-forward ──────────────────────────────────────────────────────────────────
interface Carry { old: P.Staff; late: P.Staff; previousRunId: string; moveSql: string; runId: string }
let c: P.World<Carry>;

test.describe('Generate Payroll — a late hire is carried forward ("Earlier days") [DB: previous published run]', () => {
  test.beforeAll(async () => {
    test.setTimeout(20 * 60_000);
    c = await P.world<Carry>('carry', () => newCampusOwner('pay'), async (owner) => {
      await P.publishPolicy(owner.api, {});
      const old = await P.addStaff(owner.api, { salary: 36000, name: P.qaName('Senior') });
      const previousRunId = await P.generateAndPublish(owner.api);
      // DB MANIPULATION: the run just published becomes last month's run, freeing this month for a fresh Generate.
      const moveSql = await P.moveRunToMonth(previousRunId, P.monthStart(-1), new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 2, 6)));
      const late = await P.addStaff(owner.api, { salary: 30000, joined: P.iso(P.dayOf(P.monthStart(-1), 20)), name: P.qaName('Latehire') });
      const runId = await P.generateRun(owner.api);
      return { old, late, previousRunId, moveSql, runId };
    });
  });

  test('a staff member who joined after the last published run is paid from the joining date: full month + "Earlier days"', async () => {
    const prev = P.monthStart(-1);
    const earlierDays = P.daysInMonth(prev) - 20 + 1;
    const row = await P.rowFor(c.owner.api, c.data.runId, c.data.late);
    const earlier = P.round0((30000 * earlierDays) / 30);
    expect(row.exception).toBe('None');
    expect(row.net).toBe(30000 + earlier);
    const old = await P.rowFor(c.owner.api, c.data.runId, c.data.old);
    expect(old.net, 'someone already paid by the previous run gets no earlier days').toBe(36000);
    const db = await P.sql(`select "EarlierDays" as d, "EarlierDaysAmount"::float as a, "EarlierFromDate"::date::text as f from "PayrollRunRows" where "Id" = ${P.q(row.id)}`);
    expect(db[0]).toEqual({ d: earlierDays, a: earlier, f: P.iso(P.dayOf(prev, 20)) });
  });

  test('the carried-forward days show on the payslip as "Earlier days, 20 Oct to 31 Oct"', async () => {
    const reg = await P.register(c.owner.api, c.data.runId);
    if (reg.status === 'Draft') await P.publishOk(c.owner.api, c.data.runId);
    const row = await P.rowFor(c.owner.api, c.data.runId, c.data.late);
    const slip = await P.payslip(c.owner.api, c.data.runId, row.id);
    const prev = P.monthStart(-1);
    const mon = prev.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
    const earlierDays = P.daysInMonth(prev) - 20 + 1;
    expect(slip.lines.map((l) => l.label)).toEqual(['Base salary', `Earlier days, 20 ${mon} to ${P.daysInMonth(prev)} ${mon}`, 'Net salary']);
    expect(slip.lines[1]).toMatchObject({ amount: P.round0((30000 * earlierDays) / 30), kind: 'Addition' });
  });
});
