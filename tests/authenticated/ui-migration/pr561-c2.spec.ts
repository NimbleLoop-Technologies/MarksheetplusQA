/**
 * PR 561 cycle 2 (head d495973e): Dan's follow-ups on the CU-86ey2erpk QA subtasks.
 * - eber8 #2 / C1-STRIKE-OFF-STALE: Students.LastSectionId is written in the strike-off transaction, so the last class shows at once
 *   (profile header, Basic card "Last class"/"Last section", Admission Register row and class filter); re-admission clears it.
 * - ebrbk #3 / library #40: date of birth has no age limit, only future dates are refused (client and server); the calendar opens on
 *   the current month with pickable days.
 * - TailwindUi.Blazor 2026.11.19.43: #39 (a dropdown item fires once per gesture: eb5wf archive class, eber8 #1, ebrbk #1/#2, ed105)
 *   and #42 (eberb: tooltips on truncated rail labels, badge descriptions).
 * Runs as the seeded CI owner; every test makes its own class / student / staff.
 */
import { test, expect, type Page, type Locator, type APIRequestContext } from '@playwright/test';
import path from 'node:path';
import { createClass, ownerApi, profile, quickAddStudent, strikeOff, letters } from '../../../fixtures/ui-migration';
import { addStaff } from '../../../fixtures/payroll';

const EVIDENCE = process.env.QA_EVIDENCE_DIR;
const shot = async (page: Page, name: string, target?: Locator) => {
  if (!EVIDENCE) return;
  await (target ?? page).screenshot({ path: path.join(EVIDENCE, `c2-${name}.png`) });
};
const karachiIso = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};
const ddMmmYyyy = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
};
const monthTitle = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
};
const label = (cls: { name: string; grade: string }) => new RegExp(`^${cls.name}-${cls.grade} \\(A\\)$`, 'i');

async function quickAdd(api: APIRequestContext, classId: string | null, dateOfBirth: string) {
  const res = await api.post('students/quick-add', {
    data: { fullName: `Qa ${letters(6)}`.replace(/ (.)/, (_, c) => ` ${c.toUpperCase()}`), admissionId: `Q561${letters(4).toUpperCase()}`, fatherName: 'Qa Father',
      mobileNumber: `0321561${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`, classId, admissionDate: karachiIso(), dateOfBirth: `${dateOfBirth}T00:00:00Z`, gender: 0 },
  });
  const body = await res.text();
  return { status: res.status(), body, id: res.status() === 201 ? (JSON.parse(body).id as string) : null };
}

async function registerRows(api: APIRequestContext, params: Record<string, string>) {
  const res = await api.get('students/paged', { params: { pageSize: '100', ...params } });
  expect(res.status(), `GET students/paged ${JSON.stringify(params)}`).toBe(200);
  const body = await res.json();
  return (body.items ?? body.rows ?? body.data ?? []) as any[];
}

