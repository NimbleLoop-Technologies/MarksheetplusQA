/**
 * PR 547 / ClickUp z94x8eapp5 — AC2 (default = family name) and AC4 (only new-cycle challans change; mixed state
 * agrees everywhere; Family page without ?challanId from every entry point).
 *
 * A second and third cycle in one day use DB SETUP (fixtures/fees.ts shiftIssuedCycleBack): the issued Nov 2026
 * challans are moved back a month (two for the second flip) so the scheduler issues Nov 2026 again in the new mode.
 *
 * Data: family F = Alpha (Class 1, school 1,000), Bravo (Class 2, class policy 2,500), Charlie (Class 3, school 1,000);
 *       family G = Solo (Class 1, single child).
 */
import { test, expect } from '@playwright/test';
import { newCampusOwner, type CampusOwner } from '../../../fixtures/campus-owner';
import * as f from '../../../fixtures/fees';
import { BackLinkedPage, DefaultersPage, FamilyAccountPage, FeePaymentPage, ReceiveDrawer, ROUTES, signInToWebApp } from '../../../pages/fees/AccountOffice';

const EV = '/workspace/qa-cycles/pr-555/cycle-1/evidence';
const CYCLE = '2026-11-01';

test.describe.configure({ mode: 'default' });

interface Seed {
  school: f.SchoolSetup;
  students: f.Student[];
  rootId: string;
  classId: string;
  familyName: string;
  cycle1: f.ChallanRow[];
}

let owner: CampusOwner;
let seed: Seed;
let alpha: f.Student, bravo: f.Student, charlie: f.Student, solo: f.Student;

test.beforeAll(async ({}, testInfo) => {
  test.setTimeout(8 * 60_000);
  const seeded = await f.seededOnce<Seed>(testInfo.project.outputDir, 'mode-switch', async () => {
    const o = await newCampusOwner('cn-switch');
    const sc = await f.setupSchool(o, 3);
    const mobile = f.familyMobile();
    const father = f.personName('Fatherf');
    const a = await f.addStudent(o, { name: f.personName('Alpha'), classId: sc.classes[0].id, fatherName: father, fatherMobile: mobile });
    const b = await f.addStudent(o, { name: f.personName('Bravo'), classId: sc.classes[1].id, fatherName: father, fatherMobile: mobile });
    const c = await f.addStudent(o, { name: f.personName('Charlie'), classId: sc.classes[2].id, fatherName: father, fatherMobile: mobile });
    const s = await f.addStudent(o, { name: f.personName('Solo'), classId: sc.classes[0].id, fatherName: f.personName('Fatherg'), fatherMobile: f.familyMobile() });
    // No generateChallansPerStudent in the request: the default.
    const root = await f.createSchoolPolicy(o, { tuition: 1000 });
    expect(root.status, JSON.stringify(root.body)).toBe(201);
    const cls = await f.createClassPolicy(o, root.id, [sc.classes[1].id], { tuition: 2500 });
    expect(cls.status, JSON.stringify(cls.body)).toBe(201);
    const cycle1 = await f.waitForChallans(o.tenantId, 2);
    const fam = await f.ok(await f.outstanding(o.api, a.familyId), 'family F');
    console.log(`tenant ${o.tenantId} family F ${a.familyId} family G ${s.familyId}`);
    return { owner: o, data: { school: sc, students: [a, b, c, s], rootId: root.id, classId: cls.id, familyName: fam.familyName, cycle1 } };
  });
  owner = seeded.owner;
  seed = seeded.data;
  [alpha, bravo, charlie, solo] = seed.students;
});

const familyChallan = (rows: f.ChallanRow[], s: f.Student, cycle = CYCLE) => rows.find((c) => !c.perStudent && c.familyId === s.familyId && c.cycleStart === cycle);
const studentChallan = (rows: f.ChallanRow[], s: f.Student) => rows.find((c) => c.perStudent && c.primaryStudentId === s.id);

