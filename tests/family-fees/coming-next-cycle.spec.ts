/**
 * PR 557 / ClickUp z94x8ed10y — "Remove payment screen - Family App".
 *  AC1: the Payments screen is gone from the family app (nav item, page; old links land on Fees).
 *  AC2: each child's card on the Fees screen offers "View coming next cycle" beside "View statement",
 *       showing that child's next-cycle preview (what the Payments screen's "Coming next cycle" showed).
 * Plus edge cases: per-child figures match the school's preview, remembered open state, bookshop
 * purchases on the account, a child with no challan yet, unreadable preview rows, ended enrollment,
 * signed-out access and another family's view.
 *
 * Data (self-seeded, one throwaway campus + one fresh parent for the whole file):
 *   family F (father mobile = the fresh parent's): Alpha (Class 1, school policy 1,000), Bravo (Class 2, class policy 2,500)
 *   both linked to the parent through the school's invite code; the Worker issues this month's family challan.
 * DB SETUP writes are logged ([DB SETUP]) and touch only this file's rows.
 */
import { test, expect, devices, type Browser, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { newCampusOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { callFamilyApi, createFamilyParent, waitUntilInviteProjected, type FreshParent } from '../../fixtures/devenv';
import { LoginPage } from '../../pages/LoginPage';
import * as f from '../../fixtures/fees';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const FAMILY_DB = process.env.QA_PG_FAMILY_DB ?? 'mp-familyapp-db';
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
const NOT_PUBLISHED = "Your next cycle's fees will appear here once the school publishes them.";
const SUBJECT_TO = 'Subject to any school updates before the cycle opens.';

test.describe.configure({ mode: 'default' });

interface Seed {
  parent: FreshParent;
  alpha: f.Student;
  bravo: f.Student;
  learners: Record<string, string>; // studentId -> learnerId
  enrollments: Record<string, string>; // studentId -> enrollmentId
}

let owner: CampusOwner;
let seed: Seed;

const fam = (statement: string) => f.sql(statement, FAMILY_DB);
async function famSetup(reason: string, statement: string) {
  console.log(`[DB SETUP family] ${reason}\n${statement.trim()}`);
  return fam(statement);
}
const shot = async (page: Page, name: string) => {
  await mkdir(EV, { recursive: true });
  await page.screenshot({ path: path.join(EV, `fees-next-cycle-${name}.png`), fullPage: true });
};

/** Owner issues the student's invite code; the parent redeems it and accepts it as a new child. */
async function link(o: CampusOwner, parent: FreshParent, studentId: string): Promise<void> {
  const sent = await f.ok(await o.api.post(`students/${studentId}/parent-family/invite`, { data: { sendWhatsApp: false } }), `invite ${studentId}`);
  expect(sent.code, `invite code for ${studentId}: ${JSON.stringify(sent)}`).toBeTruthy();
  await waitUntilInviteProjected(studentId);
  const redeem = await callFamilyApi(parent, 'POST', '/family/link-invites/redeem', { code: sent.code });
  expect(redeem.status, `redeem: ${redeem.body}`).toBe(200);
  const inviteId = JSON.parse(redeem.body).inviteId as string;
  const accept = await callFamilyApi(parent, 'POST', `/family/link-invites/${inviteId}/accept`, { childId: null, token: sent.code });
  expect(accept.status, `accept: ${accept.body}`).toBe(200);
}

/** The learner-plane fee mirror row of one student (null until projected). */
async function statementRow(studentId: string) {
  const rows = await fam(`select "LearnerId","EnrollmentId",coalesce("HasIssuedStatement"::text,''),coalesce("UpcomingCycleJson"::text,''),"UnbilledBookshopAmount"::text,"TotalOutstanding"::text
    from "LearnerFeeStatements" where "StudentId" = ${f.sqlQuote(studentId)}`);
  if (rows.length === 0) return null;
  const [learnerId, enrollmentId, issued, upcoming, unbilled, outstanding] = rows[0];
  return { learnerId, enrollmentId, issued: issued === 'true', upcoming: upcoming ? JSON.parse(upcoming) : null, unbilled: Number(unbilled), outstanding: Number(outstanding) };
}

async function finance(parent: FreshParent): Promise<any> {
  const res = await callFamilyApi(parent, 'GET', '/family/finance');
  expect(res.status, res.body.slice(0, 300)).toBe(200);
  return JSON.parse(res.body);
}
const schoolEntry = (overview: any, studentId: string) =>
  overview.children.flatMap((c: any) => c.schools.map((s: any) => ({ ...s, childName: c.name, learnerId: c.learnerId })))
    .find((s: any) => s.enrollmentId === seed.enrollments[studentId]);

async function parentPage(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: process.env.QA_FAMILY_URL, ignoreHTTPSErrors, ...opts });
  const page = await context.newPage();
  await page.goto('/fees');
  await new LoginPage(page).signIn(seed.parent.email, seed.parent.password);
  await expect(page).toHaveURL(/\/fees/, { timeout: 45_000 });
  await expect(page.getByTestId('fees-overview')).toBeVisible({ timeout: 45_000 });
  return page;
}
const card = (page: Page, s: f.Student) => page.getByTestId('child-school-card').filter({ hasText: s.name });