// ── eber8 #2 / C1-STRIKE-OFF-STALE / C1-BASIC-CARD ─────────────────────────────────────────────────────────────────────
test.describe('PR 561 c2 — z94x8eber8 #2 last class written with the strike-off', () => {
  test('C2-LAST-CLASS-IMMEDIATE: right after the strike-off call, profile, register row and class filter name the class left @smoke', async () => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const pupil = await quickAddStudent(api, cls.id);
    await strikeOff(api, pupil.id);
    const p = await profile(api, pupil.id); // no polling: written in the strike-off transaction
    expect(p.status).toBe(1);
    expect(p.classId ?? null).toBeNull();
    expect(p.sectionId ?? null).toBeNull();
    expect(String(p.lastClassSection ?? '')).toMatch(label(cls));
    expect(String(p.lastClassName ?? '').toLowerCase()).toBe(`${cls.name} - ${cls.grade}`.toLowerCase());
    expect(p.lastSectionName).toBe('A');
    const row = ((await (await api.get('students')).json()) as any[]).find((s) => s.id === pupil.id);
    expect(String(row?.classSection ?? '')).toMatch(label(cls));
    const filtered = await registerRows(api, { classId: cls.id });
    expect(filtered.map((r) => r.id), 'class filter includes the struck-off student by last class').toContain(pupil.id);
    const struck = await registerRows(api, { classId: cls.id, status: 'Struck off' });
    expect(struck.map((r) => r.id)).toContain(pupil.id);
    const other = await createClass(api, '8');
    expect((await registerRows(api, { classId: other.id })).map((r) => r.id)).not.toContain(pupil.id);
    await api.dispose();
  });

  test('C2-STRIKE-OFF-IN-UI (C1-STRIKE-OFF-STALE): in-profile strike-off shows the class left in the header and Basic card without a reload @smoke', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const pupil = await quickAddStudent(api, cls.id);
    await page.goto(`/registrar/students/${pupil.id}`);
    await expect(page.getByText(/Section A/).first()).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-action="strike-off"]').click();
    const modal = page.locator('[data-strike-off-body]');
    await modal.getByRole('radio').first().check();
    await page.locator('[data-action="confirm-strike-off"]').click();
    await expect(modal).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(label(cls)).first(), 'header without reload').toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Last class', { exact: true }).first()).toBeVisible({ timeout: 5_000 });
    await shot(page, 'strike-off-in-ui');
    await api.dispose();
  });

  test('C2-BASIC-LAST-CLASS (C1-BASIC-CARD): struck-off Basic card shows locked "Last class"/"Last section" with the class left; save keeps the student unplaced', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const pupil = await quickAddStudent(api, cls.id);
    await strikeOff(api, pupil.id);
    await page.goto(`/registrar/students/${pupil.id}`);
    await expect(page.getByText(label(cls)).first()).toBeVisible({ timeout: 20_000 });
    const klass = page.locator('#profile-basic-class');
    const section = page.locator('#profile-basic-section');
    await expect(klass).toBeDisabled();
    await expect(section).toBeDisabled();
    await expect(page.locator('label[for="profile-basic-class"]')).toHaveText('Last class');
    await expect(page.locator('label[for="profile-basic-section"]')).toHaveText('Last section');
    expect((await klass.locator('option:checked').innerText()).toLowerCase()).toBe(`${cls.name} - ${cls.grade}`.toLowerCase());
    expect(await section.locator('option:checked').innerText()).toBe('A');
    await expect(klass).toHaveValue('');
    await expect(section).toHaveValue('');
    await shot(page, 'basic-last-class', page.locator('#profile-basic-class').locator('xpath=ancestor::form[1]').or(page.locator('main')).first());
    const email = page.locator('#profile-basic-email');
    await email.fill(`qa561c2.${Date.now()}@testenv.local`);
    await email.press('Tab');
    await page.locator('[data-action="save-basic"]').click();
    await expect(page.locator('[data-action="save-basic"]')).toBeDisabled({ timeout: 15_000 });
    const after = await profile(api, pupil.id);
    expect(after.email).toContain('qa561c2.');
    expect(after.classId ?? null).toBeNull();
    expect(after.sectionId ?? null).toBeNull();
    expect(after.status).toBe(1);
    expect(String(after.lastClassSection)).toMatch(label(cls));
    await page.reload();
    await expect(page.locator('label[for="profile-basic-class"]')).toHaveText('Last class', { timeout: 20_000 });
    await api.dispose();
  });

  test('C2-READMIT: re-admission into another class clears the last class; header shows the new class', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const next = await createClass(api, '8');
    const pupil = await quickAddStudent(api, cls.id);
    await strikeOff(api, pupil.id);
    const res = await api.post(`students/${pupil.id}/re-admission`, { data: { reAdmissionDate: `${karachiIso()}T00:00:00Z`, classId: next.id, sectionId: next.sectionId } });
    expect(res.status(), `re-admission: ${await res.text()}`).toBeLessThan(300);
    const p = await profile(api, pupil.id);
    expect(p.status).toBe(0);
    expect(p.classId).toBe(next.id);
    expect(p.lastClassSection ?? null).toBeNull();
    expect(p.lastClassName ?? null).toBeNull();
    expect((await registerRows(api, { classId: cls.id })).map((r) => r.id)).not.toContain(pupil.id);
    expect((await registerRows(api, { classId: next.id })).map((r) => r.id)).toContain(pupil.id);
    await page.goto(`/registrar/students/${pupil.id}`);
    await expect(page.locator('label[for="profile-basic-class"]')).toHaveText('Class', { timeout: 20_000 });
    await expect(page.locator('#profile-basic-class')).toHaveValue(next.id);
    await api.dispose();
  });

  test('C2-REGISTER-UI: Admission Register filtered by the class lists the struck-off student under the class left', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const pupil = await quickAddStudent(api, cls.id);
    await strikeOff(api, pupil.id);
    await page.goto('/registrar/students');
    await page.getByPlaceholder('Search by name, admission ID or mobile').fill(pupil.fullName);
    const row = page.getByRole('row').filter({ hasText: pupil.fullName });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText(new RegExp(`${cls.name}-${cls.grade} \\(A\\)`, 'i'));
    await shot(page, 'register-class-filter');
    await api.dispose();
  });
});

