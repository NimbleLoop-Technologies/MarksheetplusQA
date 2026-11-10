/**
 * Payroll permissions across the 10 stories (PR 544).
 * World "perm": owner (Head Admin) + three invited staff users (staff app-access invite, accepted on AuthApp):
 *   viewer  — custom role "QA Payroll See" (payroll See only)          [DB: role assignment switched to the custom role]
 *   editor  — custom role "QA Payroll Edit" (payroll See + Edit)       [DB: role assignment switched to the custom role]
 *   teacher — custom role with Account Office (fees) See and NO payroll permission [DB: assignment switched]
 * The product has no endpoint to give a user a custom role, so the assignment row is updated in Postgres; the exact
 * SQL is saved to the evidence folder (permissions-role-assignment.sql.txt).
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { request as pwRequest } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import { REST_API } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';
import { StaffPayrollPage } from '../../../pages/payroll/StaffPayrollPage';

interface Cred { phone: string; password: string; userId: string; staffId: string }
interface Data { ayesha: P.Staff; bilal: P.Staff; runId: string; viewer: Cred; editor: Cred; teacher: Cred; sql: string[] }
let w: P.World<Data>;

async function invite(owner: import('../../../fixtures/campus-owner').CampusOwner, roleId?: string): Promise<{ cred: Cred; sql?: string }> {
  const m = await P.inviteMember(owner, roleId ? { customRoleId: roleId } : {});
  const { identifier, password } = m.credentials();
  await m.api.dispose();
  return { cred: { phone: identifier, password, userId: m.userId, staffId: m.staffId }, sql: m.assignmentSql };
}

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('perm', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, {});
    const ayesha = await P.addStaff(api, { salary: 45000, name: P.qaName('Ayesha') });
    const bilal = await P.addStaff(api, { salary: 38000, name: P.qaName('Bilal') });
    const seeRole = await P.createPayrollSeeOnlyRole(api);
    const editRole = await P.createPayrollRole(api, true);
    const viewer = await invite(owner, seeRole);
    const editor = await invite(owner, editRole);
    // No payroll permission, but Account Office (fees) visible, so the nav check is meaningful.
    const teacher = await invite(owner, await P.createPayrollRole(api, false, false));
    const runId = await P.generateRun(api);
    const sql = [viewer.sql!, editor.sql!, teacher.sql!];
    await P.saveEvidence('permissions-role-assignment.sql.txt', sql.join('\n'));
    return { ayesha, bilal, runId, viewer: viewer.cred, editor: editor.cred, teacher: teacher.cred, sql };
  });
});

const tokens: Record<string, APIRequestContext> = {};
async function apiAs(who: 'viewer' | 'editor' | 'teacher'): Promise<APIRequestContext> {
  if (tokens[who]) return tokens[who];
  const c = w.data[who];
  const auth = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  const res = await auth.post(`${REST_API}/auth/login`, { data: { username: c.phone, password: c.password, persona: 1 } });
  expect(res.status(), `${who} RestApi login`).toBe(200);
  const token = (await res.json()).accessToken as string;
  await auth.dispose();
  tokens[who] = await pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: `${REST_API}/`, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  return tokens[who];
}
const asWorld = (who: 'viewer' | 'editor' | 'teacher') => ({
  owner: { credentials: () => ({ identifier: w.data[who].phone, password: w.data[who].password }) },
  statePath: w.statePath.replace('-ui.json', `-${who}-ui.json`),
});
const status = async () => (await P.register(w.owner.api, w.data.runId)).status;

test.describe('Payroll See without Edit — draft', () => {
  test('Staff Payroll page: readable, no "Generate payroll" / "Continue draft", footer note shown', async ({ browser }) => {
    test.skip((await status()) !== 'Draft', 'needs the draft');
    const page = await P.openApp(browser, asWorld('viewer'));
    const ui = new StaffPayrollPage(page);
    await ui.expectMonthCard();
    await expect(ui.stateLine).toContainText(/staff members have exceptions/);
    await expect(ui.continueDraftButton).toHaveCount(0);
    await expect(ui.generateButton).toHaveCount(0);
    await expect(ui.readOnlyNote).toBeVisible();
    await page.screenshot({ path: P.shot('permissions-viewer-landing.png'), fullPage: true });
    await page.context().close();
  });

  test('draft register: readable, no row actions, no "Review and publish", the footer note; the Edit endpoints refuse (403)', async ({ browser }) => {
    test.skip((await status()) !== 'Draft', 'needs the draft');
    const page = await P.openApp(browser, asWorld('viewer'), P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await expect(run.reviewAndPublish).toHaveCount(0);
    await expect(run.rowAction(w.data.ayesha.name, 'Add exception')).toHaveCount(0);
    await expect(run.readOnlyNote).toBeVisible();
    await page.screenshot({ path: P.shot('permissions-viewer-draft.png'), fullPage: true });
    await page.context().close();
    const api = await apiAs('viewer');
    const r = await P.rowFor(w.owner.api, w.data.runId, w.data.ayesha);
    const calls = {
      generate: await api.post('payroll-runs/current'),
      absence: await P.putAbsence(api, w.data.runId, r.id, { unpaidDays: 1 }),
      oneOff: await P.postOneOff(api, w.data.runId, r.id, { type: 'Incentive', label: 'x', amount: 1, reason: 'x' }),
      preview: await P.preview(api, w.data.runId),
    };
    const log = Object.entries(calls).map(([k, v]) => `${k} -> ${v.status()}`);
    await P.saveEvidence('permissions-viewer-draft-api.txt', log.join('\n'));
    for (const [k, v] of Object.entries(calls)) expect(v.status(), k).toBe(403);
    expect((await P.rowFor(w.owner.api, w.data.runId, w.data.ayesha)).unpaidDays).toBe(0);
  });

  test('a publish attempt without Edit is refused server-side (403) and audited as "Publish denied"; an unknown run id also answers 403 (no id probing)', async () => {
    test.skip((await status()) !== 'Draft', 'needs the draft');
    const api = await apiAs('viewer');
    const res = await P.publish(api, w.data.runId);
    expect(res.status()).toBe(403);
    expect((await res.json()).message).toBe('You do not have permission to publish payroll.');
    const denied = (await P.auditEntries(w.data.runId)).filter((a) => a.action === 'Publish denied');
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied.at(-1)!.actor).toBe(w.data.viewer.userId);
    expect(await status()).toBe('Draft');
    expect((await P.publish(api, '00000000-0000-0000-0000-000000000000')).status(), 'review fix: Edit checked before not-found').toBe(403);
  });
});

test.describe('Concurrent publish by two admins', () => {
  test('the second publish is refused with "This payroll was just published by someone else."', async () => {
    let results: { who: string; status: number; body: string }[] = [];
    if ((await status()) === 'Draft') {
      const editor = await apiAs('editor');
      const [a, b] = await Promise.all([P.publish(w.owner.api, w.data.runId), P.publish(editor, w.data.runId)]);
      results = [{ who: 'owner', status: a.status(), body: await a.text() }, { who: 'editor', status: b.status(), body: await b.text() }];
      await P.saveEvidence('publish-concurrent-two-admins.txt', results.map((r) => `${r.who}: ${r.status} ${r.body}`).join('\n'));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(JSON.parse(loser.body).message).toMatch(/^(This payroll was just published by someone else\.|.+ payroll has already been published\.)$/);
    }
    expect((await P.auditEntries(w.data.runId)).filter((a) => a.action === 'Run published')).toHaveLength(1);
    expect(await status()).toBe('Published');
  });
});

test.describe('Payroll See without Edit — published', () => {
  test('published register: readable, no "Mark as paid", no "Post an adjustment", footer note; payslips of paid lines readable', async ({ browser }) => {
    test.skip((await status()) !== 'Published', 'needs the published run');
    const b = await P.rowFor(w.owner.api, w.data.runId, w.data.bilal);
    if (b.paymentStatus === 'Unpaid') await P.markPaid(w.owner.api, w.data.runId, b.id);
    const page = await P.openApp(browser, asWorld('viewer'), P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await expect(run.rowAction(w.data.ayesha.name, 'Mark as paid')).toHaveCount(0);
    await expect(run.postAdjustment).toHaveCount(0);
    await expect(run.readOnlyNote).toBeVisible();
    await run.rowAction(w.data.bilal.name, 'View payslip').click();
    await expect(run.dialogText('Net salary')).toBeVisible();
    await expect(run.dialogButton('Post an adjustment')).toHaveCount(0);
    await page.screenshot({ path: P.shot('permissions-viewer-published.png'), fullPage: true });
    await page.context().close();
  });

  test('mark paid and adjustments without Edit are refused (403) and audited ("Payment denied", "Adjustment denied")', async () => {
    test.skip((await status()) !== 'Published', 'needs the published run');
    const api = await apiAs('viewer');
    const r = await P.rowFor(w.owner.api, w.data.runId, w.data.ayesha);
    const paid = await P.markPaid(api, w.data.runId, r.id);
    expect(paid.status()).toBe(403);
    expect((await paid.json()).message).toBe('You do not have permission to mark payroll as paid.');
    const adj = await P.postAdjustment(api, w.data.runId, { staffMemberId: w.data.ayesha.id, direction: 'PayMore', amount: 100, reason: 'Viewer try' });
    expect(adj.status()).toBe(403);
    expect((await adj.json()).message).toBe('You do not have permission to post a payroll adjustment.');
    const audit = await P.auditEntries(w.data.runId);
    expect(audit.filter((a) => a.action === 'Payment denied' && a.actor === w.data.viewer.userId).length).toBeGreaterThanOrEqual(1);
    expect(audit.filter((a) => a.action === 'Adjustment denied' && a.actor === w.data.viewer.userId).length).toBeGreaterThanOrEqual(1);
    expect((await P.rowFor(w.owner.api, w.data.runId, w.data.ayesha)).paymentStatus).toBe('Unpaid');
    expect((await P.markPaid(api, w.data.runId, '00000000-0000-0000-0000-000000000000')).status(), 'unknown row: 403 too').toBe(403);
  });
});

test.describe('No Payroll permission', () => {
  test('the API refuses every payroll read (403)', async () => {
    const api = await apiAs('teacher');
    for (const url of ['payroll-runs/current', 'payroll-runs/history', `payroll-runs/${w.data.runId}/register`]) {
      expect((await api.get(url)).status(), url).toBe(403);
    }
  });

  test('Staff Payroll is absent from Account Office for a role without the Payroll permission', async ({ browser }) => {
    const page = await P.openApp(browser, asWorld('teacher'), '/accounts/dashboard');
    const ui = new StaffPayrollPage(page);
    await expect(ui.accountOfficeNav).toBeVisible();
    await page.screenshot({ path: P.shot('permissions-no-payroll-account-office-nav.png') });
    await expect(ui.navLink()).toHaveCount(0);
    await page.context().close();
  });

  test('P-DENIED-COPY: the direct URL shows "You do not have permission to view payroll."', async ({ browser }) => {
    const page = await P.openApp(browser, asWorld('teacher'), P.PAYROLL_PATH);
    const ui = new StaffPayrollPage(page);
    await expect(ui.heading).toBeVisible();
    await page.screenshot({ path: P.shot('P-DENIED-COPY-landing.png'), fullPage: true });
    await expect(ui.deniedText('You do not have permission to view payroll.')).toBeVisible();
    await page.goto(P.runPath(w.data.runId));
    await expect(ui.deniedText('You do not have permission to view payroll.')).toBeVisible();
    await page.context().close();
  });
});
