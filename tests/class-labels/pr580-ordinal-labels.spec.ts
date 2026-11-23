/**
 * PR 580 / ClickUp z94x8e8quc — ordinal class names keep a lowercase suffix ("9th - 9", not "9Th - 9").
 * UAT reopen (Natasha, QA Integration, 23 Nov): the Create paper drawer's Class dropdown read "9Th - 9".
 *
 * Saved QA lesson for display retests: not only the seeded "Orange - 7". A throwaway campus gets ordinal classes
 * (1st, 2nd, 3rd, 4th, 9th, 10th, 11th, 12th, 21st), a Play Group class and a plain word class, one student in each, and
 * every school-app screen that shows a class label is read: Create paper Class dropdown (the ticket), Classes list,
 * class page header, Students list, student profile header, Marksheets, Master sheet, Datesheet, Attendance.
 *
 * Hard AC: the Create paper dropdown shows "9th - 9", "1st - 1", "2nd - 2", "3rd - 3", ... and never "9Th".
 * Every other screen is a soft check (one finding per screen) so the run reports them all.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { newCampusOwner, cacheOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { signInToWebApp } from '../../pages/fees/AccountOffice';
import * as f from '../../fixtures/fees';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.resolve(EV, '..', 'seed');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
const WEB = process.env.QA_BASE_URL ?? 'https://localhost:7236';
/** A capitalised ordinal suffix straight after a digit: the bug. */
const BAD = /\d(St|Nd|Rd|Th)\b/;

const CLASSES = [
  { name: '1st', grade: '1' }, { name: '2nd', grade: '2' }, { name: '3rd', grade: '3' }, { name: '4th', grade: '4' },
  { name: '9th', grade: '9' }, { name: '10th', grade: '10' }, { name: '11th', grade: '11' }, { name: '12th', grade: '12' },
  { name: '21st', grade: '21' }, { name: 'play group', grade: 'K' }, { name: 'orange', grade: '7' },
];

let owner: CampusOwner;
const created: { name: string; grade: string; id: string }[] = [];
const createFailures: Record<string, string> = {};
let student9: f.Student | undefined;
const findings: Record<string, { bad: string[]; sample: string[] }> = {};

// Default mode: a failed soft-free check must not skip the remaining screens (a worker restart re-seeds a fresh campus).
test.describe.configure({ mode: 'default' });

async function ownerPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors, baseURL: WEB, viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Karachi' });
  const page = await ctx.newPage();
  await signInToWebApp(page, owner.credentials());
  return page;
}

async function shot(page: Page, name: string) {
  mkdirSync(EV, { recursive: true });
  await page.screenshot({ path: path.join(EV, `pr580-${name}.png`), fullPage: true });
}

/** Lines of visible text (and select option labels) that mention one of our classes. */
async function classLines(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll('option')).map((o) => o.textContent ?? '');
    return [document.body.innerText, ...opts].join('\n');
  });
  return [...new Set(text.split('\n').map((l) => l.trim()).filter((l) => /\b(\d+(st|nd|rd|th)|play group|orange)\b/i.test(l)))];
}

async function survey(page: Page, screen: string) {
  await page.waitForTimeout(1500);
  const lines = await classLines(page);
  const bad = lines.filter((l) => BAD.test(l));
  findings[screen] = { bad, sample: lines.slice(0, 40) };
  await shot(page, screen);
  mkdirSync(EV, { recursive: true });
  writeFileSync(path.join(EV, 'pr580-findings.json'), JSON.stringify({ created, createFailures, findings }, null, 2));
  expect.soft(bad, `${screen}: capitalised ordinal suffix`).toEqual([]);
  return lines;
}

test.beforeAll(async () => {
  test.setTimeout(5 * 60_000);
  mkdirSync(EV, { recursive: true });
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  owner = await newCampusOwner('pr580');
  await f.ok(await owner.api.post('sessions/create', {
    data: {
      sessionName: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30',
      terms: [
        { termName: 'Term 1', termStartDate: '2026-09-01', termEndDate: '2026-12-31', passingCriteria: 40 },
        { termName: 'Term 2', termStartDate: '2027-01-01', termEndDate: '2027-06-30', passingCriteria: 40 },
      ],
    },
  }), 'sessions/create');
  for (const c of CLASSES) {
    const r = await owner.api.post('classes/create', { data: { className: c.name, grade: c.grade, sections: [{ sectionName: 'A', size: 40 }], subjects: null } });
    const body = await r.text();
    if (r.status() < 300) created.push({ ...c, id: JSON.parse(body).id });
    else createFailures[`${c.name}/${c.grade}`] = `HTTP ${r.status()} ${body.slice(0, 200)}`;
  }
  const cached = cacheOwner(owner);
  writeFileSync(path.join(SEED_DIR, 'seed-pr580.json'), JSON.stringify({ email: cached.email, tenantId: cached.tenantId, password: cached.password }), { mode: 0o600 });
  try { chmodSync(SEED_DIR, 0o700); } catch { /* */ }
  for (const c of created) {
    const s = await f.addStudent(owner, { name: f.personName('Ordinal'), classId: c.id, fatherName: f.personName('Father'), fatherMobile: f.familyMobile() });
    if (c.name === '9th') student9 = s;
  }
  writeFileSync(path.join(EV, 'pr580-findings.json'), JSON.stringify({ created, createFailures }, null, 2));
});

