/**
 * PR 564 / ClickUp z94x8ee9rn — dashboard absentee leak fix (v2 must-pass).
 *  /dashboard/main returns only absentToday: { count } (no students list), and only with Attendance See;
 *    without See, absentToday is null and the Home tile shows a dash.
 *  /dashboard/absences returns 403 without See, and honours optional classId / sectionId filters
 *    (a mismatched or unknown id yields empty days; no filter stays campus-wide).
 *  The count is Absent + Active + not archived students today. Struck-off and archived absents are excluded.
 * Self-seeding throwaway campus. Local isolated stack only. Dates are the server's operational (PKT) day.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { newCampusOwner, cacheOwner, REST_API, type CampusOwner } from '../../fixtures/campus-owner';
import { addStaffWithContacts, inviteAndAccept, putStaffRoles, staffRoles, campusApi, mobile549, letters } from '../../fixtures/access-roles';
import { DESIGNATION } from '../../fixtures/payroll';
import { createFamilyParent, callFamilyApi, type FreshParent } from '../../fixtures/devenv';
import { signInToWebApp } from '../../pages/fees/AccountOffice';
import { LoginPage } from '../../pages/LoginPage';
import * as f from '../../fixtures/fees';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.join(EV, '..', 'seed');
const SEED = path.join(SEED_DIR, 'seed.json');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
const DASH = '—';

const pad = (n: number) => String(n).padStart(2, '0');
const pktToday = () => {
  const d = new Date(Date.now() + 5 * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const weekday = (iso: string) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${iso}T00:00:00+05:00`).getDay()];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const initials = (s: string) => s.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + '.').join(' ');
const NAME_KEYS = /^(studentName|name|fullName|fatherName|guardianName|motherName|parentName)$/i;
const PHONE_KEYS = /(phone|mobile|whatsapp|contact)/i;
function redact(v: any, key = ''): any {
  if (Array.isArray(v)) return v.map(x => redact(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  if (typeof v === 'string') {
    if (NAME_KEYS.test(key)) return initials(v);
    if (PHONE_KEYS.test(key)) return `***${v.replace(/\D/g, '').slice(-2)}`;
    if (/address/i.test(key)) return '<address>';
    if (/(picture|photo|avatar|url)/i.test(key)) return v ? '<url>' : v;
    if (/token/i.test(key)) return '<token>';
    if (/password/i.test(key)) return '<password>';
  }
  return v;
}

function hasKey(v: any, name: string): boolean {
  if (Array.isArray(v)) return v.some(x => hasKey(x, name));
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k.toLowerCase() === name.toLowerCase()) return true;
      if (hasKey(x, name)) return true;
    }
  }
  return false;
}

async function evidence(name: string, data: unknown, raw = false) {
  mkdirSync(EV, { recursive: true });
  const file = path.join(EV, name);
  writeFileSync(file, JSON.stringify(raw ? data : redact(data), null, 2));
  return file;
}

function writeSeed(data: unknown) {
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SEED, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { chmodSync(SEED_DIR, 0o700); chmodSync(SEED, 0o600); } catch { /* */ }
}

interface Kid {
  id: string;
  name: string;
  cls: '7' | '8';
  section: string;
  sectionId: string;
  classId: string;
  markedAbsent: boolean;
  fate: 'active' | 'struck-off' | 'archived';
}

async function quickAdd(api: APIRequestContext, classId: string, mobile: string, first: string) {
  const fullName = `${first} ${cap(letters(6))}`;
  const res = await api.post('students/quick-add', {
    data: {
      fullName,
      admissionId: `P564-${letters(5).toUpperCase()}`,
      fatherName: `Dpfather ${cap(letters(5))}`,
      mobileNumber: mobile || mobile549(),
      classId,
      admissionDate: '2026-09-01T00:00:00Z',
      dateOfBirth: '2014-02-02T00:00:00Z',
      gender: 0,
    },
  });
  expect(res.status(), `quick-add ${fullName}: ${(await res.text()).slice(0, 300)}`).toBe(201);
  return { id: (await res.json()).id as string, name: fullName };
}

async function bearer(token: string) {
  return pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: `${REST_API}/`, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

async function getJson(api: APIRequestContext, p: string, params?: Record<string, string>) {
  const r = await api.get(p, params ? { params } : undefined);
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* text */ }
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return { path: `/${p}${qs}`, status: r.status(), body };
}

