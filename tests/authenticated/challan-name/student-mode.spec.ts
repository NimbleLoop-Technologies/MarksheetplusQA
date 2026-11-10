/**
 * PR 547 / ClickUp z94x8eapp5 — AC3 (challans under the student's name), AC5 (payments on student challans),
 * and edge cases on a school that bills per student from its first cycle.
 *
 * Data (one throwaway campus for the whole file, Worker scheduler issues the cycle):
 *   family F: Alpha (Class 1, school policy 1,000), Bravo (Class 2, class policy 2,500), Charlie (Class 3, school policy 1,000)
 *   family G: Solo (Class 1) — single child
 *   school policy: per student ON; class policy on Class 2 (inherits the root's setting)
 */
import { test, expect, devices, type APIResponse } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { DefaultersPage, FamilyAccountPage, FeePaymentPage, ReceiveDrawer, ROUTES, signInToWebApp } from '../../../pages/fees/AccountOffice';
import { newCampusOwner, type CampusOwner } from '../../../fixtures/campus-owner';
import * as f from '../../../fixtures/fees';

const EV = '/workspace/qa-cycles/pr-555/cycle-1/evidence';
const CHALLAN_NUMBER = /^\d{4}-\d{4}$/;

// Tests run in file order on one worker; a failed test restarts the worker and the cached campus is reused.
test.describe.configure({ mode: 'default' });

let owner: CampusOwner;
let school: f.SchoolSetup;
let alpha: f.Student, bravo: f.Student, charlie: f.Student, solo: f.Student;
let issued: f.ChallanRow[];
const challanOf = (s: f.Student) => issued.find((c) => c.primaryStudentId === s.id)!;

interface Seed {
  school: f.SchoolSetup;
  students: f.Student[];
  issued: f.ChallanRow[];
}

test.beforeAll(async ({}, testInfo) => {
  test.setTimeout(8 * 60_000);
  const seeded = await f.seededOnce<Seed>(testInfo.project.outputDir, 'student-mode', async () => {
    const o = await newCampusOwner('cn-student');
    const sc = await f.setupSchool(o, 3);
    const mobile = f.familyMobile();
    const father = f.personName('Fatherf');
    const a = await f.addStudent(o, { name: f.personName('Alpha'), classId: sc.classes[0].id, fatherName: father, fatherMobile: mobile });
    const b = await f.addStudent(o, { name: f.personName('Bravo'), classId: sc.classes[1].id, fatherName: father, fatherMobile: mobile });
    const c = await f.addStudent(o, { name: f.personName('Charlie'), classId: sc.classes[2].id, fatherName: father, fatherMobile: mobile });
    const s = await f.addStudent(o, { name: f.personName('Solo'), classId: sc.classes[0].id, fatherName: f.personName('Fatherg'), fatherMobile: f.familyMobile() });
    expect(new Set([a.familyId, b.familyId, c.familyId]).size, 'siblings share one family').toBe(1);
    expect(s.familyId).not.toBe(a.familyId);
    const root = await f.createSchoolPolicy(o, { tuition: 1000, perStudent: true });
    expect(root.status, JSON.stringify(root.body)).toBe(201);
    const cls = await f.createClassPolicy(o, root.id, [sc.classes[1].id], { tuition: 2500 });
    expect(cls.status, JSON.stringify(cls.body)).toBe(201);
    const iss = await f.waitForChallans(o.tenantId, 4);
    console.log(`tenant ${o.tenantId} family F ${a.familyId} family G ${s.familyId}`);
    return { owner: o, data: { school: sc, students: [a, b, c, s], issued: iss } };
  });
  owner = seeded.owner;
  school = seeded.data.school;
  [alpha, bravo, charlie, solo] = seeded.data.students;
  issued = seeded.data.issued;
});

test.afterAll(async () => {
  await owner?.api.dispose();
});

test('AC3 one numbered challan per student, only that student\'s charges, snapshot flag set', async () => {
  expect(issued).toHaveLength(4);
  for (const [s, amount] of [[alpha, 1000], [bravo, 2500], [charlie, 1000], [solo, 1000]] as const) {
    const c = challanOf(s);
    expect(c, `challan for ${s.name}`).toBeTruthy();
    expect(c.perStudent).toBe(true);
    expect(c.familyId).toBe(s.familyId);
    expect(c.lineStudents).toEqual([s.id]);
    expect(c.total).toBe(amount);
    expect(c.number).toMatch(CHALLAN_NUMBER);
  }
  // Sequential, distinct, never the "Outstanding-<guid>" junk number (Umair 11-02 architecture #1).
  const numbers = issued.map((c) => c.number).sort();
  expect(new Set(numbers).size).toBe(4);
  const seq = numbers.map((n) => Number(n.slice(5)));
  expect(seq).toEqual([1, 2, 3, 4]);
  // The family's student challans add up to what one family challan would have been (1,000 + 2,500 + 1,000).
  expect(issued.filter((c) => c.familyId === alpha.familyId).reduce((a, c) => a + c.total, 0)).toBe(4500);
});