// ── ebrbk #3 / library #40: date of birth ───────────────────────────────────────────────────────────────────────
test.describe('PR 561 c2 — date of birth: only future dates refused', () => {
  test('C2-DOB-API: quick-add and add staff accept today and a young age, refuse tomorrow with "cannot be in the future" @smoke', async () => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    for (const iso of [karachiIso(), karachiIso(-365 * 3)]) {
      const r = await quickAdd(api, cls.id, iso);
      expect(r.status, `quick-add DOB ${iso}: ${r.body}`).toBe(201);
    }
    const tomorrow = await quickAdd(api, cls.id, karachiIso(1));
    expect(tomorrow.status, tomorrow.body).toBe(400);
    expect(tomorrow.body).toContain('Date of birth cannot be in the future.');
    // Staff: no 18-year minimum any more.
    const young = await addStaff(api, { salary: 30_000, dob: karachiIso(-365 * 10) });
    expect(young.id).toBeTruthy();
    const todayStaff = await addStaff(api, { salary: 30_000, dob: karachiIso() });
    expect(todayStaff.id).toBeTruthy();
    await expect(addStaff(api, { salary: 30_000, dob: karachiIso(1) })).rejects.toThrow(/400.*Date of birth cannot be in the future/s);
    await api.dispose();
  });

  test('C2-DOB-ADD-STAFF-CALENDAR (ebrbk #3 / #40): the empty DOB calendar opens on the current month, past days and today pickable, tomorrow disabled', async ({ page }) => {
    await page.goto('/staff/register/new');
    const field = page.locator('#add-staff-date-of-birth-field');
    await expect(field).toBeVisible({ timeout: 20_000 });
    await field.locator('[data-date-trigger]').click();
    const panel = page.locator('[data-date-panel]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-calendar-title]')).toContainText(monthTitle(karachiIso()));
    const today = panel.locator(`button:has(time[datetime="${karachiIso()}"])`);
    await expect(today).toBeEnabled();
    const tomorrowIso = karachiIso(1);
    if (tomorrowIso.slice(0, 7) === karachiIso().slice(0, 7)) await expect(panel.locator(`button:has(time[datetime="${tomorrowIso}"])`)).toBeDisabled();
    const first = `${karachiIso().slice(0, 8)}01`;
    await shot(page, 'dob-add-staff-calendar', panel);
    await panel.locator(`button:has(time[datetime="${first}"])`).click();
    await expect(page.locator('#add-staff-date-of-birth')).toHaveValue(ddMmmYyyy(first));
  });

  test('C2-DOB-STUDENT-PROFILE: typing tomorrow is refused on the student profile, today is accepted', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const pupil = await quickAddStudent(api, cls.id);
    await page.goto(`/registrar/students/${pupil.id}`);
    const dob = page.locator('#profile-basic-dob');
    await expect(dob).toBeVisible({ timeout: 20_000 });
    await dob.fill(ddMmmYyyy(karachiIso(1)));
    await dob.press('Tab');
    await expect(dob).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#profile-basic-dob-error')).toHaveText(`Choose a date on or before ${ddMmmYyyy(karachiIso())}.`);
    await expect(page.locator('[data-action="save-basic"]')).toBeDisabled();
    const p1 = await profile(api, pupil.id);
    expect(String(p1.dateOfBirth).slice(0, 10), 'tomorrow must not be saved').not.toBe(karachiIso(1));
    await shot(page, 'dob-student-tomorrow');
    await page.reload();
    await expect(dob).toBeVisible({ timeout: 20_000 });
    await dob.fill(ddMmmYyyy(karachiIso()));
    await dob.press('Tab');
    await page.locator('[data-action="save-basic"]').click();
    await expect.poll(async () => String((await profile(api, pupil.id)).dateOfBirth).slice(0, 10), { timeout: 15_000 }).toBe(karachiIso());
    await api.dispose();
  });
});

