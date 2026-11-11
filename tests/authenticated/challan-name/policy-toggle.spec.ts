/**
 * PR 547 / ClickUp z94x8eapp5 — AC1: the "Challan name" switch on the school (root) fee policy editor only.
 * Set-up (add) through the UI, edit (saved + reloaded), history; absent on class add/edit/duplicate; a crafted
 * class-policy request cannot set it. One throwaway campus for the file (no challan generation needed).
 * Tests run in file order: the first one creates the school policy through the UI.
 */
import { test, expect, devices } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { newCampusOwner, type CampusOwner } from '../../../fixtures/campus-owner';
import * as f from '../../../fixtures/fees';
import { FeePolicyEditor, ROUTES, signInToWebApp } from '../../../pages/fees/AccountOffice';

// Evidence folder of the QA cycle running the suite (QA_EVIDENCE_DIR), defaulting to cycle 1's.
const EV = process.env.QA_EVIDENCE_DIR ?? '/workspace/qa-cycles/pr-555/cycle-1/evidence';
const DESCRIPTION =
  'Off: one combined challan under the family name. On: a separate challan for each student. Applies from the next fee cycle; issued challans keep their grouping.';

test.describe.configure({ mode: 'default' });

interface Seed {
  school: f.SchoolSetup;
}

let owner: CampusOwner;
let seed: Seed;

test.beforeAll(async ({}, testInfo) => {
  test.setTimeout(4 * 60_000);
  const seeded = await f.seededOnce<Seed>(testInfo.project.outputDir, 'policy-toggle', async () => {
    const o = await newCampusOwner('cn-toggle');
    const sc = await f.setupSchool(o, 2);
    await f.addStudent(o, { name: f.personName('Toggle'), classId: sc.classes[0].id, fatherName: f.personName('Fathert'), fatherMobile: f.familyMobile() });
    console.log(`tenant ${o.tenantId}`);
    return { owner: o, data: { school: sc } };
  });
  owner = seeded.owner;
  seed = seeded.data;
});

/** The school policy's first version id (created by the UI test, or by API when that test did not get that far). */
async function rootPolicyId(): Promise<string> {
  const rows = await f.sql(`select "Id" from "FeePolicies" where "TenantId" = ${f.sqlQuote(owner.tenantId)} and "PolicyType" = 'Root' order by "VersionNumber" limit 1`);
  if (rows.length) return rows[0][0];
  const created = await f.createSchoolPolicy(owner, { tuition: 1500 });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.id;
}

async function classPolicyId(): Promise<string> {
  const rows = await f.sql(`select "Id" from "FeePolicies" where "TenantId" = ${f.sqlQuote(owner.tenantId)} and "PolicyType" = 'Class' and "VersionNumber" = 1 order by "CreatedDate" limit 1`);
  if (rows.length) return rows[0][0];
  const created = await f.createClassPolicy(owner, (await f.latestPolicyVersion(await rootPolicyId())).id, [seed.school.classes[0].id], { tuition: 1800 });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.id;
}

