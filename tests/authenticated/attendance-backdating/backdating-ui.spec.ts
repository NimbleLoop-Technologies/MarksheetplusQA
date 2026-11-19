/**
 * PR 548 / CU-z94x8ean2v — back-dated attendance through the School WebApp.
 * Self-seeding: one fresh "QA548 <suffix>" class per file. Run inside the qa548 netns with --workers=1.
 * Tests titled "BUG:" assert the EXPECTED behaviour and fail while the bug is present.
 */
import { test, expect } from '@playwright/test';
import { AttendanceRegisterPage } from '../../../pages/attendance/AttendanceRegisterPage';
import {
  AttendanceApi, schoolDb, seedBackdatingClass, seedFreshClass, pastWorkingDay, todayPkt, dayLabel, type BackdatingClass,
} from '../../../fixtures/attendance';

// Not serial: a failing BUG test must not skip the others. A failure restarts the worker and beforeAll re-seeds.
test.describe.configure({ mode: 'default' });

let api: AttendanceApi;
let seeded: BackdatingClass;

const OPEN_FROM_GRID_DATE = () => pastWorkingDay(5);
const DOUBLE_CLICK_DATE = () => pastWorkingDay(6);
const RACE_DATE = () => pastWorkingDay(7);
const BACK_TO_TODAY_DATE = () => pastWorkingDay(8);
const AFTER_SAVE_DATE = () => pastWorkingDay(9);

const dayOf = (isoDate: string) => Number(isoDate.slice(8));

test.beforeAll(async () => {
  api = await AttendanceApi.signIn();
  seeded = await seedBackdatingClass(api, { lateAdmission: pastWorkingDay(3), withMoves: true });
  test.skip(pastWorkingDay(10) < seeded.sessionStart, 'needs 10 working days of the current session behind today');
});

test.afterAll(async () => {
  await api?.dispose();
});

test('an unmarked past day opens from the month grid, is marked, and the month grid updates without a reload', { tag: '@smoke' }, async ({ page }) => {
  const register = new AttendanceRegisterPage(page);
  const date = OPEN_FROM_GRID_DATE();

  await register.gotoMonth(seeded.sectionA.id, date);
  await register.month.openUnmarkedDay(dayOf(date), dayLabel(date));

  await expect.poll(() => register.url().searchParams.get('date')).toBe(date);
  await expect(register.registerDate()).toContainText(dayLabel(date).split(', ')[1]);
  await expect(register.pastDateBanner()).toBeVisible();

  const names = await register.rosterNames();
  expect(names).toEqual(expect.arrayContaining([seeded.early.fullName, seeded.leaver.fullName, seeded.mover.fullName, seeded.steady.fullName]));
  expect(names).not.toContain(seeded.late.fullName);

  await register.markAbsent(seeded.mover.fullName);
  await register.openSubmit();
  await register.submitDialog.confirm();
  await register.submitDialog.expectClosed();
  await expect(register.successToast()).toBeVisible();
  await expect(register.successToast()).toContainText(dayLabel(date).split(', ')[1]);

  await register.openMonthTab();
  if (date.slice(0, 7) !== todayPkt().slice(0, 7)) {
    await register.gotoMonth(seeded.sectionA.id, date);
  }
  await expect.poll(() => register.month.code(seeded.mover.fullName, dayOf(date))).toBe('A');
  await expect.poll(() => register.month.code(seeded.early.fullName, dayOf(date))).toBe('P');
  await expect(register.month.unmarkedDayButton(dayOf(date), dayLabel(date))).toHaveCount(0);

  const audit = await schoolDb.audit(seeded.sectionA.id, date);
  expect(audit.map((a) => a.action)).toEqual(['Attendance backdated']);
});

