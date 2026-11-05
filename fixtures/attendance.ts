/**
 * PR 548 (back-dated attendance) helpers for the LOCAL branch-testing stack. API + Postgres only, no page objects.
 *
 *  - seedBackdatingClass(): creates a fresh "QA548 <suffix>" class with sections A and B, quick-adds pupils into A,
 *    then back-dates BOTH sections' CreatedDate to the current session's start (DB precondition on data this
 *    helper just created — the RestApi has no way to create a section in the past). Optionally strikes one pupil
 *    off and transfers one A -> B, so the roster-on-a-date rules can be checked.
 *  - attendanceApi(): RestApi client signed in as the seeded school owner (QA_EMAIL / QA_PASSWORD, persona Campus).
 *  - schoolDb: read-only queries against the school DB (audit rows, records) + the CreatedDate precondition.
 *
 * Run inside the PR network namespace (qa548): localhost:7244 there is the PR's RestApi.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomInt } from 'node:crypto';
import { expect, request as pwRequest, type APIRequestContext, type APIResponse } from '@playwright/test';

const run = promisify(execFile);

export const REST_API = process.env.QA_REST_API_URL ?? 'https://localhost:7244';
const PG = {
  host: process.env.QA_PG_HOST ?? 'localhost',
  user: process.env.QA_PG_USER ?? 'postgres',
  db: process.env.QA_PG_SCHOOL_DB ?? 'mp-shared-schools-db',
  password: process.env.QA_PG_PASSWORD ?? 'admin123',
};

export const PRESENT = 0;
export const ABSENT = 1;

// ── Dates (operational calendar: PKT, Sunday non-working) ───────────────────────────────────

const PKT_OFFSET_MS = 5 * 3600_000;
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const todayPkt = () => iso(new Date(Date.now() + PKT_OFFSET_MS));
export const addDays = (isoDate: string, days: number) => iso(new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000));
export const isSunday = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).getUTCDay() === 0;

/** The n-th working day before today (n = 1 is the previous working day). */
export function pastWorkingDay(n: number): string {
  let d = todayPkt();
  for (let found = 0; found < n; ) {
    d = addDays(d, -1);
    if (!isSunday(d)) found++;
  }
  return d;
}

export function nextSunday(after = todayPkt()): string {
  let d = addDays(after, 1);
  while (!isSunday(d)) d = addDays(d, 1);
  return d;
}

export function previousSunday(before = todayPkt()): string {
  let d = addDays(before, -1);
  while (!isSunday(d)) d = addDays(d, -1);
  return d;
}

export function nextWorkingDay(after = todayPkt()): string {
  let d = addDays(after, 1);
  while (isSunday(d)) d = addDays(d, 1);
  return d;
}

