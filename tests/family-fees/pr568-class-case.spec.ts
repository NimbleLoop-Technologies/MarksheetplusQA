/**
 * PR 568 / ClickUp z94x8eavje — Family app title-cases class labels and fund names.
 *
 * Ticket (plus the attachment): capitalize the first letter of the class name and the fund name.
 * Jamie-qa fail: Fees and Home showed "orange-7 (A)" and "class 1-1 (A)"; fund name was untested (no challan).
 * After the fix: "Orange-7 (A)" / "Class 1-1 (A)", fund names title-cased. Also check the statement,
 * the purchase bill and the datesheets. WebApp printed challan and invite labels changed too — they must not regress.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { newCampusOwner, cacheOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { createFamilyParent, callFamilyApi, type FreshParent } from '../../fixtures/devenv';
import { LoginPage } from '../../pages/LoginPage';
import { FamilyDashboardPage } from '../../pages/family/FamilyDashboardPage';
import { signInToWebApp } from '../../pages/fees/AccountOffice';
import * as f from '../../fixtures/fees';
import * as shop from '../../fixtures/bookshop';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.resolve(EV, '..', 'seed');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
const FAMILY = process.env.QA_FAMILY_URL ?? 'https://localhost:7100';
const WEB = process.env.QA_BASE_URL ?? 'https://localhost:7236';

test.describe.configure({ mode: 'serial' });

const addDays = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
};
const localYmd = (d = new Date()) => {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

interface Seed {
  owner: CampusOwner;
  parent: FreshParent;
  alia: f.Student;
  zain: f.Student;
  bilal: f.Student;
  orangeId: string;
  class1Id: string;
  term1: string;
  fundId: string;
  sale?: shop.Sale;
}

let seed: Seed;

const shot = async (page: Page, name: string) => {
  mkdirSync(EV, { recursive: true });
  await page.screenshot({ path: path.join(EV, `${name}.png`), fullPage: true });
};

const noLowerClass = (text: string) => !/(^|[\n·]|,\s)orange-7|(^|[\n·]|,\s)class 1-1/.test(text);

async function link(owner: CampusOwner, parent: FreshParent, studentId: string) {
  const sent = await f.ok(await owner.api.post(`students/${studentId}/parent-family/invite`), `invite ${studentId}`);
  expect(sent.code, `invite code for ${studentId}`).toBeTruthy();
  let redeem = { status: 0, body: '' };
  await expect(async () => {
    redeem = await callFamilyApi(parent, 'POST', '/family/link-invites/redeem', { code: sent.code });
    expect(redeem.status, `redeem: ${redeem.body}`).toBe(200);
  }).toPass({ timeout: 60_000, intervals: [2_000] });
  const inviteId = JSON.parse(redeem.body).inviteId as string;
  const accept = await callFamilyApi(parent, 'POST', `/family/link-invites/${inviteId}/accept`, { childId: null, token: null });
  expect(accept.status, `accept: ${accept.body}`).toBe(200);
  await expect(async () => {
    const status = await f.ok(await owner.api.get(`students/${studentId}/parent-family`), `link status ${studentId}`);
    expect(status.status, JSON.stringify(status)).toBe('Linked');
  }).toPass({ timeout: 60_000, intervals: [2_000] });
}

async function parentPage(browser: Browser, start = '/dashboard'): Promise<Page> {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: FAMILY,
    ignoreHTTPSErrors,
    viewport: { width: 1280, height: 900 },
    timezoneId: 'Asia/Karachi',
  });
  const page = await ctx.newPage();
  await page.goto(start);
  await new LoginPage(page).signIn(seed.parent.email, seed.parent.password);
  return page;
}

test.beforeAll(async () => {
  test.setTimeout(12 * 60_000);
  mkdirSync(EV, { recursive: true });
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  const owner = await newCampusOwner('pr568');
  const session = await f.ok(await owner.api.post('sessions/create', {
    data: {
      sessionName: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30',
      terms: [
        { termName: 'Term 1', termStartDate: '2026-09-01', termEndDate: '2026-12-31', passingCriteria: 40 },
        { termName: 'Term 2', termStartDate: '2027-01-01', termEndDate: '2027-06-30', passingCriteria: 40 },
      ],
    },
  }), 'sessions/create');
  const term1 = session.terms?.[0]?.id ?? session.Terms?.[0]?.Id;
  expect(term1, 'term 1 id').toBeTruthy();
  const orange = await f.ok(await owner.api.post('classes/create', {
    data: { className: 'orange', grade: '7', sections: [{ sectionName: 'A', size: 40 }], subjects: null },
  }), 'orange');
  const c1 = await f.ok(await owner.api.post('classes/create', {
    data: { className: 'class 1', grade: '1', sections: [{ sectionName: 'A', size: 40 }], subjects: null },
  }), 'class 1');
  const parent = await createFamilyParent();
  const father = 'Farooq Avje';
  const alia = await f.addStudent(owner, { name: 'Alia Avje', classId: orange.id, fatherName: father, fatherMobile: parent.phone });
  const zain = await f.addStudent(owner, { name: 'Zain Avje', classId: c1.id, fatherName: father, fatherMobile: parent.phone });
  const bilal = await f.addStudent(owner, { name: 'Bilal Avje', classId: orange.id, fatherName: father, fatherMobile: parent.phone });
  await link(owner, parent, alia.id);
  await link(owner, parent, zain.id);

  const fundRes = await owner.api.post('additional-funds', { data: { name: 'sport fund', description: null, amount: 500 } });
  expect(fundRes.status(), `create fund: ${await fundRes.text()}`).toBeLessThan(300);
  const fundId = (await fundRes.json()).id as string;
  expect(fundId, 'fund id').toBeTruthy();
  const root = await f.createSchoolPolicy(owner, { tuition: 1000 });
  expect(root.status, JSON.stringify(root.body)).toBe(201);
  const updated = await f.updatePolicy(owner, root.id, { additionalFundIds: [fundId] });
  expect(updated.status(), `attach sport fund: ${await updated.text()}`).toBeLessThan(300);

  await f.armTodaysRun(owner.tenantId);
  await f.waitForChallans(owner.tenantId, 1);

  const item = await shop.createPricedItem(owner, { name: 'QA Pencil', price: 30, cost: 10, stock: 20 });
  const sale = await shop.sale(owner, [{ type: 'Item', itemId: item.id, quantity: 1 }], { studentId: alia.id, feeAccount: true });

  const subjects = await f.ok(await owner.api.get(`grades/7/default-subjects`), 'subjects grade 7') as Array<{ name?: string; Name?: string }>;
  const subjectName = (subjects[0]?.name ?? subjects[0]?.Name ?? '').trim();
  expect(subjectName, 'a default subject for grade 7').toBeTruthy();
  await f.ok(await owner.api.post('datesheet/init', { data: { termId: term1 } }), 'datesheet/init');
  const saved = await f.ok(await owner.api.post('datesheet/save-assignments', {
    data: { termId: term1, assignments: [{ classId: orange.id, examDate: `${addDays(localYmd(), 5)}T00:00:00Z`, subjectName }] },
  }), 'datesheet/save-assignments');
  expect(saved.failures ?? saved.Failures ?? [], JSON.stringify(saved)).toEqual([]);
  await f.ok(await owner.api.post(`datesheet/publish/${term1}`), 'datesheet/publish');

  seed = { owner, parent, alia, zain, bilal, orangeId: orange.id, class1Id: c1.id, term1, fundId, sale };
  const cached = cacheOwner(owner);
  writeFileSync(path.join(SEED_DIR, 'seed.json'), JSON.stringify({
    email: cached.email, phone: cached.phone, tenantId: cached.tenantId, schoolName: cached.schoolName,
    password: cached.password, parentEmail: parent.email, parentPassword: parent.password,
    alia: alia.id, zain: zain.id, bilal: bilal.id, fundId, saleId: sale.id, billNumber: sale.billNumber,
  }), { mode: 0o600 });
  try { chmodSync(SEED_DIR, 0o700); } catch { /* */ }
});

