/**
 * PR 582 / ClickUp z94x8e8wb2 (UAT reopen of PR 567) — Home calendar "N absent" popover class label.
 *
 * UAT fail (23 Nov): the popover read "Play Group-K (A)". Expected the standard form "Play Group (A)", like "Orange-7 (A)".
 * Fix c9de38bd: ToClassSectionLabel drops the grade when it is "K" (trimmed, case-insensitive); other grades stay.
 *
 * ACs (ticket/acs.md):
 *  AC-L1 kindergarten: "Play Group (A)", never "Play Group-K (A)" / "Play Group-k (A)", desktop and 390 px.
 *  AC-L2 normal grade: "Orange-7 (A)".
 *  AC-L3 ordinal: class "9th" grade "9" -> "9th-9 (A)" (grade kept, suffix lowercase, never "9Th").
 *  AC-L5 no HTTP 5xx on Home / dashboard/absences; each popover line is "Name — Class label" only.
 * Extra boundary: a class whose grade is stored as lowercase "k" also drops the grade ("Nursery (A)").
 *
 * Self-seeding: one throwaway campus (newCampusOwner), a current session, four one-section classes with one pupil each,
 * today's Morning register submitted with every pupil absent. No DB manipulation. Local stack only. Serial, one worker.
 * The existing PR 567 spec (tests/access-roles/pr567-absentee-label.spec.ts) stays as it is; this file extends the idea.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { newCampusOwner, cacheOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { letters } from '../../fixtures/access-roles';
import { todayPkt } from '../../fixtures/attendance';
import { signInToWebApp } from '../../pages/fees/AccountOffice';
import * as f from '../../fixtures/fees';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.resolve(EV, '..', 'seed');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';

test.describe.configure({ mode: 'serial' });

interface Seeded { key: string; className: string; grade: string; want: string; id?: string; pupil?: string; error?: string }
/** Class as typed (stored lowercase by the app), grade, and the label the popover must show. */
const CLASSES: Seeded[] = [
  { key: 'playgroup', className: 'play group', grade: 'K', want: 'Play Group (A)' },
  { key: 'orange', className: 'orange', grade: '7', want: 'Orange-7 (A)' },
  { key: 'ninth', className: '9th', grade: '9', want: '9th-9 (A)' },
  { key: 'nursery-lower-k', className: 'nursery', grade: 'k', want: 'Nursery (A)' },
];
const BAD = [/Play Group\s*-\s*K/i, /Nursery\s*-\s*K/i, /\d(St|Nd|Rd|Th)\b/, /9th-K/i, /9th \(A\)/];

let owner: CampusOwner;
let today: string;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function evPath(name: string) {
  mkdirSync(EV, { recursive: true });
  return path.join(EV, `pr582-label-${name}`);
}

async function openPopoverLines(page: Page): Promise<{ text: string; lines: string[] }> {
  // Desktop and phone each render a copy; only one is visible at a given width.
  const chip = page.locator(`[data-home-absent="${today}"]`).locator('visible=true').first();
  await expect(chip, `today's absent chip data-home-absent=${today}`).toBeVisible({ timeout: 45_000 });
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  await page.waitForTimeout(800);
  let panel = page.locator('[role="dialog"]:visible, [popover]:popover-open, [role="tooltip"]:visible').filter({ has: page.locator('li') }).first();
  if (!(await panel.count())) {
    await chip.hover();
    await page.waitForTimeout(800);
    panel = page.locator('[role="dialog"]:visible, [popover]:popover-open, [role="tooltip"]:visible').filter({ has: page.locator('li') }).first();
  }
  await expect(panel, 'absent popover panel').toBeVisible({ timeout: 10_000 });
  const lines = (await panel.locator('li').allInnerTexts()).map((l) => l.replace(/\s+/g, ' ').trim());
  return { text: await panel.innerText(), lines };
}

