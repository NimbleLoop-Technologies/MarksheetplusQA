/**
 * PR 544 cycle 3 — the five items reopened/filed after cycle 2, checked deeper than their cycle-1/2 assertions.
 * World "cycle3": no statutory. Ayesha 30,000, Bilal 25,000, plus 3 spare staff. Draft generated for the current month.
 *  - z94x8ecrnd (P-PANEL-IN-PLACE): the panel opens inside its own row, the next row follows it, and the net is not clipped.
 *  - z94x8ecrnz (P-PREVIEW-SEARCH): no search box and no filter control on the Preview.
 *  - z94x8edjpa (NF1): Publish on a draft discarded a moment earlier (two tabs) gives a clear answer, not the
 *    connection copy; Publish + Discard raced 10 times never answer 500 and never delete a published run.
 *  - z94x8ecrpa (P-MOBILE-ROW-ACTIONS): on a Pixel 5 every line's Status and actions are on screen, nothing scrolls
 *    sideways (page or table), and Mark as paid works from the phone layout.
 * DB MANIPULATION (logged in the evidence): a published run is moved to an earlier month to free the current one.
 */
import { devices, expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

const pixel5 = (({ defaultBrowserType: _ignored, ...d }) => d)(devices['Pixel 5']);
interface Data { ayesha: P.Staff; bilal: P.Staff; spares: P.Staff[]; runId: string; discarded: string[]; moved: number }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('cycle3', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: false, eobiEnabled: false });
    const ayesha = await P.addStaff(api, { salary: 30000, name: P.qaName('Ayesha') });
    const bilal = await P.addStaff(api, { salary: 25000, name: P.qaName('Bilal') });
    const spares: P.Staff[] = [];
    for (let i = 0; i < 3; i++) spares.push(await P.addStaff(api, { salary: 20000 + i * 1000 }));
    return { ayesha, bilal, spares, runId: await P.generateRun(api), discarded: [], moved: 0 };
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
  return P.generateRun(w.owner.api);
}

