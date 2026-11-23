/**
 * PR 578 (Abdullah) — two Fee Payment bugs:
 *   z94x8eefv5  a part-paid challan that goes past its due date shows BOTH "Partly paid" and "Overdue" badges and is listed
 *               under BOTH the Partly paid and the Overdue status filters (Pending = neither).
 *   z94x8eeg1z  a school that bills per student titles the first tile "Students with dues" and counts students with dues;
 *               the Overdue tile counts students ("N students"). A family-billing school keeps "Families with dues" /
 *               "N families" (regression check).
 * Umair's fee rules checked on the way: a campus bills all-family or all-student (each world here is one mode only); family
 * mode lists one row per family; amounts show as whole rupees.
 *
 * Worlds (Worker scheduler issues the cycle; due dates moved with DB SETUP):
 *   student mode S: family F = Alpha (Class 1) + Bravo (Class 2), family G = Solo (Class 1); tuition 1,000 each.
 *     Alpha: PKR 400 paid, due date 5 days ago  -> Partly paid + Overdue
 *     Solo:  unpaid, due date 5 days ago        -> Overdue only
 *     Bravo: unpaid, due date in the future     -> Pending only
 *   family mode M: family H = Hotel + India (Class 1, 2), family J = Juliet, family K = Kilo; tuition 1,000 per student.
 *     H: PKR 500 paid, overdue                  -> Partly paid + Overdue
 *     J: unpaid, overdue                         -> Overdue only
 *     K: unpaid, due in the future               -> Pending only
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FeePaymentPage, signInToWebApp } from '../../pages/fees/AccountOffice';
import { newCampusOwner, type CampusOwner } from '../../fixtures/campus-owner';
import * as f from '../../fixtures/fees';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
// Default mode: one failed check must not hide the others (a worker restart re-seeds both campuses).
test.describe.configure({ mode: 'default' });

interface World { owner: CampusOwner; students: Record<string, f.Student>; issued: f.ChallanRow[] }
let S: World; let M: World;
const log: Record<string, unknown> = {};
const save = () => { mkdirSync(EV, { recursive: true }); writeFileSync(path.join(EV, 'pr578-data.json'), JSON.stringify(log, null, 2)); };

async function makeWorld(label: string, perStudent: boolean, spec: [string, number, string][]): Promise<World> {
  const o = await newCampusOwner(label);
  const sc = await f.setupSchool(o, 2);
  const mobiles: Record<string, string> = {}; const fathers: Record<string, string> = {};
  const students: Record<string, f.Student> = {};
  for (const [name, cls, fam] of spec) {
    mobiles[fam] ??= f.familyMobile(); fathers[fam] ??= f.personName(`Father${fam}`);
    students[name] = await f.addStudent(o, { name: f.personName(name), classId: sc.classes[cls].id, fatherName: fathers[fam], fatherMobile: mobiles[fam] });
  }
  const root = await f.createSchoolPolicy(o, { tuition: 1000, perStudent });
  expect(root.status, JSON.stringify(root.body)).toBe(201);
  return { owner: o, students, issued: [] };
}

async function setDue(tenantId: string, challanIds: string[], daysFromToday: number) {
  if (!challanIds.length) return;
  await f.dbSetup(`PR 578: due date ${daysFromToday} days from today`, `
    update "FeeChallans" set "DueDate" = (current_date + (${daysFromToday}) * interval '1 day')
    where "TenantId" = '${tenantId}' and "Id" in (${challanIds.map((i) => `'${i}'`).join(',')})`);
}

test.beforeAll(async () => {
  test.setTimeout(12 * 60_000);
  S = await makeWorld('pr578-s', true, [['Alpha', 0, 'F'], ['Bravo', 1, 'F'], ['Solo', 0, 'G']]);
  M = await makeWorld('pr578-m', false, [['Hotel', 0, 'H'], ['India', 1, 'H'], ['Juliet', 0, 'J'], ['Kilo', 1, 'K']]);
  S.issued = await f.waitForChallans(S.owner.tenantId, 3);
  M.issued = await f.waitForChallans(M.owner.tenantId, 3);
  const sOf = (n: string) => S.issued.find((c) => c.primaryStudentId === S.students[n].id)!;
  const mOf = (n: string) => M.issued.find((c) => c.familyId === M.students[n].familyId)!;
  // Pay first (a payment must not be refused as late), then move the due dates.
  await f.ok(await f.pay(S.owner.api, S.students.Alpha.familyId, 400, { challanId: sOf('Alpha').id }), 'pay Alpha 400');
  await f.ok(await f.pay(M.owner.api, M.students.Hotel.familyId, 500), 'pay family H 500');
  await setDue(S.owner.tenantId, [sOf('Alpha').id, sOf('Solo').id], -5);
  await setDue(S.owner.tenantId, [sOf('Bravo').id], 10);
  await setDue(M.owner.tenantId, [mOf('Hotel').id, mOf('Juliet').id], -5);
  await setDue(M.owner.tenantId, [mOf('Kilo').id], 10);
  log.tenants = { student: S.owner.tenantId, family: M.owner.tenantId };
  log.issued = { student: S.issued.map((c) => ({ id: c.id, total: c.total })), family: M.issued.map((c) => ({ id: c.id, total: c.total })) };
  save();
});

test.afterAll(async () => { await S?.owner.api.dispose(); await M?.owner.api.dispose(); });

const nameOf = (w: World, n: string) => w.students[n].name;
const rowKey = (i: any) => `${i.familyName ?? ''}|${(i.students ?? []).map((s: any) => s.name ?? s.studentName).join(',')}|${i.challanNumber ?? ''}`;

async function statusApi(w: World, status?: string) {
  const q = `page=1&pageSize=100${status ? `&status=${encodeURIComponent(status)}` : ''}`;
  return f.pending(w.owner.api, q);
}
/** Which of the world's people a page's items cover (student name or family member name in the item JSON). */
function who(w: World, items: any[]): string[] {
  const text = JSON.stringify(items).toLowerCase();
  return Object.keys(w.students).filter((n) => text.includes(w.students[n].name.toLowerCase())).sort();
}