test('AC: Create paper drawer Class dropdown shows "9th - 9" and lowercase ordinals', async ({ browser }) => {
  expect(created.map((c) => c.name), `classes created (failures: ${JSON.stringify(createFailures)})`).toEqual(expect.arrayContaining(['1st', '2nd', '3rd', '4th', '9th', '10th', '11th', '12th']));
  const page = await ownerPage(browser);
  await page.goto('/exams/papers');
  await page.getByRole('button', { name: /Create exam paper/i }).first().click();
  await expect(page.locator('#paper-class')).toBeVisible({ timeout: 30_000 });
  if (await page.locator('#paper-session option').count() > 1) await page.locator('#paper-session').selectOption({ index: 1 });
  await page.waitForTimeout(1000);
  const opts = (await page.locator('#paper-class option').allInnerTexts()).map((o) => o.trim());
  writeFileSync(path.join(EV, 'pr580-create-paper-options.json'), JSON.stringify(opts, null, 2));
  for (const want of ['1st - 1', '2nd - 2', '3rd - 3', '4th - 4', '9th - 9', '10th - 10', '11th - 11', '12th - 12', 'Orange - 7']) {
    expect(opts, `option ${want}`).toContain(want);
  }
  if (created.some((c) => c.name === '21st')) expect(opts).toContain('21st - 21');
  expect(opts.filter((o) => BAD.test(o))).toEqual([]);
  const nine = opts.findIndex((o) => o === '9th - 9');
  await page.locator('#paper-class').selectOption({ index: nine });
  await page.waitForTimeout(500);
  await shot(page, 'create-paper-9th-selected');
  findings['create-paper-dropdown'] = { bad: opts.filter((o) => BAD.test(o)), sample: opts };
  await page.context().close();
});

test('wider: every school-app screen that shows a class label', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const page = await ownerPage(browser);
  const nine = created.find((c) => c.name === '9th')!;
  const screens: [string, string][] = [
    ['classes-list', '/classrooms/classes'],
    ['class-9th-page', `/classrooms/classes/${nine.id}`],
    ['students-list', '/registrar/students'],
    ['student-9th-profile', `/registrar/students/${student9!.id}`],
    ['marksheets', '/exams/marksheets'],
    ['mastersheet', '/exams/mastersheet'],
    ['datesheet', '/exams/datesheet'],
    ['attendance', '/classrooms/attendance'],
  ];
  for (const [name, url] of screens) {
    await test.step(name, async () => {
      await page.goto(url);
      await page.waitForLoadState('networkidle').catch(() => {});
      await survey(page, name);
    });
  }
  await page.context().close();
});

test('wider: Edit class drawer pre-fills the class name with a lowercase ordinal ("9th", not "9Th")', async ({ browser }) => {
  const page = await ownerPage(browser);
  await page.goto('/classrooms/classes');
  await page.getByRole('button', { name: 'Actions for 9th - 9' }).first().click();
  await page.getByRole('menuitem', { name: /^Edit/ }).first().click()
    .catch(async () => page.getByRole('button', { name: /^Edit/ }).first().click());
  const input = page.locator('#class-edit-name');
  await expect(input).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  const value = await input.inputValue();
  findings['class-edit-drawer'] = { bad: BAD.test(value) ? [value] : [], sample: [value, await page.locator('dialog[open], [role="dialog"]').last().innerText().catch(() => '')] };
  writeFileSync(path.join(EV, 'pr580-findings.json'), JSON.stringify({ created, createFailures, findings }, null, 2));
  await shot(page, 'class-edit-drawer-9th');
  expect.soft(value, 'Edit class: Class name input').toBe('9th');
  // Close without saving (Cancel / Escape), so nothing is renamed.
  await page.keyboard.press('Escape');
  await page.context().close();
});

test('wider: saving the Edit class drawer (adds a section only) does not store or show "9Th"', async ({ browser }) => {
  const page = await ownerPage(browser);
  await page.goto('/classrooms/classes');
  await page.getByRole('button', { name: 'Actions for 9th - 9' }).first().click();
  await page.getByRole('menuitem', { name: /^Edit/ }).first().click()
    .catch(async () => page.getByRole('button', { name: /^Edit/ }).first().click());
  await expect(page.locator('#class-edit-name')).toBeVisible({ timeout: 15_000 });
  // A change the drawer must save without touching the name: one more section, B.
  await page.locator('[data-action="add-section"]').click();
  await page.locator('[id^="section-name-"]').last().fill('B');
  await page.getByRole('button', { name: 'Save class' }).click();
  await page.waitForTimeout(2500);
  const nine = created.find((c) => c.name === '9th')!;
  const stored = await f.sql(`select "Name" from "Classes" where "Id" = '${nine.id}'`).catch((e) => [[`sql error ${String(e).slice(0, 80)}`]]);
  await page.goto('/classrooms/classes');
  await page.waitForTimeout(1500);
  const lines = await survey(page, 'classes-list-after-edit-save');
  findings['edit-save-stored-name'] = { bad: /9Th/.test(String(stored[0]?.[0])) ? [String(stored[0]?.[0])] : [], sample: [String(stored[0]?.[0])] };
  writeFileSync(path.join(EV, 'pr580-findings.json'), JSON.stringify({ created, createFailures, findings }, null, 2));
  expect.soft(String(stored[0]?.[0]), 'stored class name').not.toMatch(/9Th/);
  expect.soft(lines.filter((l) => BAD.test(l))).toEqual([]);
  await page.context().close();
});
