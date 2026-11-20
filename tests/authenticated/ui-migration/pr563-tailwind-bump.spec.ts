/**
 * PR 563 (TailwindUi.Blazor 2026.11.19.43 → 2026.11.20.45): library #41 ButtonGroupItem Color / SelectedVariant (QA card
 * z94x8eb5vm, attendance Present/Absent colours) and #40 DateInput open month (QA card z94x8ebrbk, date-of-birth calendars).
 *
 * Every test records computed styles (canvas-resolved to rgba) and screenshots to QA_EVIDENCE_DIR, keyed by QA_PR563_BUILD
 * (`main` or `pr`, default `pr`). Run once on a main build to write `pr563-styles-main.json`, then on the PR build:
 * - the #41 expectations (Present selected = success tint, Absent selected = solid danger with a white dot) run only when the
 *   build has the feature (the Absent dot turns white when selected); on older builds those tests skip;
 * - every style the PR must NOT change (unselected status buttons, List/Roll call, sittings, payroll item type groups, date
 *   picker open month and disabled days) is compared with the main baseline when the baseline file exists.
 * Also: end-to-end quick add of a student with both dates picked in the calendar, and a submitted register with one Absent.
 * Runs as the seeded CI owner; makes its own class, students and staff.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { AttendanceApi } from '../../../fixtures/attendance';
import { quickAddStudent } from '../../../fixtures/ui-migration';
import { addStaff, markLeft } from '../../../fixtures/payroll';

// Not serial: one failing check must not skip the others; a failure restarts the worker and beforeAll re-seeds.
test.describe.configure({ mode: 'default' });

const EVIDENCE = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '../../../test-results/pr563');
const BUILD = process.env.QA_PR563_BUILD ?? 'pr';
const STYLES_FILE = (build: string) => path.join(EVIDENCE, `pr563-styles-${build}.json`);
const baseline: Record<string, any> | null = BUILD !== 'main' && fs.existsSync(STYLES_FILE('main')) ? JSON.parse(fs.readFileSync(STYLES_FILE('main'), 'utf8')) : null;
const recorded: Record<string, any> = fs.existsSync(STYLES_FILE(BUILD)) ? JSON.parse(fs.readFileSync(STYLES_FILE(BUILD), 'utf8')) : {};
const record = (key: string, value: unknown) => {
  recorded[key] = value;
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(STYLES_FILE(BUILD), JSON.stringify(recorded, null, 2));
};
const shot = async (target: Page | Locator, name: string) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: path.join(EVIDENCE, `pr563-${BUILD}-${name}.png`), animations: 'disabled' });
};
/** The PR must leave this style exactly as main draws it. */
const sameAsMain = (key: string, value: unknown) => {
  record(key, value);
  if (!baseline) return;
  expect.soft(value, `${key}: must match the main build`).toEqual(baseline[key]);
};

type Rgba = [number, number, number, number];
interface Look { bg: Rgba; text: Rgba; shadow: string; border: Rgba; dot: Rgba | null }

/** Computed colours of a button, resolved through a canvas so oklch / color-mix come back as rgba. */
async function look(button: Locator): Promise<Look> {
  return button.evaluate((el) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const rgba = (c: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], Math.round((d[3] / 255) * 100) / 100];
    };
    const cs = getComputedStyle(el);
    const svg = el.querySelector('svg');
    return {
      bg: rgba(cs.backgroundColor), text: rgba(cs.color), border: rgba(cs.borderTopColor),
      // Colours inside box-shadow (ring / inset-ring) resolved one by one.
      shadow: cs.boxShadow.replace(/(oklch|rgba?|color-mix|lab|oklab)\([^()]*(\([^()]*\)[^()]*)*\)/g, (m) => `rgba(${rgba(m).join(',')})`),
      dot: svg ? rgba(getComputedStyle(svg).fill) : null,
    };
  });
}
async function hovered(page: Page, button: Locator): Promise<Look> {
  await button.hover();
  await page.waitForTimeout(250);
  const l = await look(button);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(250);
  return l;
}
// Green family: green is the top channel (a pale success-50 tint like 243,248,245 counts).
const isGreen = ([r, g, b]: Rgba) => g > r && g >= b;
// A tint, not a solid fill: translucent, or a low-saturation colour (a solid success fill would be strongly saturated).
const isTint = ([r, g, b, a]: Rgba) => a < 1 || Math.max(r, g, b) - Math.min(r, g, b) < 60;
const isRed = ([r, g, b]: Rgba) => r > 150 && r > g + 60 && r > b + 60;

