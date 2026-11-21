/**
 * PR 567 / ClickUp z94x8e8wb2 — Calendar "N absent" chip/popover shows the standard class label.
 *
 * Ticket: display the grade with the class name, and capitalize the section.
 * Jamie-qa fail: popover read "Alia Jqorange — Orange A" (section capitalized, grade missing).
 * Expected on other screens, and after this fix: "Name — Orange-7 (A)" on desktop and mobile widths.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { newCampusOwner, cacheOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { letters } from '../../fixtures/access-roles';
import { signInToWebApp } from '../../pages/fees/AccountOffice';
import * as f from '../../fixtures/fees';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.resolve(EV, '..', 'seed');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';

test.describe.configure({ mode: 'serial' });

const pad = (n: number) => String(n).padStart(2, '0');
const pktToday = () => {
  const d = new Date(Date.now() + 5 * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

let owner: CampusOwner;
let today: string;
let names: string[] = [];

async function openPopover(page: Page): Promise<string> {
  // Desktop and phone each render a copy; only one is visible at a given width (hidden lg:block / lg:hidden).
  const chip = page.locator(`[data-home-absent="${today}"]`).locator('visible=true').first();
  await expect(chip, `today's absent chip data-home-absent=${today}`).toBeVisible({ timeout: 30_000 });
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  await page.waitForTimeout(800);
  const pop = page.locator('[role="dialog"]:visible, [popover]:popover-open, [data-home-absent-popover]:visible, [role="tooltip"]:visible').first();
  if (await pop.count()) {
    return pop.innerText();
  }
  // Hover fallback if click didn't open a dialog (some widths use a hover popover).
  await chip.hover();
  await page.waitForTimeout(800);
  const texts = await page.locator('[role="dialog"], [popover], [data-home-absent-popover], [role="tooltip"]').allInnerTexts();
  return texts.filter(Boolean).join('\n---\n');
}

test.beforeAll(async () => {
  test.setTimeout(8 * 60_000);
  mkdirSync(EV, { recursive: true });
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  owner = await newCampusOwner('pr567');
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
  }), 'class orange');
  const kids = ['Alia', 'Bilal', 'Daniyal'];
  const created: { id: string; name: string }[] = [];
  for (const first of kids) {
    const fullName = `${first} ${letters(8).replace(/^./, (c) => c.toUpperCase())}`;
    const res = await owner.api.post('students/quick-add', {
      data: {
        fullName, admissionId: `P567-${letters(5).toUpperCase()}`,
        fatherName: `Father ${letters(5)}`, mobileNumber: `0340${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
        classId: orange.id, admissionDate: '2026-09-01T00:00:00Z', dateOfBirth: '2014-02-02T00:00:00Z', gender: 0,
      },
    });
    expect(res.status(), `quick-add ${fullName}: ${(await res.text()).slice(0, 300)}`).toBe(201);
    created.push({ id: (await res.json()).id as string, name: fullName });
  }
  names = created.map((k) => k.name);
  today = pktToday();
  const sections = await f.ok(await owner.api.get('attendance-register/sections'), 'sections') as Array<{ sectionId: string; classId: string; sectionName: string }>;
  const section = sections.find((s) => s.classId === orange.id);
  expect(section, 'Orange A section').toBeTruthy();
  const reg = await f.ok(await owner.api.get('attendance-register/today', { params: { sectionId: section!.sectionId, date: today } }), 'register');
  const marks = (reg.students as Array<{ studentId: string }>).map((st) => ({ studentId: st.studentId, status: 1 }));
  expect(marks.length, 'pupils on the register').toBe(3);
  const sub = await owner.api.post('attendance-register/submit', {
    data: { sectionId: section!.sectionId, registerDate: today, sitting: 0, marks, expectedVersion: reg.version ?? 0 },
  });
  expect(sub.status(), `submit register: ${(await sub.text()).slice(0, 400)}`).toBeLessThan(300);
  const cached = cacheOwner(owner);
  writeFileSync(path.join(SEED_DIR, 'seed.json'), JSON.stringify({
    email: cached.email, phone: cached.phone, tenantId: cached.tenantId, today, names, password: cached.password,
  }), { mode: 0o600 });
  try { chmodSync(SEED_DIR, 0o700); } catch { /* */ }
});

for (const vp of [
  { name: 'desktop', width: 1440, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
] as const) {
  test(`Calendar absent popover on ${vp.name} reads "Name — Orange-7 (A)"`, async ({ browser }) => {
    test.setTimeout(3 * 60_000);
    const ctx = await browser.newContext({
      ignoreHTTPSErrors,
      baseURL: process.env.QA_BASE_URL,
      timezoneId: 'Asia/Karachi',
      viewport: { width: vp.width, height: vp.height },
    });
    const page = await ctx.newPage();
    await signInToWebApp(page, owner.credentials());
    await page.goto('/');
    const chip = page.locator(`[data-home-absent="${today}"]`).locator('visible=true').first();
    await chip.scrollIntoViewIfNeeded();
    await expect(chip).toBeVisible({ timeout: 45_000 });
    const popover = await openPopover(page);
    await page.screenshot({ path: path.join(EV, `absent-popover-${vp.name}.png`), fullPage: true });
    writeFileSync(path.join(EV, `popover-${vp.name}.txt`), popover);
    expect(popover, `${vp.name} popover was empty`).toBeTruthy();
    for (const name of names) {
      expect(popover, `${vp.name}: missing ${name}`).toContain(name);
      // The pre-fix line was "Name — Orange A". After the fix: "Name — Orange-7 (A)".
      expect(popover, `${vp.name}: expected "${name} — Orange-7 (A)", got:\n${popover}`).toMatch(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+[—–-]\\s+Orange-7 \\(A\\)`));
    }
    expect(popover, `${vp.name}: old grade-less "Orange A" must not remain`).not.toMatch(/Orange A(?!\s*\()/);
    await ctx.close();
  });
}
