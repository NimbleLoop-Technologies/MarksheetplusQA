/**
 * PR 548 / CU-z94x8ean2v — back-dated attendance, server rules (RestApi).
 * Self-seeding: one fresh "QA548 <suffix>" class per file (sections back-dated to the session start in the DB).
 * Run inside the qa548 netns with --workers=1. Tests titled "BUG:" assert the EXPECTED behaviour and fail
 * while the bug is present.
 */
import { test, expect } from '@playwright/test';
import {
  AttendanceApi, ABSENT, PRESENT, schoolDb, seedBackdatingClass, seedFreshClass,
  pastWorkingDay, nextWorkingDay, previousSunday, todayPkt, addDays, isSunday, type BackdatingClass,
} from '../../../fixtures/attendance';

// Not serial: a failing BUG test must not skip the others. A failure restarts the worker and beforeAll re-seeds.
test.describe.configure({ mode: 'default' });

let api: AttendanceApi;
let seeded: BackdatingClass;

// Dates used here, all distinct (n-th working day before today).
const ROSTER_DATE = () => pastWorkingDay(5);
const BACKFILL_DATE = () => pastWorkingDay(6);
const DUPLICATE_DATE = () => pastWorkingDay(7);
const WRONG_ROSTER_DATE = () => pastWorkingDay(8);
const RACE_DATE = () => pastWorkingDay(9);

test.beforeAll(async () => {
  api = await AttendanceApi.signIn();
  seeded = await seedBackdatingClass(api, { lateAdmission: pastWorkingDay(3), withMoves: true });
  test.skip(pastWorkingDay(10) < seeded.sessionStart, 'needs 10 working days of the current session behind today');
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('roster on a past date', () => {
  test('lists pupils enrolled on that date: later admissions out, later leavers and movers in', async () => {
    const register = await api.register(seeded.sectionA.id, ROSTER_DATE());
    const ids = register.students.map((s) => s.studentId);
    expect(ids).toEqual(expect.arrayContaining([seeded.early.id, seeded.steady.id, seeded.leaver.id, seeded.mover.id]));
    expect(ids).not.toContain(seeded.late.id);
    expect(register.isClosed).toBe(false);
    expect(register.canMark).toBe(true);
  });

  test('a pupil transferred in after the date is not on the destination section that day', async () => {
    const register = await api.register(seeded.sectionB.id, ROSTER_DATE());
    expect(register.students.map((s) => s.studentId)).not.toContain(seeded.mover.id);
  });

  test("today's roster reflects the current placement", async () => {
    const a = (await api.register(seeded.sectionA.id)).students.map((s) => s.studentId);
    const b = (await api.register(seeded.sectionB.id)).students.map((s) => s.studentId);
    expect(a).toEqual(expect.arrayContaining([seeded.early.id, seeded.late.id, seeded.steady.id]));
    expect(a).not.toContain(seeded.leaver.id);
    expect(a).not.toContain(seeded.mover.id);
    expect(b).toContain(seeded.mover.id);
  });
});

test.describe('submitting a past unmarked working day', () => {
  test('is accepted, audited as AttendanceBackdated with the submitter, and shows in month + CSV', { tag: '@smoke' }, async () => {
    const date = BACKFILL_DATE();
    const marks = await api.marksFor(seeded.sectionA.id, date, [seeded.mover.id]);
    const res = await api.submit(seeded.sectionA.id, date, marks, 0);
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ isResubmission: false, version: 1, absentCount: 1, presentCount: marks.length - 1 });

    const audit = await schoolDb.audit(seeded.sectionA.id, date);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('Attendance backdated');
    expect(audit[0].actorName.length).toBeGreaterThan(0);
    expect(Date.now() - Date.parse(audit[0].occurredAtUtc)).toBeLessThan(5 * 60_000);

    const records = await schoolDb.records(seeded.sectionA.id, date);
    expect(records).toHaveLength(marks.length);

    const register = await api.register(seeded.sectionA.id, date);
    expect(register).toMatchObject({ isSubmitted: true, isClosed: true, version: 1 });

    const monthStart = `${date.slice(0, 8)}01`;
    const month = await api.month(seeded.sectionA.id, monthStart);
    const day = Number(date.slice(8));
    expect(month.days.find((d) => d.day === day)?.isUnmarked).toBe(false);
    const moverRow = month.students.find((s) => s.studentId === seeded.mover.id)!;
    expect(moverRow.cells.find((c) => c.day === day)?.code).toBe('A');

    const csv = await api.exportCsv(seeded.sectionA.id, monthStart);
    const header = csv.split('\n').find((l) => l.startsWith('Student,'))!.split(',');
    const earlyLine = csv.split('\n').find((l) => l.includes(seeded.early.fullName))!.split(',');
    expect(earlyLine[header.indexOf(String(day))]).toBe('P');
  });

  test('a second submit for an already-submitted past date points to the correction flow (not a concurrency message)', async () => {
    const date = DUPLICATE_DATE();
    const marks = await api.marksFor(seeded.sectionA.id, date);
    expect((await api.submit(seeded.sectionA.id, date, marks, 0)).status()).toBe(200);

    for (const version of [0, 1]) {
      const again = await api.submit(seeded.sectionA.id, date, marks, version);
      expect(again.status()).toBe(400);
      const text = await again.text();
      expect(text).toContain('correction');
      expect(text).not.toContain('another user');
    }
    expect(await schoolDb.audit(seeded.sectionA.id, date)).toHaveLength(1);
  });

  test('marks for a pupil who was not enrolled that day are rejected', async () => {
    const date = WRONG_ROSTER_DATE();
    const marks = [...(await api.marksFor(seeded.sectionA.id, date)), { studentId: seeded.late.id, status: PRESENT }];
    const res = await api.submit(seeded.sectionA.id, date, marks, 0);
    expect(res.status()).toBe(400);
    expect((await res.json()).errors.Marks[0]).toContain(seeded.late.id);
  });

  test('a submit without ExpectedVersion is rejected', async () => {
    const date = WRONG_ROSTER_DATE();
    const res = await api.submit(seeded.sectionA.id, date, await api.marksFor(seeded.sectionA.id, date), null);
    expect(res.status()).toBe(400);
    expect((await res.json()).errors).toHaveProperty('ExpectedVersion');
  });

  test('two simultaneous backfills of one date write exactly one register and neither returns a 5xx', async () => {
    const date = RACE_DATE();
    const marks = await api.marksFor(seeded.sectionA.id, date);
    const [r1, r2] = await Promise.all([api.submit(seeded.sectionA.id, date, marks, 0), api.submit(seeded.sectionA.id, date, marks, 0)]);
    const statuses = [r1.status(), r2.status()].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeLessThan(500);
    expect(await schoolDb.audit(seeded.sectionA.id, date)).toHaveLength(1);
    expect(await schoolDb.records(seeded.sectionA.id, date)).toHaveLength(marks.length);
  });
});