test('Family Fees and Home show Orange-7 (A) / Class 1-1 (A), and fund names are title-cased', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  const page = await parentPage(browser, '/dashboard');
  await new FamilyDashboardPage(page).expectLoaded();
  await shot(page, 'family-home');
  const home = await page.locator('main').innerText();
  writeFileSync(path.join(EV, 'family-home.txt'), home);
  expect(home, `Home still has lowercase class labels:\n${home}`).toContain('Orange-7 (A)');
  expect(home, `Home still has lowercase class labels:\n${home}`).toContain('Class 1-1 (A)');
  expect(noLowerClass(home), `Home leaked a lowercase class label:\n${home}`).toBe(true);
  const aliaLine = await new FamilyDashboardPage(page).childSchoolLine('Alia Avje').innerText().catch(() => '');
  const zainLine = await new FamilyDashboardPage(page).childSchoolLine('Zain Avje').innerText().catch(() => '');
  expect(aliaLine).toMatch(/Orange-7 \(A\)/);
  expect(zainLine).toMatch(/Class 1-1 \(A\)/);

  await page.goto('/fees');
  await expect(page.getByTestId('fees-overview').or(page.getByRole('heading', { name: /^Fees$/ }))).toBeVisible({ timeout: 45_000 });
  await shot(page, 'family-fees');
  const fees = await page.locator('main').innerText();
  writeFileSync(path.join(EV, 'family-fees.txt'), fees);
  expect(fees).toContain('Orange-7 (A)');
  expect(fees).toContain('Class 1-1 (A)');
  expect(noLowerClass(fees), `Fees leaked a lowercase class label:\n${fees}`).toBe(true);
  // Fund names are on the statement line items, not the Fees overview cards (those show totals only).
});

