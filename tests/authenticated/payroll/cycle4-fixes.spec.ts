/**
 * PR 544 cycle 4 — the four items reopened/filed after cycle 3 (fix commit 1c924d83 "Fix bugs from QA cycle 3").
 * World "cycle4": no statutory. Ayesha 30,000, Bilal 25,000, a staff member with a long name, plus 3 spare staff.
 *  - z94x8edjpa (NF1): Publish on a draft another tab discarded (UI two tabs and API discard) shows "This draft was
 *    discarded." and leaves for Staff Payroll, never "Check your connection".
 *  - z94x8edteg (NF2): "+ Add a one-off" is readable (contrast) and opens the form.
 *  - z94x8edteh (NF3): with the register searched, the first "+ Add a one-off" click opens the form and a failed save
 *    keeps the typed value (repeated, since cycle 3 saw it 3/3).
 *  - z94x8edtej (NF4): on a Pixel 5 the draft register fits the screen, salary/net/exception/action ride under the name,
 *    and the panel opened from the phone button is on screen and saves. Other phone widths are measured too.
 *  - NF5 (new in cycle 4): from sm up to ~1024 px the draft register still scrolls sideways and the open panel's net is off screen.
 * DB MANIPULATION (logged in the evidence): a published run is moved to an earlier month to free the current one.
 */
import { devices, expect, test, type Page } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';
import { StaffPayrollPage } from '../../../pages/payroll/StaffPayrollPage';

const strip = <T extends { defaultBrowserType?: unknown }>({ defaultBrowserType: _ignored, ...d }: T) => d;
const pixel5 = strip(devices['Pixel 5']);
interface Data { ayesha: P.Staff; bilal: P.Staff; long: P.Staff; spares: P.Staff[]; runId: string; moved: number }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('cycle4', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: false, eobiEnabled: false });
    const ayesha = await P.addStaff(api, { salary: 30000, name: P.qaName('Ayesha') });
    const bilal = await P.addStaff(api, { salary: 25000, name: P.qaName('Bilal') });
    const long = await P.addStaff(api, { salary: 125000, name: P.qaName('Muhammadabdurrahmanqureshi') });
    const spares: P.Staff[] = [];
    for (let i = 0; i < 3; i++) spares.push(await P.addStaff(api, { salary: 20000 + i * 1000 }));
    return { ayesha, bilal, long, spares, runId: await P.generateRun(api), moved: 0 };
  });
});

const current = async () => (await w.owner.api.get('payroll-runs/current')).json();
/** A draft for the current month: moves a published run back a month, or generates when the month is empty. */
async function freshDraft(log?: string[]): Promise<string> {
  const cur = await current();
  if (cur.state === 'Draft') return cur.runId;
  if (cur.state === 'Published') {
    w.data.moved += 1;
    const stmt = await P.moveRunToMonth(cur.runId, P.monthStart(-w.data.moved));
    log?.push(`DB: ${stmt}`);
  }
  const id = await P.generateRun(w.owner.api);
  w.data.runId = id;
  await P.persistWorld('cycle4', w.data);
  return id;
}

