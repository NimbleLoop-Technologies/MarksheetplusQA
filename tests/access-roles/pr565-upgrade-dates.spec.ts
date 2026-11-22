/**
 * PR 565 cycle 2 upgrade check: seed dated records (past days, so both main and the PR
 * accept them) and record how those days are displayed. Run once on a main stack
 * (QA_UPGRADE_PHASE=before) and again on the same data after switching the app
 * containers to the PR build (QA_UPGRADE_PHASE=after).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { randomUUID, randomInt } from 'node:crypto';
import path from 'node:path';
import { newCampusOwner, cacheOwner, ownerFromCache, type CampusOwner } from '../../fixtures/campus-owner';
import * as f from '../../fixtures/fees';
import { addStaff, DESIGNATION } from '../../fixtures/payroll';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence-upgrade');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.resolve(EV, '..', 'seed-upgrade');
const PHASE = (process.env.QA_UPGRADE_PHASE ?? 'before').toLowerCase();
const PICKED = '2026-11-15';
const PICKED_ISO = `${PICKED}T00:00:00Z`;
const INSTANT = new Date(`${PICKED}T00:00:00+05:00`).toISOString();
const EMPLOYMENT_FULL_TIME = '33333333-3333-3333-3333-333333333331';

test.describe.configure({ mode: 'serial' });

function dayOf(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  const iso = s.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const named = s.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (named) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mi = months.findIndex((x) => x.toLowerCase() === named[2].toLowerCase());
    if (mi >= 0) return `${named[3]}-${String(mi + 1).padStart(2, '0')}-${named[1].padStart(2, '0')}`;
  }
  return s;
}

async function shot(res: { status: () => number; text: () => Promise<string> }) {
  return { status: res.status(), body: (await res.text()).slice(0, 2000) };
}

test('upgrade: seed or re-read dated records and confirm the picked day is unchanged', async () => {
  test.setTimeout(8 * 60_000);
  mkdirSync(EV, { recursive: true });
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  const seedPath = path.join(SEED_DIR, 'upgrade-seed.json');
  const beforePath = path.join(EV, 'before.json');
  const outPath = path.join(EV, `${PHASE}.json`);

  let owner: CampusOwner;
  let ids: any;

  if (PHASE === 'after') {
    expect(existsSync(seedPath), 'upgrade seed.json from the main run is missing').toBeTruthy();
    ids = JSON.parse(readFileSync(seedPath, 'utf8'));
    owner = await ownerFromCache(ids);
  } else {
    owner = await newCampusOwner('pr565up');
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
    const classId = orange.id;
    const studentBody = await f.ok(await owner.api.post('students/quick-add', {
      data: {
        fullName: 'Upgrade Alia', admissionId: `UP-${randomInt(100000, 999999)}`, fatherName: 'Farooq Date',
        mobileNumber: '0301' + String(randomInt(1000000, 9999999)), classId,
        admissionDate: PICKED, dateOfBirth: '2016-03-10T00:00:00Z', gender: 0,
      },
    }), 'upgrade student');
    const fam = await f.sql(`select "FamilyId" from "Students" where "Id" = ${f.q(studentBody.id)}`);
    const item = await f.ok(await owner.api.post('bookshop/inventory', {
      data: {
        itemName: 'QA 565 Upgrade Notebook', sku: `UP565-${randomInt(10000, 99999)}`, category: 'Stationery', description: null,
        openingStock: 500, reorderLevel: 0, costPrice: 100, retailPrice: 200, hasVariants: false, options: [], variants: [],
      },
    }), 'upgrade item');
    const itemId = (item.item ?? item).id;
    const staff = await addStaff(owner.api, { name: 'Upgrade Staff', salary: 40000, designationId: DESIGNATION.teacher, joined: PICKED });
    // Open day: main accepts a missing businessDate; send the picked day anyway so the call works on both.
    await shot(await owner.api.post('bookshop/point-of-sale/day', { data: { openingFloat: 0, businessDate: PICKED_ISO } }));
    const sale = await f.ok(await owner.api.post('bookshop/point-of-sale/sales', {
      data: {
        clientSaleId: randomUUID(), movementDate: PICKED_ISO, reference: null, lowStockReason: null,
        studentId: null, tenderType: 'Cash', amountReceived: 1_000_000,
        lines: [{ type: 'Item', itemId, variantId: null, kitId: null, quantity: 1, lowStockReason: null }],
      },
    }), 'upgrade sale');
    const saleRows = await f.sql(`select "Id", "SaleDate"::text, "BillNumber" from "BookshopSales" where "TenantId" = ${f.q(owner.tenantId)} and "BillNumber" = ${f.q(sale.reference)}`);
    const move = await shot(await owner.api.post(`bookshop/inventory/${itemId}/stock-movements`, {
      data: { variantId: null, reasonCode: 'Purchase Receipt', quantity: 1, movementDate: PICKED_ISO, reference: 'UP565', notes: 'upgrade seed' },
    }));
    const cert = await shot(await owner.api.post(`staff/${staff.id}/certifications`, {
      data: { certificationName: 'Upgrade Cert', issuingBody: 'QA Board', issueDate: PICKED_ISO, expiryDate: null, certificateNumber: null, documentUrl: null },
    }));
    const policy = await shot(await owner.api.post('fee-policies', {
      data: {
        policyName: 'Upgrade Policy', publishNow: false, description: null, policyType: 0, rootPolicyId: null,
        scope: 0, classIds: [], occurrence: 0, challanGenerationDay: 15, dueDay: 25, tuitionFee: 1000,
        enableFineRule: false, fineType: null, fineAmount: null, graceDays: null,
        effectiveFrom: PICKED_ISO, effectiveUntil: null, additionalFundIds: [],
        bankName: 'QA Bank', accountTitle: 'QA School Account', accountNumber: null, bankBranch: 'Main',
      },
    }));
    const cached = cacheOwner(owner);
    ids = {
      email: cached.email, phone: cached.phone, tenantId: cached.tenantId, password: cached.password,
      classId, studentId: studentBody.id, familyId: fam[0][0], itemId, staffId: staff.id,
      saleId: saleRows[0]?.[0], billNumber: sale.reference, storedSaleDate: saleRows[0]?.[1],
      certStatus: cert.status, policyStatus: policy.status, moveStatus: move.status,
      picked: PICKED, instant: INSTANT,
    };
    writeFileSync(seedPath, JSON.stringify(ids, null, 2), { mode: 0o600 });
    try { chmodSync(SEED_DIR, 0o700); } catch { /* */ }
  }

  const record: Record<string, unknown> = { phase: PHASE, picked: PICKED };
  const sqlSale = ids.saleId
    ? await f.sql(`select "SaleDate"::text, "BillNumber" from "BookshopSales" where "Id" = ${f.q(ids.saleId)}`)
    : [];
  record.saleStored = sqlSale[0]?.[0] ?? '';
  record.billNumber = sqlSale[0]?.[1] ?? ids.billNumber;
  if (ids.saleId) {
    const bill = await shot(await owner.api.get(`bookshop/sales/${ids.saleId}`));
    record.saleGet = bill;
  }
  if (ids.staffId) {
    const profile = await shot(await owner.api.get(`staff/${ids.staffId}/profile`));
    record.staffProfile = profile;
  }
  if (ids.studentId) {
    const profile = await shot(await owner.api.get(`students/${ids.studentId}/profile`));
    record.studentProfile = profile;
    const sqlAdm = await f.sql(`select "AdmissionDate"::text from "Students" where "Id" = ${f.q(ids.studentId)}`);
    record.admissionStored = sqlAdm[0]?.[0] ?? '';
  }
  if (ids.itemId) {
    const list = await shot(await owner.api.get(`bookshop/inventory/${ids.itemId}/stock-movements`));
    record.stockList = list;
  }
  if (ids.staffId) {
    const list = await shot(await owner.api.get(`staff/${ids.staffId}/certifications`));
    record.certList = list;
  }
  const doj = await f.sql(`select "DateOfJoining"::text from "Staff" where "Id" = ${f.q(ids.staffId)}`).catch(() => []);
  record.dojStored = doj[0]?.[0] ?? '';

  writeFileSync(outPath, JSON.stringify(record, null, 2));

  const blob = JSON.stringify(record);
  expect(blob, `phase=${PHASE} should still show the picked day ${PICKED}`).toMatch(new RegExp(PICKED));
  if (record.saleStored) expect(dayOf(record.saleStored), 'stored sale date').toBe(PICKED);
  if (record.admissionStored) expect(dayOf(record.admissionStored), 'stored admission date').toBe(PICKED);
  if (record.dojStored) expect(dayOf(record.dojStored), 'stored date of joining').toBe(PICKED);

  if (PHASE === 'after') {
    expect(existsSync(beforePath), 'before.json from the main seed is missing').toBeTruthy();
    const before = JSON.parse(readFileSync(beforePath, 'utf8'));
    const cmp: Record<string, unknown> = {
      saleStored: { before: before.saleStored, after: record.saleStored },
      admissionStored: { before: before.admissionStored, after: record.admissionStored },
      dojStored: { before: before.dojStored, after: record.dojStored },
    };
    writeFileSync(path.join(EV, 'compare.json'), JSON.stringify(cmp, null, 2));
    expect(dayOf(record.saleStored), 'sale day after upgrade').toBe(dayOf(before.saleStored));
    expect(dayOf(record.admissionStored), 'admission day after upgrade').toBe(dayOf(before.admissionStored));
    expect(dayOf(record.dojStored), 'DOJ after upgrade').toBe(dayOf(before.dojStored));
  }
});
