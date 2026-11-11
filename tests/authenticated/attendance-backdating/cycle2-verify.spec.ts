/**
 * PR 548 cycle 2 focused re-verification against head 7305b4ff.
 * Past-date GET/submit currently throws Postgres UNION uuid/text in GetRosterHistoryAsync — covered as NEW-1.
 */
import { test, expect } from '@playwright/test';
import {
  AttendanceApi, ABSENT, PRESENT, schoolDb, seedFreshClass, seedBackdatingClass,
  pastWorkingDay, nextWorkingDay, previousSunday, todayPkt, addDays, isSunday, type BackdatingClass,
} from '../../../fixtures/attendance';
import { AttendanceRegisterPage } from '../../../pages/attendance/AttendanceRegisterPage';

test.describe.configure({ mode: 'default' });

let api: AttendanceApi;
let seeded: BackdatingClass;

test.beforeAll(async () => {
  api = await AttendanceApi.signIn();
  seeded = await seedBackdatingClass(api, { lateAdmission: pastWorkingDay(3), withMoves: true });
});
test.afterAll(async () => { await api?.dispose(); });

test('z94x8ec4qh: month offers session-start days for a section created today; days before the session stay closed', async () => {
  const fresh = await seedFreshClass(api, seeded.sessionStart);
  const date = pastWorkingDay(1);
  const month = await api.month(fresh.sectionId, `${date.slice(0, 8)}01`);
  expect(month.days.find((d) => d.day === Number(date.slice(8)))?.isUnmarked).toBe(true);
  const before = addDays(seeded.sessionStart, -1);
  while (isSunday(before)) { /* noop - use fixed Aug */ }
  const pre = await api.month(fresh.sectionId, '2026-08-01');
  expect(pre.days.find((d) => d.day === 31)?.isUnmarked).toBe(false);
  const sep = await api.month(fresh.sectionId, '2026-09-01');
  expect(sep.days.find((d) => d.day === 1)?.isUnmarked).toBe(true); // session start 2026-09-01
});

test('z94x8ec4qt: ?date=<today> does not show the Mark past attendance banner', async ({ page }) => {
  const fresh = await seedFreshClass(api, seeded.sessionStart);
  const register = new AttendanceRegisterPage(page);
  await register.gotoToday(fresh.sectionId, todayPkt());
  await expect(register.rosterRow(fresh.pupil.fullName)).toBeVisible();
  await expect(register.pastDateBanner()).toHaveCount(0);
});

test('z94x8ec4qq/qr: today is not closed for a working day (see-only would use canMark=false → still not IsClosed)', async () => {
  const reg = await api.register(seeded.sectionA.id);
  expect(reg.isClosed).toBe(false);
  expect(reg.isWorkingDay).toBe(true);
});

test('z94x8ec4qv: RegisterDate validation message does not leak the .NET parameter suffix', async () => {
  const res = await api.submit(seeded.sectionA.id, nextWorkingDay(), [{ studentId: seeded.early.id, status: PRESENT }], 0);
  expect(res.status()).toBe(400);
  const body = await res.json();
  const msg = body.errors?.RegisterDate?.[0] ?? JSON.stringify(body);
  expect(msg).not.toContain("(Parameter 'RegisterDate')");
});

test('z94x8ec4qw: submit confirmation names the date (today path)', async ({ page }) => {
  const fresh = await seedFreshClass(api, seeded.sessionStart);
  const register = new AttendanceRegisterPage(page);
  await register.gotoToday(fresh.sectionId);
  await register.markAbsent(fresh.pupil.fullName);
  await register.openSubmit();
  await expect(register.submitDialog.dialog).toContainText(/Submit attendance for/);
  await expect(register.submitDialog.dialog).toContainText(/\d/); // date in title after cycle-2 fix
  await register.submitDialog.cancel();
});

test('z94x8ec9p5: past-date register GET loads (no UNION uuid/text crash in GetRosterHistoryAsync)', async () => {
  const fresh = await seedFreshClass(api, seeded.sessionStart);
  const res = await api.http.get('attendance-register/today', { params: { sectionId: fresh.sectionId, date: pastWorkingDay(1) } });
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).students.map((s: { studentId: string }) => s.studentId)).toContain(fresh.pupil.id);
});

test('z94x8ec9p5: past-date submit is accepted (same roster history path)', async () => {
  const fresh = await seedFreshClass(api, seeded.sessionStart);
  const res = await api.submit(fresh.sectionId, pastWorkingDay(1), [{ studentId: fresh.pupil.id, status: ABSENT }], 0);
  expect(res.status(), await res.text()).toBe(200);
});

test('today submit still works (regression)', async () => {
  const fresh = await seedFreshClass(api, seeded.sessionStart);
  const marks = [{ studentId: fresh.pupil.id, status: PRESENT }];
  const res = await api.submit(fresh.sectionId, todayPkt(), marks, 0);
  expect(res.status(), await res.text()).toBe(200);
});