const karachiIso = (offsetDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86_400_000));
const monthTitle = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
};
const setDark = async (page: Page, dark: boolean) => {
  await page.addInitScript((d) => { try { localStorage.setItem('tailwindui-blazor-theme', d ? 'dark' : 'light'); } catch { /* blocked */ } }, dark);
};

let api: AttendanceApi;
let sectionId = '';
let pupils: { id: string; fullName: string }[] = [];

test.beforeAll(async () => {
  api = await AttendanceApi.signIn();
  const className = `QA563 ${Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('')}`;
  const created = await api.http.post('classes/create', { data: { className, grade: '6', sections: [{ sectionName: 'A', size: 40 }], subjects: null } });
  expect(created.status(), `create class ${className}: ${await created.text()}`).toBe(201);
  const classId = (await created.json()).id as string;
  const sections = (await (await api.http.get('attendance-register/sections')).json()) as Array<{ sectionId: string; classId: string }>;
  sectionId = sections.find((s) => s.classId === classId)!.sectionId;
  for (let i = 0; i < 3; i++) pupils.push(await quickAddStudent(api.http, classId));
});
test.afterAll(async () => { await api?.dispose(); });

async function openRegister(page: Page, dark: boolean, opts: { sittings?: boolean } = {}) {
  await setDark(page, dark);
  if (opts.sittings) {
    // The school calendar configures one sitting, so the sitting toggle never renders: add After break to the response.
    await page.route(/attendance-register\/today/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const s = body.sittings ?? body.Sittings ?? [0];
      body.sittings = typeof s[0] === 'number' ? [0, 1] : ['Morning', 'AfterBreak'];
      await route.fulfill({ response: res, json: body });
    });
  }
  await page.goto(`/classrooms/attendance?section=${sectionId}&view=today`);
  await expect(page.getByRole('heading', { name: 'Attendance Register', level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('group', { name: `Status of ${pupils[0].fullName}`, exact: true })).toBeVisible({ timeout: 20_000 });
  expect(await page.locator('html').evaluate((h) => h.classList.contains('dark'))).toBe(dark);
}
const statusButton = (page: Page, pupil: { fullName: string }, name: 'Present' | 'Absent') =>
  page.getByRole('group', { name: `Status of ${pupil.fullName}`, exact: true }).getByRole('button', { name, exact: true });

for (const dark of [false, true]) {
  const mode = dark ? 'dark' : 'light';

  test(`PR563-REG-${mode.toUpperCase()}: Present selected is a success tint, Absent selected is solid danger with a white dot; unselected and hover as main (${mode})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openRegister(page, dark);
    const [p0, p1] = pupils;
    // p1 is marked Absent (local draft, nothing submitted).
    await statusButton(page, p1, 'Absent').click();
    await expect(statusButton(page, p1, 'Absent')).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(1, 1);
    await page.waitForTimeout(400);

    const presentSel = await look(statusButton(page, p0, 'Present'));
    const absentUnsel = await look(statusButton(page, p0, 'Absent'));
    const absentSel = await look(statusButton(page, p1, 'Absent'));
    const presentUnsel = await look(statusButton(page, p1, 'Present'));
    const hov = {
      presentSel: await hovered(page, statusButton(page, p0, 'Present')),
      absentUnsel: await hovered(page, statusButton(page, p0, 'Absent')),
      absentSel: await hovered(page, statusButton(page, p1, 'Absent')),
      presentUnsel: await hovered(page, statusButton(page, p1, 'Present')),
    };
    record(`register-${mode}`, { presentSel, absentSel, presentUnsel, absentUnsel, hover: hov });

    const roster = page.locator('[data-roster]');
    await shot(roster, `register-${mode}`);
    await shot(page.getByRole('group', { name: `Status of ${p0.fullName}`, exact: true }), `register-${mode}-present-selected`);
    await shot(page.getByRole('group', { name: `Status of ${p1.fullName}`, exact: true }), `register-${mode}-absent-selected`);
    for (const [who, name, tag] of [[p0, 'Present', 'hover-present-selected'], [p1, 'Absent', 'hover-absent-selected'], [p0, 'Absent', 'hover-absent-unselected'], [p1, 'Present', 'hover-present-unselected']] as const) {
      await statusButton(page, who, name).hover();
      await page.waitForTimeout(250);
      await shot(page.getByRole('group', { name: `Status of ${who.fullName}`, exact: true }), `register-${mode}-${tag}`);
    }
    await page.mouse.move(1, 1);

    // Unselected buttons look exactly as on main, at rest and on hover (dot colours included).
    sameAsMain(`register-${mode}-unselected`, { presentUnsel: { ...presentUnsel, dot: presentUnsel.dot }, absentUnsel });
    sameAsMain(`register-${mode}-unselected-hover`, { presentUnsel: hov.presentUnsel, absentUnsel: hov.absentUnsel });

    const hasFeature = absentSel.dot !== null && absentSel.dot.slice(0, 3).every((c) => c === 255);
    test.skip(!hasFeature && BUILD === 'main', 'main build: baseline recorded, #41 expectations need the bump');
    // #41: Present selected = success tint (translucent green), Absent selected = solid danger, white dot.
    expect.soft(isGreen(presentSel.bg), `Present selected background ${presentSel.bg} is green`).toBe(true);
    expect.soft(isTint(presentSel.bg), `Present selected ${presentSel.bg} is a tint, not a solid fill`).toBe(true);
    expect.soft(isGreen(presentSel.text), `Present selected text ${presentSel.text} is green`).toBe(true);
    expect.soft(isRed(absentSel.bg), `Absent selected background ${absentSel.bg} is red`).toBe(true);
    expect.soft(absentSel.bg[3], 'Absent selected is solid').toBe(1);
    expect.soft(absentSel.dot, 'Absent selected dot is white').toEqual([255, 255, 255, 1]);
    expect.soft(absentSel.text.slice(0, 3).every((c) => c > 230), `Absent selected text ${absentSel.text} is white`).toBe(true);
    // Hover keeps the colour family and shows a change.
    expect.soft(isGreen(hov.presentSel.bg), `Present selected hover ${hov.presentSel.bg} stays green`).toBe(true);
    expect.soft(isRed(hov.absentSel.bg), `Absent selected hover ${hov.absentSel.bg} stays red`).toBe(true);
    expect.soft(hov.absentSel.bg, 'Absent selected hover is visible').not.toEqual(absentSel.bg);
    expect.soft(hov.presentSel.bg, 'Present selected hover is visible').not.toEqual(presentSel.bg);
    // Present selected never uses the danger colour.
    expect.soft(isRed(presentSel.bg), 'Present selected is not red').toBe(false);
  });

  test(`PR563-MODE-GROUP-${mode.toUpperCase()}: List / Roll call keep main's look, at rest and on hover (${mode})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openRegister(page, dark);
    const group = page.locator('[data-marking-mode]');
    const list = group.getByRole('button', { name: 'List', exact: true });
    const roll = group.getByRole('button', { name: 'Roll call', exact: true });
    await page.mouse.move(1, 1);
    const value = { listSel: await look(list), rollUnsel: await look(roll), rollHover: await hovered(page, roll), listHover: await hovered(page, list) };
    await shot(group, `mode-group-${mode}`);
    sameAsMain(`mode-group-${mode}`, value);
  });

  test(`PR563-SITTINGS-${mode.toUpperCase()}: the sitting toggle (two sittings injected) keeps main's look (${mode})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openRegister(page, dark, { sittings: true });
    const group = page.locator('[data-sitting]');
    await expect(group).toBeVisible();
    const [morning, after] = await group.getByRole('button').all();
    await page.mouse.move(1, 1);
    const value = { selected: await look(morning), unselected: await look(after), unselectedHover: await hovered(page, after), selectedHover: await hovered(page, morning) };
    await shot(group, `sittings-${mode}`);
    sameAsMain(`sittings-${mode}`, value);
  });

  test(`PR563-PAYROLL-GROUPS-${mode.toUpperCase()}: incentive / deduction form button groups keep main's look (${mode})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setDark(page, dark);
    await page.goto('/accounts/staff-payroll/incentives-and-deductions/new');
    const groups = page.locator('[data-type-group], [data-amount-type-group], [data-category-group]');
    await expect(groups.first()).toBeVisible({ timeout: 30_000 });
    const value: Record<string, unknown> = {};
    for (const sel of ['[data-type-group]', '[data-amount-type-group]', '[data-category-group]']) {
      const g = page.locator(sel);
      if (!(await g.count())) continue;
      const buttons = await g.getByRole('button').all();
      value[sel] = [];
      for (const b of buttons) (value[sel] as unknown[]).push({ pressed: await b.getAttribute('aria-pressed'), rest: await look(b) });
      const unselected = buttons.length > 1 ? buttons[1] : buttons[0];
      (value as any)[`${sel}-hover`] = await hovered(page, unselected);
      await shot(g, `payroll-${sel.replace(/\W/g, '')}-${mode}`);
    }
    sameAsMain(`payroll-groups-${mode}`, value);
  });
}