// ── TailwindUi.Blazor #39: one activation per gesture ───────────────────────────────────────────────────────────────
interface GestureResult { confirmOpens: number; mutations: number; firstOpenMs: number | null }

async function watchConfirm(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__c2 = { opens: 0, was: false, t0: performance.now(), first: null as number | null };
    const tick = () => {
      const d = document.getElementById('mp-confirm-dialog') as HTMLDialogElement | null;
      const open = !!d?.open;
      if (open && !w.__c2.was) { w.__c2.opens++; if (w.__c2.first === null) w.__c2.first = performance.now() - w.__c2.t0; }
      w.__c2.was = open;
      w.__c2.raf = requestAnimationFrame(tick);
    };
    tick();
  });
}
const readConfirm = (page: Page) => page.evaluate(() => ({ opens: (window as any).__c2.opens as number, first: (window as any).__c2.first as number | null }));

/** QA's gesture: hold the row-menu button ~300 ms, click the item, accept the confirm 50 ms after it opens (forced). */
async function pressThenItem(page: Page, trigger: Locator, item: string, mutation: RegExp): Promise<GestureResult> {
  let mutations = 0;
  const onReq = (r: any) => { if (mutation.test(`${r.method()} ${r.url()}`)) mutations++; };
  page.on('request', onReq);
  await trigger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000); // a search re-render closes an open menu: let the list settle first
  await watchConfirm(page);
  await page.evaluate(() => { (window as any).__c2.t0 = performance.now(); });
  await trigger.click({ delay: 300 });
  await page.locator('el-menu:popover-open').getByText(item, { exact: true }).click({ timeout: 3000 });
  await expect.poll(async () => (await readConfirm(page)).opens, { timeout: 3000 }).toBeGreaterThan(0);
  await page.waitForTimeout(50);
  await page.locator('#mp-confirm-dialog [data-confirm-accept]').click({ force: true, noWaitAfter: true });
  await page.waitForTimeout(2500);
  const c = await readConfirm(page);
  page.off('request', onReq);
  return { confirmOpens: c.opens, mutations, firstOpenMs: c.first };
}