test.beforeAll(async ({}, testInfo) => {
  test.setTimeout(10 * 60_000);
  const seeded = await f.seededOnce<Seed>(testInfo.project.outputDir, 'coming-next-cycle', async () => {
    const o = await newCampusOwner('nc557');
    const sc = await f.setupSchool(o, 2);
    const parent = await createFamilyParent();
    const father = f.personName('Fathernc');
    const a = await f.addStudent(o, { name: f.personName('Alpha'), classId: sc.classes[0].id, fatherName: father, fatherMobile: parent.phone });
    const b = await f.addStudent(o, { name: f.personName('Bravo'), classId: sc.classes[1].id, fatherName: father, fatherMobile: parent.phone });
    expect(a.familyId, 'siblings share one school family').toBe(b.familyId);
    await link(o, parent, a.id);
    await link(o, parent, b.id);
    const root = await f.createSchoolPolicy(o, { tuition: 1000 });
    expect(root.status, JSON.stringify(root.body)).toBe(201);
    const cls = await f.createClassPolicy(o, root.id, [sc.classes[1].id], { tuition: 2500 });
    expect(cls.status, JSON.stringify(cls.body)).toBe(201);
    await f.armTodaysRun(o.tenantId);
    await f.waitForChallans(o.tenantId, 1);
    const learners: Record<string, string> = {};
    const enrollments: Record<string, string> = {};
    await expect(async () => {
      for (const s of [a, b]) {
        const row = await statementRow(s.id);
        expect(row?.issued, `issued statement mirrored for ${s.name}`).toBe(true);
        learners[s.id] = row!.learnerId;
        enrollments[s.id] = row!.enrollmentId;
      }
    }).toPass({ timeout: 180_000, intervals: [3_000] });
    console.log(`tenant ${o.tenantId} family ${a.familyId} parent ${parent.phone}`);
    return { owner: o, data: { parent, alpha: a, bravo: b, learners, enrollments } };
  });
  owner = seeded.owner;
  seed = seeded.data;
});

test.afterAll(async () => {
  await owner?.api.dispose();
});

// ── AC1: Payments screen removed ─────────────────────────────────────────────────────────────

test('AC1 the family navigation no longer has Payments: Home, Exams & Datesheet, Fees, Purchases', { tag: '@smoke' }, async ({ browser }) => {
  const nav = await callFamilyApi(seed.parent, 'GET', '/family/navigation');
  expect(nav.status).toBe(200);
  expect(nav.body.toLowerCase()).not.toContain('payments');
  const page = await parentPage(browser);
  const sidebar = page.getByRole('navigation').first();
  await expect(sidebar.getByText('Fees', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Payments$/ })).toHaveCount(0);
  await expect(page.getByText(/^Payments$/)).toHaveCount(0);
  await shot(page, 'ac1-nav');
  await page.context().close();
});