// ── #40 DateInput open month ────────────────────────────────────────────────────────────────────────────────────────────
interface PickerView { title: string; enabled: number; disabled: number; todayEnabled: boolean | null; tomorrowEnabled: boolean | null }
async function openPicker(page: Page, inputId: string, tag: string): Promise<PickerView> {
  const field = page.locator(`#${inputId}-field`);
  await expect(field).toBeVisible({ timeout: 20_000 });
  await field.locator('[data-date-trigger]').click();
  const panel = page.locator('[data-date-panel]:visible').first();
  await expect(panel).toBeVisible();
  const title = (await panel.locator('[data-calendar-title]').innerText()).trim();
  const days = panel.locator('button:has(time[datetime])');
  const states = await days.evaluateAll((bs) => bs.map((b) => ({ d: b.querySelector('time')!.getAttribute('datetime')!, on: !(b as HTMLButtonElement).disabled })));
  const find = (iso: string) => states.find((s) => s.d === iso)?.on ?? null;
  const view = { title, enabled: states.filter((s) => s.on).length, disabled: states.filter((s) => !s.on).length, todayEnabled: find(karachiIso()), tomorrowEnabled: find(karachiIso(1)) };
  await shot(panel, `picker-${tag}`);
  await page.keyboard.press('Escape');
  return view;
}

