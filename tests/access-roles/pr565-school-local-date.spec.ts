/**
 * PR 565 / ClickUp z94x8ee9wf (+ z94x8eeah1) — future-date checks use the school-local date, not UTC.
 *
 * Run with the API container clock shifted to 02:00 PKT / 21:00 UTC the previous day
 * (scripts/faketime.sh on). At that instant:
 *   school-local today  = 2026-11-21
 *   UTC today           = 2026-11-20
 *   school-local tomorrow = 2026-11-22
 *
 * On this PR: local today must save, local tomorrow must be rejected, in each of the
 * eight "not in the future" places. Admission, fee policy and student fee effective
 * date are also checked (their rules may differ; results are recorded).
 * Date of birth and fee payment already used operational today and must keep that behaviour.
 *
 * Set QA_EXPECT_UTC_DATE_BUG=1 on a main baseline at the same simulated instant:
 * the eight places should reject school-local today (they still compare against UTC).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { randomUUID, randomInt } from 'node:crypto';
import path from 'node:path';
import { newCampusOwner, cacheOwner, type CampusOwner } from '../../fixtures/campus-owner';
import * as f from '../../fixtures/fees';
import * as shop from '../../fixtures/bookshop';
import { addStaff, markLeft, DESIGNATION } from '../../fixtures/payroll';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.resolve(EV, '..', 'seed');
const EXPECT_UTC_BUG = (process.env.QA_EXPECT_UTC_DATE_BUG ?? 'false').toLowerCase() === '1'
  || (process.env.QA_EXPECT_UTC_DATE_BUG ?? '').toLowerCase() === 'true';

const LOCAL_TODAY = '2026-11-21';
const LOCAL_TOMORROW = '2026-11-22';
const UTC_TODAY = '2026-11-20';
const iso = (d: string) => `${d}T00:00:00Z`;
const EMPLOYMENT_FULL_TIME = '33333333-3333-3333-3333-333333333331';

test.describe.configure({ mode: 'serial' });

let owner: CampusOwner;
let classId = '';
let student: f.Student = { id: '', name: '', admissionId: '', classId: '', familyId: '' };
let itemId = '';
let staffA: { id: string; name: string };
let staffB: { id: string; name: string };
const results: Record<string, unknown> = { expectUtcBug: EXPECT_UTC_BUG, localToday: LOCAL_TODAY, localTomorrow: LOCAL_TOMORROW, utcToday: UTC_TODAY };

type Shot = { status: number; body: string };
const shot = async (res: { status: () => number; text: () => Promise<string> }): Promise<Shot> => ({
  status: res.status(),
  body: (await res.text()).slice(0, 800),
});

const looksFuture = (s: Shot) => s.status >= 400 && s.status < 500 && /future/i.test(s.body);
const ok = (s: Shot) => s.status < 300;

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

test.beforeAll(async () => {
  test.setTimeout(8 * 60_000);
  mkdirSync(EV, { recursive: true });
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  owner = await newCampusOwner('pr565');
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
        admissionDate: '2026-09-01', dateOfBirth: '2016-03-10T00:00:00Z', gender: 0,
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
  const day = await owner.api.post('bookshop/point-of-sale/day', { data: { openingFloat: 0 } });
  results.openPosDay = await shot(day);
  staffA = await addStaff(owner.api, { name: 'Sana Left', salary: 40000, designationId: DESIGNATION.teacher, joined: '2025-01-01' });
  staffB = await addStaff(owner.api, { name: 'Bilal Emp', salary: 40000, designationId: DESIGNATION.teacher, joined: '2025-01-01' });
  const cached = cacheOwner(owner);
  writeFileSync(path.join(SEED_DIR, 'seed.json'), JSON.stringify({
    email: cached.email, phone: cached.phone, tenantId: cached.tenantId, password: cached.password,
    classId, studentId: student.id, itemId, staffA: staffA.id, staffB: staffB.id,
  }), { mode: 0o600 });
  try { chmodSync(SEED_DIR, 0o700); } catch { /* */ }
});

test.afterAll(() => {
  mkdirSync(EV, { recursive: true });
  writeFileSync(path.join(EV, 'date-check-results.json'), JSON.stringify(results, null, 2));
});