test('AC1 school policy set-up: the "Challan name" switch is off by default, keyboard operable, and saved with the policy', async ({ page }) => {
  await signInToWebApp(page, owner.credentials());
  const editor = new FeePolicyEditor(page);
  await editor.open(ROUTES.newSchoolPolicy);
  await writeFile(`${EV}/aria-policy-editor-new-school.txt`, await page.getByRole('main').ariaSnapshot());
  await expect(editor.heading).toHaveText('Set up school policy');
  await expect(editor.challanNameSection).toBeVisible();
  await expect(editor.perStudentToggle).not.toBeChecked();
  await expect(page.getByText(DESCRIPTION)).toBeVisible();
  await editor.perStudentToggle.focus();
  await page.keyboard.press('Space');
  await expect(editor.perStudentToggle).toBeChecked();
  await editor.perStudentToggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EV}/ui-policy-toggle-new-school-desktop.png`, fullPage: true });
  await editor.fillSchoolPolicy({ tuition: 1500, generationDay: f.todaysGenerationDay(), dueDay: 25 });
  await editor.publish();
  await expect.poll(async () => (await f.sql(`select count(*) from "FeePolicies" where "TenantId" = ${f.sqlQuote(owner.tenantId)} and "PolicyType" = 'Root'`))[0][0], { timeout: 30_000 }).toBe('1');
  const root = await f.latestPolicyVersion(await rootPolicyId());
  expect(root.perStudent, 'saved with the switch on').toBe(true);
});

test('AC1 Pixel 5: the switch and its copy fit the phone layout', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['Pixel 5'], ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await signInToWebApp(page, owner.credentials());
  const editor = new FeePolicyEditor(page);
  await editor.open(ROUTES.editPolicy((await f.latestPolicyVersion(await rootPolicyId())).id));
  await editor.perStudentToggle.scrollIntoViewIfNeeded();
  await expect(editor.perStudentToggle).toBeInViewport();
  const box = await editor.perStudentToggle.boundingBox();
  expect(box!.x + box!.width, 'switch inside the 393px viewport').toBeLessThanOrEqual(393);
  await page.screenshot({ path: `${EV}/ui-policy-toggle-pixel5.png` });
  await ctx.close();
});

test('AC1 editing the school policy: switch off, saved as a new version, reloads off, recorded in history', async ({ page }) => {
  await signInToWebApp(page, owner.credentials());
  const editor = new FeePolicyEditor(page);
  const current = await f.latestPolicyVersion(await rootPolicyId());
  await editor.open(ROUTES.editPolicy(current.id));
  await expect(editor.heading).toHaveText('School policy settings');
  await expect(editor.perStudentToggle).toBeChecked({ checked: current.perStudent });
  const target = !current.perStudent;
  await editor.setPerStudent(target);
  await editor.save();
  await editor.confirmIfAsked();
  await expect.poll(async () => (await f.latestPolicyVersion(current.id)).perStudent, { timeout: 30_000 }).toBe(target);
  const saved = await f.latestPolicyVersion(current.id);
  expect(saved.version).toBe(current.version + 1);
  const eff = await f.sql(`select to_char("EffectiveFrom" at time zone 'UTC','YYYY-MM-DD'), "Status" from "FeePolicies" where "Id" = ${f.sqlQuote(saved.id)}`);
  console.log(`saved version ${saved.version} effectiveFrom=${eff[0][0]} status=${eff[0][1]}`);
  await page.screenshot({ path: `${EV}/ui-policy-toggle-saved.png`, fullPage: true });
  await editor.open(ROUTES.editPolicy(saved.id));
  await expect(editor.perStudentToggle).toBeChecked({ checked: target });
  const detail = await f.policyDetail(owner, saved.id);
  expect(detail.generateChallansPerStudent).toBe(target);
  const [before, after] = current.perStudent ? ['Student', 'Family'] : ['Family', 'Student'];
  expect(detail.versionHistory.flatMap((v: any) => v.changes)).toContainEqual(expect.objectContaining({ fieldName: 'Challan Name', beforeValue: before, afterValue: after }));
  // Fee Payment lays itself out from the active school policy's mode right after the change.
  expect((await f.pending(owner.api)).generateChallansPerStudent).toBe(target);
});

test('AC1 no switch on class policies: add, edit and duplicate; the class policy reads the root\'s setting', async ({ page }) => {
  const cls = await classPolicyId();
  const root = await f.latestPolicyVersion(await rootPolicyId());
  expect((await f.policyDetail(owner, cls)).generateChallansPerStudent).toBe(root.perStudent);
  await signInToWebApp(page, owner.credentials());
  const editor = new FeePolicyEditor(page);
  for (const [url, title] of [
    [ROUTES.newClassPolicy, 'Add class policy'],
    [ROUTES.editPolicy(cls), 'Edit class policy'],
    [ROUTES.duplicateClassPolicy(cls), 'Duplicate class policy'],
  ] as const) {
    await editor.open(url);
    await expect(editor.heading).toHaveText(title);
    await expect(editor.challanNameSection, `${title}: no Challan name section`).toHaveCount(0);
    await expect(editor.perStudentToggle, `${title}: no switch`).toHaveCount(0);
  }
  await page.screenshot({ path: `${EV}/ui-policy-class-duplicate-no-toggle.png`, fullPage: true });
});

test('AC1 a crafted class-policy request cannot set the switch (create and update store false; root decides)', async () => {
  const rootNow = await f.latestPolicyVersion(await rootPolicyId());
  if (rootNow.perStudent) expect((await f.updatePolicy(owner, rootNow.id, { generateChallansPerStudent: false })).status()).toBe(200);
  const created = await f.createClassPolicy(owner, (await f.latestPolicyVersion(rootNow.id)).id, [seed.school.classes[1].id], { tuition: 900, perStudent: true });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const stored = await f.sql(`select "GenerateChallansPerStudent" from "FeePolicies" where "Id" = ${f.sqlQuote(created.id)}`);
  expect(stored[0][0]).toBe('f');
  expect((await f.policyDetail(owner, created.id)).generateChallansPerStudent).toBe(false);
  const upd = await f.updatePolicy(owner, created.id, { generateChallansPerStudent: true, tuitionFee: 950 });
  expect(upd.status(), await upd.text()).toBe(200);
  expect((await f.latestPolicyVersion(created.id)).perStudent).toBe(false);
});

test('AC1 omitting the field on update keeps the saved value (older clients)', async () => {
  const before = await f.latestPolicyVersion(await rootPolicyId());
  expect((await f.updatePolicy(owner, before.id, { generateChallansPerStudent: true })).status()).toBe(200);
  const on = await f.latestPolicyVersion(before.id);
  expect(on.perStudent).toBe(true);
  expect((await f.updatePolicy(owner, on.id, { tuitionFee: 1600 })).status()).toBe(200);
  expect((await f.latestPolicyVersion(before.id)).perStudent).toBe(true);
});
