/**
 * PR 548 / CU-z94x8ean2v — QA cycle 4 (head 60ffae44 "Fix past empty roster UI").
 * Re-verifies z94x8ec4qu in the UI from every entry point, and checks that a section that really has no
 * students today still gets the page-level empty state. Self-seeding; run in the qa548 netns, --workers=1.
 */
import { test, expect, type Page } from '@playwright/test';
import { AttendanceApi, seedBackdatingClass, seedFreshClass, pastWorkingDay, todayPkt, dayLabel, schoolDb, type BackdatingClass } from '../../../fixtures/attendance';
import { AttendanceRegisterPage } from '../../../pages/attendance/AttendanceRegisterPage';

test.describe.configure({ mode: 'default' });

const EMPTY_ROSTER = 'No students were enrolled in this section on this date.';
const SHOTS = process.env.QA_EVIDENCE_DIR ?? '/workspace/qa-cycles/pr-548/cycle-4/evidence';
let api: AttendanceApi;
let seeded: BackdatingClass;

test.beforeAll(async () => {
  api = await AttendanceApi.signIn();
  seeded = await seedBackdatingClass(api, { lateAdmission: pastWorkingDay(3), withMoves: true });
  test.skip(pastWorkingDay(10) < seeded.sessionStart, 'needs 10 working days of the current session behind today');
});
test.afterAll(async () => { await api?.dispose(); });

async function expectEmptyPastRoster(page: Page, register: AttendanceRegisterPage, date: string) {
  await expect.poll(() => register.url().searchParams.get('date')).toBe(date);
  await expect(page.getByText(EMPTY_ROSTER)).toBeVisible();
  await expect(page.getByText(/^No students in .* yet$/)).toHaveCount(0);
  await expect(register.todayTab).toBeVisible();
  await expect(register.monthTab).toBeVisible();
  await expect(register.registerDate()).toContainText(dayLabel(date).split(', ')[1]);
  await expect(page.getByRole('button', { name: 'Submit attendance', exact: true })).toHaveCount(0);
  await expect(page.getByText(/could not load|something went wrong/i)).toHaveCount(0);
}

test.describe('z94x8ec4qu: past date with an empty roster (cycle 4)', () => {
  test('direct link to a past date (pupil admitted today): proper message, tabs kept, tabs still navigate', async ({ page }) => {
    const fresh = await seedFreshClass(api, todayPkt());
    const date = pastWorkingDay(2);
    const register = new AttendanceRegisterPage(page);
    await register.gotoToday(fresh.sectionId, date);
    await expectEmptyPastRoster(page, register, date);
    await page.screenshot({ path: `${SHOTS}/qu-c4-direct-link.png`, fullPage: true });
    await register.openMonthTab();
    await expect(register.month.row(fresh.pupil.fullName)).toBeVisible();
    // The Today tab is the day view: it keeps the dated register (KeepAlive), so the message comes back.
    await register.todayTab.click();
    await expect(page.getByText(EMPTY_ROSTER)).toBeVisible();
    // Today's own register for the same section is unaffected.
    await register.gotoToday(fresh.sectionId);
    await expect(register.registerDate()).toContainText(dayLabel(todayPkt()).split(', ')[1]);
    expect(await register.rosterNames()).toEqual([fresh.pupil.fullName]);
  });

  test('month grid -> empty past day (transferred-in-today section B): proper message, no Submit', async ({ page }) => {
    const date = pastWorkingDay(2);
    const register = new AttendanceRegisterPage(page);
    await register.gotoMonth(seeded.sectionB.id, date);
    await register.month.openUnmarkedDay(Number(date.slice(8)), dayLabel(date));
    await expectEmptyPastRoster(page, register, date);
    await page.screenshot({ path: `${SHOTS}/qu-c4-month-grid-sectionB.png`, fullPage: true });
    expect(await schoolDb.audit(seeded.sectionB.id, date)).toHaveLength(0);
  });

  test('section with no students at all: today keeps the page-level empty state; a past date shows the dated message', async ({ page }) => {
    const className = `QA548 Empty ${Math.random().toString(36).slice(2, 7)}`;
    const created = await api.http.post('classes/create', {
      data: { className, grade: '9', sections: [{ sectionName: 'A', size: 40 }], subjects: null },
    });
    expect(created.status()).toBe(201);
    const classId = (await created.json()).id as string;
    const s = ((await (await api.http.get('attendance-register/sections')).json()) as Array<{ sectionId: string; classId: string }>).find((x) => x.classId === classId)!;
    const register = new AttendanceRegisterPage(page);
    await register.gotoToday(s.sectionId);
    await expect(page.getByText(/^No students in .* yet$/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit attendance', exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/qu-c4-empty-section-today.png`, fullPage: true });
    const date = pastWorkingDay(1);
    await register.gotoToday(s.sectionId, date);
    await expect(page.getByText(/could not load|something went wrong/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Submit attendance', exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/qu-c4-empty-section-past.png`, fullPage: true });
  });
});