test('z94x8eefv5 API (student mode): part-paid + overdue row carries both flags and answers both filters', async () => {
  const all = await statusApi(S);
  const partly = await statusApi(S, 'Partly paid');
  const overdue = await statusApi(S, 'Overdue');
  const pendingOnly = await statusApi(S, 'Pending');
  log.studentApi = { all: all.items, summary: all.summary, partly: who(S, partly.items), overdue: who(S, overdue.items), pending: who(S, pendingOnly.items) };
  save();
  expect(all.generateChallansPerStudent).toBe(true);
  expect(all.items).toHaveLength(3);
  const alpha = all.items.find((i) => JSON.stringify(i).toLowerCase().includes(nameOf(S, 'Alpha').toLowerCase()));
  expect(alpha.status).toBe('Overdue');
  expect(alpha.isPartlyPaid).toBe(true);
  expect(who(S, partly.items)).toEqual(['Alpha']);
  expect(who(S, overdue.items)).toEqual(['Alpha', 'Solo']);
  expect(who(S, pendingOnly.items)).toEqual(['Bravo']);
});

test('z94x8eeg1z API: student mode counts students; family mode counts families', async () => {
  const s = await statusApi(S);
  const m = await statusApi(M);
  log.summaries = { student: s.summary, family: m.summary, familyRows: m.items.length };
  save();
  expect(s.summary.pendingChallans, 'students with dues').toBe(3);
  expect(s.summary.overdueChallans, 'overdue students').toBe(2);
  expect(m.generateChallansPerStudent).toBe(false);
  expect(m.items, 'family mode: one row per family').toHaveLength(3);
  expect(m.summary.pendingChallans, 'families with dues').toBe(3);
  expect(m.summary.overdueChallans, 'overdue families').toBe(2);
});

