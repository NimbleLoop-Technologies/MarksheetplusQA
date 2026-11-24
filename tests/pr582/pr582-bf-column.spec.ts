/**
 * PR 582 / ClickUp z94x8ea2ny — remove the Brought-forward (B/F) column from the attendance Month register and every export.
 *
 * ACs (ticket/acs.md, derived; the ticket has no description):
 *  AC-BF1 screen: no "B/F" / "Brought forward" header; after the last day come <MMM> and Total, in that order.
 *  AC-BF2 screen: no B/F cells; This-month and Total still show and add up; headers line up with cells.
 *  AC-BF3 exports: CSV (Export dialog + POST attendance-register/month/export, section and campus scope), Print
 *         (popup written from #attendance-month-print) and PDF (html2canvas of #attendance-month-pdf). There is no Excel.
 *  AC-BF4 no regression: day marks, Print / Export succeed, no HTTP 5xx, month navigation.
 *
 * Self-seeding: one throwaway campus owner per file (newCampusOwner), a current session, and seedBackdatingClass()
 * (class "QA548 <x>", sections A/B; its section CreatedDate is back-dated in Postgres to the session start — DB setup on
 * rows this file just created, see fixtures/attendance.ts). Marks: last working day of the previous month (all present)
 * and the two working days before today in this month, so the previous month's attendance exists while B/F is gone.
 * Local stack only (QA_REST_API_URL, QA_PG_*). Serial, one worker.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { newCampusOwner, cacheOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { AttendanceApi, PRESENT, addDays, isSunday, pastWorkingDay, todayPkt, seedBackdatingClass, type BackdatingClass } from '../../fixtures/attendance';
import { signInToWebApp } from '../../pages/fees/AccountOffice';
import { AttendanceRegisterPage } from '../../pages/attendance/AttendanceRegisterPage';
import * as f from '../../fixtures/fees';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.resolve(EV, '..', 'seed');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
/** Anything that could still be a brought-forward column, header or value. */
const BF = /\bB\s*\/\s*F\b|brought[\s-]*forward|broughtforward/i;

test.describe.configure({ mode: 'serial' });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthStart = (isoDate: string) => `${isoDate.slice(0, 7)}-01`;
const mmm = (isoDate: string) => MONTHS[Number(isoDate.slice(5, 7)) - 1];
const daysIn = (isoDate: string) => new Date(Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)), 0)).getUTCDate();

let owner: CampusOwner;
let api: AttendanceApi;
let seeded: BackdatingClass;
let today: string;
let thisMonth: string;
let prevMonth: string;
let prevDay: string;
const markDays: string[] = [];
/** Expected present count in this month, by pupil name. */
const expectedThisMonth = new Map<string, number>();
const expectedPrevMonth = new Map<string, number>();

function shotPath(name: string) {
  mkdirSync(EV, { recursive: true });
  return path.join(EV, `pr582-bf-${name}`);
}

/** Every HTTP 5xx the page saw, so a failing Print / Export cannot hide behind a toast. */
function watch5xx(page: Page): string[] {
  const seen: string[] = [];
  page.on('response', (r) => { if (r.status() >= 500) seen.push(`${r.request().method()} ${r.url()} -> ${r.status()}`); });
  return seen;
}

async function ownerPage(browser: Browser, width = 1440, height = 900): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors, baseURL: process.env.QA_BASE_URL, timezoneId: 'Asia/Karachi', viewport: { width, height }, acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const errors = watch5xx(page);
  await signInToWebApp(page, owner.credentials());
  return { ctx, page, errors };
}

/** Column headers of the Month grid, in order: "Student", "1".."N", "<MMM>", "Total". */
async function gridHeaders(page: Page): Promise<string[]> {
  const reg = new AttendanceRegisterPage(page);
  return reg.month.region.locator('thead tr').first().locator('th').evaluateAll((ths) =>
    ths.map((th) => {
      const t = (th.textContent ?? '').replace(/\s+/g, ' ').trim();
      // A day header carries ", Sunday" (sr-only) or a button; its number leads.
      const day = /^(\d{1,2})\b/.exec(t);
      return day ? day[1] : t;
    }));
}