test('Back to today leaves the past register for today’s', async ({ page }) => {
  const register = new AttendanceRegisterPage(page);
  await register.gotoToday(seeded.sectionA.id, BACK_TO_TODAY_DATE());
  await expect(register.pastDateBanner()).toBeVisible();
  await register.backToToday();
  await expect.poll(() => register.url().searchParams.get('date')).toBeNull();
  await expect(register.pastDateBanner()).toHaveCount(0);
  await expect(register.registerDate()).not.toContainText(dayLabel(BACK_TO_TODAY_DATE()).split(', ')[1]);
});

test('double-clicking Submit register writes one back-dated register', async ({ page }) => {
  const register = new AttendanceRegisterPage(page);
  const date = DOUBLE_CLICK_DATE();
  await register.gotoToday(seeded.sectionA.id, date);
  await register.markAbsent(seeded.steady.fullName);
  await register.openSubmit();
  await register.submitDialog.doubleClickConfirm();
  await register.submitDialog.expectClosed();
  await expect.poll(async () => (await schoolDb.audit(seeded.sectionA.id, date)).length).toBe(1);
});

test("today's register can still be marked and submitted (regression)", async ({ page }) => {
  const register = new AttendanceRegisterPage(page);
  await register.gotoToday(seeded.sectionB.id);
  await expect(register.pastDateBanner()).toHaveCount(0);
  await register.markAbsent(seeded.mover.fullName);
  await register.openSubmit();
  await register.submitDialog.confirm();
  await register.submitDialog.expectClosed();
  await expect(register.submittedBanner()).toBeVisible();
  expect((await schoolDb.audit(seeded.sectionB.id, todayPkt())).map((a) => a.action)).toEqual(['Attendance submitted']);
});

test.describe('known bugs (assert expected behaviour)', () => {
  test("BUG: after a back-dated submit the page does not claim only today's register can be marked", async ({ page }) => {
    const register = new AttendanceRegisterPage(page);
    await register.gotoToday(seeded.sectionA.id, AFTER_SAVE_DATE());
    await register.openSubmit();
    await register.submitDialog.confirm();
    await register.submitDialog.expectClosed();
    await expect(register.submittedBanner()).toBeVisible();
    await expect(page.getByText("Only today's register can be marked")).toHaveCount(0);
  });

  test('BUG: when someone else back-fills the same date first, the dialog explains it and Review keeps that date', async ({ page }) => {
    const register = new AttendanceRegisterPage(page);
    const date = RACE_DATE();
    await register.gotoToday(seeded.sectionA.id, date);
    await expect(register.pastDateBanner()).toBeVisible();

    // Another user submits the same past date while this page is open.
    const other = await api.submit(seeded.sectionA.id, date, await api.marksFor(seeded.sectionA.id, date), 0);
    expect(other.status()).toBe(200);

    await register.openSubmit();
    await register.submitDialog.confirm();
    await expect(register.submitDialog.statusText()).toContainText('correction');
    await expect(register.submitDialog.dialog).not.toContainText("Only today's register can be marked");
    await register.submitDialog.review();
    await expect.poll(() => register.url().searchParams.get('date')).toBe(date);
  });

  test('BUG: a section created today still offers earlier session days to mark in the month grid', async ({ page }) => {
    const fresh = await seedFreshClass(api, seeded.sessionStart);
    const register = new AttendanceRegisterPage(page);
    const date = pastWorkingDay(1);
    await register.gotoMonth(fresh.sectionId, date);
    await expect(register.month.unmarkedDayButton(dayOf(date), dayLabel(date))).toHaveCount(1);
  });

  test('BUG: today opened with ?date=<today> does not show the "Mark past attendance" banner', async ({ page }) => {
    const fresh = await seedFreshClass(api, seeded.sessionStart);
    const register = new AttendanceRegisterPage(page);
    await register.gotoToday(fresh.sectionId, todayPkt());
    await expect(register.rosterRow(fresh.pupil.fullName)).toBeVisible();
    await expect(register.pastDateBanner()).toHaveCount(0);
  });
});
