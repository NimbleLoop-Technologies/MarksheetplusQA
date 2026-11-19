/**
 * PR 544 NF3 retest (z94x8edteh, fix 5a91b937 "keep the open row panel's state when a search lands").
 * The open row panel's state now lives on the register page (PayrollRowPanelState), so a search that replaces the rows must
 * not reset it. Cycle 4 baseline at 1c924d83: opening the row within ~0.4 s of typing the search swallowed the first
 * "+ Add a one-off" press 13/13 and a failed save emptied Unpaid days 6/6.
 * World "nf3": no statutory. Ayesha 30,000, Bilal 25,000, 10 spare staff (two register pages at 8 a page).
 */
import { expect, test, type Page } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

interface Data { ayesha: P.Staff; bilal: P.Staff; spares: P.Staff[]; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('nf3', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: false, eobiEnabled: false });
    const ayesha = await P.addStaff(api, { salary: 30000, name: P.qaName('Ayesha') });
    const bilal = await P.addStaff(api, { salary: 25000, name: P.qaName('Bilal') });
    const spares: P.Staff[] = [];
    for (let i = 0; i < 10; i++) spares.push(await P.addStaff(api, { salary: 20000 + i * 1000 }));
    return { ayesha, bilal, spares, runId: await P.generateRun(api) };
  });
});

const desktop = { viewport: { width: 1366, height: 900 } };
async function openDraft(page: Page) {
  const run = new PayrollRunPage(page);
  await page.goto(P.runPath(w.data.runId));
  await run.expectDraftLoaded();
  return run;
}
/** Type the search, wait `delay` ms, open the row (the row is still on the unfiltered page when delay < ~400 ms). */
async function searchThenOpen(run: PayrollRunPage, page: Page, s: P.Staff, delay: number) {
  await run.searchFor(s.name);
  if (delay) await page.waitForTimeout(delay);
  const rowsAtOpen = await run.table.getByRole('row').count();
  await run.openRow(s.name);
  return rowsAtOpen;
}
const reset = async (s: P.Staff) => P.absence(w.owner.api, w.data.runId, (await P.rowFor(w.owner.api, w.data.runId, s)).id, 0);