/** CSV rows split on commas (the register writes no quoted commas for these generated names). */
const csvRows = (csv: string) => csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length > 0).map((l) => l.split(','));

function checkCsvSection(csv: string, month: string, label: string) {
  expect(csv, `${label}: no B/F anywhere`).not.toMatch(BF);
  const rows = csvRows(csv);
  const headerIdx = rows.findIndex((r) => r[0] === 'Student');
  expect(headerIdx, `${label}: header row present`).toBeGreaterThanOrEqual(0);
  const header = rows[headerIdx];
  const n = daysIn(month);
  const want = ['Student', ...Array.from({ length: n }, (_, i) => String(i + 1)), mmm(month), 'Total'];
  expect(header, `${label}: header is Student, 1..${n}, ${mmm(month)}, Total`).toEqual(want);
  const students = rows.slice(headerIdx + 1).filter((r) => /^\d+ - /.test(r[0]));
  expect(students.length, `${label}: student rows`).toBeGreaterThan(0);
  for (const r of students) {
    expect(r.length, `${label}: row "${r[0]}" has as many fields as the header`).toBe(header.length);
    expect(r[r.length - 1], `${label}: Total equals ${mmm(month)} for "${r[0]}"`).toBe(r[r.length - 2]);
  }
  return { header, students };
}

test.beforeAll(async () => {
  test.setTimeout(8 * 60_000);
  mkdirSync(EV, { recursive: true });
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  today = todayPkt();
  thisMonth = monthStart(today);
  owner = await newCampusOwner('pr582bf');
  const cached = cacheOwner(owner);
  writeFileSync(path.join(SEED_DIR, 'seed-pr582-bf.json'), JSON.stringify({ email: cached.email, phone: cached.phone, tenantId: cached.tenantId, password: cached.password }), { mode: 0o600 });
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
  api = new AttendanceApi(owner.api, owner.tenantId);
  // late pupil is admitted 3 working days ago, so the previous month shows "N" (not enrolled) cells in their row.
  seeded = await seedBackdatingClass(api, { lateAdmission: pastWorkingDay(3), withMoves: false });

  // Last working day of the previous month (all present), then the two working days before today in this month.
  prevDay = addDays(thisMonth, -1);
  while (isSunday(prevDay)) prevDay = addDays(prevDay, -1);
  prevMonth = monthStart(prevDay);
  for (const d of [pastWorkingDay(2), pastWorkingDay(1)]) if (d >= thisMonth) markDays.push(d);
  const pupils = [seeded.early, seeded.steady, seeded.late, seeded.leaver, seeded.mover];
  const enrolledOn = (d: string) => pupils.filter((p) => p !== seeded.late || d >= seeded.lateAdmission);

  const submitDay = async (d: string, absentIds: string[]) => {
    // The past-date roster replays the academic register (~2 s behind a quick-add): wait until every enrolled pupil is on it.
    await expect.poll(async () => (await api.register(seeded.sectionA.id, d)).students.length, { message: `roster ${d}`, timeout: 45_000, intervals: [1000, 2000] })
      .toBe(enrolledOn(d).length);
    const reg = await api.register(seeded.sectionA.id, d);
    const marks = reg.students.map((s) => ({ studentId: s.studentId, status: absentIds.includes(s.studentId) ? 1 : PRESENT }));
    const res = await api.submit(seeded.sectionA.id, d, marks, reg.version ?? 0);
    expect(res.status(), `submit ${d}: ${(await res.text()).slice(0, 300)}`).toBeLessThan(300);
    for (const p of enrolledOn(d)) {
      const m = d >= thisMonth ? expectedThisMonth : expectedPrevMonth;
      m.set(p.fullName, (m.get(p.fullName) ?? 0) + (absentIds.includes(p.id) ? 0 : 1));
    }
  };
  await submitDay(prevDay, []);
  if (markDays[0]) await submitDay(markDays[0], [seeded.steady.id]);
  if (markDays[1]) await submitDay(markDays[1], [seeded.late.id]);
  for (const p of pupils) if (!expectedThisMonth.has(p.fullName)) expectedThisMonth.set(p.fullName, 0);
  writeFileSync(shotPath('seed.json'), JSON.stringify({
    tenantId: owner.tenantId, className: seeded.className, section: seeded.sectionA.label, sectionId: seeded.sectionA.id,
    prevDay, markDays, lateAdmission: seeded.lateAdmission,
    expectedThisMonth: Object.fromEntries(expectedThisMonth), expectedPrevMonth: Object.fromEntries(expectedPrevMonth),
  }, null, 2));
});

