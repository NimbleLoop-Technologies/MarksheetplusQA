/**
 * PR 569 / ClickUp z94x8e4ubc — Family Exams shows the selected child's class in the no-exams state.
 *
 * Original ticket asked for name, class and school (and a breadcrumb) when no published datesheet exists.
 * The redesigned Exams page no longer has that header; Umair confirmed the school name isn't needed,
 * and breadcrumb ACs are waived. Dan's fix: a child with no datesheet shows "Alia · Orange-7 (A)" above
 * the empty message, with no school name; an unplaced child shows "Class not available".
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { newCampusOwner, cacheOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { createFamilyParent, callFamilyApi, type FreshParent } from '../../fixtures/devenv';
import { LoginPage } from '../../pages/LoginPage';
import { FamilyDashboardPage } from '../../pages/family/FamilyDashboardPage';
import * as f from '../../fixtures/fees';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.resolve(EV, '..', 'seed');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
const FAMILY = process.env.QA_FAMILY_URL ?? 'https://localhost:7100';

test.describe.configure({ mode: 'serial' });

let owner: CampusOwner;
let parent: FreshParent;
let alia: f.Student;
let unplacedId: string;
let unplacedName = 'Zain Unplaced';

const shot = async (page: Page, name: string) => {
  mkdirSync(EV, { recursive: true });
  await page.screenshot({ path: path.join(EV, `${name}.png`), fullPage: true });
};

async function link(studentId: string) {
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

async function parentPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: FAMILY,
    ignoreHTTPSErrors,
    viewport: { width: 1280, height: 900 },
    timezoneId: 'Asia/Karachi',
  });
  const page = await ctx.newPage();
  await page.goto('/dashboard');
  await new LoginPage(page).signIn(parent.email, parent.password);
  await new FamilyDashboardPage(page).expectLoaded();
  return page;
}

async function openChildExamsFromHome(page: Page, childName: string) {
  const exams = page.getByRole('link', { name: /^Exams$/ }).or(page.getByRole('button', { name: /^Exams$/ }));
  const hrefs = await page.getByRole('link', { name: /^Exams$/ }).evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')));
  writeFileSync(path.join(EV, `exams-hrefs-${childName.split(' ')[0].toLowerCase()}.json`), JSON.stringify(hrefs, null, 2));
  // Prefer the Exams control on that child's card.
  const card = page.locator('main').getByText(childName, { exact: true }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const inCard = card.locator('xpath=ancestor::*[.//a[normalize-space()="Exams"] or .//button[normalize-space()="Exams"]][1]');
  if (await inCard.getByRole('link', { name: /^Exams$/ }).count()) {
    await inCard.getByRole('link', { name: /^Exams$/ }).click();
  } else if (await inCard.getByRole('button', { name: /^Exams$/ }).count()) {
    await inCard.getByRole('button', { name: /^Exams$/ }).click();
  } else {
    const idx = childName.startsWith('Zain') ? 1 : 0;
    await exams.nth(Math.min(idx, (await exams.count()) - 1)).click();
  }
  await expect(page).toHaveURL(/\/exams/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Exams & Datesheet' })).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  mkdirSync(EV, { recursive: true });
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  owner = await newCampusOwner('pr569');
  await f.ok(await owner.api.post('sessions/create', {
    data: {
      sessionName: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30',
      terms: [
        { termName: 'Term 1', termStartDate: '2026-09-01', termEndDate: '2026-12-31', passingCriteria: 40 },
        { termName: 'Term 2', termStartDate: '2027-01-01', termEndDate: '2027-06-30', passingCriteria: 40 },
      ],
    },
  }), 'sessions/create');
  const orange = await f.ok(await owner.api.post('classes/create', {
    data: { className: 'orange', grade: '7', sections: [{ sectionName: 'A', size: 40 }], subjects: null },
  }), 'orange');
  parent = await createFamilyParent();
  const father = 'Farooq Ubc';
  alia = await f.addStudent(owner, { name: 'Alia Ubc', classId: orange.id, fatherName: father, fatherMobile: parent.phone });
  const admissionId = `P569-${String(randomInt(10000, 99999))}`;
  const unplacedRes = await owner.api.post('students/quick-add', {
    data: {
      fullName: unplacedName, admissionId, fatherName: father, mobileNumber: parent.phone,
      admissionDate: '2026-09-01T00:00:00Z', dateOfBirth: '2014-02-02T00:00:00Z', gender: 0,
    },
  });
  expect(unplacedRes.status(), `unplaced quick-add: ${await unplacedRes.text()}`).toBeLessThan(300);
  unplacedId = (await unplacedRes.json()).id as string;
  expect(unplacedId, 'unplaced student id').toBeTruthy();
  await link(alia.id);
  await link(unplacedId);
  const cached = cacheOwner(owner);
  writeFileSync(path.join(SEED_DIR, 'seed.json'), JSON.stringify({
    email: cached.email, phone: cached.phone, tenantId: cached.tenantId, password: cached.password,
    parentEmail: parent.email, parentPassword: parent.password, alia: alia.id, unplacedId,
  }), { mode: 0o600 });
  try { chmodSync(SEED_DIR, 0o700); } catch { /* */ }
});

test('Child with no datesheet shows "Alia · Orange-7 (A)" above the empty message, with no school name', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const page = await parentPage(browser);
  await openChildExamsFromHome(page, 'Alia Ubc');
  const header = page.locator('#selected-child-header');
  await expect(header, 'selected-child-header should appear above the empty message').toBeVisible({ timeout: 20_000 });
  await shot(page, 'alia-no-datesheet');
  const main = await page.locator('main').innerText();
  writeFileSync(path.join(EV, 'alia-no-datesheet.txt'), main);
  const headerText = (await header.innerText()).replace(/\s+/g, ' ').trim();
  writeFileSync(path.join(EV, 'alia-header.txt'), headerText);
  expect(headerText, `header was "${headerText}"`).toMatch(/Alia\s*·\s*Orange-7 \(A\)/);
  expect(headerText, `school name should not appear in the header: "${headerText}"`).not.toMatch(/School/i);
  expect(main, 'empty message').toMatch(/No upcoming exams for Alia\.?/);
  // School name may still appear elsewhere (e.g. a chip), but must not sit in this header.
  expect(headerText).not.toContain(owner.schoolName);
});

test('Unplaced child shows "Class not available"', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const page = await parentPage(browser);
  await openChildExamsFromHome(page, unplacedName);
  const header = page.locator('#selected-child-header');
  await expect(header, 'selected-child-header for the unplaced child').toBeVisible({ timeout: 20_000 });
  await shot(page, 'unplaced-no-class');
  const main = await page.locator('main').innerText();
  writeFileSync(path.join(EV, 'unplaced-no-class.txt'), main);
  const headerText = (await header.innerText()).replace(/\s+/g, ' ').trim();
  writeFileSync(path.join(EV, 'unplaced-header.txt'), headerText);
  expect(headerText, `header was "${headerText}"`).toMatch(/Zain\s*·\s*Class not available/);
  expect(headerText, `school name should not appear in the header: "${headerText}"`).not.toMatch(/School/i);
  expect(main).toMatch(/No upcoming exams for Zain\.?/);
});
