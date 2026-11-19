/**
 * PR 544 NF3-STALE follow-up (Dan 26974f8e + cd198ff2): the open panel follows the server's absence when a search lands,
 * unless an absence edit is still waiting (queued/retrying save or an inline error). Retest of the NF3-STALE draft from
 * nf3-retest (5a91b937: panel kept "2" while its net and badge said 5).
 * World "nf3b": no statutory, 8 staff at 30,000 (one per test, so fullyParallel workers never share a row).
 */
import { expect, test, type Page } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

interface Data { staff: P.Staff[]; runId: string }
let w: P.World<Data>;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('nf3b', () => newCampusOwner('pay'), async (owner) => {
    const api = owner.api;
    await P.publishPolicy(api, { incomeTaxEnabled: false, eobiEnabled: false });
    const staff: P.Staff[] = [];
    for (let i = 0; i < 8; i++) staff.push(await P.addStaff(api, { salary: 30000 }));
    return { staff, runId: await P.generateRun(api) };
  });
});

const desktop = { viewport: { width: 1366, height: 900 } };
const row = async (s: P.Staff) => P.rowFor(w.owner.api, w.data.runId, s);
const setDays = async (s: P.Staff, n: number) => P.absence(w.owner.api, w.data.runId, (await row(s)).id, n);
const daysText = (n: number) => (n === 0 ? '' : String(n));

async function openOn(browser: import('@playwright/test').Browser, s: P.Staff) {
  const page = await P.openApp(browser, w, P.runPath(w.data.runId), desktop);
  const run = new PayrollRunPage(page);
  await page.goto(P.runPath(w.data.runId));
  await run.expectDraftLoaded();
  await run.searchFor(s.name);
  await expect(run.table.getByRole('row')).toHaveCount(2, { timeout: 15_000 });
  await run.openRow(s.name);
  return { page, run };
}
/** Narrow the search (the row stays, the register reloads every row) and wait for that answer to land. */
async function landSearch(page: Page, run: PayrollRunPage, term: string) {
  const reload = page.waitForResponse((r) => r.url().includes('/register?') && r.url().includes(encodeURIComponent(term)));
  await run.searchFor(term);
  await reload;
  await page.waitForTimeout(800);
}
async function shown(run: PayrollRunPage, s: P.Staff) {
  return { days: await run.unpaidDays.inputValue().catch(() => '<no panel>'), panelNet: await run.panelNet().innerText().catch(() => '-'), row: (await run.row(s.name).innerText()).replace(/\s+/g, ' ').slice(-50) };
}