test.describe('PR563 date pickers (#40)', () => {
  test('PR563-DOB-PICKERS: Add Staff, student quick add, student profile and staff profile DOB open on the current month, future days disabled; same as main', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const views: Record<string, PickerView> = {};
    await page.goto('/staff/register/new');
    views.addStaffDob = await openPicker(page, 'add-staff-date-of-birth', 'add-staff-dob');
    views.addStaffJoining = await openPicker(page, 'add-staff-date-of-joining', 'add-staff-joining');

    await page.goto('/registrar/students');
    const add = page.getByRole('button', { name: /^Add (first )?student$/ }).first();
    await expect(add).toBeVisible({ timeout: 30_000 });
    await add.click();
    views.quickAddDob = await openPicker(page, 'add-student-dob', 'quick-add-dob');
    views.quickAddAdmission = await openPicker(page, 'add-student-admission-date', 'quick-add-admission');

    await page.goto(`/registrar/students/${pupils[2].id}`);
    views.studentProfileDob = await openPicker(page, 'profile-basic-dob', 'student-profile-dob');
    views.studentProfileAdmission = await openPicker(page, 'profile-basic-admission-date', 'student-profile-admission');

    const staff = await addStaff(api.http, { salary: 30_000 });
    await page.goto(`/staff/register/${staff.id}?section=basic`);
    views.staffProfileDob = await openPicker(page, 'staff-basic-dob', 'staff-profile-dob');
    await page.goto(`/staff/register/${staff.id}?section=employment`);
    views.staffProfileJoining = await openPicker(page, 'staff-employment-joining', 'staff-profile-joining');
    record('pickers', views);

    for (const k of ['addStaffDob', 'quickAddDob', 'studentProfileDob', 'staffProfileDob']) {
      // A value set on the profile (seeded DOB) opens on that value's month: only the empty Add forms must open on today.
      if (k === 'addStaffDob' || k === 'quickAddDob') expect.soft(views[k].title, `${k} opens on ${monthTitle(karachiIso())}`).toBe(monthTitle(karachiIso()));
      if (views[k].title === monthTitle(karachiIso())) {
        expect.soft(views[k].todayEnabled, `${k}: today pickable`).toBe(true);
        if (karachiIso(1).slice(0, 7) === karachiIso().slice(0, 7)) expect.soft(views[k].tomorrowEnabled, `${k}: tomorrow disabled`).toBe(false);
      }
    }
    sameAsMain('pickers-all', views);
  });

  test('PR563-STAFF-LIFECYCLE-PICKERS: Mark as left and Rehire open inside their ranges; same as main', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const views: Record<string, PickerView> = {};
    const joined = '2026-08-03';
    const staff = await addStaff(api.http, { salary: 30_000, joined });
    await page.goto(`/staff/register/${staff.id}?section=employment`);
    const markBtn = page.locator('[data-action="mark-as-left"]');
    await expect(markBtn).toBeVisible({ timeout: 30_000 });
    await markBtn.click();
    views.markAsLeft = await openPicker(page, 'mark-as-left-date', 'mark-as-left');
    await shot(page.locator('#staff-mark-as-left-modal'), 'mark-as-left-modal');

    await markLeft(api.http, staff.id, '2026-09-15');
    await page.goto(`/staff/register/${staff.id}?section=employment`);
    const rehire = page.locator('[data-action="rehire"]');
    await expect(rehire).toBeVisible({ timeout: 30_000 });
    await rehire.click();
    await expect(page.locator('#rehire-date-field')).toBeVisible({ timeout: 20_000 });
    views.rehire = await openPicker(page, 'rehire-date', 'rehire');
    await shot(page.locator('#staff-rehire-modal'), 'rehire-modal');
    record('lifecycle-pickers', views);
    // Range 15 Sep … today: opens on a month inside it with pickable days.
    expect.soft(views.rehire.enabled, 'rehire opens on a month with pickable days').toBeGreaterThan(0);
    expect.soft(['September 2026', 'October 2026', monthTitle(karachiIso())]).toContain(views.rehire.title);
    expect.soft(views.markAsLeft.enabled, 'mark as left opens on a month with pickable days').toBeGreaterThan(0);
    sameAsMain('lifecycle-pickers', views);
  });
});