test.afterAll(async () => { await owner?.api.dispose(); });

test('AC-BF1/BF2: Month grid has no B/F column; last day, then the month and Total; totals add up and line up', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  expect(markDays.length, 'this month has at least one marked past working day').toBeGreaterThan(0);
  const { ctx, page, errors } = await ownerPage(browser);
  const reg = new AttendanceRegisterPage(page);
  await reg.gotoMonth(seeded.sectionA.id, thisMonth);

  const headers = await gridHeaders(page);
  writeFileSync(shotPath('screen-headers.txt'), headers.join(' | '));
  expect(headers.join(' | '), 'no B/F header').not.toMatch(BF);
  const n = daysIn(thisMonth);
  expect(headers, `headers: Student, 1..${n}, ${mmm(thisMonth)}, Total`).toEqual(['Student', ...Array.from({ length: n }, (_, i) => String(i + 1)), mmm(thisMonth), 'Total']);
  const tableText = await reg.month.region.innerText();
  expect(tableText, 'no B/F text anywhere in the grid').not.toMatch(BF);

  // Every row: name header + one cell per day + month + Total, and nothing else (a stray B/F cell would add one).
  for (const [name, count] of expectedThisMonth) {
    const row = reg.month.row(name);
    await expect(row, `row ${name}`).toHaveCount(1);
    const cells = row.locator('th, td');
    await expect(cells, `${name}: 1 + ${n} + 2 cells`).toHaveCount(n + 3);
    const thisMonthCell = row.locator('td').nth(n);
    await expect(thisMonthCell, `${name}: ${mmm(thisMonth)} count`).toHaveText(String(count));
    await expect(reg.month.total(name), `${name}: Total equals ${mmm(thisMonth)} (no B/F added)`).toHaveText(String(count));
  }

  // Day marks still render.
  if (markDays[0]) {
    const d0 = Number(markDays[0].slice(8));
    expect(await reg.month.code(seeded.steady.fullName, d0), `steady absent on ${markDays[0]}`).toBe('A');
    expect(await reg.month.code(seeded.early.fullName, d0), `early present on ${markDays[0]}`).toBe('P');
  }
  if (markDays[1]) {
    expect(await reg.month.code(seeded.late.fullName, Number(markDays[1].slice(8))), `late absent on ${markDays[1]}`).toBe('A');
  }

  // Alignment: the last day, month and Total headers sit over their columns' cells (centres within 2 px).
  const region = reg.month.region;
  await region.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(300);
  const headerCells = region.locator('thead tr').first().locator('th');
  const firstRow = reg.month.row(seeded.early.fullName).locator('th, td');
  for (const [label, idx] of [[String(n), n], [mmm(thisMonth), n + 1], ['Total', n + 2]] as const) {
    const h = await headerCells.nth(idx).boundingBox();
    const c = await firstRow.nth(idx).boundingBox();
    expect(h && c, `${label} boxes`).toBeTruthy();
    expect(Math.abs((h!.x + h!.width / 2) - (c!.x + c!.width / 2)), `${label}: header centre over cell centre`).toBeLessThanOrEqual(2);
    expect(Math.abs(h!.width - c!.width), `${label}: header and cell widths match`).toBeLessThanOrEqual(1);
  }
  await region.screenshot({ path: shotPath('screen-right-columns.png') });
  await page.screenshot({ path: shotPath('screen-page.png'), fullPage: true });

  // Month navigation still works, and the previous month (with its own marks) has no B/F either.
  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(page.locator('[data-month-label]')).toContainText(new Date(`${prevMonth}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' }));
  await reg.month.expectLoaded();
  await expect.poll(() => gridHeaders(page), { message: 'previous month headers' })
    .toEqual(['Student', ...Array.from({ length: daysIn(prevMonth) }, (_, i) => String(i + 1)), mmm(prevMonth), 'Total']);
  for (const [name, count] of expectedPrevMonth) {
    await expect(reg.month.total(name), `${name}: ${mmm(prevMonth)} Total`).toHaveText(String(count));
  }
  await region.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await region.screenshot({ path: shotPath('screen-prev-month-right-columns.png') });
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect.poll(() => gridHeaders(page), { message: 'back on this month' }).toContain('Total');
  expect(errors, 'no HTTP 5xx while viewing the register').toEqual([]);
  await ctx.close();
});

test('AC-BF1/BF2 at 390 px: no B/F column; month and Total follow the last day after a sideways scroll', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const { ctx, page, errors } = await ownerPage(browser, 390, 844);
  const reg = new AttendanceRegisterPage(page);
  await reg.gotoMonth(seeded.sectionA.id, thisMonth);
  const n = daysIn(thisMonth);
  expect(await gridHeaders(page), 'phone headers').toEqual(['Student', ...Array.from({ length: n }, (_, i) => String(i + 1)), mmm(thisMonth), 'Total']);
  expect(await reg.month.region.innerText(), 'phone: no B/F').not.toMatch(BF);
  await reg.month.region.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(300);
  const total = reg.month.region.locator('thead th').last();
  await expect(total, 'Total header visible after scrolling right').toBeInViewport();
  for (const [name, count] of expectedThisMonth) await expect(reg.month.total(name), `${name}: Total`).toHaveText(String(count));
  await reg.month.region.screenshot({ path: shotPath('screen-390-right-columns.png') });
  expect(errors, 'no HTTP 5xx').toEqual([]);
  await ctx.close();
});

test('AC-BF3: CSV export (UI dialog, section and campus API) has no B/F header or values', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  // API, section scope.
  const sectionCsv = await api.exportCsv(seeded.sectionA.id, thisMonth);
  writeFileSync(shotPath('csv-api-section.txt'), sectionCsv);
  const { students } = checkCsvSection(sectionCsv, thisMonth, 'API section CSV');
  for (const [name, count] of expectedThisMonth) {
    const r = students.find((s) => s[0].endsWith(` - ${name}`));
    expect(r, `CSV row for ${name}`).toBeTruthy();
    expect(r!.slice(-2), `${name}: ${mmm(thisMonth)},Total`).toEqual([String(count), String(count)]);
  }
  // API, previous month (has marks from before this month).
  const prevCsv = await api.exportCsv(seeded.sectionA.id, prevMonth);
  writeFileSync(shotPath('csv-api-prev-month.txt'), prevCsv);
  checkCsvSection(prevCsv, prevMonth, 'API previous-month CSV');
  // API, campus scope: one block per section, each with the same header shape.
  const campus = await owner.api.post('attendance-register/month/export', { data: { sectionId: seeded.sectionA.id, month: thisMonth, format: 1, scope: 1 } });
  expect(campus.status(), 'campus CSV export').toBe(200);
  const campusCsv = await campus.text();
  writeFileSync(shotPath('csv-api-campus.txt'), campusCsv);
  expect(campusCsv, 'campus CSV: no B/F').not.toMatch(BF);
  const headerLines = campusCsv.split(/\r?\n/).filter((l) => l.startsWith('Student,'));
  expect(headerLines.length, 'campus CSV: one header per section (A and B)').toBeGreaterThanOrEqual(2);
  for (const h of headerLines) expect(h, 'campus CSV header ends <MMM>,Total').toMatch(new RegExp(`,${daysIn(thisMonth)},${mmm(thisMonth)},Total$`));

  // UI: Export -> CSV -> This section -> Export downloads the file.
  const { ctx, page, errors } = await ownerPage(browser);
  const reg = new AttendanceRegisterPage(page);
  await reg.gotoMonth(seeded.sectionA.id, thisMonth);
  await reg.month.region.page().locator('[data-month-register] [data-action="export"]').click();
  const dialog = page.getByRole('dialog', { name: 'Export month register' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: /^CSV/ }).check();
  await expect(dialog.getByRole('radio', { name: 'This section' })).toBeChecked();
  await page.screenshot({ path: shotPath('export-dialog-csv.png') });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action="confirm-export"]').click(),
  ]);
  const file = shotPath(`ui-${download.suggestedFilename()}`);
  await download.saveAs(file);
  const uiCsv = readFileSync(file, 'utf8');
  writeFileSync(shotPath('csv-ui-section.txt'), uiCsv);
  expect(download.suggestedFilename(), 'CSV file name').toMatch(/\.csv$/);
  checkCsvSection(uiCsv, thisMonth, 'UI section CSV');
  await expect(page.getByText('Month register exported', { exact: true })).toBeVisible();
  expect(errors, 'no HTTP 5xx during CSV export').toEqual([]);
  await ctx.close();
});

test('AC-BF3: Print layout has no B/F column; Print opens the register with <MMM> and Total last', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const { ctx, page, errors } = await ownerPage(browser);
  const reg = new AttendanceRegisterPage(page);
  await reg.gotoMonth(seeded.sectionA.id, thisMonth);
  const n = daysIn(thisMonth);
  const want = ['Student', ...Array.from({ length: n }, (_, i) => String(i + 1)), mmm(thisMonth), 'Total'];

  // The in-page print host (shown only under print media).
  const host = page.locator('#attendance-month-print [data-print-table]');
  await expect(host).toHaveCount(1);
  const hostHeaders = await host.locator('thead th').allTextContents();
  expect(hostHeaders.map((t) => t.trim()), 'print host headers').toEqual(want);
  const hostText = await page.locator('#attendance-month-print').evaluate((el) => el.textContent ?? '');
  expect(hostText, 'print host: no B/F').not.toMatch(BF);

  // The Print button writes the host into a popup and prints it; the popup closes itself on afterprint. Keep it open
  // for the evidence: the opener's window.open is wrapped so the popup's print() is recorded instead of run.
  await page.evaluate(() => {
    const open = window.open.bind(window);
    window.open = ((...args: Parameters<typeof window.open>) => {
      const w = open(...args);
      if (w) w.print = () => { (window as unknown as { __printed?: number }).__printed = ((window as unknown as { __printed?: number }).__printed ?? 0) + 1; };
      return w;
    }) as typeof window.open;
  });
  const [popup] = await Promise.all([
    ctx.waitForEvent('page'),
    page.locator('[data-month-register] [data-action="print"]').click(),
  ]);
  await popup.waitForLoadState('domcontentloaded');
  const table = popup.locator('[data-print-table]');
  await expect(table, 'printed register table').toHaveCount(1, { timeout: 15_000 });
  const printed = (await table.locator('thead th').allTextContents()).map((t) => t.trim());
  const printText = await popup.locator('body').innerText();
  writeFileSync(shotPath('print-popup.txt'), `${printed.join(' | ')}\n\n${printText}`);
  await popup.setViewportSize({ width: 1400, height: 700 }).catch(() => { /* popup may not allow resize */ });
  await popup.emulateMedia({ media: 'print' }).catch(() => { /* */ });
  await popup.screenshot({ path: shotPath('print-popup.png'), fullPage: true });
  expect(printed, 'printed headers').toEqual(want);
  expect(printText, 'printed register: no B/F').not.toMatch(BF);
  for (const [name, count] of expectedThisMonth) {
    const row = table.locator('tbody tr').filter({ hasText: name });
    const cells = row.locator('td');
    await expect(cells, `${name}: printed cells = 1 + ${n} + 2`).toHaveCount(n + 3);
    await expect(cells.nth(n + 1), `${name}: printed ${mmm(thisMonth)}`).toHaveText(String(count));
    await expect(cells.nth(n + 2), `${name}: printed Total`).toHaveText(String(count));
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed?: number }).__printed ?? 0), { message: 'print() was called on the popup' }).toBe(1);
  await popup.close().catch(() => { /* already closed after print */ });
  expect(errors, 'no HTTP 5xx during Print').toEqual([]);
  await ctx.close();
});

test('AC-BF3: PDF export renders the register without B/F and downloads', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const { ctx, page, errors } = await ownerPage(browser);
  const reg = new AttendanceRegisterPage(page);
  await reg.gotoMonth(seeded.sectionA.id, thisMonth);
  // The PDF is an html2canvas image of an off-screen copy (#attendance-month-pdf) that lives only for the capture:
  // record that copy's headers and text the moment it is added.
  await page.evaluate(() => {
    const w = window as unknown as { __pdfHost?: { headers: string[]; text: string } };
    new MutationObserver(() => {
      const el = document.querySelector('#attendance-month-pdf [data-print-table]');
      if (el && !w.__pdfHost) {
        w.__pdfHost = {
          headers: Array.from(el.querySelectorAll('thead th')).map((th) => (th.textContent ?? '').trim()),
          text: document.querySelector('#attendance-month-pdf')?.textContent ?? '',
        };
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.locator('[data-month-register] [data-action="export"]').click();
  const dialog = page.getByRole('dialog', { name: 'Export month register' });
  await expect(dialog.getByRole('radio', { name: /^PDF/ })).toBeChecked();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.locator('[data-action="confirm-export"]').click(),
  ]);
  const file = shotPath(`ui-${download.suggestedFilename()}`);
  await download.saveAs(file);
  expect(download.suggestedFilename(), 'PDF file name').toMatch(/\.pdf$/);
  expect(readFileSync(file).subarray(0, 5).toString('latin1'), 'file is a PDF').toBe('%PDF-');
  const pdfHost = await page.evaluate(() => (window as unknown as { __pdfHost?: { headers: string[]; text: string } }).__pdfHost);
  expect(pdfHost, 'captured the PDF layout').toBeTruthy();
  writeFileSync(shotPath('pdf-layout.txt'), `${pdfHost!.headers.join(' | ')}\n\n${pdfHost!.text}`);
  const n = daysIn(thisMonth);
  expect(pdfHost!.headers, 'PDF layout headers').toEqual(['Student', ...Array.from({ length: n }, (_, i) => String(i + 1)), mmm(thisMonth), 'Total']);
  expect(pdfHost!.text, 'PDF layout: no B/F').not.toMatch(BF);
  await expect(page.getByText('Month register exported', { exact: true })).toBeVisible();
  expect(errors, 'no HTTP 5xx during PDF export').toEqual([]);
  await ctx.close();
});

test('AC-BF4: month register API answers 200 and carries no non-zero brought-forward figure', async () => {
  // The DTO keeps a broughtForward field (always 0 at this head) — nothing on screen or in exports reads it any more.
  for (const m of [thisMonth, prevMonth]) {
    const res = await owner.api.get('attendance-register/month', { params: { sectionId: seeded.sectionA.id, month: m } });
    expect(res.status(), `GET month ${m}`).toBe(200);
    const body = await res.json() as { students: Array<{ studentName: string; broughtForward?: number; thisMonth: number; total: number }> };
    writeFileSync(shotPath(`api-month-${m.slice(0, 7)}.json`), JSON.stringify(body.students.map(({ studentName, broughtForward, thisMonth: tm, total }) => ({ studentName, broughtForward, thisMonth: tm, total })), null, 2));
    for (const s of body.students) {
      expect(s.total, `${m} ${s.studentName}: total = thisMonth`).toBe(s.thisMonth);
      expect(s.broughtForward ?? 0, `${m} ${s.studentName}: broughtForward`).toBe(0);
    }
  }
});