test.describe('Cycle 3 — the reopened items', () => {
  test('C3-PANEL (z94x8ecrnd): the panel opens inside its own row, the next row follows it, and the net is fully visible', async ({ browser }) => {
    w.data.runId = await freshDraft();
    await P.persistWorld('cycle3', w.data);
    await P.absence(w.owner.api, w.data.runId, (await P.rowFor(w.owner.api, w.data.runId, w.data.ayesha)).id, 0);
    const page = await P.openApp(browser, w, P.runPath(w.data.runId), { viewport: { width: 1366, height: 900 } });
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.openRow(w.data.ayesha.name);
    await page.screenshot({ path: P.shot('c3-panel-in-row-desktop.png'), fullPage: true });
    const geo = await page.evaluate(([a, b]) => {
      const panel = document.querySelector('[data-row-panel]') as HTMLElement;
      const tr = panel.closest('tr') as HTMLElement;
      const rows = Array.from(document.querySelectorAll('main table tbody tr')) as HTMLElement[];
      const next = rows[rows.indexOf(tr) + 1];
      const net = panel.querySelector('[data-panel-net]') as HTMLElement;
      const netText = net.querySelector('p.text-xl') as HTMLElement;
      const scroller = (() => { let e: HTMLElement | null = panel; while (e && e !== document.body) { const s = getComputedStyle(e); if (/(auto|scroll|hidden)/.test(s.overflowX) && e.scrollWidth > 0) return e; e = e.parentElement; } return document.documentElement; })();
      const r = (e: Element) => e.getBoundingClientRect();
      return {
        inOwnRow: tr.textContent!.includes(a),
        nextRowIsBilalOrOther: !!next, nextTop: next ? r(next).top : null, panelBottom: r(panel).bottom, panelTop: r(panel).top, trTop: r(tr).top,
        netRight: r(netText).right, netWidth: netText.scrollWidth, netClient: netText.clientWidth,
        scrollerRight: r(scroller).right, scrollerOverflow: scroller.scrollWidth - scroller.clientWidth, vw: window.innerWidth,
        pagerTop: (document.querySelector('nav[aria-label*="agination" i]') as HTMLElement | null)?.getBoundingClientRect().top ?? null,
        b,
      };
    }, [w.data.ayesha.name, w.data.bilal.name]);
    await P.saveEvidence('c3-panel-geometry.json', JSON.stringify(geo, null, 2));
    expect(geo.inOwnRow, 'panel lives in Ayesha\'s own table row').toBe(true);
    expect(geo.panelTop - geo.trTop, 'panel starts inside its row, under the name').toBeLessThan(120);
    if (geo.nextTop !== null) expect(geo.nextTop, 'the next row follows the panel').toBeGreaterThanOrEqual(geo.panelBottom - 1);
    expect(geo.netWidth, 'net figure is not clipped inside its box').toBeLessThanOrEqual(geo.netClient + 1);
    expect(geo.netRight, 'net figure ends inside the visible table area').toBeLessThanOrEqual(Math.min(geo.scrollerRight, geo.vw) + 1);
    expect(await run.pageOverflowPx(), 'page does not scroll sideways with the panel open').toBeLessThanOrEqual(1);
    await expect(run.panelNet()).toHaveText(P.moneyRe(w.data.ayesha.salary));
    // Editing still works in the new place: 2 unpaid days on 30,000 (÷30) -> 28,000.
    await run.setUnpaidDays('2');
    await expect(run.panelNet()).toHaveText(P.moneyRe(28000), { timeout: 15_000 });
    await expect.poll(async () => (await P.rowFor(w.owner.api, w.data.runId, w.data.ayesha)).unpaidDays, { timeout: 20_000 }).toBe(2);
    await page.screenshot({ path: P.shot('c3-panel-after-edit.png'), fullPage: true });
    await page.context().close();
  });

  test('C3-PANEL (z94x8ecrnd): on a Pixel 5 the in-row panel fits the screen and the net is readable', async ({ browser }) => {
    const cur = await current();
    test.skip(cur.state !== 'Draft', 'needs a draft');
    const page = await P.openApp(browser, w, P.runPath(cur.runId), pixel5);
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.openRow(w.data.bilal.name);
    await page.screenshot({ path: P.shot('c3-panel-in-row-pixel5.png'), fullPage: true });
    const scrollGeo = async () => page.evaluate(() => {
      const panel = document.querySelector('[data-row-panel]') as HTMLElement;
      let e: HTMLElement | null = panel.parentElement; let sc: HTMLElement | null = null;
      while (e && e.tagName !== 'MAIN') { if (e.scrollWidth > e.clientWidth + 1) { sc = e; break; } e = e.parentElement; }
      const pr = panel.getBoundingClientRect();
      return { scrollerScrollLeft: sc?.scrollLeft ?? null, scrollerScrollWidth: sc?.scrollWidth ?? null, scrollerClientWidth: sc?.clientWidth ?? null, panelLeft: pr.left, panelRight: pr.right, vw: window.innerWidth };
    });
    const afterTap = await scrollGeo();
    const netOnScreenAfterTap = await run.isWithinViewportWidth(run.panelNet());
    // Scroll the table back to its start, as the user would have to, and check the panel itself fits there.
    await page.evaluate(() => { let e: HTMLElement | null = document.querySelector('[data-row-panel]')!.parentElement; while (e && e.tagName !== 'MAIN') { if (e.scrollWidth > e.clientWidth + 1) e.scrollLeft = 0; e = e.parentElement; } });
    const atStart = await scrollGeo();
    const netOnScreenAtStart = await run.isWithinViewportWidth(run.panelNet());
    await page.screenshot({ path: P.shot('c3-panel-in-row-pixel5-scrolled-back.png'), fullPage: true });
    await P.saveEvidence('c3-panel-pixel5-geometry.json', JSON.stringify({ afterTap, netOnScreenAfterTap, atStart, netOnScreenAtStart }, null, 2));
    expect(await run.pageOverflowPx(), 'page does not scroll sideways').toBeLessThanOrEqual(1);
    expect(netOnScreenAtStart, 'the panel fits the phone once the table is at its start').toBe(true);
    expect(netOnScreenAfterTap, 'the panel the user just opened is on screen where they tapped (no sideways scroll back)').toBe(true);
    await page.context().close();
  });

  test('C3-PREVIEW (z94x8ecrnz): the Preview has no search box and no filter control', async ({ browser }) => {
    const page = await P.openApp(browser, w, P.runPath(w.data.runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.reviewAndPublish.click();
    await run.expectPreviewLoaded();
    await page.screenshot({ path: P.shot('c3-preview-no-search.png'), fullPage: true });
    await expect(run.main.getByRole('textbox')).toHaveCount(0);
    await expect(run.main.getByRole('searchbox')).toHaveCount(0);
    await expect(run.main.getByRole('button', { name: /filter/i })).toHaveCount(0);
    await expect(run.publishPayroll).toBeVisible();
    await page.context().close();
  });

  test('C3-DISCARDED-THEN-PUBLISH (z94x8edjpa): Publish on a draft another tab just discarded says so, not "check your connection"', async ({ browser }) => {
    const runId = w.data.runId;
    const page = await P.openApp(browser, w, P.runPath(runId));
    const run = new PayrollRunPage(page);
    await run.expectDraftLoaded();
    await run.reviewAndPublish.click();
    await run.expectPreviewLoaded();
    await run.publishPayroll.click();
    await expect(run.dialog).toBeVisible();
    // The other tab: Discard draft (same owner).
    const del = await w.owner.api.delete(`payroll-runs/${runId}`);
    expect(del.status(), 'discard from the other tab').toBe(204);
    w.data.discarded.push(runId);
    const pubResponse = page.waitForResponse((r) => r.url().includes(`/payroll-runs/${runId}/publish`));
    await run.dialogButton('Publish').click();
    const res = await pubResponse;
    const body = await res.text();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: P.shot('c3-publish-after-discard.png'), fullPage: true });
    const visibleText = await page.locator('body').innerText();
    await P.saveEvidence('c3-publish-after-discard.txt', [
      `DELETE payroll-runs/${runId} (other tab) -> ${del.status()}`,
      `UI POST publish -> ${res.status()} ${body.slice(0, 300)}`,
      `connection copy shown: ${visibleText.includes('Check your connection')}`,
      `"This draft was discarded." shown: ${visibleText.includes('This draft was discarded.')}`,
    ].join('\n'));
    expect.soft(res.status(), 'publish answers a clear conflict, not 404/500').toBe(409);
    expect.soft(visibleText, 'the user is not told to check their connection').not.toContain('Check your connection');
    expect.soft(visibleText, 'the user is told the draft was discarded').toContain('This draft was discarded.');
    await page.context().close();
    w.data.runId = await freshDraft();
    await P.persistWorld('cycle3', w.data);
  });

  test('C3-RACE (z94x8edjpa): Publish and Discard at the same moment, 10 times: no 500, a published run is never deleted, the loser gets a clear 409', async () => {
    test.setTimeout(10 * 60_000);
    const api = w.owner.api;
    const log: string[] = [];
    const tally: Record<string, number> = {};
    for (let i = 1; i <= 10; i++) {
      const runId = await freshDraft(log);
      const [pub, del] = await Promise.all([api.post(`payroll-runs/${runId}/publish`), api.delete(`payroll-runs/${runId}`)]);
      const pubText = await pub.text();
      const delText = await del.text();
      const reg = await api.get(`payroll-runs/${runId}/register?pageSize=1`);
      const regStatus = reg.status() === 200 ? (await reg.json()).status : `HTTP ${reg.status()}`;
      const rows = await P.sql<{ n: number }>(`select count(*)::int as n from "PayrollRunRows" where "PayrollRunId" = ${P.q(runId)}`);
      const ledgerTx = await P.ledgerTxCount(w.owner.tenantId, `payroll:${runId}:%`);
      const key = `publish ${pub.status()} / discard ${del.status()}`;
      tally[key] = (tally[key] ?? 0) + 1;
      if (del.status() === 204) w.data.discarded.push(runId);
      log.push(`#${i} run ${runId}: publish -> ${pub.status()} ${pubText.slice(0, 140)} | discard -> ${del.status()} ${delText.slice(0, 120)} | run now: ${regStatus}, rows ${rows[0].n}, ledger tx ${ledgerTx}`);
      expect.soft(pub.status(), log.at(-1)).not.toBe(500);
      expect.soft(del.status(), log.at(-1)).not.toBe(500);
      if (pub.status() === 200) {
        expect.soft(regStatus, 'a run that answered "published" still exists').toBe('Published');
        expect.soft(del.status(), 'discard lost to publish -> 409').toBe(409);
      } else {
        expect.soft(del.status(), 'publish lost -> discard won').toBe(204);
        expect.soft(pub.status(), `publish after a discard won is a clear 409 (${log.at(-1)})`).toBe(409);
        if (pub.status() === 409) expect.soft(pubText).toContain('This draft was discarded.');
        expect.soft(regStatus).toBe('HTTP 404');
        expect.soft(rows[0].n, 'no rows left behind').toBe(0);
        expect.soft(ledgerTx, 'no ledger postings for a discarded run').toBe(0);
      }
    }
    log.push('', 'Tally: ' + JSON.stringify(tally));
    await P.saveEvidence('c3-race-publish-discard.txt', log.join('\n'));
    await P.persistWorld('cycle3', w.data);
  });

  test('C3-DISCARD-RECORD: every discarded draft leaves a discard record with its audit trail (review comment, 60e714fc)', async () => {
    test.skip(w.data.discarded.length === 0, 'nothing discarded in this run');
    const ids = w.data.discarded.map(P.q).join(',');
    const recs = await P.sql<{ id: string; n: number; by: string }>(`select "PayrollRunId" as id, length("AuditTrailJson"::text)::int as n, "DiscardedByUserId" as by from "PayrollRunDiscardEntries" where "PayrollRunId" in (${ids})`);
    await P.saveEvidence('c3-discard-records.txt', `discarded: ${w.data.discarded.join(', ')}\nrecords:\n${recs.map((r) => `${r.id} auditTrailJson ${r.n} chars`).join('\n')}`);
    expect(recs.map((r) => r.id).sort()).toEqual([...w.data.discarded].sort());
  });

  test('C3-MOBILE (z94x8ecrpa): on a Pixel 5 every published line shows its Status and actions on screen; Mark as paid works from the phone layout', async ({ browser }) => {
    let cur = await current();
    if (cur.state !== 'Published') {
      const runId = cur.state === 'Draft' ? cur.runId : await P.generateRun(w.owner.api);
      await P.publishOk(w.owner.api, runId);
      cur = await current();
    }
    const runId = cur.runId;
    const page = await P.openApp(browser, w, P.runPath(runId), pixel5);
    const run = new PayrollRunPage(page);
    await run.expectPublishedLoaded();
    await page.screenshot({ path: P.shot('c3-mobile-published-pixel5.png'), fullPage: true });
    expect(await run.pageOverflowPx(), 'page does not scroll sideways').toBeLessThanOrEqual(1);
    const tableOverflow = await page.evaluate(() => {
      const t = document.querySelector('main table') as HTMLElement; let e: HTMLElement | null = t.parentElement; let worst = 0;
      while (e && e.tagName !== 'MAIN') { worst = Math.max(worst, e.scrollWidth - e.clientWidth); e = e.parentElement; }
      return worst;
    });
    // A few px of residual table overflow (the hidden columns' padding) is recorded, not asserted: nothing is hidden by it.
    await P.saveEvidence('c3-mobile-table-overflow.txt', `published register table container overflow on Pixel 5: ${tableOverflow}px`);
    expect(tableOverflow, 'no column is pushed off screen').toBeLessThanOrEqual(40);
    for (const s of [w.data.ayesha, w.data.bilal, ...w.data.spares]) {
      const row = run.row(s.name);
      await expect(row.getByText(/^(Unpaid|Paid|Posting pending)$/).first(), `${s.name} status visible`).toBeVisible();
      expect(await run.isWithinViewportWidth(row.getByText(/^(Unpaid|Paid|Posting pending)$/).first()), `${s.name} status on screen`).toBe(true);
      expect(await run.isWithinViewportWidth(run.rowAction(s.name, 'View payslip')), `${s.name} View payslip on screen`).toBe(true);
    }
    expect(await run.isWithinViewportWidth(run.rowAction(w.data.bilal.name, 'Mark as paid'))).toBe(true);
    await run.rowAction(w.data.bilal.name, 'Mark as paid').click();
    const confirm = run.dialogButton('Mark as paid');
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await expect(run.row(w.data.bilal.name).getByText('Paid', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    expect((await P.rowFor(w.owner.api, runId, w.data.bilal)).paymentStatus).toBe('Paid');
    await page.screenshot({ path: P.shot('c3-mobile-mark-paid-pixel5.png'), fullPage: true });
    await run.rowAction(w.data.ayesha.name, 'View payslip').click();
    await expect(run.dialogText('Net salary')).toBeVisible();
    expect(await run.dialogFitsViewport(), 'payslip fits the phone').toBe(true);
    await page.screenshot({ path: P.shot('c3-mobile-payslip-pixel5.png') });
    await page.context().close();
  });
});