// ── General visual sweep (screenshots only; compared offline) ───────────────────────────────────────────────────────────
const SWEEP = [
  '/', '/registrar/students', '/staff/register', '/staff/register/new', '/classrooms/classes', '/classrooms/attendance',
  '/accounts/dashboard', '/accounts/fee-policies', '/accounts/fee-payment', '/accounts/additional-funds', '/accounts/staff-payroll',
  '/accounts/staff-payroll/policy', '/accounts/staff-payroll/incentives-and-deductions', '/exams/dashboard', '/exams/datesheet',
  '/exams/marksheets', '/exams/mastersheet', '/exams/papers', '/setup/sessions', '/setup/campus-settings', '/setup/roles',
  '/setup/subscription', '/bookshop/inventory', '/bookshop/kits', '/bookshop/point-of-sale', '/bookshop/day-close', '/bookshop/sales-history',
];
for (const dark of [false, true]) {
  const mode = dark ? 'dark' : 'light';
  test(`PR563-SWEEP-${mode.toUpperCase()}: main screens render without an error banner (${mode}); screenshots for the offline diff`, async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await setDark(page, dark);
    const errors: string[] = [];
    // The stack's self-signed certificate stops the service worker registering; that is the test stack, not the app.
    page.on('pageerror', (e) => { if (!/ServiceWorker/.test(e.message)) errors.push(`${page.url()}: ${e.message}`); });
    for (const route of SWEEP) {
      await page.goto(route);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);
      await expect.soft(page.locator('#blazor-error-ui:visible'), `${route}: Blazor error banner`).toHaveCount(0);
      await page.mouse.move(1, 1);
      await shot(page, `sweep-${mode}${route === '/' ? '-home' : route.replace(/\//g, '-')}`);
    }
    // A few overlays: a select dropdown, a drawer and a dialog.
    await page.goto(`/staff/register/new`);
    await page.waitForTimeout(1500);
    const combo = page.getByRole('combobox').first();
    if (await combo.count()) { await combo.click().catch(() => {}); await page.waitForTimeout(500); await shot(page, `sweep-${mode}-overlay-select`); await page.keyboard.press('Escape'); }
    await page.goto(`/registrar/students/${pupils[0].id}`);
    await page.waitForTimeout(2000);
    await shot(page, `sweep-${mode}-student-profile`);
    const menu = page.getByRole('button', { name: /actions|more|options/i }).first();
    if (await menu.count()) { await menu.click().catch(() => {}); await page.waitForTimeout(500); await shot(page, `sweep-${mode}-overlay-menu`); await page.keyboard.press('Escape'); }
    record(`sweep-errors-${mode}`, errors);
    expect.soft(errors, 'page errors').toEqual([]);
  });
}