test('AC2 a new school policy defaults to family name; siblings under different class policies share one challan', async () => {
  const detail = await f.policyDetail(owner, seed.rootId);
  expect(detail.generateChallansPerStudent).toBe(false);
  const cols = await f.sql(`select "GenerateChallansPerStudent" from "FeePolicies" where "TenantId" = ${f.sqlQuote(owner.tenantId)}`);
  expect(cols.map((r) => r[0])).toEqual(['f', 'f']);
  const F = familyChallan(seed.cycle1, alpha)!;
  expect(F.perStudent).toBe(false);
  expect(F.lineStudents.sort()).toEqual([alpha.id, bravo.id, charlie.id].sort());
  expect(F.total).toBe(4500);
  const G = familyChallan(seed.cycle1, solo)!;
  expect(G.total).toBe(1000);
  expect(seed.cycle1).toHaveLength(2);
  const page = await f.pending(owner.api);
  expect(page.generateChallansPerStudent).toBe(false);
  expect(page.items.every((i) => !i.generateChallansPerStudent)).toBe(true);
});

test('AC4 switching family -> student versions the policy, shows in history, and never regroups the issued cycle', async () => {
  const res = await f.updatePolicy(owner, seed.rootId, { generateChallansPerStudent: true });
  expect(res.status(), await res.text()).toBe(200);
  const latest = await f.latestPolicyVersion(seed.rootId);
  expect(latest.perStudent).toBe(true);
  expect(latest.version).toBe(2);
  const detail = await f.policyDetail(owner, latest.id);
  expect(detail.generateChallansPerStudent).toBe(true);
  const change = detail.versionHistory.flatMap((v: any) => v.changes).find((c: any) => c.fieldName === 'Challan Name');
  expect(change, 'history shows the change').toMatchObject({ beforeValue: 'Family', afterValue: 'Student' });
  // Class policy inherits the root's setting.
  expect((await f.policyDetail(owner, seed.classId)).generateChallansPerStudent).toBe(true);
  // Re-runs of the already issued cycle keep it as it was.
  await f.waitForSchedulerPass(owner.tenantId);
  const after = await f.challans(owner.tenantId);
  expect(after.map((c) => [c.id, c.perStudent, c.lineStudents.sort().join()])).toEqual(seed.cycle1.map((c) => [c.id, c.perStudent, c.lineStudents.sort().join()]));
});

test('AC4 the next cycle after the switch is issued per student; the older family challans are untouched', async () => {
  test.setTimeout(6 * 60_000);
  if ((await f.challans(owner.tenantId)).length < 6) await f.shiftIssuedCycleBack(owner.tenantId, CYCLE, 1);
  const all = await f.waitForChallans(owner.tenantId, 6);
  for (const [s, amount] of [[alpha, 1000], [bravo, 2500], [charlie, 1000], [solo, 1000]] as const) {
    const c = studentChallan(all, s)!;
    expect(c, `student challan ${s.name}`).toBeTruthy();
    expect(c.cycleStart).toBe(CYCLE);
    expect(c.lineStudents).toEqual([s.id]);
    expect(c.total).toBe(amount);
    expect(c.number).toMatch(/^2611-\d{4}$/);
  }
  const older = all.filter((c) => !c.perStudent);
  expect(older).toHaveLength(2);
  for (const c of older) {
    expect(c.cycleStart).toBe('2026-10-01');
    expect(seed.cycle1.map((x) => x.id)).toContain(c.id);
  }
});