test('Bookshop POS sale: local today saves, local tomorrow is rejected', async () => {
  const sale = async (d: string) => shot(await owner.api.post('bookshop/point-of-sale/sales', {
    data: {
      clientSaleId: randomUUID(), movementDate: iso(d), reference: null, lowStockReason: null,
      studentId: null, tenderType: 'Cash', amountReceived: 1_000_000,
      lines: [{ type: 'Item', itemId, variantId: null, kitId: null, quantity: 1, lowStockReason: null }],
    },
  }));
  expectTomorrowRejected(await sale(LOCAL_TOMORROW), 'pos-sale');
  expectToday(await sale(LOCAL_TODAY), 'pos-sale', EXPECT_UTC_BUG);
});

test('Stock movement: local today saves, local tomorrow is rejected', async () => {
  const move = async (d: string) => shot(await owner.api.post(`bookshop/inventory/${itemId}/stock-movements`, {
    data: { variantId: null, reasonCode: 'Purchase Receipt', quantity: 1, movementDate: iso(d), reference: 'QA565', notes: 'date check' },
  }));
  expectTomorrowRejected(await move(LOCAL_TOMORROW), 'stock-movement');
  expectToday(await move(LOCAL_TODAY), 'stock-movement', EXPECT_UTC_BUG);
});

test('Staff mark-as-left: local today saves, local tomorrow is rejected', async () => {
  const leave = async (id: string, d: string) => shot(await owner.api.post(`staff/${id}/mark-as-left`, {
    data: { lastWorkingDay: iso(d), reason: 'Resigned', note: 'QA date check' },
  }));
  expectTomorrowRejected(await leave(staffA.id, LOCAL_TOMORROW), 'mark-as-left');
  expectToday(await leave(staffA.id, LOCAL_TODAY), 'mark-as-left', EXPECT_UTC_BUG);
});

test('Staff rehire: local today saves, local tomorrow is rejected', async () => {
  // staffA is left only when mark-as-left on local today saved (the PR). On the UTC-date
  // baseline that call is rejected, so leave them on a clearly past day first.
  // Do not regex the profile body: the fixture staff name used to contain "Left".
  const markedToday = ok((results['mark-as-left'] as { today?: Shot } | undefined)?.today ?? { status: 0, body: '' });
  if (!markedToday) {
    const past = await shot(await owner.api.post(`staff/${staffA.id}/mark-as-left`, {
      data: { lastWorkingDay: iso('2026-11-01'), reason: 'Resigned', note: 'QA date check past' },
    }));
    results['rehire-mark-past'] = past;
  }
  const profile = await shot(await owner.api.get(`staff/${staffA.id}/profile`));
  results['rehire-profile-before'] = profile;
  const rehire = async (d: string) => shot(await owner.api.post(`staff/${staffA.id}/rehire`, {
    data: {
      designationId: DESIGNATION.teacher, category: 'Teaching', reportsToStaffId: null,
      employmentTypeId: EMPLOYMENT_FULL_TIME, dateOfJoining: iso(d),
    },
  }));
  expectTomorrowRejected(await rehire(LOCAL_TOMORROW), 'rehire');
  expectToday(await rehire(LOCAL_TODAY), 'rehire', EXPECT_UTC_BUG);
});

test('Employment date of joining: local today saves, local tomorrow is rejected', async () => {
  const emp = async (d: string) => shot(await owner.api.put(`staff/${staffB.id}/employment`, {
    data: {
      designation: DESIGNATION.teacher, dateOfJoining: iso(d), employmentType: EMPLOYMENT_FULL_TIME,
      specialization: null, workEmail: null, contractStartDate: null, contractEndDate: null,
    },
  }));
  expectTomorrowRejected(await emp(LOCAL_TOMORROW), 'employment-joining');
  expectToday(await emp(LOCAL_TODAY), 'employment-joining', EXPECT_UTC_BUG);
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
      category: 'Teaching', designationId: DESIGNATION.teacher, dateOfJoining: iso(d),
      employmentTypeId: EMPLOYMENT_FULL_TIME, reportingManagerId: null, monthlySalary: 40000,
      highestQualification: 'Masters', specialization: null, university: 'Punjab University', yearOfCompletion: 2012,
      totalExperience: '5', previousInstitution: null,
    },
  }));
  expectTomorrowRejected(await add(LOCAL_TOMORROW, 'TM'), 'add-staff');
  expectToday(await add(LOCAL_TODAY, 'TD'), 'add-staff', EXPECT_UTC_BUG);
});