const expectedActiveAbsentNames = (kids: Kid[]) =>
  kids.filter(k => k.markedAbsent && k.fate === 'active').map(k => k.name);

test.describe('PR 564 dashboard absentee leak fix (CU-z94x8ee9rn)', () => {
  test.describe.configure({ mode: 'serial', timeout: 15 * 60_000 });
  test.use({ timezoneId: 'Asia/Karachi', ignoreHTTPSErrors, viewport: { width: 1440, height: 1024 } });

  let owner: CampusOwner;
  let today: string;
  let month: string;
  let class7: string;
  let class8: string;
  let sections: Array<{ sectionId: string; sectionName: string; classId: string }>;
  let kids: Kid[] = [];
  let staff: Record<string, { staffId: string; email: string; password: string; userId: string; role: string }>;
  let parent: FreshParent;
  let childId: string;
  let apis: Record<string, APIRequestContext>;
  let rolesCatalog: unknown;
  const matrix: Array<Record<string, unknown>> = [];
  const calls: Array<Record<string, unknown>> = [];

  const record = (role: string, call: { path: string; status: number; body: any }) => {
    const row = { role, method: 'GET', ...call };
    calls.push(row);
    return row;
  };

  test.beforeAll(async () => {
    test.setTimeout(15 * 60_000);
    mkdirSync(EV, { recursive: true });
    mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });

    parent = await createFamilyParent();
    owner = await newCampusOwner('pr564');
    await f.ok(await owner.api.post('sessions/create', { data: {
      sessionName: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30',
      terms: [
        { termName: 'Term 1', termStartDate: '2026-09-01', termEndDate: '2026-12-31', passingCriteria: 40 },
        { termName: 'Term 2', termStartDate: '2027-01-01', termEndDate: '2027-06-30', passingCriteria: 40 },
      ],
    } }), 'sessions/create');

    const a = await f.ok(await owner.api.post('classes/create', { data: { className: 'Class 7', grade: '7', sections: [{ sectionName: 'A', size: 40 }], subjects: null } }), 'class 7');
    const b = await f.ok(await owner.api.post('classes/create', { data: { className: 'Class 8', grade: '8', sections: [{ sectionName: 'A', size: 3 }, { sectionName: 'B', size: 40 }], subjects: null } }), 'class 8');
    class7 = a.id; class8 = b.id;

    // Class 7 A: two active absents, one present, one absent-then-struck-off.
    // Class 8 A: one active absent, one present, one absent-then-archived.
    // Class 8 B: two active absents, one present.
    const plan: Array<{ first: string; classId: string; cls: '7' | '8'; absent: boolean; fate: Kid['fate']; mobile?: string }> = [
      { first: 'Alia', classId: a.id, cls: '7', absent: true, fate: 'active' },
      { first: 'Bilal', classId: a.id, cls: '7', absent: true, fate: 'active' },
      { first: 'Daniyal', classId: a.id, cls: '7', absent: false, fate: 'active' },
      { first: 'Esha', classId: a.id, cls: '7', absent: true, fate: 'struck-off' },
      { first: 'Farah', classId: b.id, cls: '8', absent: true, fate: 'active' },
      { first: 'Ghazi', classId: b.id, cls: '8', absent: false, fate: 'active' },
      { first: 'Hiba', classId: b.id, cls: '8', absent: true, fate: 'archived' },
      { first: 'Imran', classId: b.id, cls: '8', absent: true, fate: 'active' },
      { first: 'Javeria', classId: b.id, cls: '8', absent: false, fate: 'active' },
      { first: 'Kamran', classId: b.id, cls: '8', absent: true, fate: 'active' },
    ];
    for (const row of plan) {
      const k = await quickAdd(owner.api, row.classId, row.first === 'Alia' ? parent.phone : (row.mobile || ''), row.first);
      kids.push({ ...k, cls: row.cls, section: '', sectionId: '', classId: row.classId, markedAbsent: row.absent, fate: row.fate });
    }

    const allSections = await f.ok(await owner.api.get('attendance-register/sections'), 'sections') as Array<{ sectionId: string; sectionName: string; classId: string }>;
    sections = allSections.filter(s => s.classId === a.id || s.classId === b.id);
    today = pktToday();
    month = today.slice(0, 7);

    for (const s of sections) {
      const reg = await f.ok(await owner.api.get('attendance-register/today', { params: { sectionId: s.sectionId, date: today } }), `register ${s.sectionName}`);
      for (const st of reg.students) {
        const k = kids.find(x => x.id === st.studentId);
        if (k) { k.section = s.sectionName; k.sectionId = s.sectionId; }
      }
      if (!(reg.students as unknown[]).length) continue;
      const marks = (reg.students as Array<{ studentId: string }>).map(st => {
        const k = kids.find(x => x.id === st.studentId);
        return { studentId: st.studentId, status: k?.markedAbsent ? 1 : 0 };
      });
      const sub = await owner.api.post('attendance-register/submit', { data: { sectionId: s.sectionId, registerDate: today, sitting: 0, marks, expectedVersion: reg.version ?? 0 } });
      expect(sub.status(), `submit ${s.sectionName}: ${(await sub.text()).slice(0, 300)}`).toBeLessThan(300);
    }
    expect(kids.filter(k => k.cls === '8' && k.section.includes('A')).length, 'Class 8 A should have pupils (section A size 3)').toBe(3);
    expect(kids.filter(k => k.cls === '8' && k.section.includes('B')).length, 'Class 8 B should have the overflow pupils').toBe(3);

    // Strike off / archive after the register is in, so we can prove the count drops them.
    const esha = kids.find(k => k.name.startsWith('Esha'))!;
    const off = await owner.api.post(`students/${esha.id}/struck-off`, { data: { reason: 'Left school', comments: 'PR564 QA: exclude from absent today' } });
    expect(off.status(), `struck-off Esha: ${(await off.text()).slice(0, 400)}`).toBeLessThan(300);

    const hiba = kids.find(k => k.name.startsWith('Hiba'))!;
    const arch = await owner.api.post(`students/${hiba.id}/archive`);
    expect(arch.status(), `archive Hiba: ${(await arch.text()).slice(0, 400)}`).toBeLessThan(300);

    staff = {};
    const staffPlan = [
      ['noRole', '', DESIGNATION.teacher],
      ['teacher', 'Teacher', DESIGNATION.teacher],
      ['accountant', 'Accountant', DESIGNATION.teacher],
      ['headAdmin', 'Head Admin', DESIGNATION.teacher],
    ] as const;
    for (const [key, role, des] of staffPlan) {
      const email = `pr564-${key.toLowerCase()}+${letters(6)}@testenv.local`;
      const row = await addStaffWithContacts(owner.api, { first: key, phone: mobile549(), email, designationId: des });
      const acc = await inviteAndAccept(owner.api, row.id, email);
      const put = await putStaffRoles(owner.api, row.id, role ? [role] : []);
      expect(put.status(), `roles ${key}: ${await put.text()}`).toBe(200);
      const assigned = (await staffRoles(owner.api, row.id)).body!.assignedRoleIds;
      expect(assigned, `assigned ${key}`).toEqual(role ? [role] : []);
      staff[key] = { staffId: row.id, email, password: acc.password, userId: acc.userId, role: role || '(none)' };
    }

    const child = kids.find(k => k.name.startsWith('Alia'))!;
    childId = child.id;
    const sent = await f.ok(await owner.api.post(`students/${child.id}/parent-family/invite`), 'invite');
    let redeem = { status: 0, body: '' };
    await expect(async () => {
      redeem = await callFamilyApi(parent, 'POST', '/family/link-invites/redeem', { code: sent.code });
      expect(redeem.status, redeem.body).toBe(200);
    }).toPass({ timeout: 60_000, intervals: [2_000] });
    const accept = await callFamilyApi(parent, 'POST', `/family/link-invites/${JSON.parse(redeem.body).inviteId}/accept`, { childId: null, token: null });
    expect(accept.status, accept.body).toBe(200);
    await expect(async () => {
      const st = await f.ok(await owner.api.get(`students/${child.id}/parent-family`), 'link');
      expect(st.status).toBe('Linked');
    }).toPass({ timeout: 60_000, intervals: [2_000] });

    const roles = await owner.api.get('access-roles');
    rolesCatalog = { status: roles.status(), body: roles.status() === 200 ? await roles.json() : await roles.text() };
    await evidence('roles-catalog.json', rolesCatalog);

    writeSeed({
      today, month, weekday: weekday(today),
      owner: cacheOwner(owner),
      class7, class8, sections, kids,
      staff, parent: { phone: parent.phone, email: parent.email, password: parent.password, token: parent.token },
      childId,
      expectedActiveAbsent: expectedActiveAbsentNames(kids),
    });

    apis = { owner: owner.api };
    for (const k of Object.keys(staff)) apis[k] = await campusApi(staff[k].email, staff[k].password);
    apis.parent = await bearer(parent.token);
  });

  test.afterAll(async () => {
    await evidence('api-calls.json', calls);
    try { writeFileSync(path.join(SEED_DIR, 'api-calls-raw.json'), JSON.stringify(calls, null, 2), { mode: 0o600 }); } catch { /* */ }
    for (const api of Object.values(apis || {})) {
      if (api && api !== owner?.api) await api.dispose().catch(() => undefined);
    }
  });

  test('1. no-role staff: main returns 200 with absentToday null and no students key; absences 403', async () => {
    const main = record('noRole', await getJson(apis.noRole, 'dashboard/main'));
    const abs = record('noRole', await getJson(apis.noRole, 'dashboard/absences', { month }));
    await evidence('check-1-norole.json', { main, absences: abs, hasStudentsKey: hasKey(main.body, 'students') });

    expect(main.status, `main: ${JSON.stringify(redact(main.body)).slice(0, 400)}`).toBe(200);
    expect(main.body?.absentToday ?? main.body?.AbsentToday ?? null, 'absentToday must be null without See').toBeNull();
    expect(hasKey(main.body, 'students'), 'no students key anywhere in /dashboard/main').toBe(false);
    expect(abs.status, `absences: ${JSON.stringify(redact(abs.body)).slice(0, 400)}`).toBe(403);
  });

  test('2. Attendance See: count equals active Absent students today; struck-off and archived excluded', async () => {
    // Independent count from the registers (owner has See + the raw marks).
    const expected = expectedActiveAbsentNames(kids);
    const registerAbsents: Array<{ id: string; name: string; section: string; status: number }> = [];
    for (const s of sections) {
      const reg = await f.ok(await owner.api.get('attendance-register/today', { params: { sectionId: s.sectionId, date: today } }), `recount ${s.sectionName}`);
      for (const st of reg.students) {
        const k = kids.find(x => x.id === st.studentId);
        registerAbsents.push({ id: st.studentId, name: st.studentName, section: s.sectionName, status: st.status });
        if (k && k.fate !== 'active') {
          // Struck-off / archived pupils may or may not remain on the register; the dashboard count must still exclude them.
        }
      }
    }

    const main = record('teacher', await getJson(apis.teacher, 'dashboard/main'));
    const body = main.body;
    const absentToday = body?.absentToday ?? body?.AbsentToday;
    await evidence('check-2-count.json', {
      today, weekday: weekday(today),
      expectedCount: expected.length, expectedNames: expected.map(initials),
      registerAbsents: redact(registerAbsents),
      mainStatus: main.status,
      absentToday,
      hasStudentsKey: hasKey(body, 'students'),
      note: `Today is ${weekday(today)} ${today} PKT. A non-working day would return count 0; this run records whatever the campus calendar does.`,
    });

    expect(main.status).toBe(200);
    expect(absentToday, 'absentToday present for See').toBeTruthy();
    expect(hasKey(body, 'students'), 'See token also must not receive a students list on /main').toBe(false);
    expect(Object.keys(absentToday).sort()).toEqual(['count']);
    if (absentToday.count === 0 && expected.length > 0) {
      // Non-working day: the repository returns 0. Record it; do not treat as a product fail if Saturday/Sunday is off.
      await evidence('check-2-non-working-day.json', { today, weekday: weekday(today), expected: expected.length, got: 0 });
    }
    expect(absentToday.count, `count should equal ${expected.length} active absents (excluded struck-off Esha and archived Hiba)`).toBe(expected.length);
  });

  test('3. absences filters: sectionId, classId, mismatch/unknown empty, no filter campus-wide', async () => {
    const sec7A = sections.find(s => s.classId === class7)!;
    const sec8A = sections.find(s => s.classId === class8 && s.sectionName.endsWith('A'))!;
    const sec8B = sections.find(s => s.classId === class8 && s.sectionName.endsWith('B'))!;
    const unknown = randomUUID();

    const namesOn = (body: any) => {
      const days = body?.days ?? body?.Days ?? [];
      const todayDay = days.find((d: any) => (d.date ?? d.Date) === today || String(d.date ?? d.Date).startsWith(today));
      const students = todayDay?.students ?? todayDay?.Students ?? [];
      return students.map((st: any) => ({
        name: st.name ?? st.Name,
        className: st.className ?? st.ClassName,
        sectionName: st.sectionName ?? st.SectionName,
        sectionId: st.sectionId ?? st.SectionId,
      }));
    };
    const dayCount = (body: any) => {
      const days = body?.days ?? body?.Days ?? [];
      const todayDay = days.find((d: any) => (d.date ?? d.Date) === today || String(d.date ?? d.Date).startsWith(today));
      return todayDay?.absentCount ?? todayDay?.AbsentCount ?? (todayDay ? (todayDay.students ?? todayDay.Students ?? []).length : 0);
    };

    const unfiltered = record('teacher', await getJson(apis.teacher, 'dashboard/absences', { month }));
    const bySection7 = record('teacher', await getJson(apis.teacher, 'dashboard/absences', { month, sectionId: sec7A.sectionId }));
    const byClass8 = record('teacher', await getJson(apis.teacher, 'dashboard/absences', { month, classId: class8 }));
    const bySection8B = record('teacher', await getJson(apis.teacher, 'dashboard/absences', { month, sectionId: sec8B.sectionId }));
    const mismatch = record('teacher', await getJson(apis.teacher, 'dashboard/absences', { month, classId: class7, sectionId: sec8A.sectionId }));
    const unknownClass = record('teacher', await getJson(apis.teacher, 'dashboard/absences', { month, classId: unknown }));
    const unknownSection = record('teacher', await getJson(apis.teacher, 'dashboard/absences', { month, sectionId: unknown }));

    const out = {
      unfiltered: { status: unfiltered.status, todayCount: dayCount(unfiltered.body), students: namesOn(unfiltered.body) },
      section7A: { status: bySection7.status, todayCount: dayCount(bySection7.body), students: namesOn(bySection7.body) },
      class8: { status: byClass8.status, todayCount: dayCount(byClass8.body), students: namesOn(byClass8.body) },
      section8B: { status: bySection8B.status, todayCount: dayCount(bySection8B.body), students: namesOn(bySection8B.body) },
      mismatch: { status: mismatch.status, days: (mismatch.body?.days ?? mismatch.body?.Days ?? []).length, todayStudents: namesOn(mismatch.body) },
      unknownClass: { status: unknownClass.status, days: (unknownClass.body?.days ?? unknownClass.body?.Days ?? []).length, todayStudents: namesOn(unknownClass.body) },
      unknownSection: { status: unknownSection.status, days: (unknownSection.body?.days ?? unknownSection.body?.Days ?? []).length, todayStudents: namesOn(unknownSection.body) },
    };
    await evidence('check-3-filters.json', out);

    for (const c of [unfiltered, bySection7, byClass8, bySection8B, mismatch, unknownClass, unknownSection]) {
      expect(c.status, c.path).toBe(200);
    }

    const sec7Names = namesOn(bySection7.body);
    expect(sec7Names.length, 'section 7 A should return that section only').toBeGreaterThan(0);
    expect(sec7Names.every((s: any) => s.sectionId === sec7A.sectionId || /7/.test(s.className)), 'sectionId filter leaked another section').toBe(true);
    expect(sec7Names.some((s: any) => /8/.test(s.className)), 'section 7 A must not include Class 8').toBe(false);

    const class8Names = namesOn(byClass8.body);
    expect(class8Names.length, 'class 8 should return that class only').toBeGreaterThan(0);
    expect(class8Names.every((s: any) => /8/.test(s.className) || s.sectionId === sec8A.sectionId || s.sectionId === sec8B.sectionId)).toBe(true);
    expect(class8Names.some((s: any) => /7/.test(s.className)), 'classId=8 must not include Class 7').toBe(false);

    const sec8BNames = namesOn(bySection8B.body);
    expect(sec8BNames.every((s: any) => s.sectionId === sec8B.sectionId || String(s.sectionName).toUpperCase().includes('B'))).toBe(true);
    expect(sec8BNames.some((s: any) => s.sectionId === sec8A.sectionId)).toBe(false);

    expect(namesOn(mismatch.body), 'mismatched classId+sectionId should be empty today').toEqual([]);
    expect(namesOn(unknownClass.body), 'unknown classId should be empty today').toEqual([]);
    expect(namesOn(unknownSection.body), 'unknown sectionId should be empty today').toEqual([]);

    // No filter is campus-wide (the pre-fix behaviour, minus archive exclusions). Must include both classes.
    const allNames = namesOn(unfiltered.body);
    expect(allNames.some((s: any) => /7/.test(s.className))).toBe(true);
    expect(allNames.some((s: any) => /8/.test(s.className))).toBe(true);
    // Archived Hiba must not appear. Struck-off Esha is excluded from /main; record whether /absences still lists her.
    expect(allNames.some((s: any) => String(s.name).toLowerCase().startsWith('hiba'))).toBe(false);
  });

  test('4. Family token: 403 on absences; main returns nothing useful', async () => {
    const main = record('parent', await getJson(apis.parent, 'dashboard/main'));
    const abs = record('parent', await getJson(apis.parent, 'dashboard/absences', { month }));
    const absentToday = main.body?.absentToday ?? main.body?.AbsentToday ?? null;
    const strength = main.body?.totalStrength ?? main.body?.TotalStrength;
    await evidence('check-4-family.json', { main, absences: abs, hasStudentsKey: hasKey(main.body, 'students') });

    expect(abs.status, `family absences: ${JSON.stringify(redact(abs.body)).slice(0, 400)}`).toBe(403);
    expect(hasKey(main.body, 'students'), 'family /main must not contain a students list').toBe(false);
    // Family tenant is not the campus, and the token has no Attendance See.
    if (main.status === 200) {
      expect(absentToday, 'family /main absentToday should be null (no See)').toBeNull();
      const strengthCount = strength?.count ?? strength?.Count ?? null;
      if (strengthCount !== null) expect(strengthCount, 'family /main should not show the campus roll').toBe(0);
    }
  });

  test('5. role matrix: no-role, Teacher, Accountant, parent, Head Admin', async () => {
    const roles = ['noRole', 'teacher', 'accountant', 'headAdmin', 'parent'] as const;
    for (const role of roles) {
      const main = record(role, await getJson(apis[role], 'dashboard/main'));
      const abs = record(role, await getJson(apis[role], 'dashboard/absences', { month }));
      const absentToday = main.body?.absentToday ?? main.body?.AbsentToday ?? null;
      const hasSee = abs.status === 200;
      matrix.push({
        role: role === 'noRole' ? 'staff with no roles' : role,
        assignedRole: role === 'noRole' ? '(none)' : role === 'parent' ? 'Family' : staff[role]?.role ?? role,
        attendanceSee: hasSee,
        mainStatus: main.status,
        absentToday,
        mainHasStudentsKey: hasKey(main.body, 'students'),
        absencesStatus: abs.status,
        absencesTodayCount: hasSee ? ((main.body && 0) , (abs.body?.days ?? abs.body?.Days ?? []).find((d: any) => String(d.date ?? d.Date).startsWith(today))?.absentCount
          ?? (abs.body?.days ?? abs.body?.Days ?? []).find((d: any) => String(d.date ?? d.Date).startsWith(today))?.AbsentCount
          ?? null) : null,
      });
    }
    await evidence('check-5-role-matrix.json', { today, weekday: weekday(today), expectedActiveAbsentCount: expectedActiveAbsentNames(kids).length, matrix });

    const byRole = Object.fromEntries(matrix.map(r => [String(r.role).toLowerCase().includes('no role') ? 'noRole' : String(r.role), r]));
    expect(byRole.noRole.attendanceSee).toBe(false);
    expect(byRole.noRole.mainStatus).toBe(200);
    expect(byRole.noRole.absentToday).toBeNull();
    expect(byRole.noRole.mainHasStudentsKey).toBe(false);
    expect(byRole.noRole.absencesStatus).toBe(403);

    for (const r of ['teacher', 'accountant', 'headAdmin']) {
      expect(byRole[r].attendanceSee, `${r} should have Attendance See`).toBe(true);
      expect(byRole[r].mainStatus).toBe(200);
      expect(byRole[r].absentToday).toEqual({ count: expectedActiveAbsentNames(kids).length });
      expect(byRole[r].mainHasStudentsKey).toBe(false);
      expect(byRole[r].absencesStatus).toBe(200);
    }

    expect(byRole.parent.attendanceSee).toBe(false);
    expect(byRole.parent.absencesStatus).toBe(403);
    expect(byRole.parent.mainHasStudentsKey).toBe(false);
  });

  test('6. UI: no-role dash on Absent Today; admin unchanged aside from the removed list; parent app unaffected', async ({ browser }) => {
    const shot = async (page: Page, name: string) => {
      mkdirSync(EV, { recursive: true });
      await page.screenshot({ path: path.join(EV, name), fullPage: true });
    };
    const ui: any[] = [];
    const creds: Array<{ key: string; identifier: string; password: string; expectDash: boolean }> = [
      { key: 'noRole', identifier: staff.noRole.email, password: staff.noRole.password, expectDash: true },
      { key: 'teacher', identifier: staff.teacher.email, password: staff.teacher.password, expectDash: false },
      { key: 'accountant', identifier: staff.accountant.email, password: staff.accountant.password, expectDash: false },
      { key: 'headAdmin', identifier: staff.headAdmin.email, password: staff.headAdmin.password, expectDash: false },
    ];

    for (const c of creds) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors, baseURL: process.env.QA_BASE_URL, timezoneId: 'Asia/Karachi', viewport: { width: 1440, height: 1024 } });
      const page = await ctx.newPage();
      const seen: any[] = [];
      page.on('response', async (r) => {
        if (/\/dashboard\//.test(r.url())) {
          let body: any = null;
          try { body = await r.json(); } catch { /* */ }
          seen.push({ method: r.request().method(), url: new URL(r.url()).pathname + new URL(r.url()).search, status: r.status(), body });
        }
      });
      await signInToWebApp(page, { identifier: c.identifier, password: c.password });
      await page.goto('/');
      await page.waitForTimeout(6000);
      await shot(page, `ui-home-${c.key}.png`);
      const tile = page.locator('[data-home-tile="absent"]');
      await expect(tile, `absent tile visible for ${c.key}`).toBeVisible();
      const tileText = (await tile.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const pageText = await page.locator('body').innerText();
      const leakedNames = kids.filter(k => k.markedAbsent && k.fate === 'active').filter(k => pageText.includes(k.name));
      const leakedPhotos = await page.locator('img[src*="profile"], img[src*="uploads"], img[src*="/files/"]').count().catch(() => 0);
      const chip = page.locator(`[data-home-absent="${today}"]`).first();
      let popover = '';
      if (await chip.count()) {
        await chip.hover();
        await page.waitForTimeout(800);
        await shot(page, `ui-home-${c.key}-absent-popover.png`);
        popover = (await page.locator('[role="dialog"], [role="tooltip"], .popover-panel').allInnerTexts().catch(() => [])).join(' | ');
      }
      ui.push({ role: c.key, tileText, expectDash: c.expectDash, leakedNames: leakedNames.map(k => initials(k.name)), leakedPhotos, todayChip: await chip.count(), popover: popover ? 'present' : '', calls: seen });
      if (c.expectDash) {
        expect(tileText, `no-role tile should show a dash, got "${tileText}"`).toContain(DASH);
        expect(leakedNames, 'no-role Home must not show absent student names').toEqual([]);
      } else {
        expect(tileText, `See role tile should show the count, got "${tileText}"`).toMatch(new RegExp(String(expectedActiveAbsentNames(kids).length)));
      }
      // /dashboard/main responses in the UI must never carry a students list.
      for (const call of seen.filter(s => /\/dashboard\/main/.test(s.url))) {
        expect(hasKey(call.body, 'students'), `${c.key} UI /dashboard/main has a students key`).toBe(false);
      }
      await ctx.close();
    }

    // Parent: Family App home should load and must not fetch campus absentee lists.
    {
      const ctx = await browser.newContext({ ignoreHTTPSErrors, baseURL: process.env.QA_FAMILY_URL, timezoneId: 'Asia/Karachi', viewport: { width: 1440, height: 1024 } });
      const page = await ctx.newPage();
      const seen: any[] = [];
      page.on('response', async (r) => {
        const u = new URL(r.url());
        if (u.pathname.includes('/dashboard') || u.pathname.includes('absent')) {
          let body: any = null;
          try { body = await r.json(); } catch { /* */ }
          seen.push({ method: r.request().method(), url: u.pathname + u.search, status: r.status(), body });
        }
      });
      await page.goto('/');
      await new LoginPage(page).signIn(parent.email, parent.password);
      await page.waitForTimeout(8000);
      await shot(page, 'ui-family-home-parent.png');
      const familyText = await page.locator('body').innerText().catch(() => '');
      const leaked = kids.filter(k => k.markedAbsent && k.fate === 'active' && k.name !== kids.find(x => x.id === childId)?.name)
        .filter(k => familyText.includes(k.name));
      ui.push({ role: 'parent (Family App)', url: page.url(), dashboardCalls: seen, leakedOtherAbsents: leaked.map(k => initials(k.name)) });
      expect(page.url(), 'Family App should stay on the family origin').toContain(new URL(process.env.QA_FAMILY_URL!).host);
      expect(leaked, 'Family App must not list other campus absentees').toEqual([]);
      await ctx.close();
    }

    // Parent on the campus WebApp (previously sent to /subscription/plan).
    {
      const ctx = await browser.newContext({ ignoreHTTPSErrors, baseURL: process.env.QA_BASE_URL, timezoneId: 'Asia/Karachi', viewport: { width: 1440, height: 1024 } });
      const page = await ctx.newPage();
      const seen: any[] = [];
      page.on('response', async (r) => {
        if (/\/dashboard\//.test(r.url())) seen.push({ url: new URL(r.url()).pathname, status: r.status() });
      });
      await page.goto('/');
      try {
        await new LoginPage(page).signIn(parent.email, parent.password);
      } catch (e) {
        seen.push({ note: `login: ${(e as Error).message.split('\n')[0]}` });
      }
      await page.waitForTimeout(8000);
      await shot(page, 'ui-webapp-parent.png');
      ui.push({ role: 'parent (campus WebApp)', url: page.url(), calls: seen });
      await ctx.close();
    }

    await evidence('check-6-ui.json', ui);
    try { writeFileSync(path.join(SEED_DIR, 'ui-network-raw.json'), JSON.stringify(ui, null, 2), { mode: 0o600 }); } catch { /* */ }
  });

  test('7. no other endpoint returns an absentee student list to no-role staff', async () => {
    const sec = sections[0];
    const paths: Array<{ path: string; params?: Record<string, string> }> = [
      { path: 'dashboard/main' },
      { path: 'dashboard/absences', params: { month } },
      { path: 'dashboard/exams', params: { month } },
      { path: 'attendance-register/sections' },
      { path: 'attendance-register/today', params: { sectionId: sec.sectionId, date: today } },
      { path: 'students' },
    ];
    const out = [];
    const leaked: typeof out = [];
    const names = expectedActiveAbsentNames(kids);
    for (const p of paths) {
      const call = record('noRole-sweep', await getJson(apis.noRole, p.path, p.params));
      const bodyText = typeof call.body === 'string' ? call.body : JSON.stringify(call.body ?? '');
      const named = names.filter(n => bodyText.includes(n));
      const studentsKey = hasKey(call.body, 'students');
      const row = { path: call.path, status: call.status, studentsKey, named: named.map(initials), body: call.body };
      out.push(row);
      // 200 + our absent pupils' names, or a students[] of absentees, is a leak.
      if (call.status === 200 && (named.length > 0 || (studentsKey && p.path.startsWith('dashboard')))) leaked.push(row);
    }
    await evidence('check-7-endpoint-sweep.json', { leaked, out });
    expect(leaked, `no-role staff still received absentee lists: ${JSON.stringify(redact(leaked)).slice(0, 800)}`).toEqual([]);
  });
});
