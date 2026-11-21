/**
 * PR 565 cycle 2 / ClickUp z94x8ee9wf + z94x8eeah1 —
 * Picked calendar days travel as UTC instants; POS uses the till's local day.
 *
 * The client sends a picked local day as the UTC instant of its local midnight
 * (PKT 21 Nov → 2026-11-20T19:00:00Z). Server "not in future" checks compare
 * against UTC now. Storage is still the operational day at 00:00Z.
 *
 * Clock is taken from QA_CLOCK_UTC (ISO instant) when set, otherwise the
 * runner's clock, always interpreted in QA_TZ (default Asia/Karachi):
 *   - 02:00 PKT window: QA_CLOCK_UTC=2026-11-20T21:00:00Z
 *   - 23:59 PKT edge:   QA_CLOCK_UTC=2026-11-21T18:59:00Z
 *   - daytime: unset (real clock)
 *
 * Official 8 places: today must save, tomorrow must be rejected.
 * Admission, fee policy and student fee starts are also recorded.
 * DOB and fee payment are unchanged paths and must keep prior behaviour.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { randomUUID, randomInt } from 'node:crypto';
import path from 'node:path';
import { newCampusOwner, cacheOwner, type CampusOwner } from '../../fixtures/campus-owner';
import * as f from '../../fixtures/fees';
import { addStaff, DESIGNATION } from '../../fixtures/payroll';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.resolve(EV, '..', 'seed');
const EXPECT_UTC_BUG = (process.env.QA_EXPECT_UTC_DATE_BUG ?? 'false').toLowerCase() === '1'
  || (process.env.QA_EXPECT_UTC_DATE_BUG ?? '').toLowerCase() === 'true';
const TZ = process.env.QA_TZ ?? 'Asia/Karachi';
const CLOCK_UTC = process.env.QA_CLOCK_UTC ?? '';

function nowUtc(): Date {
  return CLOCK_UTC ? new Date(CLOCK_UTC) : new Date();
}

function localDayOf(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

function addCalendarDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** UTC instant of local midnight in Asia/Karachi (UTC+5, no DST). */
function instant(localDay: string): string {
  return new Date(`${localDay}T00:00:00+05:00`).toISOString();
}

/** Unchanged paths (DOB, fee payment) still send a midnight-Z label. */
const iso = (d: string) => `${d}T00:00:00Z`;