test('AC4 mixed state: list rows, family read, defaulters, dashboard and prints agree; nothing counted twice', async () => {
  const all = await f.challans(owner.tenantId);
  const combinedF = all.find((c) => !c.perStudent && c.familyId === alpha.familyId)!;
  const page = await f.pending(owner.api);
  expect(page.generateChallansPerStudent).toBe(true);
  const rowsF = page.items.filter((i) => i.familyId === alpha.familyId);
  const familyRow = rowsF.find((i) => !i.generateChallansPerStudent);
  expect(familyRow, 'family row for the older combined challan').toBeTruthy();
  expect(familyRow.amountDue).toBe(combinedF.remaining);
  for (const s of [alpha, bravo, charlie]) {
    const c = studentChallan(all, s)!;
    const row = rowsF.find((i) => i.challanId === c.id);
    expect(row, `row for ${s.name}`).toBeTruthy();
    const scoped = await f.ok(await f.outstanding(owner.api, s.familyId, c.id), `outstanding ${s.name}`);
    expect(row.amountDue).toBe(scoped.totalOutstanding);
    expect(scoped.totalOutstanding).toBe(c.remaining);
  }
  const fam = await f.ok(await f.outstanding(owner.api, alpha.familyId), 'family read');
  expect(fam.totalOutstanding, 'family read = family row').toBe(familyRow.amountDue);
  expect(fam.studentChallans).toHaveLength(3);
  const rowSumF = rowsF.reduce((a: number, i: any) => a + i.amountDue, 0);
  expect(fam.householdOutstanding).toBe(rowSumF);
  const defaulters = await f.ok(await owner.api.get('fee-dashboard/defaulters'), 'defaulters');
  expect(defaulters.families.find((x: any) => x.familyId === alpha.familyId).outstandingAmount, 'defaulters = household').toBe(rowSumF);
  const dashboard = await f.ok(await owner.api.get('fee-dashboard'), 'dashboard');
  const total = page.items.reduce((a: number, i: any) => a + i.amountDue, 0);
  expect(page.summary.amountOutstanding).toBe(total);
  expect(dashboard.outstandingAmount).toBe(total);
  const docs = await f.ok(await f.prints(owner.api, alpha.familyId), 'prints');
  expect(docs.filter((d: any) => !d.generateChallansPerStudent)).toHaveLength(1);
  expect(docs.filter((d: any) => d.generateChallansPerStudent)).toHaveLength(3);
  const printed = docs.reduce((a: number, d: any) => a + d.unbilledBookshopAmount + d.students.reduce((x: number, s: any) => x + s.tuition + s.otherCharges + s.previousBalance + s.fine, 0), 0);
  expect(printed, 'printed documents total the household').toBe(rowSumF);
});

test('AC4 a family-mode challan id is not a student scope: 404 on reads, 400 on payment, nothing paid', async () => {
  const all = await f.challans(owner.tenantId);
  const combinedF = all.find((c) => !c.perStudent && c.familyId === alpha.familyId)!;
  const before = await f.remainingByChallan(owner.tenantId);
  expect((await f.outstanding(owner.api, alpha.familyId, combinedF.id)).status()).toBe(404);
  expect((await f.prints(owner.api, alpha.familyId, combinedF.id)).status()).toBe(404);
  const pay = await f.pay(owner.api, alpha.familyId, 100, { challanId: combinedF.id });
  expect(pay.status()).toBe(400);
  expect(await pay.text()).toContain('Student challan not found for this family.');
  expect(await f.remainingByChallan(owner.tenantId)).toEqual(before);
});

test('AC4 UI: Fee Payment lists students under a Student column; the older family row stays (desktop + Pixel 5)', async ({ page, browser }) => {
  await signInToWebApp(page, owner.credentials());
  const list = new FeePaymentPage(page);
  await list.open();
  await expect(list.columnHeader('Student')).toBeVisible();
  await expect(list.columnHeader('Family')).toHaveCount(0);
  await expect(list.columnHeader('Students')).toHaveCount(0);
  const names = (await list.rowNames()).map((n) => n.toLowerCase());
  for (const s of [alpha, bravo, charlie, solo]) expect(names).toContain(s.name.toLowerCase());
  expect(names).toContain(seed.familyName.toLowerCase());
  await page.screenshot({ path: `${EV}/ui-fee-payment-mixed-desktop.png`, fullPage: true });
  // Pixel 5 viewport with the same session.
  const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true, storageState: await page.context().storageState() });
  const phone = await ctx.newPage();
  await new FeePaymentPage(phone).open();
  await phone.screenshot({ path: `${EV}/ui-fee-payment-mixed-pixel5.png`, fullPage: true });
  await ctx.close();
});