test('AC3 pending list: one row per student, named by the student, amounts from that student only', async () => {
  const page = await f.pending(owner.api);
  expect(page.generateChallansPerStudent).toBe(true);
  expect(page.items).toHaveLength(4);
  for (const s of [alpha, bravo, charlie, solo]) {
    const row = page.items.find((i) => i.challanId === challanOf(s).id);
    expect(row, `row for ${s.name}`).toBeTruthy();
    expect(row.generateChallansPerStudent).toBe(true);
    expect(row.students.map((x: any) => x.studentId)).toEqual([s.id]);
    expect(row.amountDue).toBe(challanOf(s).total);
    expect(row.challanNumber).toBe(challanOf(s).number);
  }
  expect(page.summary.amountOutstanding).toBe(5500);
  expect(page.summary.pendingChallans).toBe(4);
});

test('AC3 scoped outstanding: ?challanId= is that student only; the family read lists each student challan', async () => {
  for (const s of [alpha, bravo, charlie]) {
    const body = await f.ok(await f.outstanding(owner.api, s.familyId, challanOf(s).id), `outstanding ${s.name}`);
    expect(body.challanStudentName.toLowerCase()).toBe(s.name.toLowerCase());
    expect(body.totalOutstanding).toBe(challanOf(s).total);
    expect(body.students.map((x: any) => x.studentId)).toEqual([s.id]);
  }
  const fam = await f.ok(await f.outstanding(owner.api, alpha.familyId), 'family outstanding');
  expect(fam.totalOutstanding).toBe(0);
  expect(fam.studentChallans.map((x: any) => x.challanId).sort()).toEqual([alpha, bravo, charlie].map((s) => challanOf(s).id).sort());
  expect(fam.householdOutstanding).toBe(4500);
  expect(fam.householdPendingChallansCount).toBe(3);
});

test('AC3 challan-prints: one document per student under the student name; ?challanId= narrows it; legacy route 404', async () => {
  const docs = await f.ok(await f.prints(owner.api, alpha.familyId), 'challan-prints');
  expect(docs).toHaveLength(3);
  for (const d of docs) {
    expect(d.generateChallansPerStudent).toBe(true);
    expect(d.students).toHaveLength(1);
    expect(d.studentName).toBe(d.students[0].studentName);
    expect(d.challanNumber).toMatch(CHALLAN_NUMBER);
  }
  const one = await f.ok(await f.prints(owner.api, alpha.familyId, challanOf(bravo).id), 'challan-prints ?challanId');
  expect(one).toHaveLength(1);
  expect(one[0].challanId).toBe(challanOf(bravo).id);
  expect(one[0].students[0].tuition).toBe(2500);
  // README: the singular legacy route is deprecated and answers 404 for a student-only family.
  expect((await owner.api.get(`fee-payments/families/${alpha.familyId}/challan-print`)).status()).toBe(404);
});

test('AC5 partial payment on one student challan touches only that student; receipt lines are that student\'s', async () => {
  const before = await f.remainingByChallan(owner.tenantId);
  const receipt = await f.ok(await f.pay(owner.api, bravo.familyId, 1000, { challanId: challanOf(bravo).id }), 'pay Bravo 1000');
  const after = await f.remainingByChallan(owner.tenantId);
  expect(after[challanOf(bravo).id]).toBe(1500);
  for (const s of [alpha, charlie, solo]) expect(after[challanOf(s).id]).toBe(before[challanOf(s).id]);
  expect(receipt.totalPaid).toBe(1000);
  expect(receipt.lines.length).toBeGreaterThan(0);
  for (const line of receipt.lines) expect(line.studentName.toLowerCase()).toBe(bravo.name.toLowerCase());
  // The student's scope after the payment.
  const scoped = await f.ok(await f.outstanding(owner.api, bravo.familyId, challanOf(bravo).id), 'Bravo outstanding');
  expect(scoped.totalOutstanding).toBe(1500);
  const row = (await f.pending(owner.api)).items.find((i) => i.challanId === challanOf(bravo).id);
  expect(row.amountDue).toBe(1500);
  expect(row.status).toBe('Partial');
});