test('AC1 old /payments links land on Fees (replace, no not-found page); GET /family/payments is gone (404, not 500)', async ({ browser }) => {
  const page = await parentPage(browser);
  await page.goto('/payments');
  await expect(page).toHaveURL(/\/fees$/, { timeout: 30_000 });
  await expect(page.getByTestId('fees-overview')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/not found|nothing at this address/i)).toHaveCount(0);
  await page.goto('/payments?school=x#y');
  await expect(page).toHaveURL(/\/fees$/, { timeout: 30_000 });
  // Back from Fees must not bounce through /payments again (NavigateTo replace: true).
  await page.goto('/dashboard');
  await page.goto('/payments');
  await expect(page).toHaveURL(/\/fees$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard/);
  const api = await callFamilyApi(seed.parent, 'GET', '/family/payments');
  expect(api.status).toBe(404);
  await page.context().close();
});

// ── AC2: View coming next cycle on each child's card ─────────────────────────────────────────

test('AC2 every child card shows "View statement" and "View coming next cycle" side by side, closed by default', { tag: '@smoke' }, async ({ browser }) => {
  const page = await parentPage(browser);
  for (const s of [seed.alpha, seed.bravo]) {
    const c = card(page, s);
    await expect(c).toHaveCount(1);
    await expect(c.getByTestId('view-statement-link')).toHaveText('View statement');
    const toggle = c.getByTestId('coming-next-cycle-toggle');
    await expect(toggle).toHaveText('View coming next cycle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(c.getByTestId('coming-next-cycle-content')).toHaveCount(0);
    // Same action row
    const linkBox = (await c.getByTestId('view-statement-link').boundingBox())!;
    const toggleBox = (await toggle.boundingBox())!;
    expect(Math.abs(linkBox.y - toggleBox.y), 'link and toggle on one row').toBeLessThan(12);
  }
  await shot(page, 'ac2-closed');
  await page.context().close();
});

test('AC2 opening a child\'s preview shows that child\'s own estimate, matching the school\'s preview; the sibling stays closed', { tag: '@smoke' }, async ({ browser }) => {
  const overview = await finance(seed.parent);
  const page = await parentPage(browser);
  for (const [s, other, amount] of [[seed.alpha, seed.bravo, 1000], [seed.bravo, seed.alpha, 2500]] as const) {
    const row = await statementRow(s.id);
    expect(row?.upcoming, `school preview mirrored for ${s.name}`).toBeTruthy();
    expect(row!.upcoming.EstimatedAmount, `school preview amount for ${s.name}`).toBe(amount);
    const entry = schoolEntry(overview, s.id);
    expect(entry.comingNextCycle.estimatedAmount).toBe(amount);
    const month = new Date(entry.comingNextCycle.cycleStartDate).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    const c = card(page, s);
    await c.getByTestId('coming-next-cycle-toggle').click();
    await expect(c.getByTestId('coming-next-cycle-toggle')).toHaveText('Hide coming next cycle');
    await expect(c.getByTestId('coming-next-cycle-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(c.getByTestId('coming-next-cycle-summary')).toHaveText(`Expected in ${month}: Rs. ${amount.toLocaleString('en-US')} (based on the current fee policy).`);
    await expect(c.getByTestId('coming-next-cycle-content')).toContainText(SUBJECT_TO);
    await expect(card(page, other).getByTestId('coming-next-cycle-content')).toHaveCount(0);
    await shot(page, `ac2-open-${s === seed.alpha ? 'alpha' : 'bravo'}`);
    await c.getByTestId('coming-next-cycle-toggle').click();
    await expect(c.getByTestId('coming-next-cycle-content')).toHaveCount(0);
    await expect(c.getByTestId('coming-next-cycle-toggle')).toHaveText('View coming next cycle');
  }
  await page.context().close();
});

test('AC2 an open preview stays open after a reload in the same session, and starts closed in a new session', async ({ browser }) => {
  const page = await parentPage(browser);
  await card(page, seed.bravo).getByTestId('coming-next-cycle-toggle').click();
  await expect(card(page, seed.bravo).getByTestId('coming-next-cycle-content')).toBeVisible();
  await page.reload();
  await expect(card(page, seed.bravo).getByTestId('coming-next-cycle-content')).toBeVisible({ timeout: 30_000 });
  await expect(card(page, seed.alpha).getByTestId('coming-next-cycle-content')).toHaveCount(0);
  await page.context().close();
  const fresh = await parentPage(browser);
  await expect(card(fresh, seed.bravo).getByTestId('coming-next-cycle-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(fresh.getByTestId('coming-next-cycle-content')).toHaveCount(0);
  await fresh.context().close();
});

test('AC2 "View statement" still opens the child\'s statement, and Back returns to Fees', async ({ browser }) => {
  const page = await parentPage(browser);
  await card(page, seed.alpha).getByTestId('view-statement-link').click();
  await expect(page).toHaveURL(new RegExp(`/fees/child/${seed.learners[seed.alpha.id]}/${seed.enrollments[seed.alpha.id]}`));
  await expect(page.getByText(/couldn.t load/i)).toHaveCount(0);
  await expect(page.getByRole('main')).toContainText(/Rs\. ?[\d,]+/, { timeout: 30_000 });
  await shot(page, 'ac2-statement');
  await page.goBack();
  await expect(page).toHaveURL(/\/fees$/);
  await expect(page.getByTestId('fees-overview')).toBeVisible({ timeout: 30_000 });
  await page.context().close();
});

test('AC2 on a phone the two actions are both visible and the preview opens inside the card', async ({ browser }) => {
  const { defaultBrowserType: _ignored, ...phone } = devices['Pixel 7'];
  const page = await parentPage(browser, phone);
  const c = card(page, seed.alpha);
  await expect(c.getByTestId('view-statement-link')).toBeInViewport({ ratio: 0.5 }).catch(async () => c.scrollIntoViewIfNeeded());
  await expect(c.getByTestId('view-statement-link')).toBeVisible();
  await expect(c.getByTestId('coming-next-cycle-toggle')).toBeVisible();
  await c.getByTestId('coming-next-cycle-toggle').click();
  const content = c.getByTestId('coming-next-cycle-content');
  await expect(content).toBeVisible();
  const cardBox = (await c.boundingBox())!;
  const contentBox = (await content.boundingBox())!;
  expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll').toBe(true);
  await shot(page, 'ac2-phone');
  await page.context().close();
});

// ── Edge cases ───────────────────────────────────────────────────────────────────────────────

test('EDGE bookshop purchases charged to the fee account show under that child\'s preview (real fee-account sale)', async ({ browser }) => {
  const itemId = await f.setupBookshop(owner, 300);
  await f.feeAccountSale(owner, seed.alpha.id, itemId, 1);
  await expect(async () => {
    expect((await statementRow(seed.alpha.id))?.unbilled).toBe(300);
  }).toPass({ timeout: 120_000, intervals: [3_000] });
  const page = await parentPage(browser);
  await card(page, seed.alpha).getByTestId('coming-next-cycle-toggle').click();
  await expect(card(page, seed.alpha).getByTestId('coming-next-cycle-unbilled')).toHaveText('Plus Rs. 300 of bookshop purchases already on your account.');
  await card(page, seed.bravo).getByTestId('coming-next-cycle-toggle').click();
  await expect(card(page, seed.bravo).getByTestId('coming-next-cycle-unbilled')).toHaveCount(0);
  await shot(page, 'edge-bookshop');
  await page.context().close();
});

test('EDGE a credit covering the next cycle and a policy change in flight are worded as on the old Payments screen', async ({ browser }) => {
  const row = await statementRow(seed.bravo.id);
  const preview = { ...row!.upcoming, ExpectedAfterCredit: 0, CreditRemaining: 500, PolicyChangeInFlight: true };
  await famSetup('bravo: preview fully covered by a 3,000 credit (2,500 used, 500 left) + policy change in flight',
    `update "LearnerFeeStatements" set "UpcomingCycleJson" = ${f.sqlQuote(JSON.stringify(preview))} where "StudentId" = ${f.sqlQuote(seed.bravo.id)}`);
  const month = new Date(preview.CycleStartDate ?? preview.DueDate).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const page = await parentPage(browser);
  const c = card(page, seed.bravo);
  await c.getByTestId('coming-next-cycle-toggle').click();
  await expect(c.getByTestId('coming-next-cycle-summary')).toHaveText(`Expected in ${month}: Rs. 0. Your credit of Rs. 3,000 covers it; Rs. 500 remains as credit.`);
  await expect(c.getByTestId('policy-change-warning')).toHaveText(`The school is updating fees for ${month}. This estimate may change.`);
  await shot(page, 'edge-credit-policy-change');
  await famSetup('bravo: restore the school preview', `update "LearnerFeeStatements" set "UpcomingCycleJson" = ${f.sqlQuote(JSON.stringify(row!.upcoming))} where "StudentId" = ${f.sqlQuote(seed.bravo.id)}`);
  await page.context().close();
});

test('EDGE no preview from the school, or an unreadable preview row: the card still loads and says it is not published yet (no 500)', async ({ browser }) => {
  const row = await statementRow(seed.alpha.id);
  await famSetup('alpha: unreadable preview (valid jsonb, wrong types for the C# record)', `update "LearnerFeeStatements" set "UpcomingCycleJson" = '{"EstimatedAmount": "oops", "DueDate": 7}' where "StudentId" = ${f.sqlQuote(seed.alpha.id)}`);
  const res = await callFamilyApi(seed.parent, 'GET', '/family/finance');
  expect(res.status).toBe(200);
  const page = await parentPage(browser);
  await card(page, seed.alpha).getByTestId('coming-next-cycle-toggle').click();
  await expect(card(page, seed.alpha).getByTestId('coming-next-cycle-summary')).toHaveText(NOT_PUBLISHED);
  await expect(card(page, seed.alpha).getByTestId('coming-next-cycle-content')).not.toContainText(SUBJECT_TO);
  await famSetup('alpha: no preview at all', `update "LearnerFeeStatements" set "UpcomingCycleJson" = null where "StudentId" = ${f.sqlQuote(seed.alpha.id)}`);
  await page.reload();
  await expect(card(page, seed.alpha).getByTestId('coming-next-cycle-summary')).toHaveText(NOT_PUBLISHED, { timeout: 30_000 });
  await shot(page, 'edge-not-published');
  await famSetup('alpha: restore the school preview', `update "LearnerFeeStatements" set "UpcomingCycleJson" = ${f.sqlQuote(JSON.stringify(row!.upcoming))} where "StudentId" = ${f.sqlQuote(seed.alpha.id)}`);
  await page.context().close();
});

test('EDGE a child whose school has issued no challan yet: "No challan issued yet", the preview but no statement link', async ({ browser }) => {
  await famSetup('alpha: mirror row as a preview-only statement (new student before the first run)',
    `update "LearnerFeeStatements" set "HasIssuedStatement" = false where "StudentId" = ${f.sqlQuote(seed.alpha.id)}`);
  const page = await parentPage(browser);
  const c = card(page, seed.alpha);
  await expect(c.getByTestId('no-statement-text')).toHaveText('No challan issued yet');
  await expect(c.getByTestId('view-statement-link')).toHaveCount(0);
  await expect(c.getByTestId('coming-next-cycle-toggle')).toBeVisible();
  await c.getByTestId('coming-next-cycle-toggle').click();
  await expect(c.getByTestId('coming-next-cycle-summary')).toContainText('Expected in');
  await shot(page, 'edge-no-challan-yet');
  await famSetup('alpha: restore', `update "LearnerFeeStatements" set "HasIssuedStatement" = true where "StudentId" = ${f.sqlQuote(seed.alpha.id)}`);
  await page.context().close();
});

test('EDGE a child who left the school (enrollment no longer Active) gets no next-cycle preview', async () => {
  const enr = seed.enrollments[seed.bravo.id];
  const [[status]] = await fam(`select "Status"::text from "LearnerEnrollments" where "Id" = ${f.sqlQuote(enr)}`);
  try {
    await famSetup('bravo: enrollment ended', `update "LearnerEnrollments" set "Status" = 'Ended' where "Id" = ${f.sqlQuote(enr)}`).catch(async () =>
      famSetup('bravo: enrollment ended (int enum)', `update "LearnerEnrollments" set "Status" = 2 where "Id" = ${f.sqlQuote(enr)}`));
    const res = await callFamilyApi(seed.parent, 'GET', '/family/finance');
    expect(res.status).toBe(200);
    const entry = schoolEntry(JSON.parse(res.body), seed.bravo.id);
    test.info().annotations.push({ type: 'ended-enrollment', description: entry ? 'card kept, preview removed' : 'card removed from the overview' });
    if (entry) expect(entry.comingNextCycle ?? null).toBeNull();
  } finally {
    await famSetup('bravo: restore enrollment', `update "LearnerEnrollments" set "Status" = ${f.sqlQuote(status)} where "Id" = ${f.sqlQuote(enr)}`).catch(() =>
      famSetup('bravo: restore enrollment (int)', `update "LearnerEnrollments" set "Status" = ${Number(status)} where "Id" = ${f.sqlQuote(enr)}`));
  }
});

test('EDGE the month is the cycle\'s month in any browser time zone (UTC-5 and UTC+14)', async ({ browser }) => {
  for (const timezoneId of ['America/New_York', 'Pacific/Kiritimati']) {
    const page = await parentPage(browser, { timezoneId });
    await card(page, seed.alpha).getByTestId('coming-next-cycle-toggle').click();
    const row = await statementRow(seed.alpha.id);
    const month = new Date(row!.upcoming.CycleStartDate).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    await expect(card(page, seed.alpha).getByTestId('coming-next-cycle-summary')).toContainText(`Expected in ${month}:`);
    await page.context().close();
  }
});

test('EDGE a student admitted after this month\'s challans (real flow): "No challan issued yet" with the preview once the school re-projects the family', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const charlie = await f.addStudent(owner, { name: f.personName('Charlie'), classId: seed.alpha.classId, fatherName: 'Fathernc Late', fatherMobile: seed.parent.phone });
  expect(charlie.familyId, 'late sibling joins the billed family').toBe(seed.alpha.familyId);
  await link(owner, seed.parent, charlie.id);
  // Observation O1 (pre-existing, not PR 557): admission alone does not re-project the family, so until the next
  // money event the new child's card has no mirror row: "No fee information yet" and no next-cycle option.
  const before = await parentPage(browser);
  await expect(card(before, charlie)).toHaveCount(1, { timeout: 45_000 });
  await expect(card(before, charlie).getByTestId('no-statement-text')).toHaveText(/No fee information yet|No challan issued yet/);
  test.info().annotations.push({ type: 'late-sibling-before-money-event', description: (await card(before, charlie).getByTestId('no-statement-text').textContent()) ?? '' });
  await shot(before, 'edge-new-student-before-money-event');
  await before.context().close();
  // Any money event on the family (here a fee-account bookshop sale for the sibling) re-projects every student.
  const itemId = await f.setupBookshop(owner, 50);
  await f.feeAccountSale(owner, seed.alpha.id, itemId, 1);
  let row: Awaited<ReturnType<typeof statementRow>> = null;
  await expect(async () => {
    row = await statementRow(charlie.id);
    expect(row, 'mirror row for the new student').not.toBeNull();
  }).toPass({ timeout: 120_000, intervals: [3_000] });
  expect(row!.issued, 'no challan issued yet for the late admission').toBe(false);
  expect(row!.upcoming?.EstimatedAmount).toBe(1000);
  const page = await parentPage(browser);
  const c = card(page, charlie);
  await expect(c.getByTestId('no-statement-text')).toHaveText('No challan issued yet');
  await expect(c.getByTestId('view-statement-link')).toHaveCount(0);
  await expect(c.getByTestId('school-outstanding')).toHaveCount(0);
  await c.getByTestId('coming-next-cycle-toggle').click();
  await expect(c.getByTestId('coming-next-cycle-summary')).toContainText('Rs. 1,000 (based on the current fee policy).');
  await shot(page, 'edge-new-student-real');
  await page.context().close();
});

test('PERM signed-out: /fees and /payments go to sign-in, GET /family/finance is 401', async ({ browser, playwright }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: process.env.QA_FAMILY_URL, ignoreHTTPSErrors });
  const page = await context.newPage();
  for (const route of ['/fees', '/payments']) {
    await page.goto(route);
    await new LoginPage(page).expectLoaded();
  }
  await context.close();
  const anon = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  expect((await anon.get(`${process.env.QA_REST_API_URL}/family/finance`)).status()).toBe(401);
  await anon.dispose();
});

test('PERM another parent sees none of this family\'s children or previews', async () => {
  const other = await createFamilyParent();
  const overview = await finance(other);
  const json = JSON.stringify(overview);
  for (const s of [seed.alpha, seed.bravo]) {
    expect(json).not.toContain(seed.enrollments[s.id]);
    expect(json).not.toContain(s.name);
  }
});