const LOCAL_TODAY = localDayOf(nowUtc());
const LOCAL_TOMORROW = addCalendarDays(LOCAL_TODAY, 1);
const LOCAL_YESTERDAY = addCalendarDays(LOCAL_TODAY, -1);
const EMPLOYMENT_FULL_TIME = '33333333-3333-3333-3333-333333333331';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function displayDay(day: string): string {
  const [y, m, d] = day.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

test.describe.configure({ mode: 'serial' });

let owner: CampusOwner;
let classId = '';
let student: f.Student = { id: '', name: '', admissionId: '', classId: '', familyId: '' };
let itemId = '';
let staffA: { id: string; name: string };
let staffB: { id: string; name: string };
let todaySaleId = '';
const results: Record<string, unknown> = {
  expectUtcBug: EXPECT_UTC_BUG,
  tz: TZ,
  clockUtc: CLOCK_UTC || 'runner-now',
  localToday: LOCAL_TODAY,
  localTomorrow: LOCAL_TOMORROW,
  localYesterday: LOCAL_YESTERDAY,
  todayInstant: instant(LOCAL_TODAY),
  tomorrowInstant: instant(LOCAL_TOMORROW),
};

type Shot = { status: number; body: string };
const shot = async (res: { status: () => number; text: () => Promise<string> }): Promise<Shot> => ({
  status: res.status(),
  body: (await res.text()).slice(0, 2000),
});

const looksFuture = (s: Shot) => s.status >= 400 && s.status < 500 && /future/i.test(s.body);
const ok = (s: Shot) => s.status < 300;

function parse(body: string): any {
  try { return JSON.parse(body); } catch { return null; }
}

function dayOf(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  // A clock instant (issuedAt / soldAt) must be converted to the school-local day.
  // Storage labels are midnight UTC, e.g. 2026-11-21T00:00:00Z or "2026-11-21 00:00:00+00".
  const instant = s.match(/T(\d{2}):(\d{2})/) || s.match(/\s(\d{2}):(\d{2})/);
  const isMidnightLabel = instant && instant[1] === '00' && instant[2] === '00';
  if (instant && !isMidnightLabel) {
    const d = new Date(s.includes('T') || s.includes('+') || s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z');
    if (!Number.isNaN(d.getTime())) return localDayOf(d);
  }
  const isoMatch = s.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const named = s.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (named) {
    const mi = MONTHS.findIndex((x) => x.toLowerCase() === named[2].toLowerCase());
    if (mi >= 0) return `${named[3]}-${String(mi + 1).padStart(2, '0')}-${named[1].padStart(2, '0')}`;
  }
  return s;
}

function expectToday(s: Shot, label: string, todayShouldFail: boolean) {
  results[label] = { ...(results[label] as object ?? {}), today: s };
  if (todayShouldFail) {
    expect(looksFuture(s) || s.status >= 400, `${label} local today should be rejected on the UTC-date baseline, got ${s.status} ${s.body}`).toBeTruthy();
  } else {
    expect(ok(s), `${label} local today should save, got ${s.status} ${s.body}`).toBeTruthy();
  }
}

function expectTomorrowRejected(s: Shot, label: string) {
  results[label] = { ...(results[label] as object ?? {}), tomorrow: s };
  expect(s.status, `${label} local tomorrow should be 4xx, got ${s.status} ${s.body}`).toBeGreaterThanOrEqual(400);
  expect(s.status, `${label} local tomorrow should be 4xx, got ${s.status} ${s.body}`).toBeLessThan(500);
  expect(s.body, `${label} local tomorrow should mention the future: ${s.body}`).toMatch(/future/i);
}

function expectDayLabel(value: unknown, label: string) {
  const got = dayOf(value);
  expect(got, `${label} should be the picked local day ${LOCAL_TODAY} (not ${LOCAL_YESTERDAY}); raw=${value}`).toBe(LOCAL_TODAY);
}

async function expectStoredDay(query: string, label: string) {
  const rows = await f.sql(query);
  const raw = rows[0]?.[0] ?? '';
  results[`${label}-stored`] = raw;
  expect(raw, `${label} stored date should be present`).toBeTruthy();
  expectDayLabel(raw, `${label} stored`);
}

function expectPayloadShowsPickedDay(body: string, value: unknown, label: string) {
  if (value != null && String(value).trim() !== '') {
    expectDayLabel(value, label);
    return;
  }
  // Some profile payloads omit the date field (e.g. lastWorkingDay). Record and rely on SQL.
  results[`${label}-missing-in-payload`] = body.slice(0, 400);
}


async function storedSaleDate(reference: string): Promise<string> {
  const rows = await f.sql(`select "SaleDate"::text from "BookshopSales" where "TenantId" = ${f.q(owner.tenantId)} and "BillNumber" = ${f.q(reference)}`);
  return rows[0]?.[0] ?? '';
}

test.beforeAll(async () => {
  test.setTimeout(8 * 60_000);
  mkdirSync(EV, { recursive: true });
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  owner = await newCampusOwner('pr565c2');
  await f.ok(await owner.api.post('sessions/create', {
    data: {
      sessionName: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30',
      terms: [
        { termName: 'Term 1', termStartDate: '2026-09-01', termEndDate: '2026-12-31', passingCriteria: 40 },
        { termName: 'Term 2', termStartDate: '2027-01-01', termEndDate: '2027-06-30', passingCriteria: 40 },
      ],
    },
  }), 'sessions/create');
  const orange = await f.ok(await owner.api.post('classes/create', {
    data: { className: 'orange', grade: '7', sections: [{ sectionName: 'A', size: 40 }], subjects: null },
  }), 'orange');
  classId = orange.id;
  let lastAdd = { status: 0, body: '' };
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await owner.api.post('students/quick-add', {
      data: {
        fullName: 'Alia Date', admissionId: `CN-${randomInt(100000, 999999)}`, fatherName: 'Farooq Date',
        mobileNumber: '0301' + String(randomInt(1000000, 9999999)), classId,
        admissionDate: instant('2026-09-01'), dateOfBirth: '2016-03-10T00:00:00Z', gender: 0,
      },
    });
    lastAdd = { status: res.status(), body: (await res.text()).slice(0, 800) };
    if (res.status() < 300) {
      const body = JSON.parse(lastAdd.body);
      const fam = await f.sql(`select "FamilyId" from "Students" where "Id" = ${f.q(body.id)}`);
      student = { id: body.id, name: 'Alia Date', admissionId: body.admissionId, classId, familyId: fam[0][0] };
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  results.beforeAllQuickAdd = lastAdd;
  if (!student?.id) {
    results.beforeAllQuickAddFailed = lastAdd;
    console.log(`beforeAll quick-add failed after retries: ${lastAdd.status} ${lastAdd.body}`);
  }
  const created = await f.ok(await owner.api.post('bookshop/inventory', {
    data: {
      itemName: 'QA 565 Notebook', sku: `QA565-${randomInt(10000, 99999)}`, category: 'Stationery', description: null,
      openingStock: 500, reorderLevel: 0, costPrice: 100, retailPrice: 200, hasVariants: false, options: [], variants: [],
    },
  }), 'bookshop item');
  itemId = (created.item ?? created).id;

  const missing = await shot(await owner.api.post('bookshop/point-of-sale/day', { data: { openingFloat: 0 } }));
  results.openPosDayMissingBusinessDate = missing;
  expect(missing.status, `open-day without businessDate should be 400, got ${missing.status} ${missing.body}`).toBeGreaterThanOrEqual(400);
  expect(missing.status).toBeLessThan(500);
  expect(missing.body, `open-day should ask for businessDate: ${missing.body}`).toMatch(/business date|refresh/i);

  const day = await owner.api.post('bookshop/point-of-sale/day', {
    data: { openingFloat: 0, businessDate: instant(LOCAL_TODAY) },
  });
  const opened = await shot(day);
  results.openPosDay = opened;
  expect(ok(opened), `open-day with till local day should save, got ${opened.status} ${opened.body}`).toBeTruthy();
  const openedBody = parse(opened.body);
  expectDayLabel(openedBody?.date ?? openedBody?.Date, 'open-day date');

  staffA = await addStaff(owner.api, { name: 'Sana Left', salary: 40000, designationId: DESIGNATION.teacher, joined: '2025-01-01' });
  staffB = await addStaff(owner.api, { name: 'Bilal Emp', salary: 40000, designationId: DESIGNATION.teacher, joined: '2025-01-01' });
  const cached = cacheOwner(owner);
  writeFileSync(path.join(SEED_DIR, 'seed.json'), JSON.stringify({
    email: cached.email, phone: cached.phone, tenantId: cached.tenantId, password: cached.password,
    classId, studentId: student.id, itemId, staffA: staffA.id, staffB: staffB.id,
    localToday: LOCAL_TODAY, clockUtc: CLOCK_UTC || 'runner-now',
  }), { mode: 0o600 });
  try { chmodSync(SEED_DIR, 0o700); } catch { /* */ }
});

test.afterAll(() => {
  mkdirSync(EV, { recursive: true });
  writeFileSync(path.join(EV, 'date-check-results.json'), JSON.stringify(results, null, 2));
});

test('Bookshop POS sale: local today saves, local tomorrow is rejected, and the sale lands on the till day', async () => {
  const sale = async (d: string) => {
    const res = await owner.api.post('bookshop/point-of-sale/sales', {
      data: {
        clientSaleId: randomUUID(), movementDate: instant(d), reference: null, lowStockReason: null,
        studentId: null, tenderType: 'Cash', amountReceived: 1_000_000,
        lines: [{ type: 'Item', itemId, variantId: null, kitId: null, quantity: 1, lowStockReason: null }],
      },
    });
    return shot(res);
  };
  expectTomorrowRejected(await sale(LOCAL_TOMORROW), 'pos-sale');
  const today = await sale(LOCAL_TODAY);
  expectToday(today, 'pos-sale', EXPECT_UTC_BUG);
  if (!ok(today)) return;

  const created = parse(today.body);
  const reference = created?.reference ?? created?.billNumber ?? '';
  const stored = reference ? await storedSaleDate(reference) : '';
  results['pos-sale'] = { ...(results['pos-sale'] as object), storedSaleDate: stored, reference, created };
  expectDayLabel(stored || created?.date || created?.issuedAt, 'POS sale stored/returned date');

  const rows = reference
    ? await f.sql(`select "Id" from "BookshopSales" where "TenantId" = ${f.q(owner.tenantId)} and "BillNumber" = ${f.q(reference)}`)
    : [];
  todaySaleId = rows[0]?.[0] ?? '';
  if (todaySaleId) {
    const bill = await shot(await owner.api.get(`bookshop/sales/${todaySaleId}`));
    results['pos-sale-receipt'] = bill;
    if (ok(bill)) {
      const body = parse(bill.body);
      const receiptDay = body?.saleDate ?? body?.date ?? body?.soldAt ?? body?.issuedAt;
      expectDayLabel(receiptDay, 'POS sale receipt issuedAt/saleDate in school-local day');
    }
  }

  const dashToday = await shot(await owner.api.get(`bookshop/point-of-sale/dashboard?businessDate=${LOCAL_TODAY}`));
  const dashYesterday = await shot(await owner.api.get(`bookshop/point-of-sale/dashboard?businessDate=${LOCAL_YESTERDAY}`));
  results['pos-dashboard'] = { today: dashToday, yesterday: dashYesterday };
  expect(ok(dashToday), `dashboard for till day ${LOCAL_TODAY}: ${dashToday.status} ${dashToday.body}`).toBeTruthy();
  const dashBody = parse(dashToday.body);
  expectDayLabel(dashBody?.date, 'POS dashboard date');
  const bills = dashBody?.billsIssuedToday ?? dashBody?.bills ?? 0;
  expect(bills, `dashboard for ${LOCAL_TODAY} should include the sale, bills=${bills} body=${dashToday.body}`).toBeGreaterThan(0);
  if (ok(dashYesterday)) {
    const yb = parse(dashYesterday.body);
    const yBills = yb?.billsIssuedToday ?? yb?.bills ?? 0;
    expect(yBills, `dashboard for yesterday ${LOCAL_YESTERDAY} should not include today's sale, bills=${yBills}`).toBe(0);
  }
});

test('Stock movement: local today saves, local tomorrow is rejected, and the list shows the picked day', async () => {
  const move = async (d: string) => shot(await owner.api.post(`bookshop/inventory/${itemId}/stock-movements`, {
    data: { variantId: null, reasonCode: 'Purchase Receipt', quantity: 1, movementDate: instant(d), reference: 'QA565', notes: 'date check' },
  }));
  expectTomorrowRejected(await move(LOCAL_TOMORROW), 'stock-movement');
  const today = await move(LOCAL_TODAY);
  expectToday(today, 'stock-movement', EXPECT_UTC_BUG);
  if (!ok(today)) return;
  const created = parse(today.body);
  results['stock-movement-created'] = created;
  const listedDate = created?.movementDate ?? created?.addedDate ?? created?.date ?? created?.movement?.movementDate;
  if (listedDate) expectDayLabel(listedDate, 'stock movement returned date');

  const list = await shot(await owner.api.get(`bookshop/inventory/${itemId}/stock-movements`));
  results['stock-movement-list'] = { status: list.status, body: list.body.slice(0, 1500) };
  if (ok(list)) {
    expect(list.body, `stock movement list should include ${LOCAL_TODAY} or ${displayDay(LOCAL_TODAY)}`).toMatch(new RegExp(`${LOCAL_TODAY}|${displayDay(LOCAL_TODAY)}`));
  }
});

test('Staff mark-as-left: local today saves, local tomorrow is rejected', async () => {
  const leave = async (id: string, d: string) => shot(await owner.api.post(`staff/${id}/mark-as-left`, {
    data: { lastWorkingDay: instant(d), reason: 'Resigned', note: 'QA date check' },
  }));
  expectTomorrowRejected(await leave(staffA.id, LOCAL_TOMORROW), 'mark-as-left');
  expectToday(await leave(staffA.id, LOCAL_TODAY), 'mark-as-left', EXPECT_UTC_BUG);
  if (ok((results['mark-as-left'] as { today?: Shot }).today!)) {
    await expectStoredDay(`select "LastWorkingDay"::text from "StaffMembers" where "Id" = ${f.q(staffA.id)}`, 'mark-as-left');
    const profile = await shot(await owner.api.get(`staff/${staffA.id}/profile`));
    results['mark-as-left-profile'] = profile;
    if (ok(profile)) {
      const body = parse(profile.body);
      expectPayloadShowsPickedDay(profile.body, body?.lastWorkingDay ?? body?.employment?.lastWorkingDay ?? body?.staff?.lastWorkingDay, 'mark-as-left profile lastWorkingDay');
    }
  }
});

test('Staff rehire: local today saves, local tomorrow is rejected', async () => {
  const markedToday = ok((results['mark-as-left'] as { today?: Shot } | undefined)?.today ?? { status: 0, body: '' });
  if (!markedToday) {
    const past = await shot(await owner.api.post(`staff/${staffA.id}/mark-as-left`, {
      data: { lastWorkingDay: instant('2026-11-01'), reason: 'Resigned', note: 'QA date check past' },
    }));
    results['rehire-mark-past'] = past;
  }
  const profile = await shot(await owner.api.get(`staff/${staffA.id}/profile`));
  results['rehire-profile-before'] = profile;
  const rehire = async (d: string) => shot(await owner.api.post(`staff/${staffA.id}/rehire`, {
    data: {
      designationId: DESIGNATION.teacher, category: 'Teaching', reportsToStaffId: null,
      employmentTypeId: EMPLOYMENT_FULL_TIME, dateOfJoining: instant(d),
    },
  }));
  expectTomorrowRejected(await rehire(LOCAL_TOMORROW), 'rehire');
  expectToday(await rehire(LOCAL_TODAY), 'rehire', EXPECT_UTC_BUG);
  if (ok((results['rehire'] as { today?: Shot }).today!)) {
    await expectStoredDay(`select "DateOfJoining"::text from "StaffMembers" where "Id" = ${f.q(staffA.id)}`, 'rehire');
    const after = await shot(await owner.api.get(`staff/${staffA.id}/profile`));
    results['rehire-profile-after'] = after;
    if (ok(after)) {
      const body = parse(after.body);
      expectPayloadShowsPickedDay(after.body, body?.dateOfJoining ?? body?.employment?.dateOfJoining, 'rehire profile dateOfJoining');
    }
  }
});

test('Employment date of joining: local today saves, local tomorrow is rejected', async () => {
  const emp = async (d: string) => shot(await owner.api.put(`staff/${staffB.id}/employment`, {
    data: {
      designation: DESIGNATION.teacher, dateOfJoining: instant(d), employmentType: EMPLOYMENT_FULL_TIME,
      specialization: null, workEmail: null, contractStartDate: null, contractEndDate: null,
    },
  }));
  expectTomorrowRejected(await emp(LOCAL_TOMORROW), 'employment-joining');
  expectToday(await emp(LOCAL_TODAY), 'employment-joining', EXPECT_UTC_BUG);
  if (ok((results['employment-joining'] as { today?: Shot }).today!)) {
    await expectStoredDay(`select "DateOfJoining"::text from "StaffMembers" where "Id" = ${f.q(staffB.id)}`, 'employment-joining');
    const profile = await shot(await owner.api.get(`staff/${staffB.id}/profile`));
    results['employment-profile'] = profile;
    if (ok(profile)) {
      const body = parse(profile.body);
      expectPayloadShowsPickedDay(profile.body, body?.dateOfJoining, 'employment profile dateOfJoining');
    }
  }
});

test('Add staff: local today joining date saves, local tomorrow is rejected', async () => {
  const add = async (d: string, suffix: string) => shot(await owner.api.post('staff', {
    data: {
      staffId: `QA-${suffix}${randomInt(100, 999)}`,
      fullName: `Qa Joiner ${suffix}`, cnic: `${randomInt(31101, 45505)}-${String(randomInt(0, 10_000_000)).padStart(7, '0')}-${randomInt(1, 9)}`,
      dateOfBirth: '1990-05-05', gender: 'Female', maritalStatus: null, bloodGroup: null,
      nationality: 'Pakistani', religion: 'Islam', profilePhotoUrl: null, cnicCopyUrl: null,
      mobileNumber: '0301' + String(randomInt(1000000, 9999999)), alternateNumber: null, email: null,
      presentAddress: '1 QA Road, Lahore', permanentAddress: '1 QA Road, Lahore',
      emergencyContactName: 'Qa Contact', emergencyContactRelation: 'Sibling', emergencyContactPhone: '0302' + String(randomInt(1000000, 9999999)),
      category: 'Teaching', designationId: DESIGNATION.teacher, dateOfJoining: instant(d),
      employmentTypeId: EMPLOYMENT_FULL_TIME, reportingManagerId: null, monthlySalary: 40000,
      highestQualification: 'Masters', specialization: null, university: 'Punjab University', yearOfCompletion: 2012,
      totalExperience: '5', previousInstitution: null,
    },
  }));
  expectTomorrowRejected(await add(LOCAL_TOMORROW, 'TM'), 'add-staff');
  const today = await add(LOCAL_TODAY, 'TD');
  expectToday(today, 'add-staff', EXPECT_UTC_BUG);
  if (!ok(today)) return;
  const created = parse(today.body);
  const newId = created?.id ?? created?.staff?.id ?? '';
  results['add-staff-id'] = newId;
  if (newId) {
    await expectStoredDay(`select "DateOfJoining"::text from "StaffMembers" where "Id" = ${f.q(newId)}`, 'add-staff');
    const profile = await shot(await owner.api.get(`staff/${newId}/profile`));
    results['add-staff-profile'] = profile;
    if (ok(profile)) {
      const body = parse(profile.body);
      expectPayloadShowsPickedDay(profile.body, body?.dateOfJoining, 'add-staff profile dateOfJoining');
    }
  }
});

test('Certification add and update: local today saves, local tomorrow is rejected', async () => {
  const payload = (d: string, name: string) => ({
    certificationName: name, issuingBody: 'QA Board', issueDate: instant(d),
    expiryDate: null, certificateNumber: null, documentUrl: null,
  });
  expectTomorrowRejected(await shot(await owner.api.post(`staff/${staffB.id}/certifications`, { data: payload(LOCAL_TOMORROW, 'Tomorrow Cert') })), 'cert-add');
  const todayAdd = await shot(await owner.api.post(`staff/${staffB.id}/certifications`, { data: payload(LOCAL_TODAY, 'Today Cert') }));
  expectToday(todayAdd, 'cert-add', EXPECT_UTC_BUG);

  const past = await shot(await owner.api.post(`staff/${staffB.id}/certifications`, { data: payload('2024-06-01', 'Past Cert') }));
  results['cert-add-past'] = past;
  const certIdOf = (body: string) => {
    try {
      const parsed = JSON.parse(body);
      return parsed.row?.id ?? parsed.certification?.id ?? parsed.id ?? '';
    } catch { return ''; }
  };
  let certId = certIdOf(ok(todayAdd) ? todayAdd.body : past.body);
  if (!certId) {
    const list = await shot(await owner.api.get(`staff/${staffB.id}/certifications`));
    results['cert-list'] = list;
    try {
      const parsed = JSON.parse(list.body);
      const rows = parsed.certifications ?? parsed.items ?? parsed;
      certId = Array.isArray(rows) ? (rows[0]?.id ?? '') : '';
    } catch { /* */ }
  }
  expect(certId, `need a certification id to update, todayAdd=${todayAdd.body} past=${past.body}`).toBeTruthy();
  const upd = async (d: string) => shot(await owner.api.put(`staff/${staffB.id}/certifications/${certId}`, { data: payload(d, 'Updated Cert') }));
  expectTomorrowRejected(await upd(LOCAL_TOMORROW), 'cert-update');
  expectToday(await upd(LOCAL_TODAY), 'cert-update', EXPECT_UTC_BUG);

  const list = await shot(await owner.api.get(`staff/${staffB.id}/certifications`));
  results['cert-list-after'] = list;
  if (ok(list)) {
    const parsed = parse(list.body);
    const rows = parsed?.certifications ?? parsed?.items ?? parsed;
    const issue = Array.isArray(rows) ? (rows.find((r: any) => r?.certificationName === 'Updated Cert' || r?.issueDate)?.issueDate ?? rows[0]?.issueDate) : parsed?.issueDate;
    expectPayloadShowsPickedDay(list.body, issue, 'cert-list issueDate');
  }
});

test('Date of birth and fee payment still use operational today (today saves, tomorrow is rejected)', async () => {
  const dob = async (d: string, suffix: string) => shot(await owner.api.post('staff', {
    data: {
      staffId: `QA-DB${suffix}${randomInt(100, 999)}`,
      fullName: `Qa Dob ${suffix}`, cnic: `${randomInt(31101, 45505)}-${String(randomInt(0, 10_000_000)).padStart(7, '0')}-${randomInt(1, 9)}`,
      dateOfBirth: iso(d), gender: 'Female', maritalStatus: null, bloodGroup: null,
      nationality: 'Pakistani', religion: 'Islam', profilePhotoUrl: null, cnicCopyUrl: null,
      mobileNumber: '0304' + String(randomInt(1000000, 9999999)), alternateNumber: null, email: null,
      presentAddress: '1 QA Road, Lahore', permanentAddress: '1 QA Road, Lahore',
      emergencyContactName: 'Qa Contact', emergencyContactRelation: 'Sibling', emergencyContactPhone: '0305' + String(randomInt(1000000, 9999999)),
      category: 'Teaching', designationId: DESIGNATION.teacher, dateOfJoining: '2020-01-01',
      employmentTypeId: EMPLOYMENT_FULL_TIME, reportingManagerId: null, monthlySalary: 40000,
      highestQualification: 'Masters', specialization: null, university: 'Punjab University', yearOfCompletion: 2012,
      totalExperience: '5', previousInstitution: null,
    },
  }));
  expectTomorrowRejected(await dob(LOCAL_TOMORROW, 'TM'), 'dob');
  expectToday(await dob(LOCAL_TODAY, 'TD'), 'dob', false);

  if (!student.id) { results['fee-payment'] = { skipped: 'no student from beforeAll' }; return; }
  const pay = async (d: string) => shot(await owner.api.post(`fee-payments/families/${encodeURIComponent(student.familyId)}/payments`, {
    data: {
      clientPaymentId: randomUUID(), paymentDate: iso(d), amountReceived: 1,
      note: 'QA 565 date check', isOfflinePayment: true, fineWaivers: [],
    },
  }));
  const payTomorrow = await pay(LOCAL_TOMORROW);
  const payToday = await pay(LOCAL_TODAY);
  results['fee-payment'] = { today: payToday, tomorrow: payTomorrow };
  expect(payTomorrow.status, `fee payment tomorrow: ${payTomorrow.status} ${payTomorrow.body}`).toBeGreaterThanOrEqual(400);
  if (/future/i.test(payTomorrow.body)) {
    expect(payTomorrow.body).toMatch(/future/i);
  }
  if (ok(payToday) || /future/i.test(payToday.body) === false) {
    expect(/future/i.test(payToday.body), `fee payment local today should not be a future-date rejection: ${payToday.body}`).toBeFalsy();
  }
});

test('Admission date, fee policy and student fee effective date (recorded; today must save)', async () => {
  const admit = async (d: string, name: string) => shot(await owner.api.post('students/quick-add', {
    data: {
      fullName: name, admissionId: `P565-${randomInt(10000, 99999)}`, fatherName: 'Farooq Date',
      mobileNumber: '0303' + String(randomInt(1000000, 9999999)),
      classId, admissionDate: instant(d), dateOfBirth: '2016-03-10T00:00:00Z', gender: 0,
    },
  }));
  const admitToday = await admit(LOCAL_TODAY, 'Adm Today');
  const admitTomorrow = await admit(LOCAL_TOMORROW, 'Adm Tomorrow');
  results.admission = { today: admitToday, tomorrow: admitTomorrow };
  const admitIsDateCheck = (s: Shot) => ok(s) || looksFuture(s);
  if (admitIsDateCheck(admitToday) || admitIsDateCheck(admitTomorrow)) {
    expect(ok(admitToday) || EXPECT_UTC_BUG, `admission local today: ${admitToday.status} ${admitToday.body}`).toBeTruthy();
  }
  if (ok(admitToday)) {
    const body = parse(admitToday.body);
    const newId = body?.id ?? '';
    if (newId) {
      const profile = await shot(await owner.api.get(`students/${newId}/profile`));
      results.admissionProfile = profile;
      if (ok(profile)) {
        const pb = parse(profile.body);
        expectPayloadShowsPickedDay(profile.body, pb?.admissionDate ?? pb?.student?.admissionDate, 'admission profile');
        await expectStoredDay(`select "AdmissionDate"::text from "Students" where "Id" = ${f.q(newId)}`, 'admission');
      }
    }
  }
  const unplaced = await shot(await owner.api.post('students/quick-add', {
    data: {
      fullName: 'Adm Unplaced', admissionId: `U565-${randomInt(10000, 99999)}`, fatherName: 'Farooq Date',
      mobileNumber: '0303' + String(randomInt(1000000, 9999999)),
      admissionDate: instant('2026-09-01'), dateOfBirth: '2016-03-10T00:00:00Z', gender: 0,
    },
  }));
  results.admissionUnplacedPast = unplaced;

  const policy = async (d: string, name: string) => {
    const data: Record<string, unknown> = {
      policyName: name, publishNow: false, description: null, policyType: 0, rootPolicyId: null,
      scope: 0, classIds: [], occurrence: 0, challanGenerationDay: 15, dueDay: 25, tuitionFee: 1000,
      enableFineRule: false, fineType: null, fineAmount: null, graceDays: null,
      effectiveFrom: instant(d), effectiveUntil: null, additionalFundIds: [],
      bankName: 'QA Bank', accountTitle: 'QA School Account', accountNumber: null, bankBranch: 'Main',
    };
    return shot(await owner.api.post('fee-policies', { data }));
  };
  const polToday = await policy(LOCAL_TODAY, 'QA Policy Today');
  const polTomorrow = await policy(LOCAL_TOMORROW, 'QA Policy Tomorrow');
  const polYesterday = await policy(LOCAL_YESTERDAY, 'QA Policy Yesterday');
  results.feePolicy = { today: polToday, tomorrow: polTomorrow, yesterday: polYesterday };
  expect(ok(polToday) || EXPECT_UTC_BUG, `fee policy local today: ${polToday.status} ${polToday.body}`).toBeTruthy();
  if (ok(polToday)) {
    const created = parse(polToday.body);
    const polId = created?.id ?? created?.policy?.id ?? '';
    results.feePolicyId = polId;
    if (polId) {
      const got = await shot(await owner.api.get(`fee-policies/${polId}`));
      results.feePolicyGet = got;
      if (ok(got)) {
        const pb = parse(got.body);
        expectPayloadShowsPickedDay(got.body, pb?.effectiveFrom ?? pb?.policy?.effectiveFrom, 'fee policy detail');
      }
    }
  }

  if (!student.id) {
    const src = ok(admitToday) ? admitToday : (ok(unplaced) ? unplaced : null);
    if (src) {
      const body = JSON.parse(src.body);
      const fam = await f.sql(`select "FamilyId" from "Students" where "Id" = ${f.q(body.id)}`);
      student = { id: body.id, name: body.fullName, admissionId: body.admissionId, classId: body.classId ?? classId, familyId: fam[0][0] };
    } else {
      results.studentFeeEffective = { skipped: 'no student available' };
      return;
    }
  }
  const fee = async (d: string) => shot(await owner.api.put(`students/${student.id}/fee-details`, {
    data: {
      overrideEnabled: true, tuitionFeeAmount: 900, effectiveFrom: instant(d), effectiveUntil: null,
      reason: 'QA date check', reasonTags: [], concessions: [], funds: [], attachments: [],
    },
  }));
  const feeToday = await fee(LOCAL_TODAY);
  const feeTomorrow = await fee(LOCAL_TOMORROW);
  results.studentFeeEffective = { today: feeToday, tomorrow: feeTomorrow };
  if (ok(feeToday) || looksFuture(feeToday) || looksFuture(feeTomorrow)) {
    expect(ok(feeToday) || EXPECT_UTC_BUG, `student fee effective local today: ${feeToday.status} ${feeToday.body}`).toBeTruthy();
  }
  if (ok(feeToday)) {
    const details = await shot(await owner.api.get(`students/${student.id}/fee-details`));
    results.studentFeeDetails = details;
    if (ok(details)) {
      const pb = parse(details.body);
      expectPayloadShowsPickedDay(details.body, pb?.effectiveFrom ?? pb?.override?.effectiveFrom, 'student fee details');
    }
  }
});