async function contrast(page: Page, sel: ReturnType<PayrollRunPage['addOneOffLink']>) {
  return sel.evaluate((b) => {
    const rgb = (v: string) => (v.match(/[\d.]+/g) || []).map(Number);
    let bgEl: HTMLElement | null = b as HTMLElement; let bg = [255, 255, 255, 0];
    while (bgEl) { const v = rgb(getComputedStyle(bgEl).backgroundColor); if (v.length >= 3 && (v[3] === undefined || v[3] > 0)) { bg = v; break; } bgEl = bgEl.parentElement; }
    const fg = rgb(getComputedStyle(b).color);
    const lum = (x: number[]) => { const [r, g, bl] = x.slice(0, 3).map((u) => { u /= 255; return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
    const [l1, l2] = [lum(fg), lum(bg)].sort((a, z) => z - a);
    const r = (b as HTMLElement).getBoundingClientRect();
    return { color: getComputedStyle(b).color, background: `rgb(${bg.slice(0, 3).join(', ')})`, ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100, classes: (b as HTMLElement).className, width: r.width, height: r.height };
  });
}

test.describe('Cycle 4 — the items filed after cycle 3', () => {
  test('C4-DISCARDED-THEN-PUBLISH (z94x8edjpa): Publish on a draft discarded in another tab says "This draft was discarded." and goes to Staff Payroll', { tag: '@smoke' }, async ({ browser }) => {
    const runId = await freshDraft();
    const page = await P.openApp(browser, w, P.runPath(runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.reviewAndPublish.click();
    await run.expectPreviewLoaded();
    await run.publishPayroll.click();
    await expect(run.dialog).toBeVisible();
    // The other tab: a second page of the same session on Staff Payroll, Discard draft → Discard.
    const tab2 = await page.context().newPage();
    const ui2 = new StaffPayrollPage(tab2);
    await tab2.goto(P.PAYROLL_PATH);
    await ui2.expectMonthCard();
    await ui2.discardDraftButton.click();
    await tab2.getByRole('dialog').or(tab2.getByRole('alertdialog')).first().getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(ui2.generateButton).toBeVisible({ timeout: 30_000 });
    expect((await current()).state, 'tab 2 discarded the draft').toBe('NoRun');
    // Back in tab 1: press Publish in the still-open confirm modal.
    const pubResponse = page.waitForResponse((r) => r.url().includes(`/payroll-runs/${runId}/publish`));
    await run.dialogButton('Publish').click();
    const res = await pubResponse;
    const body = await res.text();
    const toast = page.getByText('This draft was discarded.').first();
    await expect(toast, 'the user is told the draft was discarded').toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/accounts\/staff-payroll\/?$/, { timeout: 15_000 });
    const ui = new StaffPayrollPage(page);
    await ui.expectMonthCard();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: P.shot('c4-publish-after-discard.png'), fullPage: true });
    const visibleText = await page.locator('body').innerText();
    await P.saveEvidence('c4-publish-after-discard.txt', [
      `Tab 2: Staff Payroll -> Discard draft -> Discard; payroll-runs/current state now NoRun`,
      `Tab 1 (confirm modal open): Publish -> POST publish ${res.status()} ${body.slice(0, 300)}`,
      `Tab 1 URL after: ${page.url()}`,
      `"This draft was discarded." shown: ${visibleText.includes('This draft was discarded.')}`,
      `connection copy shown: ${visibleText.includes('Check your connection')}`,
      `"Generate payroll" offered: ${await ui.generateButton.isVisible()}`,
    ].join('\n'));
    expect([404, 409], 'publish answers 404/409 (the client maps both), never 500').toContain(res.status());
    expect(visibleText).not.toContain('Check your connection');
    expect(visibleText).not.toContain('We could not publish this payroll.');
    await expect(ui.generateButton, 'Staff Payroll shows the month with no run').toBeVisible();
    await page.context().close();
  });

  test('C4-DISCARDED-THEN-PUBLISH (z94x8edjpa): the same after an API discard, and the page does not offer Publish again', async ({ browser }) => {
    const runId = await freshDraft();
    const page = await P.openApp(browser, w, P.runPath(runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.reviewAndPublish.click();
    await run.expectPreviewLoaded();
    await run.publishPayroll.click();
    await expect(run.dialog).toBeVisible();
    const del = await w.owner.api.delete(`payroll-runs/${runId}`);
    expect(del.status()).toBe(204);
    const pubResponse = page.waitForResponse((r) => r.url().includes(`/payroll-runs/${runId}/publish`));
    await run.dialogButton('Publish').click();
    const res = await pubResponse;
    await expect(page.getByText('This draft was discarded.').first()).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/accounts\/staff-payroll\/?$/, { timeout: 15_000 });
    await expect(run.dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Publish/ })).toHaveCount(0);
    // Back button returns to the dead run: the run page says it is gone, not a connection error.
    await page.goBack();
    await page.waitForTimeout(3000);
    const backText = await page.locator('main').innerText();
    await page.screenshot({ path: P.shot('c4-publish-after-discard-back.png'), fullPage: true });
    await P.saveEvidence('c4-publish-after-api-discard.txt', `DELETE ${runId} -> ${del.status()}\nPOST publish -> ${res.status()}\nafter Back: ${page.url()}\n${backText.slice(0, 400)}`);
    expect(backText).not.toContain('Check your connection');
    await page.context().close();
  });

  test('C4-RACE (z94x8edjpa): Publish and Discard at the same moment, 6 times: no 500, loser gets a clear 409', async () => {
    test.setTimeout(8 * 60_000);
    const api = w.owner.api;
    const log: string[] = []; const tally: Record<string, number> = {};
    for (let i = 1; i <= 6; i++) {
      const runId = await freshDraft(log);
      const [pub, del] = await Promise.all([api.post(`payroll-runs/${runId}/publish`), api.delete(`payroll-runs/${runId}`)]);
      const key = `publish ${pub.status()} / discard ${del.status()}`;
      tally[key] = (tally[key] ?? 0) + 1;
      log.push(`#${i} ${runId}: ${key} ${(await pub.text()).slice(0, 120)}`);
      expect.soft(pub.status()).not.toBe(500);
      expect.soft(del.status()).not.toBe(500);
      if (pub.status() === 200) expect.soft(del.status()).toBe(409); else expect.soft(pub.status()).toBe(409);
    }
    log.push('', 'Tally: ' + JSON.stringify(tally));
    await P.saveEvidence('c4-race-publish-discard.txt', log.join('\n'));
  });

  test('C4-ADD-ONE-OFF-VISIBLE (z94x8edteg): "+ Add a one-off" is readable (AA contrast) and opens the form', { tag: '@smoke' }, async ({ browser }) => {
    const runId = await freshDraft();
    const page = await P.openApp(browser, w, P.runPath(runId), { viewport: { width: 1366, height: 900 } });
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.openRow(w.data.spares[0].name);
    const link = run.addOneOffLink();
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeVisible();
    await page.screenshot({ path: P.shot('c4-add-one-off-visible.png') });
    await link.screenshot({ path: P.shot('c4-add-one-off-link-crop.png') });
    const c = await contrast(page, link);
    await link.hover();
    const hover = await contrast(page, link);
    await P.saveEvidence('c4-add-one-off-contrast.txt', JSON.stringify({ normal: c, hover }, null, 2));
    expect(c.ratio, `"+ Add a one-off" is ${c.color} on ${c.background}`).toBeGreaterThanOrEqual(4.5);
    expect.soft(hover.ratio, 'still readable on hover').toBeGreaterThanOrEqual(3);
    await link.click();
    await expect(run.oneOffField('Amount (PKR)')).toBeVisible();
    // The one-off still saves from the form it opens (on the draft line, applied, net drops by 1,500).
    await run.fillOneOff({ type: 'Deduction', label: 'Late fine C4', amount: '1500', reason: 'cycle 4 check' });
    await run.oneOffSubmit().click();
    await expect.poll(async () => (await P.rowFor(w.owner.api, runId, w.data.spares[0])).net, { timeout: 20_000 }).toBe(w.data.spares[0].salary - 1500);
    await expect(run.panelNet()).toHaveText(P.moneyRe(w.data.spares[0].salary - 1500));
    await page.context().close();
  });

  test('C4-PANEL-AFTER-SEARCH (z94x8edteh): with the register searched, the first "+ Add a one-off" click opens the form (3 tries) and a failed save keeps the typed value (2 tries)', async ({ browser }) => {
    const runId = await freshDraft();
    const page = await P.openApp(browser, w, P.runPath(runId), { viewport: { width: 1366, height: 900 } });
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    const log: string[] = [];
    const firstClick: boolean[] = [];
    for (const s of [w.data.spares[1], w.data.spares[2], w.data.bilal]) {
      await page.reload();
      await run.expectDraftLoaded();
      // Cycle-3 sequence: type the search and open the row straight away (no wait for the filtered result), as a user does.
      await run.searchFor(s.name);
      await run.openRow(s.name);
      await run.addOneOffLink().click();
      await page.waitForTimeout(1500);
      const open = (await run.oneOffField('Amount (PKR)').count()) > 0;
      firstClick.push(open);
      log.push(`search "${s.name}" -> open row -> 1st "+ Add a one-off" click: form open = ${open}`);
      if (open) await run.oneOffCancel().click();
    }
    const kept: string[] = [];
    for (const [i, s] of [w.data.spares[1], w.data.spares[2]].entries()) {
      await page.reload();
      await run.expectDraftLoaded();
      await run.searchFor(s.name);
      await run.openRow(s.name);
      await page.route('**/rows/*/absence', (route) => route.abort('internetdisconnected'));
      await run.setUnpaidDays(String(3 + i));
      await expect(run.saveFailed).toBeVisible();
      await page.waitForTimeout(1500);
      const v = await run.unpaidDays.inputValue().catch(() => '<panel gone>');
      kept.push(v);
      log.push(`search "${s.name}" -> typed ${3 + i}, save aborted -> input shows "${v}", panel open ${await run.panel.count() > 0}`);
      await page.screenshot({ path: P.shot(`c4-search-failed-save-${i + 1}.png`), fullPage: true });
      await page.unroute('**/rows/*/absence');
      await expect.poll(async () => (await P.rowFor(w.owner.api, runId, s)).unpaidDays, { timeout: 30_000 }).toBe(3 + i);
      log.push(`  server unpaidDays after retry: ${3 + i}`);
    }
    await P.saveEvidence('c4-panel-after-search.txt', log.join('\n'));
    expect.soft(firstClick, 'first click opens the one-off form every time').toEqual([true, true, true]);
    expect.soft(kept, 'the typed value stays while "Not saved" shows').toEqual(['3', '4']);
    await page.context().close();
  });

  test('C4-PIXEL5-DRAFT (z94x8edtej): on a Pixel 5 the draft fits the screen; details and the action ride under the name; the panel opens on screen and saves', { tag: '@smoke' }, async ({ browser }) => {
    const runId = await freshDraft();
    await P.absence(w.owner.api, runId, (await P.rowFor(w.owner.api, runId, w.data.bilal)).id, 0);
    const page = await P.openApp(browser, w, P.runPath(runId), pixel5);
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await page.screenshot({ path: P.shot('c4-pixel5-draft.png'), fullPage: true });
    const geo = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const t = document.querySelector('main table') as HTMLElement; let e: HTMLElement | null = t.parentElement; let worst = 0;
      while (e && e.tagName !== 'MAIN') { worst = Math.max(worst, e.scrollWidth - e.clientWidth); e = e.parentElement; }
      const off = Array.from(document.querySelectorAll('main *')).filter((x) => { const r = (x as HTMLElement).getBoundingClientRect(); const s = getComputedStyle(x); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && (r.right > vw + 1 || r.left < -1); }).slice(0, 10).map((x) => `${x.tagName}.${(x as HTMLElement).className.toString().slice(0, 60)} "${(x as HTMLElement).innerText?.slice(0, 40)}"`);
      const headers = Array.from(document.querySelectorAll('main table th')).map((h) => ({ t: (h as HTMLElement).innerText.trim(), shown: (h as HTMLElement).offsetParent !== null }));
      return { vw, innerWidth: window.innerWidth, tableOverflow: worst, docScroll: document.documentElement.scrollWidth, offScreen: off, headers };
    });
    const pageOverflow = await run.pageOverflowPx();
    const perRow: string[] = [];
    for (const s of [w.data.ayesha, w.data.bilal, w.data.long, ...w.data.spares]) {
      const row = run.row(s.name);
      const btn = row.getByRole('button', { name: /^(Add exception|Edit)$/ });
      const btnOn = await btn.isVisible() && await run.isWithinViewportWidth(btn);
      const netOn = await run.isWithinViewportWidth(row.getByText(P.moneyRe(s.salary)).first()).catch(() => false);
      const rowText = (await row.innerText()).replace(/\s+/g, ' ');
      perRow.push(`${s.name}: action visible+on screen ${btnOn}; salary on screen ${netOn}; text "${rowText.slice(0, 120)}"`);
      expect.soft(btnOn, `${s.name} action on screen`).toBe(true);
      expect.soft(rowText, `${s.name} shows Net under the name`).toContain('Net');
    }
    // Open Bilal's panel from the phone button and edit there.
    await run.openRow(w.data.bilal.name);
    await page.waitForTimeout(800);
    const panelBox = await run.panel.boundingBox();
    const netOnScreen = await run.isWithinViewportWidth(run.panelNet());
    const inOwnRow = await run.panel.evaluate((p, name) => (p.closest('tr') as HTMLElement).innerText.includes(name), w.data.bilal.name);
    await page.screenshot({ path: P.shot('c4-pixel5-panel-open.png'), fullPage: true });
    const overflowWithPanel = await run.pageOverflowPx();
    await run.setUnpaidDays('5');
    // 25,000 ÷ 30 × 5 = 4,166.67 → net 20,833 (rounded as the register rounds); accept the server's figure.
    await expect.poll(async () => (await P.rowFor(w.owner.api, runId, w.data.bilal)).unpaidDays, { timeout: 20_000 }).toBe(5);
    const serverRow = await P.rowFor(w.owner.api, runId, w.data.bilal);
    const serverNet = serverRow.net;
    await expect(run.panelNet()).toHaveText(P.moneyRe(serverNet as number), { timeout: 15_000 });
    const underName = await run.row(w.data.bilal.name).locator('[data-mobile-draft]').innerText();
    await page.screenshot({ path: P.shot('c4-pixel5-after-edit.png'), fullPage: true });
    // Collapse from the phone button.
    await run.row(w.data.bilal.name).getByRole('button', { name: 'Collapse' }).click();
    await expect(run.panel).toHaveCount(0);
    // Toolbar is on screen.
    const toolbar = { search: await run.isWithinViewportWidth(run.search), exceptionsOnly: await run.isWithinViewportWidth(run.exceptionsOnly), review: await run.isWithinViewportWidth(run.reviewAndPublish) };
    await P.saveEvidence('c4-pixel5-draft.json', JSON.stringify({ geo, pageOverflow, overflowWithPanel, perRow, panelBox, netOnScreen, inOwnRow, serverNet, underNameAfterEdit: underName, toolbar }, null, 2));
    expect(pageOverflow, 'page does not scroll sideways').toBeLessThanOrEqual(1);
    // A few px of residual table overflow (hidden columns' padding, as on the published register since cycle 3) is recorded, not asserted.
    expect(geo.tableOverflow, 'no column is pushed off screen').toBeLessThanOrEqual(40);
    expect(inOwnRow, 'panel opens in Bilal\'s row').toBe(true);
    expect(netOnScreen, 'panel net is on screen without scrolling sideways').toBe(true);
    expect(panelBox!.x, 'panel left edge on screen').toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width, 'panel right edge on screen').toBeLessThanOrEqual(pixel5.viewport!.width + 1);
    expect.soft(overflowWithPanel, 'no sideways scroll with the panel open').toBeLessThanOrEqual(1);
    expect.soft(underName, 'the net under the name follows the edit').toMatch(P.moneyRe(serverNet as number));
    expect.soft(toolbar).toEqual({ search: true, exceptionsOnly: true, review: true });
    await page.context().close();
  });

  async function measureWidths(browser: import('@playwright/test').Browser, widths: number[], file: string) {
    const runId = await freshDraft();
    const out: Record<string, { pageOverflowClosed: number; pageOverflowPanelOpen: number; tableOverflow: number; panelNetOnScreen: boolean }> = {};
    for (const width of widths) {
      const page = await P.openApp(browser, w, P.runPath(runId), { viewport: { width, height: 800 }, isMobile: width < 640, hasTouch: width < 640, deviceScaleFactor: 2 });
      const run = new PayrollRunPage(page);
      await run.expectDraftLoaded();
      const closed = await run.pageOverflowPx();
      await run.openRow(w.data.long.name);
      await page.waitForTimeout(600);
      const open = await run.pageOverflowPx();
      const netOn = await run.isWithinViewportWidth(run.panelNet());
      const tableOverflow = await page.evaluate(() => { const t = document.querySelector('main table') as HTMLElement; let e: HTMLElement | null = t.parentElement; let worst = 0; while (e && e.tagName !== 'MAIN') { worst = Math.max(worst, e.scrollWidth - e.clientWidth); e = e.parentElement; } return worst; });
      out[width] = { pageOverflowClosed: closed, pageOverflowPanelOpen: open, tableOverflow, panelNetOnScreen: netOn };
      await page.screenshot({ path: P.shot(`c4-width-${width}.png`) });
      await page.context().close();
    }
    await P.saveEvidence(file, JSON.stringify(out, null, 2));
    return out;
  }

  test('C4-WIDTHS-PHONE (z94x8edtej): below sm (320-600 px) the draft register and the open panel never scroll sideways', async ({ browser }) => {
    const out = await measureWidths(browser, [320, 360, 375, 600], 'c4-widths-phone.json');
    for (const [width, m] of Object.entries(out)) {
      expect.soft(m.pageOverflowClosed, `${width}px page overflow`).toBeLessThanOrEqual(1);
      expect.soft(m.pageOverflowPanelOpen, `${width}px page overflow with panel`).toBeLessThanOrEqual(1);
      expect.soft(m.panelNetOnScreen, `${width}px panel net on screen`).toBe(true);
    }
  });

  test('C4-WIDTHS-TABLET (new, NF5): from sm up (640-1024 px: small tablets, iPad portrait/landscape) the draft register and the open panel do not scroll sideways', async ({ browser }) => {
    const out = await measureWidths(browser, [640, 700, 768, 820, 1024], 'c4-widths-tablet.json');
    for (const [width, m] of Object.entries(out)) {
      expect.soft(m.pageOverflowClosed, `${width}px page overflow`).toBeLessThanOrEqual(1);
      expect.soft(m.pageOverflowPanelOpen, `${width}px page overflow with panel`).toBeLessThanOrEqual(1);
      expect.soft(m.panelNetOnScreen, `${width}px panel net on screen`).toBe(true);
    }
  });

  test('C4-DESKTOP-COLUMNS: at 1366 px the draft keeps its columns and one visible action per row; the under-name copy is hidden', async ({ browser }) => {
    const runId = await freshDraft();
    const page = await P.openApp(browser, w, P.runPath(runId), { viewport: { width: 1366, height: 900 } });
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    const headers = await run.headers();
    expect(headers.slice(0, 3)).toEqual(['Staff member', 'Monthly salary', 'Exceptions']);
    expect(headers.some((h) => h.startsWith('Net for'))).toBe(true);
    await expect(page.locator('[data-mobile-draft]').first()).toBeHidden();
    for (const s of [w.data.ayesha, w.data.long]) await expect(run.row(s.name).getByRole('button', { name: /^(Add exception|Edit)$/ })).toHaveCount(1);
    await run.openRow(w.data.ayesha.name);
    await expect(run.row(w.data.ayesha.name).getByRole('button', { name: 'Collapse' })).toHaveCount(1);
    expect(await run.pageOverflowPx()).toBeLessThanOrEqual(1);
    await page.screenshot({ path: P.shot('c4-desktop-columns.png'), fullPage: true });
    await page.context().close();
  });
});