// ── End to end on the bumped library: register a student from the Admission Register and take attendance ────────────────
async function pickInCalendar(page: Page, inputId: string, iso: string) {
  await page.locator(`#${inputId}-field [data-date-trigger]`).click();
  const panel = page.locator('[data-date-panel]:visible').first();
  await expect(panel).toBeVisible();
  await panel.locator(`button:has(time[datetime="${iso}"])`).click();
  await expect(panel).toBeHidden();
}
async function pickOption(page: Page, selectId: string, label: RegExp) {
  const trigger = page.locator(`#${selectId}`);
  // The library Select is a native <select> styled by the theme; a custom listbox gets a click and an option click.
  if ((await trigger.evaluate((el) => el.tagName)) === 'SELECT') {
    const value = await trigger.locator('option').evaluateAll((os, src) => (os as HTMLOptionElement[]).find((o) => new RegExp(src, 'i').test(o.label.trim()))?.value ?? null, label.source);
    expect(value, `${selectId} has an option ${label}`).not.toBeNull();
    await trigger.selectOption(value!);
    return;
  }
  await trigger.click();
  await page.getByRole('option', { name: label }).first().click();
}

test('PR563-E2E-STUDENT: quick add from the Admission Register with both dates picked in the calendar saves the student', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const created = await api.http.post('classes/create', { data: { className: `QA563 Reg ${Date.now() % 100000}`, grade: '5', sections: [{ sectionName: 'A', size: 40 }], subjects: null } });
  expect(created.status()).toBe(201);
  const cls = await created.json();
  const first = `${karachiIso().slice(0, 8)}02`;
  const fullName = `Qa ${['Amna', 'Bilal', 'Sana', 'Omar'][Math.floor(Math.random() * 4)]} ${'Reg' + 'abcdefghij'[Math.floor(Math.random() * 10)]}`.replace(/\d/g, '');
  const admissionId = `R563${Math.floor(Math.random() * 9000 + 1000)}`;
  await page.goto('/registrar/students');
  await page.getByRole('button', { name: /^Add (first )?student$/ }).first().click();
  await page.locator('#add-student-name').fill(fullName);
  await page.locator('#add-student-admission-id').fill(admissionId);
  await page.locator('#add-student-admission-id').press('Tab');
  await pickInCalendar(page, 'add-student-admission-date', first);
  // DOB: open, walk back to a past month with the previous-month button, pick the 10th.
  await page.locator('#add-student-dob-field [data-date-trigger]').click();
  const panel = page.locator('[data-date-panel]:visible').first();
  await expect(panel.locator('[data-calendar-title]')).toContainText(monthTitle(karachiIso()));
  await panel.getByRole('button', { name: /previous/i }).first().click();
  const prevTitle = (await panel.locator('[data-calendar-title]').innerText()).trim();
  await shot(panel, 'e2e-dob-previous-month');
  const tenth = await panel.locator('button:has(time[datetime$="-10"])').first();
  const dobIso = (await tenth.locator('time').getAttribute('datetime'))!;
  await tenth.click();
  await pickOption(page, 'add-student-gender', /^Male$/);
  await pickOption(page, 'add-student-class', new RegExp(cls.className ?? 'QA563 Reg', 'i')).catch(async () => pickOption(page, 'add-student-class', /QA563 Reg/i));
  await page.locator('#add-student-father').fill('Qa Father');
  await page.locator('#add-student-mobile').fill(`0321563${Math.floor(Math.random() * 9000 + 1000)}`);
  await shot(page, 'e2e-quick-add-filled');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect.poll(async () => {
    const r = await api.http.get('students/paged', { params: { pageSize: '20', search: admissionId } });
    const b = await r.json();
    return ((b.items ?? b.rows ?? b.data ?? []) as any[]).length;
  }, { timeout: 20_000, message: `student ${admissionId} saved` }).toBe(1);
  await shot(page, 'e2e-quick-add-saved');
  record('e2e-student', { admissionId, admissionDate: first, dob: dobIso, dobMonth: prevTitle });
});