test.describe('PR 561 c2 — TailwindUi.Blazor #39 a menu item fires once per gesture', () => {
  test('C2-LIB39-CLASS (eb5wf / ed105): long press + Archive class + fast accept archives once, one confirm', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    await page.goto('/classrooms/classes');
    await page.getByPlaceholder('Search classes or sections').fill(cls.name);
    const trigger = page.getByRole('button', { name: new RegExp(`^Actions for ${cls.name}`, 'i') });
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    const r = await pressThenItem(page, trigger, 'Archive class', /POST .*\/classes\/[^/]+\/archive$/);
    test.info().annotations.push({ type: 'gesture', description: JSON.stringify(r) });
    expect(r.confirmOpens, 'confirm opened once').toBe(1);
    expect(r.mutations, 'one archive POST').toBe(1);
    await expect(page.locator('#mp-confirm-dialog[open]')).toHaveCount(0);
    await api.dispose();
  });

  test('C2-LIB39-STUDENT (eber8 #1): long press + Archive student + fast accept archives once', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    const pupil = await quickAddStudent(api, cls.id);
    await page.goto('/registrar/students');
    await page.getByPlaceholder('Search by name, admission ID or mobile').fill(pupil.fullName);
    const trigger = page.getByRole('button', { name: new RegExp(`^Actions for ${pupil.fullName}`, 'i') });
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    const r = await pressThenItem(page, trigger, 'Archive', /POST .*\/students\/[^/]+\/archive$/);
    test.info().annotations.push({ type: 'gesture', description: JSON.stringify(r) });
    expect(r.confirmOpens).toBe(1);
    expect(r.mutations).toBe(1);
    expect((await registerRows(api, { archived: 'true', search: pupil.fullName })).map((x) => x.id)).toContain(pupil.id);
    await api.dispose();
  });

  test('C2-LIB39-STAFF (ebrbk #1): long press + Archive staff + fast accept archives once', async ({ page }) => {
    const api = await ownerApi();
    const staff = await addStaff(api, { salary: 30_000 });
    await page.goto('/staff/register');
    await page.getByPlaceholder('Search by name, staff ID or designation').fill(staff.name);
    const trigger = page.getByRole('button', { name: new RegExp(`^Actions for ${staff.name}`, 'i') });
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    const r = await pressThenItem(page, trigger, 'Archive', /POST .*\/staff\/[^/]+\/archive$/);
    test.info().annotations.push({ type: 'gesture', description: JSON.stringify(r) });
    expect(r.confirmOpens).toBe(1);
    expect(r.mutations).toBe(1);
    await api.dispose();
  });

  test('C2-LIB39-QUALIFICATION (ebrbk #2): long press + Remove qualification + fast accept removes once', async ({ page }) => {
    const api = await ownerApi();
    const staff = await addStaff(api, { salary: 30_000 });
    const degree = `Qa Diploma ${letters(5)}`;
    const add = await api.post(`staff/${staff.id}/qualifications`, { data: { degreeOrDiplomaName: degree, institution: 'Qa Institute', subjectOrMajor: null, yearOfCompletion: 2015, gradeOrResult: null, documentUrl: null } });
    expect(add.status(), await add.text()).toBeLessThan(300);
    await page.goto(`/staff/register/${staff.id}?section=qualifications`);
    const trigger = page.getByRole('button', { name: new RegExp(`^Actions for ${degree}`, 'i') }).first();
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    const r = await pressThenItem(page, trigger, 'Remove', /DELETE .*\/staff\/[^/]+\/qualifications\/[^/]+$/);
    test.info().annotations.push({ type: 'gesture', description: JSON.stringify(r) });
    expect(r.confirmOpens).toBe(1);
    expect(r.mutations).toBe(1);
    await api.dispose();
  });

  test('C2-LIB39-KEYBOARD: Enter on a focused menu item still opens the confirm exactly once; Cancel archives nothing', async ({ page }) => {
    const api = await ownerApi();
    const cls = await createClass(api, '8');
    await page.goto('/classrooms/classes');
    await page.getByPlaceholder('Search classes or sections').fill(cls.name);
    const trigger = page.getByRole('button', { name: new RegExp(`^Actions for ${cls.name}`, 'i') });
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    await watchConfirm(page);
    let posts = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && /\/archive$/.test(r.url())) posts++; });
    await page.waitForTimeout(1000);
    await trigger.focus();
    await page.keyboard.press('Enter');
    const item = page.locator('el-menu:popover-open [role="menuitem"]').filter({ hasText: 'Archive class' });
    await expect(item).toBeVisible();
    for (let i = 0; i < 4 && !(await item.evaluate((e) => e === document.activeElement || e.contains(document.activeElement))); i++) await page.keyboard.press('ArrowDown');
    await expect.poll(() => item.evaluate((e) => e === document.activeElement || e.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await readConfirm(page)).opens, { timeout: 3000 }).toBe(1);
    await page.waitForTimeout(800);
    await page.locator('#mp-confirm-dialog [data-confirm-cancel]').click();
    await page.waitForTimeout(800);
    expect((await readConfirm(page)).opens).toBe(1);
    expect(posts).toBe(0);
    await api.dispose();
  });
});