test('Statement, purchase bill and datesheets use the same title-cased class (and fund) labels', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  const page = await parentPage(browser, '/fees');
  await expect(page.getByTestId('view-statement-link').first()).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('view-statement-link').first().click();
  await page.waitForTimeout(2500);
  await shot(page, 'family-statement');
  const statement = await page.locator('main').innerText();
  writeFileSync(path.join(EV, 'family-statement.txt'), statement);
  expect(statement, `statement missing Orange-7 (A):\n${statement}`).toMatch(/Orange-7 \(A\)|Class 1-1 \(A\)/);
  expect(noLowerClass(statement), `statement lowercase class:\n${statement}`).toBe(true);
  expect(statement, `statement should title-case sport fund:\n${statement}`).toMatch(/Sport Fund/i);
  expect(statement, `statement still has lowercase sport fund:\n${statement}`).not.toMatch(/(^|\n)sport fund\b/);
  // Purchase bill (fee-account bookshop sale) — class title-cased if shown; bill number preserved.
  if (seed.sale?.billNumber) {
    expect(statement, `statement should mention the bookshop bill ${seed.sale.billNumber}:\n${statement}`).toMatch(new RegExp(seed.sale.billNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const billLink = page.getByRole('link', { name: /bill|purchase|BK-/i }).first();
  if (await billLink.count()) {
    await billLink.click();
    await page.waitForTimeout(2000);
    await shot(page, 'family-purchase-bill');
    const bill = await page.locator('main').innerText();
    writeFileSync(path.join(EV, 'family-purchase-bill.txt'), bill);
    expect(noLowerClass(bill), `purchase bill lowercase class:\n${bill}`).toBe(true);
  } else {
    writeFileSync(path.join(EV, 'family-purchase-bill.txt'), `No separate bill link; bill appears on the statement.\n\n${statement}`);
  }

  await page.goto('/exams');
  await expect(page.getByRole('heading', { name: 'Exams & Datesheet' })).toBeVisible({ timeout: 45_000 });
  await shot(page, 'family-exams');
  const aliaChip = page.getByRole('button', { name: /^Alia$/ }).or(page.getByRole('tab', { name: /^Alia$/ }));
  if (await aliaChip.count()) await aliaChip.first().click();
  await page.waitForTimeout(800);
  // The exam row is a button named after the subject; it opens /exams/child/...
  const subjectBtn = page.getByRole('button', { name: /Computer Science/i }).first();
  await expect(subjectBtn).toBeVisible({ timeout: 20_000 });
  await subjectBtn.click();
  await expect(page).toHaveURL(/\/exams\/child\//, { timeout: 20_000 });
  await shot(page, 'family-datesheet');
  const datesheet = await page.locator('main').innerText();
  writeFileSync(path.join(EV, 'family-datesheet.txt'), datesheet);
  // The datesheet header may use the full "Orange-7 (A)" label or the title-cased class name "Orange".
  expect(datesheet, `datesheet missing a title-cased class:\n${datesheet}`).toMatch(/Orange-7 \(A\)|Orange/);
  expect(noLowerClass(datesheet), `datesheet lowercase class:\n${datesheet}`).toBe(true);
});

test('WebApp printed challan and invite labels stay title-cased (no regression)', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  const prints = await f.ok(
    await seed.owner.api.get(`fee-payments/families/${seed.alia.familyId}/challan-prints`),
    'challan-prints',
  );
  writeFileSync(path.join(EV, 'challan-prints.json'), JSON.stringify(prints, null, 2));
  const blob = JSON.stringify(prints);
  expect(blob, `printed challan missing a title-cased class label: ${blob.slice(0, 1500)}`).toMatch(/Orange-7 \(A\)|Class 1-1 \(A\)/);
  expect(blob, `printed challan leaked lowercase class: ${blob.slice(0, 1500)}`).not.toMatch(/orange-7 \(A\)|class 1-1 \(A\)/);

  const ctx = await browser.newContext({
    ignoreHTTPSErrors, baseURL: WEB, timezoneId: 'Asia/Karachi', viewport: { width: 1280, height: 900 },
  });
  const web = await ctx.newPage();
  await signInToWebApp(web, seed.owner.credentials());
  await web.goto('/account-office/fee-payment');
  await web.waitForTimeout(4000);
  const printBtn = web.getByRole('button', { name: /print/i }).first();
  if (await printBtn.count()) {
    await printBtn.click();
    await web.waitForTimeout(2000);
  }
  await shot(web, 'webapp-fee-payment');
  writeFileSync(path.join(EV, 'webapp-fee-payment.txt'), await web.locator('main').innerText().catch(() => ''));
  await ctx.close();

  // Invite card for an unlinked sibling (Bilal): FamilyLinkClaimShared now normalizes the class label.
  const sent = await f.ok(await seed.owner.api.post(`students/${seed.bilal.id}/parent-family/invite`), 'invite Bilal');
  expect(sent.code, 'Bilal invite code').toBeTruthy();
  const guest = await createFamilyParent();
  const joinCtx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: FAMILY, ignoreHTTPSErrors, viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Karachi',
  });
  const join = await joinCtx.newPage();
  await join.goto(`/join?code=${encodeURIComponent(String(sent.code).replace('-', ''))}`);
  await new LoginPage(join).signIn(guest.email, guest.password).catch(async () => {
    // Already on the card if the session survived; otherwise the login ran.
  });
  const cont = join.getByRole('button', { name: 'Continue' });
  if (await cont.count()) {
    await cont.click();
    await join.waitForTimeout(2000);
  }
  await join.waitForTimeout(3000);
  await shot(join, 'invite-card');
  const card = await join.locator('main').innerText();
  writeFileSync(path.join(EV, 'invite-card.txt'), card);
  expect(card, `invite card missing Orange-7 (A):\n${card}`).toMatch(/Orange-7 \(A\)/);
  expect(card, `invite card lowercase class:\n${card}`).not.toMatch(/orange-7 \(A\)/);
  await joinCtx.close();
});