test.describe('dates that stay blocked', () => {
  test('a future working day is rejected', { tag: '@smoke' }, async () => {
    const date = nextWorkingDay();
    const marks = (await api.register(seeded.sectionA.id)).students.map((s) => ({ studentId: s.studentId, status: PRESENT }));
    const res = await api.submit(seeded.sectionA.id, date, marks, 0);
    expect(res.status()).toBe(400);
    expect((await res.json()).errors).toHaveProperty('RegisterDate');
  });

  test('a past Sunday is rejected', async () => {
    const date = previousSunday();
    const marks = await api.marksFor(seeded.sectionA.id, pastWorkingDay(1));
    const res = await api.submit(seeded.sectionA.id, date, marks, 0);
    expect(res.status()).toBe(400);
    expect((await res.json()).errors.RegisterDate[0]).toContain('working day');
  });

  test('a date in the previous session is rejected', async () => {
    let date = addDays(seeded.sessionStart, -1);
    while (isSunday(date)) date = addDays(date, -1);
    const res = await api.submit(seeded.sectionA.id, date, [{ studentId: seeded.early.id, status: PRESENT }], 0);
    expect(res.status()).toBe(400);
    expect((await res.json()).errors).toHaveProperty('RegisterDate');
  });

  test('a date before the section was created but within the session is offered on the month grid (lower bound = session start)', async () => {
    // Past GET/submit currently crash (UNION uuid/text) — month eligibility still proves the session-start bound.
    const fresh = await seedFreshClass(api, seeded.sessionStart);
    const date = pastWorkingDay(1);
    expect(date >= seeded.sessionStart).toBe(true);
    const month = await api.month(fresh.sectionId, `${date.slice(0, 8)}01`);
    expect(month.days.find((d) => d.day === Number(date.slice(8)))?.isUnmarked).toBe(true);
  });
});

test.describe("today's register (regression)", () => {
  test('first submit, resubmit and a stale resubmit behave as before', async () => {
    const section = seeded.sectionB.id;
    const today = todayPkt();
    const marks = (await api.register(section)).students.map((s) => ({ studentId: s.studentId, status: ABSENT }));
    expect(marks.length).toBeGreaterThan(0);

    const first = await api.submit(section, today, marks, 0);
    expect(first.status(), await first.text()).toBe(200);
    const again = await api.submit(section, today, marks.map((m) => ({ ...m, status: PRESENT })), 1);
    expect(again.status()).toBe(200);
    expect(await again.json()).toMatchObject({ isResubmission: true, version: 2 });
    const stale = await api.submit(section, today, marks, 1);
    expect(stale.status()).toBe(409);

    expect((await schoolDb.audit(section, today)).map((a) => a.action)).toEqual(['Attendance submitted', 'Attendance resubmitted']);
    expect((await api.register(section)).isClosed).toBe(false);
  });
});

test.describe('known bugs (assert expected behaviour)', () => {
  test('BUG: month register offers days from the session start even when the section was created later', async () => {
    const fresh = await seedFreshClass(api, seeded.sessionStart);
    const date = pastWorkingDay(1);
    const month = await api.month(fresh.sectionId, `${date.slice(0, 8)}01`);
    expect(month.days.find((d) => d.day === Number(date.slice(8)))?.isUnmarked).toBe(true);
  });

  test('BUG: a pupil struck off moments ago is still on an earlier date’s roster (no wait for the async register)', async () => {
    const fresh = await seedFreshClass(api, seeded.sessionStart);
    const off = await api.http.post(`students/${fresh.pupil.id}/struck-off`, { data: { reason: 'Left school', comments: 'QA548 lag' } });
    expect(off.status()).toBe(200);
    // Read straight away: the student row has already changed, the academic register entry lands ~2 s later.
    const register = await api.register(fresh.sectionId, pastWorkingDay(1));
    expect(register.students.map((s) => s.studentId)).toContain(fresh.pupil.id);
  });

  test("BUG: the RegisterDate validation message does not leak the .NET parameter suffix", async () => {
    const res = await api.submit(seeded.sectionA.id, nextWorkingDay(), [{ studentId: seeded.early.id, status: PRESENT }], 0);
    expect(res.status()).toBe(400);
    expect((await res.json()).errors.RegisterDate[0]).not.toContain("(Parameter 'RegisterDate')");
  });
});