test('AC5 double submit (same clientPaymentId) records one payment', async () => {
  const clientPaymentId = `qa-dup-${f.letters(8)}`;
  const [a, b] = await Promise.all([
    f.pay(owner.api, charlie.familyId, 200, { challanId: challanOf(charlie).id, clientPaymentId }),
    f.pay(owner.api, charlie.familyId, 200, { challanId: challanOf(charlie).id, clientPaymentId }),
  ]);
  const statuses = [a.status(), b.status()];
  expect(statuses.every((s) => s < 500), `statuses ${statuses}`).toBe(true);
  const count = await f.sql(`select count(*) from "FeePayments" where "ClientPaymentId" = ${f.sqlQuote(clientPaymentId)}`);
  expect(Number(count[0][0])).toBe(1);
  expect((await f.remainingByChallan(owner.tenantId))[challanOf(charlie).id]).toBe(800);
});

test('AC5 a student payment never settles a sibling or another family; amount above the scope is refused', async () => {
  const before = await f.remainingByChallan(owner.tenantId);
  const res = await f.pay(owner.api, alpha.familyId, 5000, { challanId: challanOf(alpha).id });
  // Over-payment beyond the student's dues: refused with a validation message, or capped to the student's dues — never spread to siblings.
  expect(res.status(), await res.text()).toBeLessThan(500);
  const after = await f.remainingByChallan(owner.tenantId);
  for (const s of [bravo, charlie, solo]) expect(after[challanOf(s).id], `${s.name} untouched`).toBe(before[challanOf(s).id]);
});

async function probe(cases: [string, () => Promise<APIResponse>, number[]][], file: string): Promise<void> {
  const before = await f.remainingByChallan(owner.tenantId);
  const results: string[] = [];
  for (const [name, call, allowed] of cases) {
    const res = await call();
    results.push(`${name}: ${res.status()} ${(await res.text()).slice(0, 160)}`);
    expect.soft(allowed, `${name} -> HTTP ${res.status()}`).toContain(res.status());
  }
  console.log(results.join('\n'));
  await writeFile(`${EV}/${file}`, results.join('\n') + '\n');
  // Nothing was paid by any refused call.
  expect(await f.remainingByChallan(owner.tenantId)).toEqual(before);
}

test('EDGE challanId of another family / unknown guid: 404 (reads) or 400 (payment), never the family fallback', async () => {
  await probe([
    ['outstanding: other family\'s challan', () => f.outstanding(owner.api, alpha.familyId, challanOf(solo).id), [404]],
    ['outstanding: unknown guid', () => f.outstanding(owner.api, alpha.familyId, '00000000-0000-0000-0000-000000000000'), [404]],
    ['prints: other family\'s challan', () => f.prints(owner.api, alpha.familyId, challanOf(solo).id), [404]],
    ['prints: unknown guid', () => f.prints(owner.api, alpha.familyId, '00000000-0000-0000-0000-000000000000'), [404]],
    ['pay: other family\'s challan', () => f.pay(owner.api, alpha.familyId, 100, { challanId: challanOf(solo).id }), [400]],
    ['pay: unknown guid', () => f.pay(owner.api, alpha.familyId, 100, { challanId: '00000000-0000-0000-0000-000000000000' }), [400]],
  ], 'edge-ids-wellformed.txt');
});

test('C1 malformed challanId / familyId on outstanding and challan-prints answer 400/404, not 500 (no stack trace)', async () => {
  await probe([
    ['outstanding ?challanId=not-a-guid', () => f.outstanding(owner.api, alpha.familyId, 'not-a-guid'), [400, 404]],
    ['outstanding ?challanId=<valid> family=not-a-guid', () => f.outstanding(owner.api, 'not-a-guid', challanOf(alpha).id), [400, 404]],
    ['challan-prints ?challanId=not-a-guid', () => f.prints(owner.api, alpha.familyId, 'not-a-guid'), [400, 404]],
    ['challan-prints family=not-a-guid', () => f.prints(owner.api, 'not-a-guid'), [400, 404]],
    // Reference (pre-existing routes, not new in PR 547): the legacy print and the family read with a malformed family.
    ['legacy challan-print family=not-a-guid (reference)', () => owner.api.get('fee-payments/families/not-a-guid/challan-print'), [400, 404, 500]],
    ['outstanding family=not-a-guid, no challanId (reference)', () => f.outstanding(owner.api, 'not-a-guid'), [400, 404, 500]],
    ['payment ?challanId=not-a-guid', () => f.pay(owner.api, alpha.familyId, 100, { challanId: 'not-a-guid' }), [400]],
    ['payment challanId=""', () => f.pay(owner.api, alpha.familyId, 100, { challanId: '' }), [400]],
  ], 'C1-malformed-ids.txt');
});