test('PR563-E2E-ATTENDANCE: mark one pupil Absent with the new buttons, submit, the server and month grid agree', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openRegister(page, false);
  await statusButton(page, pupils[2], 'Absent').click();
  await expect(statusButton(page, pupils[2], 'Absent')).toHaveAttribute('aria-pressed', 'true');
  await expect(statusButton(page, pupils[2], 'Present')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Submit attendance', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await shot(dialog, 'e2e-attendance-submit-dialog');
  await dialog.getByRole('button', { name: /submit|confirm|yes/i }).last().click();
  await expect(page.getByRole('status').filter({ has: page.getByRole('heading', { name: 'Attendance submitted' }) })).toBeVisible({ timeout: 20_000 });
  await shot(page, 'e2e-attendance-submitted');
  const reg = await api.register(sectionId);
  const statusOf = (id: string) => JSON.stringify((reg.students as any[]).find((s) => s.studentId === id));
  expect(statusOf(pupils[2].id)).toMatch(/absent|"status":1|"mark":1/i);
  // Read-only after submit: badges, no toggles; the Absent badge is danger, Present success.
  await expect(page.locator(`[data-status-badge="${pupils[2].id}"]`)).toContainText(/Absent/i);
  await expect(page.locator(`[data-status-badge="${pupils[0].id}"]`)).toContainText(/Present/i);
});