test('AC4 UI (Umair 11-03): Defaulters "Receive" opens the family with every student challan collectable', async ({ page }) => {
  await signInToWebApp(page, owner.credentials());
  const defaulters = new DefaultersPage(page);
  await defaulters.open();
  await defaulters.receiveLink(seed.familyName).click();
  const familyPage = new FamilyAccountPage(page);
  await familyPage.waitLoaded();
  await expect(familyPage.studentChallansCard).toBeVisible();
  const fam = await f.ok(await f.outstanding(owner.api, alpha.familyId), 'family read');
  await expect(familyPage.outstandingTile).toContainText(fam.householdOutstanding.toLocaleString('en-US'));
  // The Receive route opens the drawer for the family's own (combined) dues; it must not offer the student challans' amounts.
  const familyDrawer = new ReceiveDrawer(page);
  if (fam.totalOutstanding > 0) {
    await familyDrawer.expectOpen();
    await expect(familyDrawer.dialog).toContainText(fam.totalOutstanding.toLocaleString('en-US'));
    await page.screenshot({ path: `${EV}/ui-defaulters-receive-family-drawer.png`, fullPage: true });
    await familyDrawer.cancel();
  }
  await page.screenshot({ path: `${EV}/ui-defaulters-receive-family-page.png`, fullPage: true });
  // Each student's link collects that student's own challan.
  await familyPage.studentChallanLink(new RegExp(`^Receive ${bravo.name}$`, 'i')).click();
  await expect(page).toHaveURL(/\/receive\?challanId=/);
  const drawer = new ReceiveDrawer(page);
  await drawer.expectOpen();
  await expect(drawer.dialog).toContainText(new RegExp(bravo.name, 'i'));
  await expect(drawer.dialog).toContainText('2,500');
  await page.screenshot({ path: `${EV}/ui-defaulters-receive-student-drawer.png`, fullPage: true });
});

test('AC4 UI: ledger back link and its Receive keep the student challans reachable', async ({ page }) => {
  await signInToWebApp(page, owner.credentials());
  const ledger = new BackLinkedPage(page);
  await ledger.open(ROUTES.ledger(alpha.familyId));
  await ledger.receivePayment().click();
  const familyPage = new FamilyAccountPage(page);
  await familyPage.waitLoaded();
  await expect(familyPage.studentChallansCard).toBeVisible();
  await page.screenshot({ path: `${EV}/ui-ledger-receive-family-page.png`, fullPage: true });
});

test('AC4 a family payment settles only the combined challan; a student payment only that student\'s', async () => {
  const all = await f.challans(owner.tenantId);
  const combinedF = all.find((c) => !c.perStudent && c.familyId === alpha.familyId)!;
  const combinedG = all.find((c) => !c.perStudent && c.familyId === solo.familyId)!;
  const before = await f.remainingByChallan(owner.tenantId);
  // Family F pays its family row's full amount with no challanId.
  await f.ok(await f.pay(owner.api, alpha.familyId, before[combinedF.id]), 'family F payment');
  let after = await f.remainingByChallan(owner.tenantId);
  expect(after[combinedF.id]).toBe(0);
  for (const s of [alpha, bravo, charlie]) expect(after[studentChallan(all, s)!.id], `${s.name} untouched`).toBe(before[studentChallan(all, s)!.id]);
  // Family G: a student payment never settles the combined challan.
  await f.ok(await f.pay(owner.api, solo.familyId, 1000, { challanId: studentChallan(all, solo)!.id }), 'Solo payment');
  after = await f.remainingByChallan(owner.tenantId);
  expect(after[studentChallan(all, solo)!.id]).toBe(0);
  expect(after[combinedG.id]).toBe(before[combinedG.id]);
});

const latestPaymentId = async (familyId: string) =>
  (await f.sql(`select "Id" from "FeePayments" where "FamilyId" = ${f.sqlQuote(familyId)} order by "CreatedDate" desc limit 1`))[0][0];

test('AC5 UI: a student payment from the student\'s Family page settles that student challan only', async ({ page }) => {
  await signInToWebApp(page, owner.credentials());
  const all = await f.challans(owner.tenantId);
  const c = studentChallan(all, charlie)!;
  const before = await f.remainingByChallan(owner.tenantId);
  const familyPage = new FamilyAccountPage(page);
  await familyPage.open(ROUTES.familyReceive(alpha.familyId, c.id));
  await expect(familyPage.heading).toContainText(new RegExp(charlie.name, 'i'));
  const drawer = new ReceiveDrawer(page);
  await drawer.expectOpen();
  await drawer.pay(400);
  const done = new BackLinkedPage(page).paymentReceivedDialog();
  await expect(done).toBeVisible({ timeout: 30_000 });
  await expect(done).toContainText('Rs 400');
  await page.screenshot({ path: `${EV}/ui-student-payment-received-dialog.png`, fullPage: true });
  const after = await f.remainingByChallan(owner.tenantId);
  expect(after[c.id]).toBe(before[c.id] - 400);
  for (const s of [alpha, bravo]) expect(after[studentChallan(all, s)!.id]).toBe(before[studentChallan(all, s)!.id]);
});