// ── TailwindUi.Blazor #42: rail tooltips (eberb) ───────────────────────────────────────────────────────────────────
test.describe('PR 561 c2 — z94x8eberb rail tooltips', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  // The Admission Office badge counts students not placed in a class; with a badge the label no longer fits at 1280 px.
  let unplaced: string | null = null;
  test.beforeAll(async () => {
    const api = await ownerApi();
    const r = await quickAdd(api, null, '2014-03-03');
    expect(r.status, r.body).toBe(201);
    unplaced = r.id;
    await api.dispose();
  });
  test.afterAll(async () => {
    if (!unplaced) return;
    const api = await ownerApi();
    await strikeOff(api, unplaced, 'Left School'); // out of the not-placed count again
    await api.dispose();
  });

  test('C2-LIB42-TRUNCATED: hovering a truncated rail label shows its full name; a label that fits shows none @smoke', async ({ page }) => {
    await page.goto('/');
    const items = page.locator('a[data-app-shell-nav-item]:visible');
    await expect(items.first()).toBeVisible({ timeout: 20_000 });
    const info = await items.evaluateAll((els) => els.map((e) => {
      const clip = e.querySelector('[data-app-shell-tip-clip]') as HTMLElement | null;
      return { name: e.getAttribute('data-nav-name'), truncatedTip: e.getAttribute('data-app-shell-tip-truncated'), clipped: !!clip && clip.scrollWidth > clip.clientWidth, visible: !!clip && clip.offsetParent !== null };
    }));
    test.info().annotations.push({ type: 'rail', description: JSON.stringify(info) });
    const clipped = info.filter((i) => i.clipped && i.visible);
    expect(clipped.length, 'some label is truncated at 1280 px').toBeGreaterThan(0);
    const tip = page.locator('#tw-app-shell-tooltip');
    for (const c of clipped) {
      await page.locator(`a[data-app-shell-nav-item][data-nav-name="${c.name}"]:visible`).first().hover();
      await expect(tip).toHaveCSS('opacity', '1');
      await expect(tip).toContainText(c.name!);
      await shot(page, `rail-tip-${c.name!.replace(/\W+/g, '-')}`);
    }
    const fits = info.find((i) => !i.clipped && i.visible && !i.truncatedTip?.includes('·'));
    if (fits) {
      await page.locator(`a[data-app-shell-nav-item][data-nav-name="${fits.name}"]:visible`).first().hover();
      await page.waitForTimeout(400);
      expect(await tip.evaluate((e) => getComputedStyle(e).opacity).catch(() => '0')).toBe('0');
    }
  });

  test('C2-LIB42-BADGE: count badges carry a description (sr-only and tooltip)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('a[data-app-shell-nav-item]:visible').first()).toBeVisible({ timeout: 20_000 });
    const badges = await page.locator('a[data-app-shell-nav-item]:visible [data-app-shell-tip]').evaluateAll((els) => els.map((e) => ({ text: (e as HTMLElement).innerText.trim(), tip: e.getAttribute('data-app-shell-tip'), sr: e.querySelector('.sr-only')?.textContent ?? null })));
    test.info().annotations.push({ type: 'badges', description: JSON.stringify(badges) });
    const counts = badges.filter((b) => /^\d+/.test(b.text));
    expect(counts.length, 'a count badge (Admission Office: not placed)').toBeGreaterThan(0);
    for (const b of counts) {
      expect(b.sr ?? '').toMatch(/^, \d+ (students? not placed in a class|class(es)? with results pending)$/);
      expect(b.tip ?? '').toMatch(/\d+ (students? not placed in a class|class(es)? with results pending)/);
    }
    const first = page.locator('a[data-app-shell-nav-item]:visible [data-app-shell-tip]').filter({ hasText: /^\d/ }).first();
    await first.hover();
    await expect(page.locator('#tw-app-shell-tooltip')).toHaveCSS('opacity', '1');
    await expect(page.locator('#tw-app-shell-tooltip')).toContainText(/not placed in a class|results pending/);
    await shot(page, 'rail-badge-tip');
  });
});