test('z94x8eefv5 API (family mode): part-paid + overdue family has both flags and answers both filters', async () => {
  const all = await statusApi(M);
  const h = all.items.find((i) => i.familyId === M.students.Hotel.familyId);
  expect(h.status).toBe('Overdue');
  expect(h.isPartlyPaid).toBe(true);
  const fam = async (st: string) => (await statusApi(M, st)).items.map((i) => i.familyId).sort();
  const F = (n: string) => M.students[n].familyId;
  expect(await fam('Partly paid')).toEqual([F('Hotel')]);
  expect(await fam('Overdue')).toEqual([F('Hotel'), F('Juliet')].sort());
  expect(await fam('Pending')).toEqual([F('Kilo')]);
});

const signedIn = new WeakSet<Page>();
async function openList(page: Page, w: World, query = '') {
  if (!signedIn.has(page)) { await signInToWebApp(page, w.owner.credentials()); signedIn.add(page); }
  const list = new FeePaymentPage(page);
  await list.open();
  if (query) {
    await page.goto(`/accounts/fee-payment${query}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);
  }
  return list;
}

/** The list's own Status filter: Open filters -> "Statuses" select -> Apply; waits for the filtered read. */
async function setStatus(page: Page, status: string | null) {
  await page.getByRole('button', { name: 'Open filters' }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('combobox', { name: 'Statuses' }) }).first();
  await expect(dialog).toBeVisible();
  const select = dialog.getByRole('combobox', { name: 'Statuses' });
  await select.selectOption({ label: status ?? 'All statuses' });
  const read = page.waitForResponse((r) => r.url().includes('/fee-payments/pending-challans'), { timeout: 20_000 }).catch(() => null);
  const apply = dialog.getByRole('button', { name: /^Apply/ });
  if (await apply.count()) await apply.click(); else await page.keyboard.press('Escape');
  await read;
  await page.waitForTimeout(1200);
}
async function badges(page: Page, rowText: string) {
  return page.getByRole('row').filter({ hasText: rowText }).first().locator('[data-status-badge]').allInnerTexts().then((b) => b.map((x) => x.trim()));
}

for (const vp of [{ w: 1366, h: 900, tag: 'desktop' }, { w: 390, h: 844, tag: 'phone' }]) {
  test(`z94x8eefv5 + z94x8eeg1z UI student mode (${vp.tag}): two badges, tiles say students`, async ({ browser }) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: vp.w, height: vp.h }, timezoneId: 'Asia/Karachi', baseURL: process.env.QA_BASE_URL });
    const page = await ctx.newPage();
    const list = await openList(page, S);
    await expect(page.locator('[data-tile="families"]')).toContainText('Students with dues');
    await expect(page.locator('[data-tile="families"]')).not.toContainText('Families with dues');
    await expect(page.locator('[data-tile="families"]')).toContainText(/\b3\b/);
    await expect(page.locator('[data-tile="overdue"]')).toContainText(/\b2 students\b/);
    // Whole rupees on the Outstanding tile: 1,000 x 3 - 400 = 2,600.
    // Soft: a late fine (if the policy adds one) could raise it; the point is whole rupees.
    await expect.soft(page.locator('[data-tile="outstanding"]')).toContainText(/2,600|2\.6K|2\.6k/);
    await expect(page.locator('[data-tile="outstanding"]')).not.toContainText(/\.\d\d\b/);
    expect(await badges(page, nameOf(S, 'Alpha'))).toEqual(['Partly paid', 'Overdue']);
    expect(await badges(page, nameOf(S, 'Solo'))).toEqual(['Overdue']);
    expect(await badges(page, nameOf(S, 'Bravo'))).toEqual(['Pending']);
    // Badges do not overlap each other (phone width included).
    const boxes = await page.getByRole('row').filter({ hasText: nameOf(S, 'Alpha') }).first().locator('[data-status-badge]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
    if (boxes.length === 2) {
      const [a, b] = boxes as any[];
      const overl = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overl, 'badges overlap').toBe(false);
    }
    await page.screenshot({ path: path.join(EV, `pr578-student-mode-${vp.tag}.png`), fullPage: true });
    void list;
    await ctx.close();
  });
}

test('z94x8eefv5 UI student mode: the Status filter lists Alpha under Partly paid AND under Overdue', async ({ page }) => {
  const results: Record<string, string[]> = {};
  await openList(page, S);
  for (const st of ['Partly paid', 'Overdue', 'Pending']) {
    await setStatus(page, st);
    const names = await new FeePaymentPage(page).rowNames();
    results[st] = Object.keys(S.students).filter((n) => names.some((x) => x.toLowerCase().includes(S.students[n].name.toLowerCase()))).sort();
    await page.screenshot({ path: path.join(EV, `pr578-student-filter-${st.replace(' ', '-')}.png`), fullPage: true });
  }
  log.uiFilters = results; save();
  expect(results['Partly paid']).toEqual(['Alpha']);
  expect(results['Overdue']).toEqual(['Alpha', 'Solo']);
  expect(results['Pending']).toEqual(['Bravo']);
});

test('regression UI family mode: "Families with dues", "N families", one row per family, two badges on the part-paid overdue family', async ({ page }) => {
  await openList(page, M);
  await expect(page.locator('[data-tile="families"]')).toContainText('Families with dues');
  await expect(page.locator('[data-tile="families"]')).toContainText(/\b3\b/);
  await expect(page.locator('[data-tile="overdue"]')).toContainText(/\b2 families\b/);
  const names = await new FeePaymentPage(page).rowNames();
  expect(names, 'one row per family').toHaveLength(3);
  const hRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: /^Receive from / }) }).filter({ hasText: nameOf(M, 'Hotel') }).first();
  const hBadges = (await hRow.locator('[data-status-badge]').allInnerTexts()).map((x) => x.trim());
  log.familyUi = { names, hBadges }; save();
  expect(hBadges).toEqual(['Partly paid', 'Overdue']);
  await page.screenshot({ path: path.join(EV, 'pr578-family-mode.png'), fullPage: true });
  await setStatus(page, 'Partly paid');
  await page.screenshot({ path: path.join(EV, 'pr578-family-filter-Partly-paid.png'), fullPage: true });
  expect(await new FeePaymentPage(page).rowNames()).toHaveLength(1);
  await setStatus(page, 'Overdue');
  await page.screenshot({ path: path.join(EV, 'pr578-family-filter-Overdue.png'), fullPage: true });
  expect(await new FeePaymentPage(page).rowNames()).toHaveLength(2);
  await setStatus(page, 'Pending');
  expect(await new FeePaymentPage(page).rowNames()).toHaveLength(1);
});

test('PR 578 Fee Dashboard + Defaulters: student mode speaks of students, family mode of families (soft)', async ({ browser }) => {
  for (const [w, noun, tag] of [[S, 'student', 'student'], [M, 'famil', 'family']] as const) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Karachi', baseURL: process.env.QA_BASE_URL });
    const page = await ctx.newPage();
    await signInToWebApp(page, w.owner.credentials());
    await page.goto('/accounts/dashboard');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2500);
    const dash = await page.getByRole('main').innerText();
    await page.screenshot({ path: path.join(EV, `pr578-dashboard-${tag}.png`), fullPage: true });
    await page.goto('/accounts/dashboard/defaulters');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2500);
    const def = await page.getByRole('main').innerText();
    await page.screenshot({ path: path.join(EV, `pr578-defaulters-${tag}.png`), fullPage: true });
    log[`dash-${tag}`] = dash.slice(0, 3000); log[`def-${tag}`] = def.slice(0, 3000); save();
    expect.soft(dash, `${tag}: dashboard uncleared dues title`).toMatch(new RegExp(`${tag === 'student' ? 'Students' : 'Families'} with uncleared dues`));
    expect.soft(def.toLowerCase(), `${tag}: defaulters wording`).toContain(noun);
    expect.soft(dash + def, `${tag}: whole rupees only`).not.toMatch(/(PKR|Rs)\s?[\d,]+\.\d{1,2}\b/);
    await ctx.close();
  }
});