test('AC4 UI (Umair 11-03): the receipt\'s back link reaches the family page with its student challans', async ({ page }) => {
  await signInToWebApp(page, owner.credentials());
  const receipt = new BackLinkedPage(page);
  await receipt.open(ROUTES.receipt(await latestPaymentId(alpha.familyId)));
  await page.screenshot({ path: `${EV}/ui-student-receipt-page.png`, fullPage: true });
  await receipt.backLink(new RegExp(seed.familyName, 'i')).click();
  const familyPage = new FamilyAccountPage(page);
  await familyPage.waitLoaded();
  await expect(familyPage.studentChallansCard).toBeVisible();
  await page.screenshot({ path: `${EV}/ui-receipt-back-family-page.png`, fullPage: true });
});

test('C2 a payment on a student challan is acknowledged and receipted under the student\'s name, not the family\'s', async ({ page }) => {
  await signInToWebApp(page, owner.credentials());
  const paymentId = await latestPaymentId(alpha.familyId);
  const api = await f.ok(await owner.api.get(`fee-payments/payments/${paymentId}/receipt`), 'receipt');
  console.log(`receipt familyName=${api.familyName} lines=${api.lines.map((l: any) => l.studentName).join()}`);
  const receipt = new BackLinkedPage(page);
  await receipt.open(ROUTES.receipt(paymentId));
  // AC3 (derived): student challans are issued "in each student's name" — the paper given for them should be too.
  await expect.soft(page.getByRole('main'), 'receipt names the student').toContainText(new RegExp(charlie.name, 'i'));
  expect.soft(api.familyName.toLowerCase(), 'receipt payer is the student').toContain(charlie.name.split(' ')[0].toLowerCase());
});

test('C3 Fee Payment "Families with dues" counts families, not student rows, in a per-student school', async ({ page }) => {
  await signInToWebApp(page, owner.credentials());
  const list = new FeePaymentPage(page);
  await list.open();
  const families = new Set((await f.pending(owner.api)).items.map((i) => i.familyId)).size;
  await page.screenshot({ path: `${EV}/C3-families-with-dues-tile.png` });
  await expect(list.tile('Families with dues')).toContainText(String(families));
});

test('AC4 switching student -> family: issued student challans stay per student, the next cycle is combined', async () => {
  test.setTimeout(8 * 60_000);
  const res = await f.updatePolicy(owner, (await f.latestPolicyVersion(seed.rootId)).id, { generateChallansPerStudent: false });
  expect(res.status(), await res.text()).toBe(200);
  expect((await f.latestPolicyVersion(seed.rootId)).perStudent).toBe(false);
  await f.waitForSchedulerPass(owner.tenantId);
  expect(await f.challans(owner.tenantId)).toHaveLength(6);
  // Nov student challans become Sep (two months back, so their numbers cannot clash with Oct's).
  await f.shiftIssuedCycleBack(owner.tenantId, CYCLE, 2);
  const all = await f.waitForChallans(owner.tenantId, 8);
  const novF = familyChallan(all, alpha)!;
  expect(novF.perStudent).toBe(false);
  expect(novF.lineStudents.sort()).toEqual([alpha.id, bravo.id, charlie.id].sort());
  expect(novF.total).toBe(4500);
  const students = all.filter((c) => c.perStudent);
  expect(students).toHaveLength(4);
  for (const c of students) expect(c.cycleStart).toBe('2026-09-01');
  const page = await f.pending(owner.api);
  expect(page.generateChallansPerStudent).toBe(false);
  const total = page.items.reduce((a: number, i: any) => a + i.amountDue, 0);
  expect(page.summary.amountOutstanding).toBe(total);
  const fam = await f.ok(await f.outstanding(owner.api, alpha.familyId), 'family read');
  expect(fam.totalOutstanding).toBe(novF.remaining);
  const rowsF = page.items.filter((i) => i.familyId === alpha.familyId);
  expect(fam.householdOutstanding).toBe(rowsF.reduce((a: number, i: any) => a + i.amountDue, 0));
});