test.describe('NF3-STALE follow-up — the open panel follows the server unless an edit is waiting', () => {
  test('R2-SERVER-REFRESH: no local edit, another tab changes the days (5, 0, 3), a search lands -> the input, its net and the badge all show the server', async ({ browser }) => {
    const s = w.data.staff[0];
    await setDays(s, 2);
    const { page, run } = await openOn(browser, s);
    await expect(run.unpaidDays).toHaveValue('2');
    const log: string[] = [];
    let term = s.name;
    for (const v of [5, 0, 3]) {
      await setDays(s, v);
      const server = await row(s);
      term = term === s.name ? s.name.slice(0, -2) : s.name;
      await landSearch(page, run, term);
      const got = await shown(run, s);
      log.push(`other tab -> ${v} (net ${server.net}): shown ${JSON.stringify(got)}`);
      expect.soft(got.days, `input follows the server (${v})`).toBe(daysText(v));
      expect.soft(got.panelNet).toMatch(P.moneyRe(server.net ?? 0));
    }
    await page.screenshot({ path: P.shot('r2-server-refresh.png'), fullPage: true });
    await P.saveEvidence('r2-server-refresh.txt', log.join('\n'));
    await page.context().close();
  });

  test('R2-PENDING-EDIT-KEPT (original NF3): a typed value whose save is still in flight survives a search landing 0-400 ms later, then saves (6 tries)', async ({ browser }) => {
    test.setTimeout(8 * 60_000);
    const s = w.data.staff[1];
    await setDays(s, 0);
    const { page, run } = await openOn(browser, s);
    const log: string[] = []; let bad = 0;
    let term = s.name;
    for (const [i, delay] of [0, 0, 0, 100, 200, 400].entries()) {
      const typed = String(2 + i);
      await page.route('**/rows/*/absence', async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
      await run.setUnpaidDays(typed);
      if (delay) await page.waitForTimeout(delay);
      term = term === s.name ? s.name.slice(0, -2) : s.name;
      await landSearch(page, run, term);
      const during = await run.unpaidDays.inputValue();
      await expect.poll(async () => (await row(s)).unpaidDays, { timeout: 20_000 }).toBe(Number(typed));
      await page.waitForTimeout(1200);
      const after = await shown(run, s);
      const server = await row(s);
      await page.unroute('**/rows/*/absence');
      const ok = during === typed && after.days === typed && P.moneyRe(server.net ?? 0).test(after.panelNet);
      if (!ok) bad++;
      log.push(`#${i + 1} typed ${typed}, search landed +${delay}ms while the save was in flight: input "${during}"; after save: ${JSON.stringify(after)} server ${server.unpaidDays}/${server.net} -> ${ok ? 'ok' : 'BAD'}`);
    }
    await P.saveEvidence('r2-pending-edit-kept.txt', log.join('\n'));
    expect(bad, log.join('\n')).toBe(0);
    await page.context().close();
  });

  test('R2-FAILED-SAVE-VS-OTHER-TAB: a save that keeps failing is a waiting edit -> a search landing after another tab\'s change keeps the typed value, and the retry saves it', async ({ browser }) => {
    const s = w.data.staff[2];
    await setDays(s, 2);
    const { page, run } = await openOn(browser, s);
    await page.route('**/rows/*/absence', (route) => route.abort('internetdisconnected'));
    await run.setUnpaidDays('4');
    await expect(run.saveFailed).toBeVisible();
    await setDays(s, 6); // another tab
    await landSearch(page, run, s.name.slice(0, -2));
    const during = await shown(run, s);
    await page.unroute('**/rows/*/absence');
    await expect.poll(async () => (await row(s)).unpaidDays, { timeout: 30_000 }).toBe(4);
    await page.waitForTimeout(1200);
    const after = await shown(run, s);
    const server = await row(s);
    await P.saveEvidence('r2-failed-save-vs-other-tab.txt', JSON.stringify({ during, after, server: { days: server.unpaidDays, net: server.net } }, null, 2));
    expect.soft(during.days, 'typed value kept while its save is waiting').toBe('4');
    expect(after.days).toBe('4');
    expect(after.panelNet).toMatch(P.moneyRe(server.net ?? 0));
    await page.context().close();
  });

  test('R2-INVALID-KEPT: an inline error ("40" days) is a waiting edit -> a search landing keeps "40" and nothing is saved', async ({ browser }) => {
    const s = w.data.staff[3];
    await setDays(s, 2);
    const { page, run } = await openOn(browser, s);
    await run.setUnpaidDays('40');
    await page.waitForTimeout(500);
    const errBefore = (await run.panel.innerText()).replace(/\s+/g, ' ');
    await landSearch(page, run, s.name.slice(0, -2));
    const got = await shown(run, s);
    const errAfter = (await run.panel.innerText()).replace(/\s+/g, ' ');
    const server = await row(s);
    await P.saveEvidence('r2-invalid-kept.txt', JSON.stringify({ got, server: server.unpaidDays, panelBefore: errBefore.slice(0, 300), panelAfter: errAfter.slice(0, 300) }, null, 2));
    expect.soft(got.days).toBe('40');
    expect.soft(errAfter, 'the inline error is still shown').toBe(errBefore);
    expect(server.unpaidDays).toBe(2);
    await page.context().close();
  });

  test('R2-BLOCKED-4XX: a save the server refuses (400) puts the panel back to the server value and the net agrees', async ({ browser }) => {
    const s = w.data.staff[4];
    await setDays(s, 2);
    const { page, run } = await openOn(browser, s);
    await page.route('**/rows/*/absence', (route) => route.fulfill({ status: 400, contentType: 'application/problem+json', body: JSON.stringify({ title: 'qa forced 400', status: 400 }) }));
    await run.setUnpaidDays('4');
    await page.waitForTimeout(1500);
    const got = await shown(run, s);
    const strip = await run.saveFailed.count() > 0 ? (await run.saveFailed.first().innerText()).replace(/\s+/g, ' ') : '<no failed strip>';
    await page.screenshot({ path: P.shot('r2-blocked-4xx.png'), fullPage: true });
    await page.unroute('**/rows/*/absence');
    const server = await row(s);
    await P.saveEvidence('r2-blocked-4xx.txt', JSON.stringify({ got, strip, server: { days: server.unpaidDays, net: server.net } }, null, 2));
    expect(server.unpaidDays).toBe(2);
    expect.soft(got.days, 'panel back to the server value').toBe('2');
    expect.soft(got.panelNet).toMatch(P.moneyRe(server.net ?? 0));
    await page.context().close();
  });

  test('R2-LINES-OTHER-TAB: another tab adds a one-off to the open row, a search lands -> the panel lists it and its net includes it', async ({ browser }) => {
    const s = w.data.staff[5];
    await setDays(s, 0);
    const { page, run } = await openOn(browser, s);
    await P.oneOff(w.owner.api, w.data.runId, (await row(s)).id, { type: 'Incentive', label: 'R2 other tab', amount: 1500, reason: 'nf3 retest 2' });
    const server = await row(s);
    await landSearch(page, run, s.name.slice(0, -2));
    await page.waitForTimeout(1500);
    const listed = await run.lineCheckbox('R2 other tab').count();
    const got = await shown(run, s);
    await page.screenshot({ path: P.shot('r2-lines-other-tab.png'), fullPage: true });
    await P.saveEvidence('r2-lines-other-tab.txt', JSON.stringify({ listed, got, serverNet: server.net }, null, 2));
    expect.soft(listed, 'the new line is listed in the open panel').toBe(1);
    expect(got.panelNet).toMatch(P.moneyRe(server.net ?? 0));
    await page.context().close();
  });

  test('R2-ONEOFF-FORM-AND-SERVER-DAYS: a half-filled one-off form stays filled while the days follow another tab\'s change', async ({ browser }) => {
    const s = w.data.staff[6];
    await setDays(s, 0);
    const { page, run } = await openOn(browser, s);
    await run.addOneOffLink().click();
    await run.fillOneOff({ type: 'Deduction', label: 'R2 form', amount: '300', reason: 'kept' });
    await setDays(s, 3);
    const server = await row(s);
    await landSearch(page, run, s.name.slice(0, -2));
    const form = { label: await run.oneOffField('Label').inputValue(), amount: await run.oneOffField('Amount (PKR)').inputValue(), reason: await run.oneOffField('Reason').inputValue() };
    const got = await shown(run, s);
    await P.saveEvidence('r2-oneoff-form-and-server-days.txt', JSON.stringify({ form, got, server: { days: server.unpaidDays, net: server.net } }, null, 2));
    expect.soft(form).toEqual({ label: 'R2 form', amount: '300', reason: 'kept' });
    expect.soft(got.days).toBe('3');
    expect(got.panelNet).toMatch(P.moneyRe(server.net ?? 0));
    await page.context().close();
  });
});