test('Certification add and update: local today saves, local tomorrow is rejected', async () => {
  const payload = (d: string, name: string) => ({
    certificationName: name, issuingBody: 'QA Board', issueDate: iso(d),
    expiryDate: null, certificateNumber: null, documentUrl: null,
  });
  expectTomorrowRejected(await shot(await owner.api.post(`staff/${staffB.id}/certifications`, { data: payload(LOCAL_TOMORROW, 'Tomorrow Cert') })), 'cert-add');
  const todayAdd = await shot(await owner.api.post(`staff/${staffB.id}/certifications`, { data: payload(LOCAL_TODAY, 'Today Cert') }));
  expectToday(todayAdd, 'cert-add', EXPECT_UTC_BUG);

  // For update, seed a past-dated cert so we have an id even if today's add was rejected on main.
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
  // DOB already used operational today on main too, so local today should save even on the UTC-bug baseline.
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
  // Tomorrow must be rejected as in the future (already operational today). Today may 4xx for "no challan" rather than "future".
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
      mobileNumber: student ? '0303' + String(randomInt(1000000, 9999999)) : '03030000000',
      classId, admissionDate: d, dateOfBirth: '2016-03-10T00:00:00Z', gender: 0,
    },
  }));
  const admitToday = await admit(LOCAL_TODAY, 'Adm Today');
  const admitTomorrow = await admit(LOCAL_TOMORROW, 'Adm Tomorrow');
  results.admission = { today: admitToday, tomorrow: admitTomorrow };
  // QuickAdd may return a catch-all 400 (not a future-date validation). Record both dates; only
  // assert when the response is a real date-check (success or a "future" problem).
  const admitIsDateCheck = (s: Shot) => ok(s) || looksFuture(s);
  if (admitIsDateCheck(admitToday) || admitIsDateCheck(admitTomorrow)) {
    expect(ok(admitToday) || EXPECT_UTC_BUG, `admission local today: ${admitToday.status} ${admitToday.body}`).toBeTruthy();
  }
  const unplaced = await shot(await owner.api.post('students/quick-add', {
    data: {
      fullName: 'Adm Unplaced', admissionId: `U565-${randomInt(10000, 99999)}`, fatherName: 'Farooq Date',
      mobileNumber: '0303' + String(randomInt(1000000, 9999999)),
      admissionDate: '2026-09-01', dateOfBirth: '2016-03-10T00:00:00Z', gender: 0,
    },
  }));
  results.admissionUnplacedPast = unplaced;

  const policy = async (d: string, name: string) => {
    const data: Record<string, unknown> = {
      policyName: name, publishNow: false, description: null, policyType: 0, rootPolicyId: null,
      scope: 0, classIds: [], occurrence: 0, challanGenerationDay: 15, dueDay: 25, tuitionFee: 1000,
      enableFineRule: false, fineType: null, fineAmount: null, graceDays: null,
      effectiveFrom: iso(d), effectiveUntil: null, additionalFundIds: [],
      bankName: 'QA Bank', accountTitle: 'QA School Account', accountNumber: null, bankBranch: 'Main',
    };
    return shot(await owner.api.post('fee-policies', { data }));
  };
  const polToday = await policy(LOCAL_TODAY, 'QA Policy Today');
  const polTomorrow = await policy(LOCAL_TOMORROW, 'QA Policy Tomorrow');
  const polUtc = await policy(UTC_TODAY, 'QA Policy UtcToday');
  results.feePolicy = { today: polToday, tomorrow: polTomorrow, utcToday: polUtc };
  expect(ok(polToday) || EXPECT_UTC_BUG, `fee policy local today: ${polToday.status} ${polToday.body}`).toBeTruthy();

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
      overrideEnabled: true, tuitionFeeAmount: 900, effectiveFrom: iso(d), effectiveUntil: null,
      reason: 'QA date check', reasonTags: [], concessions: [], funds: [], attachments: [],
    },
  }));
  const feeToday = await fee(LOCAL_TODAY);
  const feeTomorrow = await fee(LOCAL_TOMORROW);
  results.studentFeeEffective = { today: feeToday, tomorrow: feeTomorrow };
  // Record only: a 404 "no policy" is a setup miss, not a date-check result.
  if (ok(feeToday) || looksFuture(feeToday) || looksFuture(feeTomorrow)) {
    expect(ok(feeToday) || EXPECT_UTC_BUG, `student fee effective local today: ${feeToday.status} ${feeToday.body}`).toBeTruthy();
  }
});