/** "Friday, 30 Oct" — the month grid's accessible day label. */
export function dayLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  const month = d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${weekday}, ${String(d.getUTCDate()).padStart(2, '0')} ${month}`;
}

// ── Postgres ────────────────────────────────────────────────────────────────────────────────

async function psql(sql: string): Promise<string[]> {
  const { stdout } = await run('psql', ['-h', PG.host, '-U', PG.user, '-d', PG.db, '-q', '-At', '-F', '|', '-c', sql], {
    env: { ...process.env, PGPASSWORD: PG.password },
    timeout: 30_000,
  });
  return stdout.split('\n').filter((l) => l.length > 0);
}

/** Single-quoted SQL literal; ids here are UUIDs we created, but quote defensively anyway. */
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

export interface AuditRow { action: string; registerDate: string; present: number; absent: number; actorName: string; occurredAtUtc: string }
export interface RecordRow { studentId: string; status: string; isCorrection: boolean; actorName: string }

export const schoolDb = {
  async sessionStart(tenantId: string): Promise<string> {
    const [row] = await psql(`select to_char("StartDate", 'YYYY-MM-DD') from "Sessions" where "TenantId" = ${lit(tenantId)}
      and "StartDate" <= now() and "EndDate" >= now() order by "StartDate" desc limit 1`);
    if (!row) throw new Error(`no current session for tenant ${tenantId}`);
    return row;
  },

  /** Precondition on a section THIS run created: pretend it existed since `isoDate` (PKT midnight). */
  async backdateSectionCreated(sectionId: string, isoDate: string) {
    const rows = await psql(`update "Sections" set "CreatedDate" = (${lit(isoDate)}::date - interval '5 hours')
      where "Id" = ${lit(sectionId)} returning "Id"`);
    expect(rows, `backdate section ${sectionId}`).toHaveLength(1);
  },

  async audit(sectionId: string, registerDate: string): Promise<AuditRow[]> {
    const rows = await psql(`select "Action", "RegisterDate", "PresentCount", "AbsentCount", "ActorName", "OccurredAtUtc"
      from "AttendanceAuditEntries" where "SectionId" = ${lit(sectionId)} and "RegisterDate" = ${lit(registerDate)} order by "OccurredAtUtc"`);
    return rows.map((r) => {
      const [action, date, present, absent, actorName, occurredAtUtc] = r.split('|');
      return { action, registerDate: date, present: Number(present), absent: Number(absent), actorName, occurredAtUtc };
    });
  },

  async records(sectionId: string, registerDate: string): Promise<RecordRow[]> {
    const rows = await psql(`select "StudentId", "Status", "IsCorrection", "ActorName" from "AttendanceRecords"
      where "SectionId" = ${lit(sectionId)} and "RegisterDate" = ${lit(registerDate)}`);
    return rows.map((r) => {
      const [studentId, status, isCorrection, actorName] = r.split('|');
      return { studentId, status, isCorrection: isCorrection === 't', actorName };
    });
  },

  /** Register event types recorded for a student (e.g. "Admitted", "Struck off", "Section transferred"). */
  async registerEvents(studentId: string): Promise<string[]> {
    return psql(`select "EventType" from "AcademicRegisterEntries" where "SubjectId" = ${lit(studentId)} order by "OccurredAt"`);
  },

  /**
   * The academic register is written asynchronously (outbox -> relay -> worker), ~2 s after the student row changes.
   * The PR's past-date roster replays that register, so callers that need the settled roster wait here.
   */
  async waitForRegisterEvent(studentId: string, eventType: string, timeout = 45_000) {
    await expect
      .poll(() => schoolDb.registerEvents(studentId), { message: `register entry "${eventType}" for ${studentId}`, timeout, intervals: [500, 1000, 2000] })
      .toContain(eventType);
  },
};

// ── RestApi ─────────────────────────────────────────────────────────────────────────────────

export interface Mark { studentId: string; status: number }

export interface RegisterStudent { studentId: string; studentName: string; status: number; isPersisted: boolean }
export interface TodayRegister {
  sectionId: string; registerDate: string; isWorkingDay: boolean; isSubmitted: boolean; canMark: boolean;
  isClosed: boolean; version: number; students: RegisterStudent[];
}
export interface MonthRegister {
  days: Array<{ day: number; isWorkingDay: boolean; isFuture: boolean; isUnmarked: boolean; isToday: boolean }>;
  students: Array<{ studentId: string; studentName: string; cells: Array<{ day: number; code: string }> }>;
}

export class AttendanceApi {
  constructor(readonly http: APIRequestContext, readonly tenantId: string) {}

  static async signIn(): Promise<AttendanceApi> {
    const username = process.env.QA_EMAIL;
    const password = process.env.QA_PASSWORD;
    if (!username || !password) throw new Error('QA_EMAIL / QA_PASSWORD missing from .env');
    const login = await pwRequest.newContext({ ignoreHTTPSErrors: true });
    const res = await login.post(`${REST_API}/auth/login`, { data: { username, password, persona: 1 } });
    expect(res.status(), 'RestApi /auth/login (school owner)').toBe(200);
    const token = (await res.json()).accessToken as string;
    await login.dispose();
    const tenantId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).tenant as string;
    const http = await pwRequest.newContext({
      ignoreHTTPSErrors: true,
      baseURL: `${REST_API}/`,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    return new AttendanceApi(http, tenantId);
  }

  async register(sectionId: string, date?: string): Promise<TodayRegister> {
    const res = await this.http.get('attendance-register/today', { params: date ? { sectionId, date } : { sectionId } });
    expect(res.status(), `GET register ${sectionId} ${date ?? 'today'}`).toBe(200);
    return res.json();
  }

  async month(sectionId: string, isoMonthStart: string): Promise<MonthRegister> {
    const res = await this.http.get('attendance-register/month', { params: { sectionId, month: isoMonthStart } });
    expect(res.status(), `GET month ${sectionId} ${isoMonthStart}`).toBe(200);
    return res.json();
  }

  submit(sectionId: string, registerDate: string, marks: Mark[], expectedVersion: number | null = 0): Promise<APIResponse> {
    const data: Record<string, unknown> = { sectionId, registerDate, sitting: 0, marks };
    if (expectedVersion !== null) data.expectedVersion = expectedVersion;
    return this.http.post('attendance-register/submit', { data });
  }

  /** Marks everyone on that date's roster Present, except the ids in `absent`. */
  async marksFor(sectionId: string, date: string, absent: string[] = []): Promise<Mark[]> {
    const reg = await this.register(sectionId, date);
    return reg.students.map((s) => ({ studentId: s.studentId, status: absent.includes(s.studentId) ? ABSENT : PRESENT }));
  }

  async exportCsv(sectionId: string, isoMonthStart: string): Promise<string> {
    const res = await this.http.post('attendance-register/month/export', { data: { sectionId, month: isoMonthStart, format: 1, scope: 0 } });
    expect(res.status(), 'CSV export').toBe(200);
    return res.text();
  }

  async dispose() { await this.http.dispose(); }
}

// ── Seeding ─────────────────────────────────────────────────────────────────────────────────

export interface SeededPupil { id: string; fullName: string }
export interface BackdatingClass {
  className: string;
  classId: string;
  sectionA: { id: string; label: string };
  sectionB: { id: string; label: string };
  sessionStart: string;
  /** Admitted at session start; stays in A. */
  early: SeededPupil;
  /** Admitted at session start; stays in A. */
  steady: SeededPupil;
  /** Admitted on `lateAdmission` (after the roster test date). */
  late: SeededPupil;
  lateAdmission: string;
  /** Struck off today (when `withMoves`). */
  leaver: SeededPupil;
  /** Transferred A -> B today (when `withMoves`). */
  mover: SeededPupil;
}

const letters = (n: number) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[randomInt(26)]).join('');
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pupilMobile = () => `0345548${String(randomInt(0, 10_000)).padStart(4, '0')}`;

async function quickAdd(api: AttendanceApi, classId: string, firstName: string, admissionDate: string): Promise<SeededPupil> {
  // Letters only: QuickAdd rejects digits in names.
  const fullName = `${titleCase(firstName)} ${titleCase(letters(5))}`;
  const admissionId = `Q548-${letters(4).toUpperCase()}`;
  const res = await api.http.post('students/quick-add', {
    data: { fullName, admissionId, fatherName: 'Qa Father', mobileNumber: pupilMobile(), classId, admissionDate, dateOfBirth: '2014-02-02T00:00:00Z', gender: 0 },
  });
  expect(res.status(), `quick-add ${fullName}: ${await res.text()}`).toBe(201);
  return { id: (await res.json()).id as string, fullName };
}

/**
 * Creates "QA548 <suffix>" (grade 7) with sections A and B, backdated to the session start.
 * Pupils are added one at a time (concurrent quick-adds race on the roll number).
 */
export async function seedBackdatingClass(api: AttendanceApi, opts: { lateAdmission: string; withMoves?: boolean }): Promise<BackdatingClass> {
  const className = `QA548 ${letters(6)}`;
  const created = await api.http.post('classes/create', {
    data: { className, grade: '7', sections: [{ sectionName: 'A', size: 40 }, { sectionName: 'B', size: 40 }], subjects: null },
  });
  expect(created.status(), `create class ${className}: ${await created.text()}`).toBe(201);
  const classId = (await created.json()).id as string;

  const sections = await api.http.get('attendance-register/sections');
  const mine = ((await sections.json()) as Array<{ sectionId: string; sectionName: string; classId: string }>)
    .filter((s) => s.classId === classId);
  const a = mine.find((s) => / A$/.test(s.sectionName));
  const b = mine.find((s) => / B$/.test(s.sectionName));
  expect(a && b, `sections A/B of ${className}`).toBeTruthy();

  const sessionStart = await schoolDb.sessionStart(api.tenantId);
  await schoolDb.backdateSectionCreated(a!.sectionId, sessionStart);
  await schoolDb.backdateSectionCreated(b!.sectionId, sessionStart);

  const early = await quickAdd(api, classId, 'alpha', sessionStart);
  const late = await quickAdd(api, classId, 'bravo', opts.lateAdmission);
  const leaver = await quickAdd(api, classId, 'charlie', sessionStart);
  const mover = await quickAdd(api, classId, 'delta', sessionStart);
  const steady = await quickAdd(api, classId, 'echo', sessionStart);

  if (opts.withMoves) {
    const off = await api.http.post(`students/${leaver.id}/struck-off`, { data: { reason: 'Left school', comments: 'QA548' } });
    expect(off.status(), `strike off ${leaver.fullName}`).toBe(200);
    const moved = await api.http.post('classes/section-transfer', {
      data: { classId, fromSection: 'A', toSection: 'B', studentIds: [mover.id] },
    });
    expect(moved.status(), `transfer ${mover.fullName}`).toBe(200);
    await schoolDb.waitForRegisterEvent(leaver.id, 'Struck off');
    await schoolDb.waitForRegisterEvent(mover.id, 'Section transferred');
  }

  return {
    className, classId, sessionStart,
    sectionA: { id: a!.sectionId, label: a!.sectionName },
    sectionB: { id: b!.sectionId, label: b!.sectionName },
    early, late, leaver, mover, steady, lateAdmission: opts.lateAdmission,
  };
}

/** A class created today (no DB back-dating), for the "before the section existed" rule. */
export async function seedFreshClass(api: AttendanceApi, admissionDate: string): Promise<{ classId: string; sectionId: string; label: string; pupil: SeededPupil }> {
  const className = `QA548 Fresh ${letters(5)}`;
  const created = await api.http.post('classes/create', {
    data: { className, grade: '8', sections: [{ sectionName: 'A', size: 40 }], subjects: null },
  });
  expect(created.status(), `create class ${className}`).toBe(201);
  const classId = (await created.json()).id as string;
  const sections = await api.http.get('attendance-register/sections');
  const s = ((await sections.json()) as Array<{ sectionId: string; sectionName: string; classId: string }>).find((x) => x.classId === classId)!;
  const pupil = await quickAdd(api, classId, 'foxtrot', admissionDate);
  return { classId, sectionId: s.sectionId, label: s.sectionName, pupil };
}