test.beforeAll(async () => {
  test.setTimeout(8 * 60_000);
  mkdirSync(EV, { recursive: true });
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  today = todayPkt();
  owner = await newCampusOwner('pr582lbl');
  const cached = cacheOwner(owner);
  writeFileSync(path.join(SEED_DIR, 'seed-pr582-label.json'), JSON.stringify({ email: cached.email, phone: cached.phone, tenantId: cached.tenantId, password: cached.password }), { mode: 0o600 });
  try { chmodSync(SEED_DIR, 0o700); } catch { /* */ }
  await f.ok(await owner.api.post('sessions/create', {
    data: {
      sessionName: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30',
      terms: [
        { termName: 'Term 1', termStartDate: '2026-09-01', termEndDate: '2026-12-31', passingCriteria: 40 },
        { termName: 'Term 2', termStartDate: '2027-01-01', termEndDate: '2027-06-30', passingCriteria: 40 },
      ],
    },
  }), 'sessions/create');
  const sections = async () => f.ok(await owner.api.get('attendance-register/sections'), 'sections') as Promise<Array<{ sectionId: string; classId: string; sectionName: string }>>;
  for (const c of CLASSES) {
    const r = await owner.api.post('classes/create', { data: { className: c.className, grade: c.grade, sections: [{ sectionName: 'A', size: 40 }], subjects: null } });
    const body = await r.text();
    if (r.status() >= 300) { c.error = `HTTP ${r.status()} ${body.slice(0, 200)}`; continue; }
    c.id = JSON.parse(body).id as string;
    // Letters only (QuickAdd rejects digits); one at a time (concurrent quick-adds race on the roll number).
    const fullName = `${c.key.slice(0, 1).toUpperCase()}${letters(4)} ${letters(7).replace(/^./, (x) => x.toUpperCase())}`;
    const res = await owner.api.post('students/quick-add', {
      data: {
        fullName, admissionId: `P582-${letters(5).toUpperCase()}`, fatherName: `Father ${letters(5)}`,
        mobileNumber: `0341582${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`,
        classId: c.id, admissionDate: '2026-09-01T00:00:00Z', dateOfBirth: '2020-02-02T00:00:00Z', gender: 0,
      },
    });
    expect(res.status(), `quick-add ${fullName}: ${(await res.text()).slice(0, 300)}`).toBe(201);
    c.pupil = fullName;
  }
  const all = await sections();
  for (const c of CLASSES.filter((x) => x.id)) {
    const section = all.find((s) => s.classId === c.id);
    expect(section, `section A of ${c.className}`).toBeTruthy();
    const reg = await f.ok(await owner.api.get('attendance-register/today', { params: { sectionId: section!.sectionId, date: today } }), `register ${c.className}`);
    const marks = (reg.students as Array<{ studentId: string }>).map((st) => ({ studentId: st.studentId, status: 1 }));
    expect(marks.length, `${c.className}: pupils on the register`).toBe(1);
    const sub = await owner.api.post('attendance-register/submit', {
      data: { sectionId: section!.sectionId, registerDate: today, sitting: 0, marks, expectedVersion: reg.version ?? 0 },
    });
    expect(sub.status(), `submit ${c.className}: ${(await sub.text()).slice(0, 300)}`).toBeLessThan(300);
  }
  writeFileSync(evPath('seed.json'), JSON.stringify({ tenantId: owner.tenantId, today, classes: CLASSES }, null, 2));
});

test.afterAll(async () => { await owner?.api.dispose(); });

test('AC-L1/L2/L3/L5 API: dashboard/absences classLabel is "Play Group (A)", "Orange-7 (A)", "9th-9 (A)"', async () => {
  expect(CLASSES.filter((c) => c.key !== 'nursery-lower-k' && c.error), 'core classes created').toEqual([]);
  const res = await owner.api.get('dashboard/absences', { params: { month: today.slice(0, 7) } });
  expect(res.status(), 'GET dashboard/absences').toBe(200);
  const body = await res.json() as { days: Array<{ date: string; absentCount: number; students: Array<Record<string, unknown>> }> };
  const day = body.days.find((d) => d.date.startsWith(today));
  writeFileSync(evPath('api-absences.json'), JSON.stringify(day, null, 2));
  expect(day, `absence day ${today}`).toBeTruthy();
  for (const c of CLASSES.filter((x) => x.pupil)) {
    const s = day!.students.find((st) => String(st.name).toLowerCase() === c.pupil!.toLowerCase());
    expect(s, `${c.pupil} in today's absences`).toBeTruthy();
    expect(s!.classLabel, `${c.className}/${c.grade}`).toBe(c.want);
  }
  const labels = day!.students.map((s) => String(s.classLabel)).join('\n');
  for (const bad of BAD) expect(labels, `no ${bad}`).not.toMatch(bad);
});

for (const vp of [
  { name: 'desktop-1440', width: 1440, height: 1000 },
  { name: 'desktop-1280', width: 1280, height: 900 },
  { name: 'mobile-390', width: 390, height: 844 },
] as const) {
  test(`AC-L1/L2/L3/L5 popover on ${vp.name}: "Play Group (A)", "Orange-7 (A)", "9th-9 (A)", name + class only`, async ({ browser }: { browser: Browser }) => {
    test.setTimeout(3 * 60_000);
    const ctx = await browser.newContext({ ignoreHTTPSErrors, baseURL: process.env.QA_BASE_URL, timezoneId: 'Asia/Karachi', viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.request().method()} ${r.url()} -> ${r.status()}`); });
    await signInToWebApp(page, owner.credentials());
    await page.goto('/');
    const { text, lines } = await openPopoverLines(page);
    await page.screenshot({ path: evPath(`popover-${vp.name}.png`), fullPage: vp.width < 500 });
    writeFileSync(evPath(`popover-${vp.name}.txt`), `${text}\n\n--- lines ---\n${lines.join('\n')}`);
    const seeded = CLASSES.filter((c) => c.pupil);
    expect(lines.length, `${vp.name}: one line per absent pupil`).toBe(seeded.length);
    for (const c of seeded) {
      // "Name — Label" and nothing else on the line (AC-L5: the earlier trim still holds).
      const line = lines.find((l) => l.toLowerCase().startsWith(c.pupil!.toLowerCase()));
      expect(line, `${vp.name}: line for ${c.pupil}`).toBeTruthy();
      expect(line!, `${vp.name}: ${c.className}/${c.grade}`).toMatch(new RegExp(`^${esc(c.pupil!)}\\s+—\\s+${esc(c.want)}$`, 'i'));
    }
    for (const bad of BAD) expect(lines.join('\n'), `${vp.name}: no ${bad}`).not.toMatch(bad);
    expect(errors, `${vp.name}: no HTTP 5xx on Home`).toEqual([]);
    await ctx.close();
  });
}
