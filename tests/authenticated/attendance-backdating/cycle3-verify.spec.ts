/**
 * PR 548 / CU-z94x8ean2v — QA cycle 3 (head 7a36a8d7 "Handle empty past rosters").
 * Verifies the cycle 2 high (z94x8ec9p5, past roster crash), the reopened empty-roster bug (z94x8ec4qu)
 * and the cycle-1 bugs that cycle 2 could not reach (qj, qm, qn, qx, qy). Self-seeding; run in the qa548
 * netns with --workers=1. Every test asserts the EXPECTED behaviour.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import {
  AttendanceApi, ABSENT, PRESENT, schoolDb, seedBackdatingClass, seedFreshClass,
  pastWorkingDay, todayPkt, dayLabel, type BackdatingClass,
} from '../../../fixtures/attendance';
import { AttendanceRegisterPage } from '../../../pages/attendance/AttendanceRegisterPage';

test.describe.configure({ mode: 'default' });

const EMPTY_ROSTER = 'No students were enrolled in this section on this date.';
const REST_LOG = process.env.QA_RESTAPI_LOG ?? '/workspace/qa-cycles/pr-548/cycle-3/logs/restapi.log';
const logSize = () => (fs.existsSync(REST_LOG) ? fs.statSync(REST_LOG).size : 0);
const logSince = (offset: number) => (fs.existsSync(REST_LOG) ? fs.readFileSync(REST_LOG).subarray(offset).toString('utf8') : '');

let api: AttendanceApi;
let seeded: BackdatingClass;

test.beforeAll(async () => {
  api = await AttendanceApi.signIn();
  // sectionB holds only the mover, transferred in today: its past roster is empty.
  seeded = await seedBackdatingClass(api, { lateAdmission: pastWorkingDay(3), withMoves: true });
  test.skip(pastWorkingDay(10) < seeded.sessionStart, 'needs 10 working days of the current session behind today');
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('z94x8ec9p5: past-date register no longer crashes', () => {
  test('past GET returns the roster and a past submit is accepted', async () => {
    const fresh = await seedFreshClass(api, seeded.sessionStart);
    const date = pastWorkingDay(1);
    const register = await api.register(fresh.sectionId, date);
    expect(register).toMatchObject({ isWorkingDay: true, isSubmitted: false, canMark: true, isClosed: false });
    expect(register.students.map((s) => s.studentId)).toEqual([fresh.pupil.id]);
    const res = await api.submit(fresh.sectionId, date, [{ studentId: fresh.pupil.id, status: ABSENT }], 0);
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ version: 1, absentCount: 1, presentCount: 0 });
    expect((await schoolDb.audit(fresh.sectionId, date)).map((a) => a.action)).toEqual(['Attendance backdated']);
  });
});

test.describe('z94x8ec4qu: a past date with an empty roster', () => {
  test('pupil admitted today: past GET is 200 with no students and cannot be marked; submit explains why', async () => {
    const fresh = await seedFreshClass(api, todayPkt());
    const date = pastWorkingDay(2);
    const register = await api.register(fresh.sectionId, date);
    expect(register.students).toEqual([]);
    expect(register.canMark).toBe(false);
    const res = await api.submit(fresh.sectionId, date, [], 0);
    expect(res.status()).toBe(400);
    expect((await res.json()).errors.RegisterDate[0]).toBe(EMPTY_ROSTER);
    expect(await schoolDb.audit(fresh.sectionId, date)).toHaveLength(0);
  });

  test('section whose only pupil transferred in today: same empty-roster answer', async () => {
    const date = pastWorkingDay(2);
    const register = await api.register(seeded.sectionB.id, date);
    expect(register.students).toEqual([]);
    expect(register.canMark).toBe(false);
    const res = await api.submit(seeded.sectionB.id, date, [], 0);
    expect(res.status()).toBe(400);
    expect((await res.json()).errors.RegisterDate[0]).toBe(EMPTY_ROSTER);
  });

  test('UI: opened from the month grid, the dated register shows the empty-roster message and the date, keeps the tabs, no Submit', async ({ page }) => {
    const fresh = await seedFreshClass(api, todayPkt());
    const date = pastWorkingDay(2);
    const register = new AttendanceRegisterPage(page);
    await register.gotoMonth(fresh.sectionId, date);
    // The grid offers the day (every pupil cell is "not enrolled") ...
    await register.month.openUnmarkedDay(Number(date.slice(8)), dayLabel(date));
    await expect.poll(() => register.url().searchParams.get('date')).toBe(date);
    // ... so the page must explain the empty roster for THAT date, not claim the section has no students.
    await expect(page.getByText(EMPTY_ROSTER)).toBeVisible();
    await expect(page.getByText(/^No students in .* yet$/)).toHaveCount(0);
    await expect(register.monthTab).toBeVisible();
    await expect(register.registerDate()).toContainText(dayLabel(date).split(', ')[1]);
    await expect(page.getByRole('button', { name: 'Submit attendance', exact: true })).toHaveCount(0);
    await expect(page.getByText(/could not load/i)).toHaveCount(0);
  });
});

test.describe('z94x8ec4qj: a just struck-off / transferred pupil stays on earlier rosters', () => {
  test('transfer moments ago: source section still lists the pupil for an earlier date, destination does not', async () => {
    const own = await seedBackdatingClass(api, { lateAdmission: pastWorkingDay(3), withMoves: false });
    const moved = await api.http.post('classes/section-transfer', {
      data: { classId: own.classId, fromSection: 'A', toSection: 'B', studentIds: [own.mover.id] },
    });
    expect(moved.status()).toBe(200);
    // Read straight away, before the async academic register entry lands.
    const date = pastWorkingDay(1);
    const [a, b] = await Promise.all([api.register(own.sectionA.id, date), api.register(own.sectionB.id, date)]);
    expect(a.students.map((s) => s.studentId)).toContain(own.mover.id);
    expect(b.students.map((s) => s.studentId)).not.toContain(own.mover.id);
    // and the back-fill of A with the mover is accepted
    const res = await api.submit(own.sectionA.id, date, a.students.map((s) => ({ studentId: s.studentId, status: PRESENT })), 0);
    expect(res.status(), await res.text()).toBe(200);
  });

  test('struck off moments ago: still on an earlier date’s roster and can be back-filled', async () => {
    const fresh = await seedFreshClass(api, seeded.sessionStart);
    const off = await api.http.post(`students/${fresh.pupil.id}/struck-off`, { data: { reason: 'Left school', comments: 'QA548 c3' } });
    expect(off.status()).toBe(200);
    const date = pastWorkingDay(1);
    const register = await api.register(fresh.sectionId, date);
    expect(register.students.map((s) => s.studentId)).toEqual([fresh.pupil.id]);
    const res = await api.submit(fresh.sectionId, date, [{ studentId: fresh.pupil.id, status: PRESENT }], 0);
    expect(res.status(), await res.text()).toBe(200);
  });
});

test.describe('z94x8ec4qx: losing a concurrent back-fill race', () => {
  test('the loser gets the correction-flow message (not "Check your connection") and no 23505 is logged', async () => {
    const offset = logSize();
    const losers: string[] = [];
    for (const n of [4, 5, 6]) {
      const fresh = await seedFreshClass(api, seeded.sessionStart);
      const date = pastWorkingDay(n);
      const marks = [{ studentId: fresh.pupil.id, status: PRESENT }];
      const rs = await Promise.all([1, 2, 3].map(() => api.submit(fresh.sectionId, date, marks, 0)));
      const statuses = rs.map((r) => r.status());
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      for (const r of rs) {
        expect(r.status()).toBeLessThan(500);
        if (r.status() !== 200) losers.push(await r.text());
      }
      expect(await schoolDb.audit(fresh.sectionId, date)).toHaveLength(1);
    }
    expect(losers.length).toBeGreaterThan(0);
    for (const text of losers) {
      expect(text).not.toMatch(/check your connection/i);
      expect(text).toMatch(/correction|already/i);
    }
    await new Promise((r) => setTimeout(r, 1500));
    expect(logSince(offset)).not.toMatch(/23505|duplicate key value/);
  });
});

test.describe('z94x8ec4qy: days before a pupil’s admission', () => {
  test('month API marks them N (not enrolled) and the grid offers no "Not marked" button for them', async ({ page }) => {
    const late = seeded.lateAdmission;
    const monthStart = `${late.slice(0, 8)}01`;
    const month = await api.month(seeded.sectionA.id, monthStart);
    const row = month.students.find((s) => s.studentId === seeded.late.id)!;
    const before = month.days.filter((d) => d.isWorkingDay && !d.isFuture && d.day < Number(late.slice(8)));
    test.skip(before.length === 0, 'late admission is the first working day of its month');
    for (const d of before) expect(row.cells.find((c) => c.day === d.day)?.code, `day ${d.day}`).toBe('N');

    const register = new AttendanceRegisterPage(page);
    await register.gotoMonth(seeded.sectionA.id, late);
    const d0 = before[before.length - 1].day;
    const label = dayLabel(`${late.slice(0, 8)}${String(d0).padStart(2, '0')}`);
    await expect(register.month.missingCellButton(seeded.late.fullName, label)).toHaveCount(0);
    await expect(register.month.row(seeded.late.fullName).locator(`td[data-day="${d0}"]`)).toContainText('Not enrolled');
  });
});

test.describe('UI messages around a back-fill (z94x8ec4qm, z94x8ec4qn)', () => {
  test("qn: after a back-dated submit the page shows the submitted state, never \"Only today's register can be marked\"", async ({ page }) => {
    const register = new AttendanceRegisterPage(page);
    const date = pastWorkingDay(8);
    await register.gotoToday(seeded.sectionA.id, date);
    await register.openSubmit();
    await register.submitDialog.confirm();
    await register.submitDialog.expectClosed();
    await expect(register.submittedBanner()).toBeVisible();
    await expect(register.submittedBanner()).toContainText('month register');
    await expect(page.getByText("Only today's register can be marked")).toHaveCount(0);
    await expect(register.registerDate()).toContainText(dayLabel(date).split(', ')[1]);
  });

  test('qm: when someone else back-fills the same date first, the dialog explains it and Review keeps that date', async ({ page }) => {
    const register = new AttendanceRegisterPage(page);
    const date = pastWorkingDay(9);
    await register.gotoToday(seeded.sectionA.id, date);
    await expect(register.pastDateBanner()).toBeVisible();
    const other = await api.submit(seeded.sectionA.id, date, await api.marksFor(seeded.sectionA.id, date), 0);
    expect(other.status()).toBe(200);

    await register.openSubmit();
    await register.submitDialog.confirm();
    await expect(register.submitDialog.dialog.getByText('Attendance date needs review')).toBeVisible();
    await expect(register.submitDialog.dialog).toContainText('correction');
    await expect(register.submitDialog.dialog).not.toContainText("Only today's register can be marked");
    await register.submitDialog.review();
    await expect.poll(() => register.url().searchParams.get('date')).toBe(date);
    await expect(register.submittedBanner()).toBeVisible();
    expect(await schoolDb.audit(seeded.sectionA.id, date)).toHaveLength(1);
  });
});