test('EDGE scheduler re-runs in the same cycle do not duplicate student challans', async () => {
  await f.waitForSchedulerPass(owner.tenantId);
  await f.waitForSchedulerPass(owner.tenantId);
  expect(await f.challans(owner.tenantId)).toHaveLength(4);
});

test('EDGE a sibling linked after the per-student cycle gets their own challan on the next pass; siblings untouched', async () => {
  const delta = await f.addStudent(owner, {
    name: f.personName('Delta'), classId: school.classes[2].id, fatherName: 'Fatherf Late', fatherMobile: (await familyMobileOf(alpha)),
  });
  expect(delta.familyId).toBe(alpha.familyId);
  const all = await f.waitForChallans(owner.tenantId, 5);
  const deltaChallans = all.filter((c) => c.primaryStudentId === delta.id);
  expect(deltaChallans).toHaveLength(1);
  expect(deltaChallans[0].perStudent).toBe(true);
  expect(deltaChallans[0].lineStudents).toEqual([delta.id]);
  expect(deltaChallans[0].number).toMatch(CHALLAN_NUMBER);
  expect(Number(deltaChallans[0].number.slice(5))).toBe(5);
  for (const s of [alpha, bravo, charlie]) {
    const c = all.find((x) => x.id === challanOf(s).id)!;
    expect(c.lineStudents).toEqual([s.id]);
  }
});

test('AC5 bookshop purchase of a student with a pending student challan goes to that student (BookshopRouting)', async () => {
  const itemId = await f.setupBookshop(owner, 300);
  await f.feeAccountSale(owner, alpha.id, itemId, 1);
  const row = (await f.pending(owner.api)).items.find((i) => i.challanId === challanOf(alpha).id);
  const scoped = await f.ok(await f.outstanding(owner.api, alpha.familyId, challanOf(alpha).id), 'Alpha outstanding');
  const docs = await f.ok(await f.prints(owner.api, alpha.familyId, challanOf(alpha).id), 'Alpha print');
  const fam = await f.ok(await f.outstanding(owner.api, alpha.familyId), 'family outstanding');
  // The list, the scoped dues and the print quote the same number (Umair 11-02 critical #2).
  expect(row.amountDue).toBe(1300);
  expect(scoped.totalOutstanding).toBe(1300);
  expect(docs[0].unbilledBookshopAmount).toBe(300);
  expect(fam.totalOutstanding, 'the family scope does not also collect it').toBe(0);
  expect(fam.studentChallans.find((x: any) => x.studentId === alpha.id).amountDue).toBe(1300);
  // Paying the student's full dues bills the purchase onto the student's own challan.
  await f.ok(await f.pay(owner.api, alpha.familyId, 1300, { challanId: challanOf(alpha).id }), 'pay Alpha 1300');
  const lines = await f.sql(`select l."Label", l."RemainingAmount", c."Id" = ${f.sqlQuote(challanOf(alpha).id)}
    from "FeeChallanLines" l join "FeeChallans" c on c."Id" = l."FeeChallanId" where l."StudentId" = ${f.sqlQuote(alpha.id)} and l."Label" like '%Bookshop%'`);
  expect(lines, 'bookshop line billed').toHaveLength(1);
  expect(lines[0][2], 'billed on the student\'s own challan').toBe('t');
  expect(Number(lines[0][1])).toBe(0);
});

test('EDGE concurrent payments that both need a transient bookshop challan: retry message, never 500, real numbers', async () => {
  // Purchases of students with no pending student challan go to their family scope, which (in a per-student school) has
  // no combined challan: the payment creates a transient bookshop-only challan numbered from the month's sequence.
  const itemId = await f.setupBookshop(owner, 250);
  await f.ok(await f.pay(owner.api, solo.familyId, 1000, { challanId: challanOf(solo).id }), 'clear Solo');
  await f.feeAccountSale(owner, solo.id, itemId, 1);
  // Alpha is cleared by the previous test; a second purchase of Alpha goes to family F's scope.
  await f.feeAccountSale(owner, alpha.id, itemId, 1);
  const [a, b] = await Promise.all([f.pay(owner.api, alpha.familyId, 250), f.pay(owner.api, solo.familyId, 250)]);
  const results = [`F ${a.status()} ${(await a.text()).slice(0, 300)}`, `G ${b.status()} ${(await b.text()).slice(0, 300)}`];
  console.log(results.join('\n'));
  for (const [r, familyId] of [[a, alpha.familyId], [b, solo.familyId]] as const) {
    expect(r.status(), 'never 500').not.toBe(500);
    if (!r.ok()) {
      // CONCURRENCY_ERROR_MESSAGE; the cashier retries on fresh dues and the retry goes through.
      expect(await r.text()).toContain('This challan was just updated. Review the latest balance.');
      await f.ok(await f.pay(owner.api, familyId, 250), 'retry after the concurrency message');
    }
  }
  const junk = await f.sql(`select "ChallanNumber" from "FeeChallans" where "TenantId" = ${f.sqlQuote(owner.tenantId)} and "ChallanNumber" !~ '^[0-9]{4}-[0-9]{4}$'`);
  expect(junk, 'every challan number is a real sequence number').toEqual([]);
});

