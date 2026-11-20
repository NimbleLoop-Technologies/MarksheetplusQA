/**
 * PR 479 / ClickUp 86eyjvhn0 (View Merged Upcoming Exams) + 86eyjvhn2 (Filter Upcoming Exams by Child).
 *
 * Self-seeding on a local CI stack:
 *   two throwaway campuses (different schools), Class 8 + Class 5 + Class 1
 *   parent F with three linked children: Hamza (Class 8, campus A), Ayesha (Class 5, campus B),
 *     Zain (Class 1, campus A, no published datesheet)
 *   published datesheets with past papers (must be excluded), a Today paper, and an overlapping
 *     future date for Hamza and Ayesha
 *   a second parent G with one linked child (chip strip must be hidden)
 *
 * 86eyjvhn2 ACs were reconstructed (ClickUp MCP exhausted) from the sibling story, the
 * View Children Datesheet UX flow, and the shipped FamilyExams / bUnit contract. Breadcrumbs waived.
 * Umair waived the dashboard "Upcoming exams" teaser (exams live in the calendar).
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { newCampusOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { callFamilyApi, createFamilyParent, type FreshParent } from '../../fixtures/devenv';
import { LoginPage } from '../../pages/LoginPage';
import { FamilyDashboardPage } from '../../pages/family/FamilyDashboardPage';
import * as f from '../../fixtures/fees';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';

test.describe.configure({ mode: 'default' });

const pad = (n: number) => String(n).padStart(2, '0');
const localYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return localYmd(new Date(y, m - 1, d + n));
};
const dayLabel = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = localYmd(new Date());
  const pretty = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  // en-GB "Fri 20 Nov" — the product uses "Fri, 20 Nov" (ddd, d MMM).
  const [wk, day, mon] = pretty.split(' ');
  const formatted = `${wk}, ${day} ${mon}`;
  return ymd === today ? `Today · ${formatted}` : formatted;
};

const TODAY = localYmd(new Date());
const PAST_A = addDays(TODAY, -10);
const PAST_B = addDays(TODAY, -5);
const OVERLAP = addDays(TODAY, 5);
const HAMZA_LATER = addDays(TODAY, 8);
const AYESHA_LATER = addDays(TODAY, 12);

interface ChildSeed {
  studentId: string;
  name: string;
  firstName: string;
  className: string;
  schoolName: string;
  learnerId?: string;
}

interface Seed {
  ownerA: CampusOwner;
  ownerB: CampusOwner;
  parent: FreshParent;
  oneChildParent: FreshParent;
  hamza: ChildSeed;
  ayesha: ChildSeed;
  zain: ChildSeed;
  solo: ChildSeed;
  hamzaSubjects: string[];
  ayeshaSubjects: string[];
  termA: string;
  termB: string;
  classHamza: string;
  classAyesha: string;
  classSolo: string;
  soloSubject: string;
  upcomingCount: number;
  overlapHamzaSubject: string;
  overlapAyeshaSubject: string;
  todaySubject: string;
  pastSubject: string;
}

let seed: Seed;

const shot = async (page: Page, name: string) => {
  await mkdir(EV, { recursive: true });
  await page.screenshot({ path: path.join(EV, `${name}.png`), fullPage: true });
};

async function subjectsFor(owner: CampusOwner, grade: string): Promise<string[]> {
  const list = await f.ok(await owner.api.get(`grades/${grade}/default-subjects`), `default subjects grade ${grade}`);
  const names = (list as { name?: string; Name?: string }[]).map((s) => s.name ?? s.Name ?? '').filter(Boolean);
  if (names.length < 3) throw new Error(`grade ${grade} has only ${names.length} default subjects: ${names.join(', ')}`);
  return names;
}

async function createClass(owner: CampusOwner, name: string, grade: string): Promise<string> {
  const created = await f.ok(
    await owner.api.post('classes/create', { data: { className: name, grade, sections: [{ sectionName: 'A', size: 40 }], subjects: null } }),
    `classes/create ${name}`,
  );
  return created.id as string;
}

async function termIdFor(owner: CampusOwner): Promise<{ sessionId: string; term1: string }> {
  const session = await f.ok(
    await owner.api.post('sessions/create', {
      data: {
        sessionName: '2026-2027',
        startDate: '2026-09-01',
        endDate: '2027-06-30',
        terms: [
          { termName: 'Term 1', termStartDate: '2026-09-01', termEndDate: '2026-12-31', passingCriteria: 40 },
          { termName: 'Term 2', termStartDate: '2027-01-01', termEndDate: '2027-06-30', passingCriteria: 40 },
        ],
      },
    }),
    'sessions/create',
  );
  const term1 = session.terms?.[0]?.id ?? session.Terms?.[0]?.Id;
  if (!term1) throw new Error(`sessions/create returned no term id: ${JSON.stringify(session)}`);
  return { sessionId: session.id, term1 };
}

async function link(owner: CampusOwner, parent: FreshParent, studentId: string): Promise<void> {
  const sent = await f.ok(await owner.api.post(`students/${studentId}/parent-family/invite`), `invite ${studentId}`);
  expect(sent.code, `invite code for ${studentId}: ${JSON.stringify(sent)}`).toBeTruthy();
  let redeem = { status: 0, body: '' };
  await expect(async () => {
    redeem = await callFamilyApi(parent, 'POST', '/family/link-invites/redeem', { code: sent.code });
    expect(redeem.status, `redeem: ${redeem.body}`).toBe(200);
  }).toPass({ timeout: 60_000, intervals: [2_000] });
  const inviteId = JSON.parse(redeem.body).inviteId as string;
  const accept = await callFamilyApi(parent, 'POST', `/family/link-invites/${inviteId}/accept`, { childId: null, token: null });
  expect(accept.status, `accept: ${accept.body}`).toBe(200);
  // The datesheet consumer only projects to students the school already marks Linked.
  await expect(async () => {
    const status = await f.ok(await owner.api.get(`students/${studentId}/parent-family`), `link status ${studentId}`);
    expect(status.status, JSON.stringify(status)).toBe('Linked');
  }).toPass({ timeout: 60_000, intervals: [2_000] });
}

async function publishDatesheet(
  owner: CampusOwner,
  termId: string,
  assignments: { classId: string; examDate: string; subjectName: string }[],
) {
  await f.ok(await owner.api.post('datesheet/init', { data: { termId } }), 'datesheet/init');
  const saved = await f.ok(
    await owner.api.post('datesheet/save-assignments', {
      data: {
        termId,
        assignments: assignments.map((a) => ({ classId: a.classId, examDate: `${a.examDate}T00:00:00Z`, subjectName: a.subjectName })),
      },
    }),
    'datesheet/save-assignments',
  );
  const failures = saved.failures ?? saved.Failures ?? [];
  expect(failures, `save-assignments failures: ${JSON.stringify(saved)}`).toEqual([]);
  await f.ok(await owner.api.post(`datesheet/publish/${termId}`), 'datesheet/publish');
}

async function familyExams(parent: FreshParent): Promise<any> {
  const res = await callFamilyApi(parent, 'GET', '/family/exams');
  expect(res.status, res.body.slice(0, 400)).toBe(200);
  return JSON.parse(res.body);
}

async function parentPage(browser: Browser, parent: FreshParent): Promise<Page> {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: process.env.QA_FAMILY_URL,
    ignoreHTTPSErrors,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.goto('/dashboard');
  await new LoginPage(page).signIn(parent.email, parent.password);
  await new FamilyDashboardPage(page).expectLoaded();
  return page;
}

async function openExamsFromDrawer(page: Page) {
  await page.getByTestId('family-nav-item').filter({ hasText: 'Exams & Datesheet' }).click();
  await expect(page).toHaveURL(/\/exams/);
  await expect(page.getByRole('heading', { name: 'Exams & Datesheet' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Upcoming exams \(/)).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  const ownerA = await newCampusOwner('exams-a');
  const ownerB = await newCampusOwner('exams-b');
  const { term1: termA } = await termIdFor(ownerA);
  const { term1: termB } = await termIdFor(ownerB);
  const classHamza = await createClass(ownerA, 'Class 8', '8');
  const classZain = await createClass(ownerA, 'Class 1', '1');
  const classAyesha = await createClass(ownerB, 'Class 5', '5');
  const classSolo = await createClass(ownerA, 'Class 3', '3');

  const hamzaSubjects = await subjectsFor(ownerA, '8');
  const ayeshaSubjects = await subjectsFor(ownerB, '5');

  const parent = await createFamilyParent();
  const oneChildParent = await createFamilyParent();
  const father = 'Imran Examseed';

  const hamzaStu = await f.addStudent(ownerA, { name: 'Hamza Examseed', classId: classHamza, fatherName: father, fatherMobile: parent.phone });
  const zainStu = await f.addStudent(ownerA, { name: 'Zain Examseed', classId: classZain, fatherName: father, fatherMobile: parent.phone });
  const ayeshaStu = await f.addStudent(ownerB, { name: 'Ayesha Examseed', classId: classAyesha, fatherName: father, fatherMobile: parent.phone });
  const soloStu = await f.addStudent(ownerA, { name: 'Bilal Examsolo', classId: classSolo, fatherName: 'Tariq Examsolo', fatherMobile: oneChildParent.phone });

  await link(ownerA, parent, hamzaStu.id);
  await link(ownerA, parent, zainStu.id);
  await link(ownerB, parent, ayeshaStu.id);
  await link(ownerA, oneChildParent, soloStu.id);

  // Link first, then publish — the datesheet projection skips children with no claiming household yet.
  const todaySubject = hamzaSubjects[0];
  const pastSubject = hamzaSubjects[1];
  const overlapHamzaSubject = hamzaSubjects[2];
  const hamzaLaterSubject = hamzaSubjects[3] ?? hamzaSubjects[0];
  const overlapAyeshaSubject = ayeshaSubjects[0];
  const ayeshaLaterSubject = ayeshaSubjects[1];
  const ayeshaPastSubject = ayeshaSubjects[2] ?? ayeshaSubjects[0];

  const soloSubjects = await subjectsFor(ownerA, '3');
  const soloSubject = soloSubjects[0];

  // One datesheet per term per school: include every class's papers in a single save.
  await publishDatesheet(ownerA, termA, [
    { classId: classHamza, examDate: PAST_A, subjectName: pastSubject },
    { classId: classHamza, examDate: PAST_B, subjectName: hamzaSubjects[3] ? hamzaSubjects[1] : pastSubject },
    { classId: classHamza, examDate: TODAY, subjectName: todaySubject },
    { classId: classHamza, examDate: OVERLAP, subjectName: overlapHamzaSubject },
    { classId: classHamza, examDate: HAMZA_LATER, subjectName: hamzaLaterSubject },
    { classId: classSolo, examDate: TODAY, subjectName: soloSubject },
  ]);
  await publishDatesheet(ownerB, termB, [
    { classId: classAyesha, examDate: PAST_A, subjectName: ayeshaPastSubject },
    { classId: classAyesha, examDate: OVERLAP, subjectName: overlapAyeshaSubject },
    { classId: classAyesha, examDate: AYESHA_LATER, subjectName: ayeshaLaterSubject },
  ]);

  // Hamza: today + overlap + later = 3 upcoming (past excluded). Ayesha: overlap + later = 2. Total 5.
  const upcomingCount = 5;
  await expect(async () => {
    const body = await familyExams(parent);
    expect(body.count, JSON.stringify(body)).toBe(upcomingCount);
    expect(body.awaiting?.length ?? 0, JSON.stringify(body.awaiting)).toBe(1);
  }).toPass({ timeout: 90_000, intervals: [2_000] });

  const body = await familyExams(parent);
  const label = (first: string) =>
    (body.children as { childId: string; label: string }[]).find((c) => c.label.startsWith(first))?.childId;
  const hamzaId = label('Hamza');
  const ayeshaId = label('Ayesha');
  const zainId = label('Zain');
  expect(hamzaId && ayeshaId && zainId, `children labels: ${JSON.stringify(body.children)}`).toBeTruthy();

  const soloBody = await familyExams(oneChildParent);
  expect(soloBody.children.length, JSON.stringify(soloBody)).toBe(1);
  await expect(async () => {
    const b = await familyExams(oneChildParent);
    expect(b.count, JSON.stringify(b)).toBe(1);
  }).toPass({ timeout: 90_000, intervals: [2_000] });

  seed = {
    ownerA,
    ownerB,
    parent,
    oneChildParent,
    hamza: { studentId: hamzaStu.id, name: 'Hamza Examseed', firstName: 'Hamza', className: 'Class 8', schoolName: ownerA.schoolName, learnerId: hamzaId },
    ayesha: { studentId: ayeshaStu.id, name: 'Ayesha Examseed', firstName: 'Ayesha', className: 'Class 5', schoolName: ownerB.schoolName, learnerId: ayeshaId },
    zain: { studentId: zainStu.id, name: 'Zain Examseed', firstName: 'Zain', className: 'Class 1', schoolName: ownerA.schoolName, learnerId: zainId },
    solo: { studentId: soloStu.id, name: 'Bilal Examsolo', firstName: 'Bilal', className: 'Class 3', schoolName: ownerA.schoolName, learnerId: soloBody.children[0].childId },
    hamzaSubjects,
    ayeshaSubjects,
    termA,
    termB,
    classHamza,
    classAyesha,
    classSolo,
    soloSubject,
    upcomingCount,
    overlapHamzaSubject,
    overlapAyeshaSubject,
    todaySubject,
    pastSubject,
  };
});

test('86eyjvhn0 — drawer opens a merged, day-grouped list of upcoming exams only', { tag: '@smoke' }, async ({ browser }) => {
  const page = await parentPage(browser, seed.parent);
  await openExamsFromDrawer(page);

  await expect(page.getByText(`Upcoming exams (${seed.upcomingCount})`)).toBeVisible();
  await expect(page.getByText(dayLabel(TODAY), { exact: true })).toBeVisible();
  await expect(page.getByText(dayLabel(OVERLAP), { exact: true })).toBeVisible();
  await expect(page.getByText(dayLabel(HAMZA_LATER), { exact: true })).toBeVisible();
  await expect(page.getByText(dayLabel(AYESHA_LATER), { exact: true })).toBeVisible();

  // Today is first and uses the middle-dot "Today · …" form, not a hyphen.
  const bodyText = await page.locator('section').first().innerText();
  expect(bodyText).toContain('Today ·');
  expect(bodyText).not.toContain('Today -');
  const todayPos = bodyText.indexOf(dayLabel(TODAY));
  const overlapPos = bodyText.indexOf(dayLabel(OVERLAP));
  expect(todayPos).toBeGreaterThanOrEqual(0);
  expect(overlapPos).toBeGreaterThan(todayPos);

  // Past papers are excluded from the merged list (API + UI).
  const api = await familyExams(seed.parent);
  const dates = (api.exams as { examDate: string; subjectName: string }[]).map((e) => e.examDate.slice(0, 10));
  expect(dates).not.toContain(PAST_A);
  expect(dates).not.toContain(PAST_B);
  await expect(page.getByText(dayLabel(PAST_A), { exact: true })).toHaveCount(0);

  // Row anatomy: subject, "Child · Class · School", no time or venue.
  const title = (s: string) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  const todaySubject = title(seed.todaySubject);
  const todayRow = page.getByRole('button', { name: new RegExp(todaySubject, 'i') }).first();
  await expect(todayRow).toBeVisible();
  await expect(todayRow).toContainText(todaySubject);
  await expect(todayRow).toContainText(`Hamza · Class 8 · ${seed.hamza.schoolName}`);
  const rowText = await todayRow.innerText();
  expect(rowText).not.toMatch(/\d{1,2}:\d{2}/);
  expect(rowText.toLowerCase()).not.toContain('venue');
  expect(rowText.toLowerCase()).not.toContain('hall');

  // Overlapping date: Ayesha before Hamza (first name ascending).
  const overlapGroup = page.locator('div.space-y-6 > div.space-y-3', { has: page.getByText(dayLabel(OVERLAP), { exact: true }) });
  const overlapButtons = overlapGroup.getByRole('button');
  await expect(overlapButtons).toHaveCount(2);
  await expect(overlapButtons.nth(0)).toContainText('Ayesha');
  await expect(overlapButtons.nth(1)).toContainText('Hamza');

  // Zain appears once as an awaiting card, not as an error, and no child is silently missing.
  await expect(page.getByText('Datesheet not published yet.')).toBeVisible();
  await expect(page.getByText(/Zain · /)).toBeVisible();
  await expect(page.getByText(seed.ayesha.schoolName).first()).toBeVisible();
  await expect(page.getByText(seed.hamza.schoolName).first()).toBeVisible();
  await expect(page.getByText("Couldn't load exams.")).toHaveCount(0);

  await shot(page, 'ac-hn0-merged-list');
  await page.context().close();
});

test('86eyjvhn0 — an exam row opens that child\'s datesheet and back returns to the list', async ({ browser }) => {
  const page = await parentPage(browser, seed.parent);
  await openExamsFromDrawer(page);
  const title = (s: string) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  await page.getByRole('button', { name: new RegExp(title(seed.todaySubject), 'i') }).first().click();
  await expect(page).toHaveURL(new RegExp(`/exams/child/${seed.hamza.learnerId}/`));
  await shot(page, 'ac-hn0-child-datesheet');
  await page.getByRole('button', { name: /back/i }).first().click();
  await expect(page).toHaveURL(/\/exams/);
  await expect(page.getByText(`Upcoming exams (${seed.upcomingCount})`)).toBeVisible();
  await page.context().close();
});

test('86eyjvhn0 — Refresh shows a republished exam on its new date', async ({ browser }) => {
  const page = await parentPage(browser, seed.parent);
  await openExamsFromDrawer(page);
  const movedTo = addDays(TODAY, 6);
  // Keep every upcoming Hamza paper and move the overlap paper. Saving a published sheet re-projects.
  await publishDatesheet(seed.ownerA, seed.termA, [
    { classId: seed.classHamza, examDate: PAST_A, subjectName: seed.pastSubject },
    { classId: seed.classHamza, examDate: TODAY, subjectName: seed.todaySubject },
    { classId: seed.classHamza, examDate: movedTo, subjectName: seed.overlapHamzaSubject },
    { classId: seed.classHamza, examDate: HAMZA_LATER, subjectName: seed.hamzaSubjects[3] ?? seed.hamzaSubjects[0] },
    { classId: seed.classSolo, examDate: TODAY, subjectName: seed.soloSubject },
  ]);
  await expect(async () => {
    const body = await familyExams(seed.parent);
    const dates = (body.exams as { examDate: string; subjectName: string }[])
      .filter((e) => e.subjectName.toLowerCase() === seed.overlapHamzaSubject.toLowerCase())
      .map((e) => e.examDate.slice(0, 10));
    expect(dates).toEqual([movedTo]);
  }).toPass({ timeout: 90_000, intervals: [2_000] });

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText(dayLabel(movedTo), { exact: true })).toBeVisible({ timeout: 30_000 });
  const title = (s: string) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  // The old overlap day should now only have Ayesha's paper, or disappear if we also moved uniquely — Ayesha still has OVERLAP.
  await expect(page.getByText(dayLabel(OVERLAP), { exact: true })).toBeVisible();
  const overlapGroup = page.locator('div.space-y-6 > div.space-y-3', { has: page.getByText(dayLabel(OVERLAP), { exact: true }) });
  await expect(overlapGroup.getByRole('button')).toHaveCount(1);
  await expect(overlapGroup.getByRole('button')).toContainText('Ayesha');
  await expect(page.getByRole('button', { name: new RegExp(title(seed.overlapHamzaSubject), 'i') })).toBeVisible();
  await shot(page, 'ac-hn0-refresh-republish');
  await page.context().close();
});

test('86eyjvhn2 — chips filter by child, update the caption, hide other awaiting cards, and All restores', { tag: '@smoke' }, async ({ browser }) => {
  const page = await parentPage(browser, seed.parent);
  await openExamsFromDrawer(page);

  await expect(page.locator('#chip-all')).toBeVisible();
  await expect(page.locator(`#chip-${seed.hamza.learnerId}`)).toHaveText('Hamza');
  await expect(page.locator(`#chip-${seed.ayesha.learnerId}`)).toHaveText('Ayesha');
  await expect(page.locator(`#chip-${seed.zain.learnerId}`)).toHaveText('Zain');
  await expect(page.locator('#chip-all')).toHaveClass(/bg-dark-900/);

  // After the republish test, Hamza still has 3 upcoming and Ayesha 2 (Zain 0). Caption may still be 5.
  await page.locator(`#chip-${seed.hamza.learnerId}`).click();
  await expect(page.getByText('Upcoming exams (3)')).toBeVisible();
  await expect(page.getByText('Ayesha ·')).toHaveCount(0);
  await expect(page.getByText('Datesheet not published yet.')).toHaveCount(0);
  await expect(page.locator(`#chip-${seed.hamza.learnerId}`)).toHaveClass(/bg-dark-900/);
  await shot(page, 'ac-hn2-filter-hamza');

  await page.locator(`#chip-${seed.ayesha.learnerId}`).click();
  await expect(page.getByText('Upcoming exams (2)')).toBeVisible();
  await expect(page.getByText('Hamza ·')).toHaveCount(0);
  await expect(page.getByText('Ayesha ·').first()).toBeVisible();
  await shot(page, 'ac-hn2-filter-ayesha');

  await page.locator(`#chip-${seed.zain.learnerId}`).click();
  await expect(page.getByText('Upcoming exams (0)')).toBeVisible();
  await expect(page.getByText('No upcoming exams for Zain.')).toBeVisible();
  await expect(page.getByText('Datesheet not published yet.')).toHaveCount(0);
  await shot(page, 'ac-hn2-filter-zain-empty');

  await page.locator('#chip-all').click();
  await expect(page.getByText(`Upcoming exams (${seed.upcomingCount})`)).toBeVisible();
  await expect(page.getByText('Datesheet not published yet.')).toBeVisible();
  await expect(page.getByText('Hamza ·').first()).toBeVisible();
  await expect(page.getByText('Ayesha ·').first()).toBeVisible();
  await expect(page.locator('#chip-all')).toHaveClass(/bg-dark-900/);
  await shot(page, 'ac-hn2-filter-all-restored');

  // Remembered chip: reload keeps Ayesha selected.
  await page.locator(`#chip-${seed.ayesha.learnerId}`).click();
  await expect(page.getByText('Upcoming exams (2)')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Upcoming exams (2)')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`#chip-${seed.ayesha.learnerId}`)).toHaveClass(/bg-dark-900/);
  await shot(page, 'ac-hn2-filter-remembered');
  await page.context().close();
});

test('86eyjvhn2 — a one-child family has no chip strip', { tag: '@smoke' }, async ({ browser }) => {
  const page = await parentPage(browser, seed.oneChildParent);
  await openExamsFromDrawer(page);
  await expect(page.locator('#chip-all')).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: 'Filter upcoming exams by child' })).toHaveCount(0);
  await expect(page.getByText('Upcoming exams (1)')).toBeVisible();
  await expect(page.getByText('Bilal ·').first()).toBeVisible();
  await shot(page, 'ac-hn2-one-child-no-chips');
  await page.context().close();
});