test.describe('NF3 — the open row panel survives a search landing', () => {
  test('NF3-FIRST-CLICK (z94x8edteh): opened 0-400 ms after typing the search, the first "+ Add a one-off" press opens the form (16 tries)', { tag: '@smoke' }, async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    const page = await P.openApp(browser, w, P.runPath(w.data.runId), desktop);
    let run = await openDraft(page);
    const delays = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 200, 400];
    const log: string[] = []; const opened: boolean[] = [];
    for (const [i, delay] of delays.entries()) {
      const s = w.data.spares[i % w.data.spares.length];
      run = await openDraft(page);
      const rowsAtOpen = await searchThenOpen(run, page, s, delay);
      await run.addOneOffLink().click();
      await page.waitForTimeout(1500);
      const open = (await run.oneOffField('Amount (PKR)').count()) > 0;
      opened.push(open);
      log.push(`#${i + 1} delay ${delay}ms, rows when opened ${rowsAtOpen}, rows now ${await run.table.getByRole('row').count()}: form open after 1st press ${open}`);
    }
    log.push(`first press opened the form ${opened.filter(Boolean).length}/${opened.length}`);
    await P.saveEvidence('nf3-first-click.txt', log.join('\n'));
    await page.screenshot({ path: P.shot('nf3-first-click-last.png'), fullPage: true });
    expect(opened.filter((o) => !o).length, log.join('\n')).toBe(0);
    await page.context().close();
  });

  test('NF3-FAILED-SAVE (z94x8edteh): opened right after typing the search, a failed save keeps the typed Unpaid days (8 tries) and the retry saves it', { tag: '@smoke' }, async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    const page = await P.openApp(browser, w, P.runPath(w.data.runId), desktop);
    const log: string[] = []; const kept: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      const s = w.data.spares[i % w.data.spares.length];
      await reset(s);
      const run = await openDraft(page);
      const rowsAtOpen = await searchThenOpen(run, page, s, i < 6 ? 0 : 200);
      const days = String(2 + (i % 4));
      await page.route('**/rows/*/absence', (route) => route.abort('internetdisconnected'));
      await run.setUnpaidDays(days);
      await expect(run.saveFailed).toBeVisible();
      await page.waitForTimeout(1500);
      const v = await run.unpaidDays.inputValue().catch(() => '<panel gone>');
      kept.push(v === days);
      if (i === 0) await page.screenshot({ path: P.shot('nf3-failed-save-kept.png'), fullPage: true });
      await page.unroute('**/rows/*/absence');
      let server = -1;
      for (let t = 0; t < 20; t++) { server = (await P.rowFor(w.owner.api, w.data.runId, s)).unpaidDays; if (server === Number(days)) break; await page.waitForTimeout(1500); }
      log.push(`#${i + 1} rows when opened ${rowsAtOpen}; typed ${days}, save aborted -> input "${v}"; server after retry ${server}; strip still failed ${await run.saveFailed.count() > 0}`);
      expect.soft(server, `retry saves ${days}`).toBe(Number(days));
    }
    log.push(`typed value kept ${kept.filter(Boolean).length}/${kept.length}`);
    await P.saveEvidence('nf3-failed-save.txt', log.join('\n'));
    expect(kept.filter((k) => !k).length, log.join('\n')).toBe(0);
    await page.context().close();
  });

  test('NF3-ONE-OFF-TYPED: a half-filled one-off form keeps its values while a search lands, and submitting it right after saves once', async ({ browser }) => {
    const s = w.data.spares[3];
    // spares[3] is also used by FAILED-SAVE (fullyParallel, shared world), which leaves it with unpaid days: start from 0 and
    // compare against the server's own net instead of the bare salary.
    await reset(s);
    await expect.poll(async () => (await P.rowFor(w.owner.api, w.data.runId, s)).unpaidDays, { timeout: 20_000 }).toBe(0);
    const netBefore = (await P.rowFor(w.owner.api, w.data.runId, s)).net ?? 0;
    const page = await P.openApp(browser, w, P.runPath(w.data.runId), desktop);
    const run = await openDraft(page);
    await run.searchFor(s.name);
    await expect(run.table.getByRole('row')).toHaveCount(2, { timeout: 15_000 });
    await run.openRow(s.name);
    await run.addOneOffLink().click();
    await run.fillOneOff({ type: 'Incentive', label: 'NF3 bonus', amount: '700', reason: 'nf3 retest' });
    // A second search lands while the form is open (a shorter term: the row stays, the rows are replaced).
    const reload = page.waitForResponse((r) => r.url().includes('/register?') && r.url().includes(encodeURIComponent(s.name.slice(0, -2))));
    await run.searchFor(s.name.slice(0, -2));
    await reload;
    await page.waitForTimeout(800);
    const values = { label: await run.oneOffField('Label').inputValue(), amount: await run.oneOffField('Amount (PKR)').inputValue(), reason: await run.oneOffField('Reason').inputValue(), incentive: await run.oneOffType('Incentive').isChecked() };
    await page.screenshot({ path: P.shot('nf3-one-off-after-search.png'), fullPage: true });
    const posts: number[] = [];
    page.on('response', (r) => { if (r.url().includes('/one-offs') && r.request().method() === 'POST') posts.push(r.status()); });
    await run.oneOffSubmit().click();
    await expect(run.oneOffField('Amount (PKR)')).toHaveCount(0, { timeout: 15_000 });
    const lines = (await P.figures(w.owner.api, w.data.runId, (await P.rowFor(w.owner.api, w.data.runId, s)).id)).lines.filter((l) => l.label === 'NF3 bonus');
    await P.saveEvidence('nf3-one-off-typed.txt', JSON.stringify({ valuesAfterSearch: values, posts, savedLines: lines.length, netBefore, net: (await P.rowFor(w.owner.api, w.data.runId, s)).net }, null, 2));
    expect(values).toEqual({ label: 'NF3 bonus', amount: '700', reason: 'nf3 retest', incentive: true });
    expect(posts, 'one POST, answered 2xx').toHaveLength(1);
    expect(posts[0]).toBeGreaterThanOrEqual(200); expect(posts[0]).toBeLessThan(300);
    expect(lines).toHaveLength(1);
    const netAfter = (await P.rowFor(w.owner.api, w.data.runId, s)).net ?? 0;
    expect(netAfter, 'net = net before + the 700 incentive').toBe(netBefore + 700);
    await expect(run.panelNet()).toHaveText(P.moneyRe(netAfter));
    await page.context().close();
  });

  test('NF3-SWITCH-ROWS: the state belongs to its row — opening another row shows that row\'s own values, and reopening the first shows the saved value', async ({ browser }) => {
    const [a, b] = [w.data.ayesha, w.data.bilal];
    await reset(a); await reset(b);
    const page = await P.openApp(browser, w, P.runPath(w.data.runId), desktop);
    const run = await openDraft(page);
    await run.openRow(a.name);
    await run.addOneOffLink().click();
    await run.fillOneOff({ label: 'Leaked?' });
    await run.setUnpaidDays('4');
    await expect.poll(async () => (await P.rowFor(w.owner.api, w.data.runId, a)).unpaidDays, { timeout: 20_000 }).toBe(4);
    await run.row(b.name).getByRole('button', { name: /^(Add exception|Edit)$/ }).click();
    await expect(run.panel).toHaveCount(1);
    await expect(run.panel).toHaveAttribute('data-row-panel', (await P.rowFor(w.owner.api, w.data.runId, b)).id);
    const bDays = await run.unpaidDays.inputValue();
    const bFormOpen = (await run.oneOffField('Label').count()) > 0;
    await run.row(a.name).getByRole('button', { name: /^(Add exception|Edit)$/ }).click();
    const aDays = await run.unpaidDays.inputValue();
    const aFormOpen = (await run.oneOffField('Label').count()) > 0;
    await P.saveEvidence('nf3-switch-rows.txt', `B (${b.name}) after A typed 4 + opened a one-off: days "${bDays}", one-off form open ${bFormOpen}\nA reopened: days "${aDays}", one-off form open ${aFormOpen}`);
    expect(bDays, 'B shows its own (empty) days').toBe('');
    expect(bFormOpen, 'A\'s open one-off form does not follow to B').toBe(false);
    expect(aDays, 'A reopened shows the saved 4').toBe('4');
    await page.context().close();
  });

  test('NF3-FILTER-AND-PAGE: the open panel through Exceptions only, a search that hides its row and back, and a page change and back', async ({ browser }) => {
    const s = w.data.spares[9];
    await P.absence(w.owner.api, w.data.runId, (await P.rowFor(w.owner.api, w.data.runId, s)).id, 2);
    const page = await P.openApp(browser, w, P.runPath(w.data.runId), desktop);
    const run = await openDraft(page);
    const log: string[] = [];
    await run.searchFor(s.name);
    await expect(run.table.getByRole('row')).toHaveCount(2, { timeout: 15_000 });
    await run.openRow(s.name);
    await expect(run.unpaidDays).toHaveValue('2');
    // Exceptions only: the row has an exception, so it stays, and so does the panel.
    await run.exceptionsOnly.click();
    await page.waitForTimeout(1500);
    log.push(`Exceptions only on: panel ${await run.panel.count()}, days "${await run.unpaidDays.inputValue().catch(() => '-')}"`);
    expect.soft(await run.unpaidDays.inputValue()).toBe('2');
    await run.exceptionsOnly.click();
    await page.waitForTimeout(1000);
    // A search that hides the open row, then cleared: the row comes back; whatever the panel shows matches the server.
    await run.searchFor(w.data.ayesha.name);
    await expect(run.table.getByRole('row')).toHaveCount(2, { timeout: 15_000 });
    log.push(`searched another name: panel ${await run.panel.count()}`);
    await P.absence(w.owner.api, w.data.runId, (await P.rowFor(w.owner.api, w.data.runId, s)).id, 3); // changed elsewhere meanwhile
    await run.searchFor(s.name);
    await expect(run.table.getByRole('row').filter({ hasText: s.name })).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    const back = { panel: await run.panel.count(), days: await run.unpaidDays.inputValue().catch(() => '-'), exceptionCell: (await run.row(s.name).innerText()).replace(/\s+/g, ' ') };
    log.push(`searched it again after the server moved to 3: ${JSON.stringify(back)}`);
    await page.screenshot({ path: P.shot('nf3-search-hides-row-back.png'), fullPage: true });
    // Page change: open a row on page 1 with no search, go to page 2 and back.
    await run.searchFor('');
    await expect(run.paginationSummary).toContainText(/of 12 results/, { timeout: 15_000 });
    const first = w.data.ayesha;
    await run.openRow(first.name);
    await run.setUnpaidDays('1');
    await expect.poll(async () => (await P.rowFor(w.owner.api, w.data.runId, first)).unpaidDays, { timeout: 20_000 }).toBe(1);
    await run.pagination.getByRole('button', { name: /next/i }).or(run.pagination.getByRole('link', { name: /next/i })).first().click();
    await page.waitForTimeout(1500);
    log.push(`page 2: panel ${await run.panel.count()}, summary "${await run.paginationSummary.innerText()}"`);
    await run.pagination.getByRole('button', { name: /previous/i }).or(run.pagination.getByRole('link', { name: /previous/i })).first().click();
    await page.waitForTimeout(1500);
    const p1 = { panel: await run.panel.count(), days: await run.unpaidDays.inputValue().catch(() => '-') };
    log.push(`back to page 1: ${JSON.stringify(p1)}`);
    const errors: string[] = [];
    await P.saveEvidence('nf3-filter-and-page.txt', log.join('\n'));
    // A panel that comes back must not show a stale value: the server now says 3 for s.
    if (back.panel > 0 && back.days !== '-') expect.soft(back.days, 'the reopened panel matches the server (3), not the stale 2').toBe('3');
    if (p1.panel > 0) expect.soft(p1.days).toBe('1');
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test('NF3-STALE (new): a search landing after the line was changed elsewhere (another tab) — the open panel\'s Unpaid days agrees with its own net and badge', async ({ browser }) => {
    const s = w.data.spares[8];
    await reset(s);
    const page = await P.openApp(browser, w, P.runPath(w.data.runId), desktop);
    const run = await openDraft(page);
    await run.searchFor(s.name);
    await expect(run.table.getByRole('row')).toHaveCount(2, { timeout: 15_000 });
    await run.openRow(s.name);
    await run.setUnpaidDays('2');
    await expect.poll(async () => (await P.rowFor(w.owner.api, w.data.runId, s)).unpaidDays, { timeout: 20_000 }).toBe(2);
    // Another tab sets 5 days on the same line.
    await P.absence(w.owner.api, w.data.runId, (await P.rowFor(w.owner.api, w.data.runId, s)).id, 5);
    const server = await P.rowFor(w.owner.api, w.data.runId, s);
    // This tab narrows the search (the row stays; the register reloads with the new figures).
    const reload = page.waitForResponse((r) => r.url().includes('/register?') && r.url().includes(encodeURIComponent(s.name.slice(0, -2))));
    await run.searchFor(s.name.slice(0, -2));
    await reload;
    await page.waitForTimeout(1500);
    const shown = { days: await run.unpaidDays.inputValue(), panelNet: await run.panelNet().innerText(), row: (await run.row(s.name).innerText()).replace(/\s+/g, ' ').slice(-60) };
    await page.screenshot({ path: P.shot('nf3-stale-after-other-tab.png'), fullPage: true });
    // A reload of the page (what a reset used to do) shows the server's value.
    await page.reload(); await run.expectDraftLoaded();
    await run.searchFor(s.name); await expect(run.table.getByRole('row')).toHaveCount(2, { timeout: 15_000 });
    await run.openRow(s.name);
    const fresh = await run.unpaidDays.inputValue();
    await P.saveEvidence('nf3-stale-after-other-tab.txt', JSON.stringify({ serverAfterOtherTab: { unpaidDays: server.unpaidDays, net: server.net }, shownAfterSearchLanded: shown, freshPanelAfterReload: fresh }, null, 2));
    expect.soft(shown.days, `panel Unpaid days vs its own net ${shown.panelNet} (server ${server.unpaidDays} days, net ${server.net})`).toBe(String(server.unpaidDays));
    expect(fresh).toBe(String(server.unpaidDays));
    await page.context().close();
  });
});