test('EDGE a struck-off student\'s issued student challan stays collectable under their name', async () => {
  const all = await f.challans(owner.tenantId);
  const delta = all.find((c) => c.perStudent && c.familyId === alpha.familyId && ![alpha.id, bravo.id, charlie.id].includes(c.primaryStudentId!));
  test.skip(!delta, 'needs the late sibling\'s challan from the earlier test');
  const deltaId = delta!.primaryStudentId!;
  await f.dbSetup('strike off the late sibling (no status API on this route set)', `update "Students" set "Status" = 'Struck off' where "Id" = ${f.sqlQuote(deltaId)}`);
  const row = (await f.pending(owner.api)).items.find((i) => i.challanId === delta!.id);
  expect(row, 'still listed').toBeTruthy();
  expect(row.amountDue).toBe(delta!.remaining);
  const scoped = await f.ok(await f.outstanding(owner.api, alpha.familyId, delta!.id), 'struck-off student dues');
  expect(scoped.totalOutstanding).toBe(delta!.remaining);
  expect(scoped.students[0].isWithdrawn).toBe(true);
  const docs = await f.ok(await f.prints(owner.api, alpha.familyId, delta!.id), 'struck-off student print');
  expect(docs).toHaveLength(1);
  await f.ok(await f.pay(owner.api, alpha.familyId, delta!.remaining, { challanId: delta!.id }), 'collect struck-off student');
  expect((await f.remainingByChallan(owner.tenantId))[delta!.id]).toBe(0);
});

test('AC3/AC4 UI: pure per-student family — Fee Payment rows, the student page, and Defaulters "Receive"', async ({ page }) => {
  await signInToWebApp(page, owner.credentials());
  const list = new FeePaymentPage(page);
  await list.open();
  await expect(list.columnHeader('Student')).toBeVisible();
  await expect(list.columnHeader('Students')).toHaveCount(0);
  await page.screenshot({ path: `${EV}/ui-fee-payment-student-mode-desktop.png`, fullPage: true });
  // A student row opens that student's page, titled with the student.
  const familyPage = new FamilyAccountPage(page);
  await familyPage.open(ROUTES.family(bravo.familyId, challanOf(bravo).id));
  await expect(familyPage.heading).toContainText(new RegExp(bravo.name, 'i'));
  await expect(familyPage.heading).not.toContainText(/family/i);
  await page.screenshot({ path: `${EV}/ui-student-page.png`, fullPage: true });
  // Defaulters -> Receive for a family with only student challans: the card offers each student, no empty "no dues" state.
  const fam = await f.ok(await f.outstanding(owner.api, bravo.familyId), 'family read');
  const defaulters = new DefaultersPage(page);
  await defaulters.open();
  await defaulters.receiveLink(fam.familyName).click();
  await familyPage.waitLoaded();
  await expect(familyPage.studentChallansCard).toBeVisible();
  await expect(familyPage.noDues).toHaveCount(0);
  await expect(familyPage.outstandingTile).toContainText(fam.householdOutstanding.toLocaleString('en-US'));
  await page.screenshot({ path: `${EV}/ui-defaulters-receive-student-only-family.png`, fullPage: true });
  await familyPage.studentChallanLink(new RegExp(`^Receive ${bravo.name}$`, 'i')).click();
  const drawer = new ReceiveDrawer(page);
  await drawer.expectOpen();
  await expect(drawer.dialog).toContainText(new RegExp(bravo.name, 'i'));
});

test('AC3/C3 Pixel 5: Fee Payment in student mode', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['Pixel 5'], ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await signInToWebApp(page, owner.credentials());
  await new FeePaymentPage(page).open();
  await page.screenshot({ path: `${EV}/ui-fee-payment-student-mode-pixel5.png`, fullPage: true });
  await ctx.close();
});

async function familyMobileOf(s: f.Student): Promise<string> {
  const rows = await f.sql(`select "FatherMobile" from "Families" where "Id" = ${f.sqlQuote(s.familyId)}`);
  return rows[0][0].replace(/^\+92/, '0');
}
