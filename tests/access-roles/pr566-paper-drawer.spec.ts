/**
 * PR 566 / ClickUp z94x8e8quc — Create-paper drawer dropdowns are title-cased and Class shows its grade.
 *
 * Ticket: capitalize Session, Class, Subject and Term; show the grade with the class name.
 * Jamie-qa fail (Integration 8415d815): options read "term 1" / "orange" / "computer science" with no grade.
 * Dan uses the shared Examination Center formatter ToClassGrade / ExamText.ClassLabel, which puts
 * spaces around the dash ("Orange - 7", same as "Prep - K" / "Two - 2" on the other EC screens).
 * The ticket does not demand "Orange-7"; a matching separator is a pass (a different one would be Low).
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { newCampusOwner, cacheOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { signInToWebApp } from '../../pages/fees/AccountOffice';
import * as f from '../../fixtures/fees';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.resolve(EV, '..', 'seed');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
const WEB = process.env.QA_BASE_URL ?? 'https://localhost:7236';

test.describe.configure({ mode: 'serial' });

let owner: CampusOwner;
let orangeId: string;
let class1Id: string;

const opts = (page: Page, id: string) => page.locator(`#${id} option`).allInnerTexts();

const titled = (labels: string[]) =>
  labels.filter((l) => !/^select /i.test(l)).every((l) => !l.trim() || /^[A-Z0-9]/.test(l.trim()));

async function ownerPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    ignoreHTTPSErrors,
    baseURL: WEB,
    viewport: { width: 1280, height: 900 },
    timezoneId: 'Asia/Karachi',
  });
  const page = await context.newPage();
  await signInToWebApp(page, owner.credentials());
  return page;
}

test.beforeAll(async () => {
  test.setTimeout(8 * 60_000);
  mkdirSync(EV, { recursive: true });
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  owner = await newCampusOwner('pr566');
  // Store names lowercased the way production does (ToDbNormalizedString), so the drawer has to title-case them.
  await f.ok(await owner.api.post('sessions/create', {
    data: {
      sessionName: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30',
      terms: [
        { termName: 'term 1', termStartDate: '2026-09-01', termEndDate: '2026-12-31', passingCriteria: 40 },
        { termName: 'term 2', termStartDate: '2027-01-01', termEndDate: '2027-06-30', passingCriteria: 40 },
      ],
    },
  }), 'sessions/create');
  const orange = await f.ok(await owner.api.post('classes/create', {
    data: { className: 'orange', grade: '7', sections: [{ sectionName: 'A', size: 40 }], subjects: null },
  }), 'class orange');
  const c1 = await f.ok(await owner.api.post('classes/create', {
    data: { className: 'class 1', grade: '1', sections: [{ sectionName: 'A', size: 40 }], subjects: null },
  }), 'class 1');
  orangeId = orange.id;
  class1Id = c1.id;
  const cached = cacheOwner(owner);
  writeFileSync(path.join(SEED_DIR, 'owner.json'), JSON.stringify({
    email: cached.email, phone: cached.phone, tenantId: cached.tenantId, schoolName: cached.schoolName,
    password: cached.password, orangeId, class1Id,
  }), { mode: 0o600 });
});

test('Create-paper dropdowns are title-cased and Class includes the grade in the shared EC format', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  const page = await ownerPage(browser);
  await page.goto('/exams/papers');
  await expect(page.getByRole('button', { name: /Create exam paper/i }).first()).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: /Create exam paper/i }).first().click();
  await expect(page.locator('#paper-class')).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: path.join(EV, 'create-drawer.png'), fullPage: true });

  const sessionOpts = (await opts(page, 'paper-session')).map((s) => s.trim());
  const termOpts = (await opts(page, 'paper-term')).map((s) => s.trim());
  const classOpts = (await opts(page, 'paper-class')).map((s) => s.trim());
  writeFileSync(path.join(EV, 'drawer-options.json'), JSON.stringify({ sessionOpts, termOpts, classOpts }, null, 2));

  const terms = termOpts.filter((o) => !/^select /i.test(o));
  const classes = classOpts.filter((o) => !/^select /i.test(o));
  expect(terms, `term options: ${termOpts.join(' | ')}`).toEqual(expect.arrayContaining(['Term 1', 'Term 2']));
  expect(terms.every((t) => !t.startsWith('term ')), `terms still lowercase: ${terms.join(', ')}`).toBe(true);
  expect(titled(sessionOpts), `session options not title/digit-cased: ${sessionOpts.join(' | ')}`).toBe(true);
  expect(titled(termOpts), `term options not title-cased: ${termOpts.join(' | ')}`).toBe(true);
  expect(titled(classOpts), `class options not title-cased: ${classOpts.join(' | ')}`).toBe(true);

  // Shared Examination Center formatter: "Orange - 7" (spaces around the dash). Ticket does not demand "Orange-7".
  expect(classes, `class options: ${classOpts.join(' | ')}`).toEqual(expect.arrayContaining(['Orange - 7', 'Class 1 - 1']));
  expect(classes.every((c) => / - \d| - [A-Z]/.test(c) || / - /.test(c)), `grade missing from a class option: ${classes.join(' | ')}`).toBe(true);

  const orangeIdx = classOpts.findIndex((o) => /orange/i.test(o));
  await page.locator('#paper-class').selectOption({ index: orangeIdx > 0 ? orangeIdx : 1 });
  await expect.poll(async () => (await opts(page, 'paper-subject')).length, { timeout: 20_000 }).toBeGreaterThan(1);
  const subjectOpts = (await opts(page, 'paper-subject')).map((s) => s.trim());
  writeFileSync(path.join(EV, 'subject-options.json'), JSON.stringify({ subjectOpts }, null, 2));
  const subjects = subjectOpts.filter((o) => !/^select /i.test(o));
  expect(subjects.length, 'expected default subjects for grade 7').toBeGreaterThan(0);
  expect(titled(subjectOpts), `subject options not title-cased: ${subjectOpts.join(' | ')}`).toBe(true);
  expect(subjects.every((s) => !/^[a-z]/.test(s)), `a subject is still lowercase: ${subjects.join(' | ')}`).toBe(true);
  if (subjects.some((s) => /computer science/i.test(s))) {
    expect(subjects).toContain('Computer Science');
  }
  await page.screenshot({ path: path.join(EV, 'create-drawer-filled.png'), fullPage: true });
});

test('Other Examination Center screens use the same "Class - Grade" formatter', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const listed = await f.ok(await owner.api.get('classes'), 'GET /classes') as Array<{ id?: string; className?: string; classGrade?: string; name?: string }>;
  writeFileSync(path.join(EV, 'classes-api.json'), JSON.stringify(listed, null, 2));
  const labels = listed.map((c) => c.classGrade ?? '').filter(Boolean);
  expect(labels, `GET /classes ClassGrade values: ${JSON.stringify(listed).slice(0, 800)}`).toEqual(expect.arrayContaining(['Orange - 7', 'Class 1 - 1']));

  const page = await ownerPage(browser);
  await page.goto('/classes');
  await page.waitForTimeout(2500);
  const classesText = await page.locator('main').innerText().catch(() => '');
  await page.screenshot({ path: path.join(EV, 'classes-list.png'), fullPage: true });
  writeFileSync(path.join(EV, 'classes-list.txt'), classesText.slice(0, 4000));
  // The Classes register is the source of the shared "Blue - 7" formatter used by Examination Center.
  expect(classesText).toMatch(/Orange\s+-\s+7/);
  expect(classesText).toMatch(/Class 1\s+-\s+1/);

  await page.goto('/exams/datesheets');
  await page.waitForTimeout(3000);
  const datesheetText = await page.locator('main').innerText().catch(() => '');
  await page.screenshot({ path: path.join(EV, 'datesheets.png'), fullPage: true });
  writeFileSync(path.join(EV, 'datesheets.txt'), datesheetText.slice(0, 4000));
  // Datesheet class chips/list use ExamText.ClassLabel (same ToClassGrade). May be empty before a sheet exists;
  // the API + Classes register already confirm the shared format. Record what the page shows.
  const datesheetHasOrange = /Orange\s+-\s+7/.test(datesheetText);
  writeFileSync(path.join(EV, 'ec-consistency.json'), JSON.stringify({
    classesApi: labels,
    classesPageHasOrangeDash7: /Orange\s+-\s+7/.test(classesText),
    datesheetPageHasOrangeDash7: datesheetHasOrange,
    formatter: 'ToClassGrade / ExamText.ClassLabel ("Name - Grade")',
  }, null, 2));
});
