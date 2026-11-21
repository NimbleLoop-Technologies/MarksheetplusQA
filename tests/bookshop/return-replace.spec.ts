/**
 * PR 552 / ClickUp 86extv6fx "Replace an Item or Kit" and 86extv6a8 "Return a Sale" (+ 86extv20b "View Recent Bills" ids on the PR).
 *  Profit fix (46657b2f): a swap on yesterday's bill leaves yesterday's figures alone and today gets the swap's margin
 *    (difference - cost change x qty); a same-price swap with a cost change counts; a same-day swap; item -> kit cost; rows from
 *    before the unit-cost columns (null costs) still read and count their difference only.
 *  Replace: difference = replacement - original, charged on the bill's own tender; old item back (Return from Student) and the
 *    new one out (Sale), both with the cashier's name; bill updated in place; audit row; cheaper / low stock / returned / tender /
 *    validation guards; fee-account bill; Sales History UI (scenario: Size 30 Rs 750 -> Size 34 Rs 820, Rs 70 cash).
 *  Return: whole bill back to stock (items and kit components) with the cashier's name, status Returned, refund by tender (cash
 *    from the drawer, fee-account reversal), reason required (<= 200), already returned, drawer short, day-close figures, UI.
 *  Permissions (custom roles, DB SETUP stand-in as in stock-movements.spec.ts), other tenant, no HTTP 500s.
 * Money on screen is whole rupees ("Rs 70"). Dates are the server's operational (PKT) day; the browser runs in Asia/Karachi.
 * Breadcrumbs are waived.
 */
import { test, expect, type Page, type BrowserContext, type Browser } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { newCampusOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { signInToWebApp } from '../../pages/fees/AccountOffice';
import * as f from '../../fixtures/fees';
import * as b from '../../fixtures/bookshop';
import { openPosDay } from '../../fixtures/pos-day';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
const q = f.sqlQuote;
const COPY = {
  cheaper: 'The replacement costs less. Refunds on a cheaper replacement are not supported yet.',
  lowStock: 'Stock is low for the replacement. Add a reason.',
  select: 'Select a replacement item.',
  selectLine: 'Select the item to replace.',
  chooseTender: 'Choose how to charge the difference.',
  cashBill: 'This bill was paid in cash, so the difference is paid in cash.',
  feeBill: 'This bill was charged to the fee account, so the difference is charged to the fee account.',
  returnedReplace: 'This bill has already been returned.',
  reasonRequired: 'Enter a reason for the return.',
  reasonTooLong: 'Reason cannot exceed 200 characters.',
  alreadyReturned: 'This bill has already been returned.',
  drawerShort: 'The drawer does not have enough cash for this refund. Add cash, or refund at day-close.',
  wholeBill: 'All items on this bill will be returned. Partial returns are not supported.',
  refundCash: 'Refund: pay cash from the drawer',
  refundFee: 'Refund: reverse the fee-account charge',
};

test.describe.configure({ mode: 'default' });
test.use({ timezoneId: 'Asia/Karachi' });
// The bookshop project also runs on builds without PR 552 (Return / Replace): skip the file there.
const MP = process.env.QA_CI_MP_DIR;
test.skip(!!MP && !existsSync(path.join(MP, 'src/MarksheetPlusCode/MarksheetPlus.Bookshop/PointOfSale/ReturnSaleModal.razor')), 'this MarksheetPlus build has no Return / Replace a Sale (PR 552)');

interface Seed { cashierName: string; student: f.Student; c: { tenantId: string; seeRoleId: string; editRoleId: string } }
let A: CampusOwner; let C: CampusOwner; let seed: Seed;

const shot = async (page: Page, name: string, fullPage = false) => {
  await mkdir(EV, { recursive: true });
  await page.screenshot({ path: path.join(EV, `rr552-${name}.png`), fullPage });
};
const evidence = async (name: string, data: unknown) => {
  await mkdir(EV, { recursive: true });
  await writeFile(path.join(EV, `rr552-${name}.json`), JSON.stringify(data, null, 2));
};
const errorsOf = async (res: { text(): Promise<string> }) => JSON.stringify(JSON.parse((await res.text()) || '{}'));
const name = (p: string) => `${p} ${f.letters(4)}`;
const yday = () => b.pktDate(1);
const today = () => b.pktDate(0);
const figures = async (o: CampusOwner) => ({ yday: await b.dayClose(o, yday()), today: await b.dayClose(o, today()), dash: await b.dashboard(o, today()) });
const delta = (after: b.DayFigures, before: b.DayFigures) => ({
  revenue: after.revenue - before.revenue, profit: after.profit - before.profit, cashSales: after.cashSales - before.cashSales,
  chargedToFees: after.chargedToFees - before.chargedToFees, cashRefunds: after.cashRefunds - before.cashRefunds, bills: after.bills - before.bills,
  returnsCount: after.returnsCount - before.returnsCount, returnsTotal: after.returnsTotal - before.returnsTotal,
});
const replacementRows = (saleId: string) => f.sql(`select "FromSku","ToSku","Quantity"::text,"Difference"::text,coalesce("DifferenceTenderType",''),coalesce("FromUnitCost"::text,'NULL'),coalesce("ToUnitCost"::text,'NULL'),"ReplacementDate"::date::text,coalesce("Reason",''),"CreatedBy","CreatedDate"::text
  from "BookshopSaleReplacements" where "BookshopSaleId" = ${q(saleId)} order by "CreatedDate"`);
const outboxFor = (tenantId: string, needle: string) => f.sql(`select "Topic","EventType","PayloadJson"::text from "OutboxMessages" where "TenantId" = ${q(tenantId)} and "PayloadJson"::text like ${q('%' + needle + '%')} order by "OccurredOn"`);

test.beforeAll(async ({}, info) => {
  test.setTimeout(5 * 60_000);
  const seeded = await f.seededOnce(info.project.outputDir, 'return-replace-552', async () => {
    const a = await newCampusOwner('rr552a');
    const school = await f.setupSchool(a, 1);
    const student = await f.addStudent(a, { name: f.personName('Sara'), classId: school.classes[0].id, fatherName: f.personName('Imran'), fatherMobile: f.familyMobile() });
    expect((await openPosDay(a.api, 50_000)).status(), 'open POS day').toBeLessThan(300);
    const c = await newCampusOwner('rr552c');
    const role = async (label: string, edit: boolean) => (await f.ok(await c.api.post('access-roles', {
      data: { sourceSystemRole: 'Bookshop Admin', roleName: `${label} ${f.letters(4)}`, description: label, permissions: [{ moduleKey: 'bookshop', see: true, edit, approve: false, export: false, publish: false }] },
    }), `custom role ${label}`)).id as string;
    const data: Seed = { cashierName: '', student, c: { tenantId: c.tenantId, seeRoleId: await role('Bookshop Viewer', false), editRoleId: await role('Bookshop Clerk', true) } };
    // The cashier name the server stamps on stock movements (main's BookshopSaleMovement), read from a sale's own movement.
    const probe = await b.createPricedItem(a, { name: 'Cashier Probe', price: 10, cost: 5 });
    const s = await b.sale(a, [{ type: 'Item', itemId: probe.id, quantity: 1 }]);
    data.cashierName = (await b.movementsFor(a.tenantId, s.billNumber))[0].createdByName;
    return { owner: a, data: { ...data, cOwner: (await import('../../fixtures/campus-owner')).cacheOwner(c) } as any };
  });
  A = seeded.owner; seed = seeded.data as Seed;
  C = await (await import('../../fixtures/campus-owner')).ownerFromCache((seeded.data as any).cOwner);
  await A.refreshToken(); await C.refreshToken();
  expect(seed.cashierName, 'sale movements carry a cashier name').not.toBe('');
});

// ── Profit fix (46657b2f) ─────────────────────────────────────────────────────────────────────

test.describe('Profit follows the replacement day rule', () => {
  test('swap on yesterday\'s bill: yesterday is unchanged, today gets difference - cost change @smoke', async () => {
    const X = await b.createPricedItem(A, { name: name('Notebook X'), price: 300, cost: 100 });
    const Y = await b.createPricedItem(A, { name: name('Notebook Y'), price: 420, cost: 150 });
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 2 }], { date: yday() });
    const before = await figures(A);
    const res = await b.replace(A, bill.id, { saleLineId: bill.lines[0].lineId, type: 'Item', itemId: Y.id, differenceTender: 'Cash' });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    const after = await figures(A);
    const rows = await replacementRows(bill.id);
    await evidence('profit-yesterday-bill', { bill: bill.billNumber, response: body, before, after, replacementRow: rows });
    expect(body).toMatchObject({ reference: bill.billNumber, difference: 240, total: 840, differenceTender: 'Cash', message: 'Item replaced.' });
    // Yesterday: every figure exactly as before.
    expect(after.yday).toEqual(before.yday);
    // Today: 2 x (420 - 300) = 240 taken in cash; margin = 240 - 2 x (150 - 100) = 140.
    expect(delta(after.today, before.today)).toMatchObject({ revenue: 240, cashSales: 240, profit: 140, bills: 0, chargedToFees: 0 });
    expect(after.dash.profit - before.dash.profit).toBe(140);
    expect(after.dash.revenue - before.dash.revenue).toBe(240);
    expect(after.dash.cashInDrawer - before.dash.cashInDrawer).toBe(240);
    expect(rows).toHaveLength(1);
    expect(rows[0].slice(0, 8)).toEqual([X.sku, Y.sku, '2', '240.00', 'Cash', '100.00', '150.00', today()]);
  });

  test('same-price swap with a cost change on yesterday\'s bill counts on today\'s profit, with no charge', async () => {
    const X = await b.createPricedItem(A, { name: name('Ruler X'), price: 300, cost: 100 });
    const Z = await b.createPricedItem(A, { name: name('Ruler Z'), price: 300, cost: 180 });
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 1 }], { date: yday() });
    const before = await figures(A);
    const res = await b.replace(A, bill.id, { saleLineId: bill.lines[0].lineId, type: 'Item', itemId: Z.id });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    const after = await figures(A);
    const rows = await replacementRows(bill.id);
    await evidence('profit-same-price-swap', { bill: bill.billNumber, response: body, before, after, replacementRow: rows });
    expect(body).toMatchObject({ difference: 0, total: 300, differenceTender: null });
    expect(after.yday).toEqual(before.yday);
    expect(delta(after.today, before.today)).toMatchObject({ revenue: 0, cashSales: 0, profit: -80 });
    expect(after.dash.profit - before.dash.profit).toBe(-80);
    expect(rows[0].slice(3, 7)).toEqual(['0.00', '', '100.00', '180.00']);
    // No money moved, so no ledger posting for the swap.
    expect((await outboxFor(A.tenantId, bill.billNumber)).filter((r) => r[2].includes('"EventId": "replace-'))).toHaveLength(0);
  });

  test('swap on a same-day bill: today ends with the bill\'s profit as it now stands', async () => {
    const X = await b.createPricedItem(A, { name: name('Pen X'), price: 300, cost: 100 });
    const Y = await b.createPricedItem(A, { name: name('Pen Y'), price: 420, cost: 150 });
    const before = await figures(A);
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 1 }]);
    const mid = await figures(A);
    expect(delta(mid.today, before.today)).toMatchObject({ revenue: 300, profit: 200, bills: 1 });
    await f.ok(await b.replace(A, bill.id, { saleLineId: bill.lines[0].lineId, type: 'Item', itemId: Y.id, differenceTender: 'Cash' }), 'same-day swap');
    const after = await figures(A);
    await evidence('profit-same-day-bill', { bill: bill.billNumber, before, mid, after });
    // As sold (300 - 100) + margin (120 - 50) = 270 = the bill now (420 - 150); revenue 420; still one bill.
    expect(delta(after.today, before.today)).toMatchObject({ revenue: 420, cashSales: 420, profit: 270, bills: 1 });
    expect(after.yday).toEqual(before.yday);
  });

  test('item -> kit swap records the kit\'s cost (sum of components) and counts its margin', async () => {
    const P = await b.createPricedItem(A, { name: name('Kit Part P'), price: 150, cost: 100 });
    const R = await b.createPricedItem(A, { name: name('Kit Part R'), price: 250, cost: 180 });
    const Y = await b.createPricedItem(A, { name: name('Atlas Y'), price: 420, cost: 150 });
    const K = await b.createKit(A, { name: name('Starter Kit'), price: 700, components: [{ itemId: P.id, quantity: 1 }, { itemId: R.id, quantity: 2 }] });
    const bill = await b.sale(A, [{ type: 'Item', itemId: Y.id, quantity: 1 }], { date: yday() });
    const stock0 = { Y: await b.stockOf(Y.id), P: await b.stockOf(P.id), R: await b.stockOf(R.id) };
    const before = await figures(A);
    await f.ok(await b.replace(A, bill.id, { saleLineId: bill.lines[0].lineId, type: 'Kit', kitId: K.id, differenceTender: 'Cash' }), 'item -> kit');
    const after = await figures(A);
    const rows = await replacementRows(bill.id);
    const stock1 = { Y: await b.stockOf(Y.id), P: await b.stockOf(P.id), R: await b.stockOf(R.id) };
    const moves = await b.movementsFor(A.tenantId, bill.billNumber);
    await evidence('profit-item-to-kit', { bill: bill.billNumber, before, after, rows, stock0, stock1, moves });
    expect(rows[0].slice(3, 7)).toEqual(['280.00', 'Cash', '150.00', '460.00']);
    expect(after.yday).toEqual(before.yday);
    // margin = 280 - (460 - 150) = -30
    expect(delta(after.today, before.today)).toMatchObject({ revenue: 280, profit: -30 });
    expect(stock1).toEqual({ Y: stock0.Y + 1, P: stock0.P - 1, R: stock0.R - 2 });
    const kitOut = moves.filter((m) => m.reason === 'Sale' && m.kitId === K.id);
    expect(kitOut.map((m) => [m.itemId, m.quantity]).sort()).toEqual([[P.id, -1], [R.id, -2]].sort());
    for (const m of moves.filter((m) => m.date === today())) expect(m.createdByName).toBe(seed.cashierName);
  });

  test('a replacement row from before the unit-cost columns (null costs) still reads, and counts its difference only', async () => {
    const X = await b.createPricedItem(A, { name: name('Legacy X'), price: 300, cost: 100 });
    const Y = await b.createPricedItem(A, { name: name('Legacy Y'), price: 400, cost: 150 });
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 1 }], { date: yday() });
    const before = await figures(A);
    await f.ok(await b.replace(A, bill.id, { saleLineId: bill.lines[0].lineId, type: 'Item', itemId: Y.id, differenceTender: 'Cash' }), 'swap');
    const withCost = await figures(A);
    await f.dbSetup(`PR 552 legacy row: null the unit costs of the swap on ${bill.billNumber}`, `update "BookshopSaleReplacements" set "FromUnitCost" = null, "ToUnitCost" = null where "BookshopSaleId" = ${q(bill.id)}`);
    const legacy = await figures(A);
    const reads = {
      sale: (await A.api.get(`bookshop/sales/${bill.id}`)).status(),
      history: (await A.api.get(`bookshop/sales-history?from=${yday()}&to=${today()}&page=1&pageSize=20`)).status(),
      kits: (await A.api.get('bookshop/kits/summary')).status(),
    };
    await evidence('profit-legacy-null-costs', { bill: bill.billNumber, before, withCost, legacy, reads });
    expect(reads).toEqual({ sale: 200, history: 200, kits: 200 });
    expect(delta(withCost.today, before.today).profit).toBe(50); // 100 - (150 - 100)
    expect(delta(legacy.today, before.today).profit).toBe(100); // difference only
    // The bill's own day nets the bill's current lines against the (cost-less) margin: 400 - 150 - 100 = 150 instead of 200.
    expect(legacy.yday.profit - before.yday.profit).toBe(-50);
  });
});

// ── Replace an Item or Kit (86extv6fx) ───────────────────────────────────────────────────────

test.describe('Replace an item or kit', () => {
  test('cash swap: stock both ways with the cashier\'s name, bill updated in place, audit row, ledger posting', async () => {
    const X = await b.createPricedItem(A, { name: name('Shirt 30'), price: 750, cost: 500, stock: 10 });
    const Y = await b.createPricedItem(A, { name: name('Shirt 34'), price: 820, cost: 540, stock: 10 });
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 1 }]);
    const s0 = { X: await b.stockOf(X.id), Y: await b.stockOf(Y.id) };
    const res = await b.replace(A, bill.id, { saleLineId: bill.lines[0].lineId, type: 'Item', itemId: Y.id, differenceTender: 'Cash' });
    expect(res.status(), await res.text()).toBe(200);
    const after = await b.getSale(A, bill.id);
    const moves = await b.movementsFor(A.tenantId, bill.billNumber);
    const rows = await replacementRows(bill.id);
    const ledger = (await outboxFor(A.tenantId, bill.billNumber)).filter((r) => r[2].includes('"EventId": "replace-'));
    await evidence('replace-cash-swap', { response: await res.json(), saleAfter: after.raw, moves, rows, ledger: ledger.map((r) => JSON.parse(r[2]).Legs) });
    expect({ X: await b.stockOf(X.id), Y: await b.stockOf(Y.id) }).toEqual({ X: s0.X + 1, Y: s0.Y - 1 });
    const back = moves.find((m) => m.itemId === X.id && m.reason === 'Return from Student');
    const out = moves.filter((m) => m.itemId === Y.id && m.reason === 'Sale');
    expect(back).toMatchObject({ quantity: 1, reference: bill.billNumber, notes: `Replaced on ${bill.billNumber}`, createdByName: seed.cashierName });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ quantity: -1, reference: bill.billNumber, createdByName: seed.cashierName });
    expect(after.billNumber).toBe(bill.billNumber);
    expect(after.total).toBe(820);
    expect(after.lines).toHaveLength(1);
    expect(after.lines[0]).toMatchObject({ lineId: bill.lines[0].lineId, name: Y.name, total: 820 });
    expect(rows[0][9]).toBe(A.userId);
    expect(rows[0][7]).toBe(today());
    expect(ledger).toHaveLength(1);
    const legs = JSON.parse(ledger[0][2]).Legs;
    expect(legs.map((l: any) => [l.Debit, l.Credit])).toEqual([[70, 0], [0, 70]]);
    const hist = await f.ok(await A.api.get(`bookshop/sales-history?search=${bill.billNumber}&page=1&pageSize=5`), 'history');
    expect(hist.items[0]).toMatchObject({ billNumber: bill.billNumber, amount: 820 });
  });

  test('fee-account bill: the difference goes on the fee account, the family is notified, cash is refused', async () => {
    const X = await b.createPricedItem(A, { name: name('Fee Book X'), price: 500, cost: 300 });
    const Y = await b.createPricedItem(A, { name: name('Fee Book Y'), price: 650, cost: 380 });
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 1 }], { studentId: seed.student.id, feeAccount: true });
    const cash = await b.replace(A, bill.id, { saleLineId: bill.lines[0].lineId, type: 'Item', itemId: Y.id, differenceTender: 'Cash' });
    expect(cash.status()).toBe(400);
    expect(await errorsOf(cash)).toContain(COPY.feeBill);
    const before = await figures(A);
    const res = await b.replace(A, bill.id, { saleLineId: bill.lines[0].lineId, type: 'Item', itemId: Y.id, differenceTender: f.FEE_ACCOUNT_TENDER });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    const after = await figures(A);
    const outbox = await outboxFor(A.tenantId, seed.student.familyId);
    await evidence('replace-fee-account', { response: body, before, after, outbox: outbox.map((r) => [r[0], r[1]]) });
    expect(body).toMatchObject({ difference: 150, total: 650, differenceTender: f.FEE_ACCOUNT_TENDER, parentNotificationRaised: true });
    expect(delta(after.today, before.today)).toMatchObject({ revenue: 150, chargedToFees: 150, cashSales: 0, profit: 70 });
    expect(outbox.map((r) => r[0])).toEqual(expect.arrayContaining([expect.stringMatching(/purchases|family/i), expect.stringMatching(/fee/i)]));
  });

  test('guards: cheaper, no tender, other tender, unknown line/item/kit/bill, other tenant, bad body: 4xx with the exact copy, nothing moves', async () => {
    const X = await b.createPricedItem(A, { name: name('Guard X'), price: 500, cost: 300 });
    const Cheap = await b.createPricedItem(A, { name: name('Guard Cheap'), price: 400, cost: 200 });
    const Dear = await b.createPricedItem(A, { name: name('Guard Dear'), price: 600, cost: 300 });
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 1 }]);
    const line = bill.lines[0].lineId;
    const stock0 = { X: await b.stockOf(X.id), Cheap: await b.stockOf(Cheap.id), Dear: await b.stockOf(Dear.id) };
    const cases: [string, () => Promise<any>, number, string][] = [
      ['cheaper', () => b.replace(A, bill.id, { saleLineId: line, type: 'Item', itemId: Cheap.id, differenceTender: 'Cash' }), 400, COPY.cheaper],
      ['no tender', () => b.replace(A, bill.id, { saleLineId: line, type: 'Item', itemId: Dear.id }), 400, COPY.chooseTender],
      ['fee tender on a cash bill', () => b.replace(A, bill.id, { saleLineId: line, type: 'Item', itemId: Dear.id, differenceTender: f.FEE_ACCOUNT_TENDER }), 400, COPY.cashBill],
      ['unsupported tender', () => b.replace(A, bill.id, { saleLineId: line, type: 'Item', itemId: Dear.id, differenceTender: 'Card' }), 400, 'Tender is not supported.'],
      ['no replacement', () => b.replace(A, bill.id, { saleLineId: line, type: 'Item' }), 400, COPY.select],
      ['bad type', () => b.replace(A, bill.id, { saleLineId: line, type: 'Gift', itemId: Dear.id }), 400, COPY.select],
      ['kit type without kit', () => b.replace(A, bill.id, { saleLineId: line, type: 'Kit', itemId: Dear.id }), 400, COPY.select],
      ['no line', () => b.replace(A, bill.id, { saleLineId: '', type: 'Item', itemId: Dear.id, differenceTender: 'Cash' }), 400, COPY.selectLine],
      ['unknown line', () => b.replace(A, bill.id, { saleLineId: randomUUID(), type: 'Item', itemId: Dear.id, differenceTender: 'Cash' }), 400, COPY.selectLine],
      ['unknown item', () => b.replace(A, bill.id, { saleLineId: line, type: 'Item', itemId: randomUUID(), differenceTender: 'Cash' }), 400, ''],
      ['unknown kit', () => b.replace(A, bill.id, { saleLineId: line, type: 'Kit', kitId: randomUUID(), differenceTender: 'Cash' }), 400, ''],
      ['unknown bill', () => b.replace(A, randomUUID(), { saleLineId: line, type: 'Item', itemId: Dear.id, differenceTender: 'Cash' }), 404, ''],
      ['other tenant', () => b.replace(C, bill.id, { saleLineId: line, type: 'Item', itemId: Dear.id, differenceTender: 'Cash' }), 404, ''],
      ['reason too long', () => b.replace(A, bill.id, { saleLineId: line, type: 'Item', itemId: Dear.id, differenceTender: 'Cash', lowStockReason: 'x'.repeat(201) }), 400, 'Reason cannot exceed 200 characters.'],
      ['empty body', () => A.api.post(`bookshop/sales/${bill.id}/replace`, { data: {} }), 400, ''],
    ];
    const results: any[] = [];
    for (const [label, call, status, copy] of cases) {
      const res = await call();
      const text = await res.text();
      results.push({ label, status: res.status(), body: text.slice(0, 400) });
    }
    await evidence('replace-guards', results);
    for (const [i, [label, , status, copy]] of cases.entries()) {
      expect.soft(results[i].status, `${label}: ${results[i].body}`).toBe(status);
      if (copy) expect.soft(results[i].body, label).toContain(copy);
    }
    expect({ X: await b.stockOf(X.id), Cheap: await b.stockOf(Cheap.id), Dear: await b.stockOf(Dear.id) }).toEqual(stock0);
    expect(await replacementRows(bill.id)).toHaveLength(0);
    expect((await b.getSale(A, bill.id)).total).toBe(500);
  });

  test('low stock: refused without a reason, allowed (warn-and-allow) with one, and the reason is on the audit row', async () => {
    const X = await b.createPricedItem(A, { name: name('Low X'), price: 200, cost: 100 });
    const Out = await b.createPricedItem(A, { name: name('Low Out'), price: 260, cost: 120, stock: 0 });
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 1 }]);
    const refused = await b.replace(A, bill.id, { saleLineId: bill.lines[0].lineId, type: 'Item', itemId: Out.id, differenceTender: 'Cash' });
    const refusedBody = await refused.text();
    const allowed = await b.replace(A, bill.id, { saleLineId: bill.lines[0].lineId, type: 'Item', itemId: Out.id, differenceTender: 'Cash', lowStockReason: 'Last one on the shelf, count pending' });
    const allowedBody = await allowed.text();
    const rows = await replacementRows(bill.id);
    await evidence('replace-low-stock', { refused: [refused.status(), refusedBody], allowed: [allowed.status(), allowedBody], rows, stockOut: await b.stockOf(Out.id) });
    expect(refused.status()).toBe(400);
    // The modal shows the story copy (help text, Confirm disabled until a reason); the API answers with the till's own sale copy.
    expect(JSON.parse(refusedBody).errors.lowStockReason[0]).toMatch(/Add a reason\.$/);
    expect(allowed.status(), allowedBody).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0][8]).toBe('Last one on the shelf, count pending');
    expect(await b.stockOf(Out.id)).toBe(-1);
  });

  test('a returned bill cannot be replaced', async () => {
    const X = await b.createPricedItem(A, { name: name('Ret X'), price: 200, cost: 100 });
    const Y = await b.createPricedItem(A, { name: name('Ret Y'), price: 300, cost: 100 });
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 1 }]);
    await f.ok(await b.returnSale(A, bill.id, 'Wrong item issued'), 'return');
    const res = await b.replace(A, bill.id, { saleLineId: bill.lines[0].lineId, type: 'Item', itemId: Y.id, differenceTender: 'Cash' });
    const text = await res.text();
    await evidence('replace-returned-bill', { status: res.status(), body: text });
    expect(res.status()).toBe(400);
    expect(text).toContain(COPY.returnedReplace);
  });
});

// ── Return a Sale (86extv6a8) ────────────────────────────────────────────────────────────────

test.describe('Return a sale', () => {
  test('cash bill with a kit and a replacement: everything back with the cashier\'s name, Returned, refund = all the cash taken @smoke', async () => {
    const P = await b.createPricedItem(A, { name: name('Ret Part P'), price: 100, cost: 60 });
    const R = await b.createPricedItem(A, { name: name('Ret Part R'), price: 120, cost: 70 });
    const X = await b.createPricedItem(A, { name: name('Ret Book X'), price: 300, cost: 100 });
    const Y = await b.createPricedItem(A, { name: name('Ret Book Y'), price: 380, cost: 150 });
    const K = await b.createKit(A, { name: name('Return Kit'), price: 400, components: [{ itemId: P.id, quantity: 2 }, { itemId: R.id, quantity: 1 }] });
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 1 }, { type: 'Kit', kitId: K.id, quantity: 1 }], { date: yday() });
    const xLine = bill.lines.find((l) => l.name === X.name)!;
    await f.ok(await b.replace(A, bill.id, { saleLineId: xLine.lineId, type: 'Item', itemId: Y.id, differenceTender: 'Cash' }), 'swap first');
    const stock0 = { X: await b.stockOf(X.id), Y: await b.stockOf(Y.id), P: await b.stockOf(P.id), R: await b.stockOf(R.id) };
    const empty = await b.returnSale(A, bill.id, '   ');
    const missing = await b.returnSale(A, bill.id, null);
    const long = await b.returnSale(A, bill.id, 'x'.repeat(201));
    const before = await figures(A);
    const res = await b.returnSale(A, bill.id, 'Wrong item issued');
    const body = await res.json();
    const again = await b.returnSale(A, bill.id, 'Wrong item issued');
    const after = await figures(A);
    const moves = (await b.movementsFor(A.tenantId, bill.billNumber)).filter((m) => m.notes === `Returned on ${bill.billNumber}`);
    const audit = await f.sql(`select "BillNumber","Reason","ReturnDate"::date::text,"CashRefund"::text,"FeeAccountRefund"::text,"CreatedBy" from "BookshopSaleReturns" where "BookshopSaleId" = ${q(bill.id)}`);
    const hist = await f.ok(await A.api.get(`bookshop/sales-history?search=${bill.billNumber}&page=1&pageSize=5`), 'history');
    const sale = await b.getSale(A, bill.id);
    await evidence('return-cash-kit', { response: body, guards: { empty: [empty.status(), await empty.text()], missing: [missing.status(), await missing.text()], long: [long.status(), await long.text()], again: [again.status(), await again.text()] }, before, after, moves, audit, history: hist.items[0], sale: sale.raw });
    expect(empty.status()).toBe(400); expect(await empty.text()).toContain(COPY.reasonRequired);
    expect(missing.status()).toBe(400); expect(await missing.text()).toContain(COPY.reasonRequired);
    expect(long.status()).toBe(400); expect(await long.text()).toContain(COPY.reasonTooLong);
    expect(res.status()).toBe(200);
    expect(body).toMatchObject({ reference: bill.billNumber, cashRefund: 780, feeAccountRefund: 0, message: 'Sale returned.' });
    expect(again.status()).toBe(409); expect(await again.text()).toContain(COPY.alreadyReturned);
    // Y (the line now) and the kit's components as they went out; X already came back with the swap.
    expect({ X: await b.stockOf(X.id), Y: await b.stockOf(Y.id), P: await b.stockOf(P.id), R: await b.stockOf(R.id) }).toEqual({ X: stock0.X, Y: stock0.Y + 1, P: stock0.P + 2, R: stock0.R + 1 });
    expect(moves.map((m) => [m.itemId, m.reason, m.quantity]).sort()).toEqual([[Y.id, 'Return from Student', 1], [P.id, 'Return from Student', 2], [R.id, 'Return from Student', 1]].sort());
    for (const m of moves) expect(m.createdByName).toBe(seed.cashierName);
    expect(audit).toEqual([[bill.billNumber, 'Wrong item issued', today(), '780.00', '0.00', A.userId]]);
    expect(hist.items[0].status).toBe('Returned');
    expect(sale.raw.isReturned).toBe(true);
    expect(delta(after.today, before.today)).toMatchObject({ cashRefunds: 780, returnsCount: 1, returnsTotal: 780, revenue: 0 });
    expect(after.yday).toEqual(before.yday);
  });

  test('fee-account bill: the charge is reversed on the fee account with a typed ledger entry, no cash leaves the drawer', async () => {
    const X = await b.createPricedItem(A, { name: name('Fee Ret X'), price: 2150, cost: 1500 });
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 1 }], { studentId: seed.student.id, feeAccount: true });
    const before = await figures(A);
    const res = await b.returnSale(A, bill.id, 'Wrong item issued');
    const body = await res.json();
    const after = await figures(A);
    const ledger = (await outboxFor(A.tenantId, bill.billNumber)).filter((r) => r[2].includes('"EventId": "return-'));
    await evidence('return-fee-account', { response: body, before, after, ledger: ledger.map((r) => JSON.parse(r[2])) });
    expect(body).toMatchObject({ cashRefund: 0, feeAccountRefund: 2150, parentNotificationRaised: true });
    expect(delta(after.today, before.today)).toMatchObject({ cashRefunds: 0, returnsCount: 1, returnsTotal: 2150 });
    expect(ledger).toHaveLength(1);
    const ev = JSON.parse(ledger[0][2]);
    expect(ev.Reason).toBe('Wrong item issued');
    expect(ev.Legs.map((l: any) => [l.Debit, l.Credit, l.FamilyId])).toEqual(expect.arrayContaining([[0, 2150, seed.student.familyId]]));
  });

  test('a cash refund bigger than the drawer is refused with the exact copy; the bill is untouched', async () => {
    // Campus C: no day opened today, so the drawer is empty; yesterday's bill took its cash yesterday.
    const X = await b.createPricedItem(C, { name: name('Drawer X'), price: 900, cost: 400 });
    const bill = await b.sale(C, [{ type: 'Item', itemId: X.id, quantity: 1 }], { date: yday() });
    const s0 = await b.stockOf(X.id);
    const res = await b.returnSale(C, bill.id, 'Customer changed mind');
    const text = await res.text();
    await evidence('return-drawer-short', { status: res.status(), body: text, drawer: (await b.dashboard(C, today())).cashInDrawer });
    expect(res.status()).toBe(409);
    expect(text).toContain(COPY.drawerShort);
    expect(await b.stockOf(X.id)).toBe(s0);
    expect((await b.getSale(C, bill.id)).raw.isReturned).toBe(false);
  });

  test('unknown bill 404, other tenant 404, empty body 400 (no 500s)', async () => {
    const X = await b.createPricedItem(A, { name: name('404 X'), price: 100, cost: 50 });
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 1 }]);
    const r = {
      unknown: (await b.returnSale(A, randomUUID(), 'x')).status(),
      otherTenant: (await b.returnSale(C, bill.id, 'x')).status(),
      emptyBody: (await A.api.post(`bookshop/sales/${bill.id}/return`, { data: {} })).status(),
      getOther: (await C.api.get(`bookshop/sales/${bill.id}`)).status(),
    };
    await evidence('return-404s', r);
    expect(r).toEqual({ unknown: 404, otherTenant: 404, emptyBody: 400, getOther: 404 });
  });
});

// ── UI ───────────────────────────────────────────────────────────────────────────────────────

async function ownerContext(browser: Browser, owner: CampusOwner): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: process.env.QA_BASE_URL, ignoreHTTPSErrors, timezoneId: 'Asia/Karachi', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await signInToWebApp(page, owner.credentials());
  await page.close();
  return ctx;
}

async function openHistory(ctx: BrowserContext, billNumber: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto('/bookshop/sales-history');
  await page.getByPlaceholder('Search by bill number, student, or admission number').fill(billNumber);
  await expect(page.locator('main table tbody tr')).toHaveCount(1, { timeout: 20_000 });
  return page;
}
const row = (page: Page, billNumber: string) => page.locator('main table tbody tr', { hasText: billNumber });
async function rowMenu(page: Page, billNumber: string) {
  await row(page, billNumber).getByRole('button').last().click();
  return page.getByRole('menuitem');
}

/** Variant item "School Uniform Shirt" with Size 30 at Rs 750 and Size 34 at Rs 820 (the story's scenario). */
async function uniformShirt(owner: CampusOwner) {
  const sku = `QA-SH-${f.letters(5).toUpperCase()}`;
  const nm = `School Uniform Shirt ${f.letters(3)}`;
  await f.ok(await owner.api.post('bookshop/inventory', {
    data: {
      itemName: nm, sku, category: 'Uniform', description: null, openingStock: null, reorderLevel: 0, costPrice: null, retailPrice: null, hasVariants: true,
      options: [{ name: 'Size', values: ['30', '34'] }],
      variants: [
        { name: '30', sku: `${sku}-30`, values: ['30'], openingStock: 10, costPrice: 500, retailPrice: 750 },
        { name: '34', sku: `${sku}-34`, values: ['34'], openingStock: 10, costPrice: 540, retailPrice: 820 },
      ],
    },
  }), 'uniform shirt');
  const rows = await f.sql(`select "Id","ParentItemId",coalesce("VariantName",''),"Sku" from "BookshopItems" where "TenantId" = ${q(owner.tenantId)} and "Sku" like ${q(sku + '%')}`);
  const parent = rows.find((r) => r[3] === sku)!;
  const v = (n: string) => rows.find((r) => r[1] === parent[0] && r[2] === n)!;
  return { name: nm, sku, parentId: parent[0], s30: { id: v('30')[0], sku: v('30')[3] }, s34: { id: v('34')[0], sku: v('34')[3] } };
}

test.describe('Sales History UI', () => {
  test('Replace item: Size 30 (Rs 750) -> Size 34 (Rs 820), Rs 70 in cash, toast, row amount; a cheaper pick is refused inline @smoke', async ({ browser }) => {
    test.setTimeout(4 * 60_000);
    const shirt = await uniformShirt(A);
    const cheap = await b.createPricedItem(A, { name: name('Cheap Sock'), price: 120, cost: 60 });
    const bill = await b.sale(A, [{ type: 'Item', itemId: shirt.parentId, variantId: shirt.s30.id, quantity: 1 }]);
    const s0 = { s30: await b.stockOf(shirt.s30.id), s34: await b.stockOf(shirt.s34.id) };
    const ctx = await ownerContext(browser, A);
    const page = await openHistory(ctx, bill.billNumber);
    await expect(row(page, bill.billNumber)).toContainText('Rs 750');
    const items = await rowMenu(page, bill.billNumber);
    await expect(items.filter({ hasText: 'Replace item' })).toBeVisible();
    await expect(items.filter({ hasText: 'Return sale' })).toBeVisible();
    await items.filter({ hasText: 'Replace item' }).click();
    const modal = page.locator('[data-replace-modal]');
    await expect(modal.getByText('Replace item', { exact: true }).first()).toBeVisible();
    await expect(modal.locator('[data-bill-title]')).toContainText(bill.billNumber);
    await expect(modal.locator('[data-line-total]')).toHaveText('Rs 750');
    // Cheaper pick first.
    await modal.getByPlaceholder('Search by item name, SKU, or kit').fill(cheap.sku);
    await page.getByText(cheap.name).first().click();
    await expect(modal.locator('[data-replace-error="cheaper"]')).toHaveText(COPY.cheaper);
    await expect(modal.locator('[data-action="confirm-replacement"]')).toBeDisabled();
    await shot(page, 'ui-replace-cheaper');
    await modal.locator('[data-action="change-replacement"]').click();
    await modal.getByPlaceholder('Search by item name, SKU, or kit').fill(shirt.s34.sku);
    await page.getByText(/34/).filter({ hasText: shirt.name }).first().click().catch(async () => { await page.locator('[role="option"], li', { hasText: shirt.s34.sku }).first().click(); });
    await expect(modal.locator('[data-pick-price]')).toHaveText('Rs 820');
    await expect(modal.locator('[data-replace-difference] [data-amount]')).toHaveText('Rs 70');
    await expect(modal.locator('[data-replace-tender]')).toContainText('Charge difference to');
    await expect(modal.locator('[data-tender-value]')).toHaveText('Cash');
    await shot(page, 'ui-replace-ready');
    // Network failure: inline copy, the selection is kept, and a retry goes through.
    await page.route('**/bookshop/sales/*/replace', (r) => r.abort('internetdisconnected'));
    await modal.locator('[data-action="confirm-replacement"]').click();
    await expect(modal.locator('[data-replace-failure]')).toHaveText('We could not process the replacement. Please check your connection and try again.');
    await expect(modal.locator('[data-pick-price]')).toHaveText('Rs 820');
    await shot(page, 'ui-replace-network-failure');
    await page.unroute('**/bookshop/sales/*/replace');
    await modal.locator('[data-action="confirm-replacement"]').click();
    await expect(page.getByText('Item replaced').first()).toBeVisible({ timeout: 20_000 });
    await expect(modal).toBeHidden();
    await shot(page, 'ui-replace-done');
    await expect(row(page, bill.billNumber)).toContainText('Rs 820');
    expect({ s30: await b.stockOf(shirt.s30.id), s34: await b.stockOf(shirt.s34.id) }).toEqual({ s30: s0.s30 + 1, s34: s0.s34 - 1 });
    await ctx.close();
  });

  test('Return sale: whole-bill note, refund line, reason required, then Returned with no more actions @smoke', async ({ browser }) => {
    test.setTimeout(4 * 60_000);
    const X = await b.createPricedItem(A, { name: name('UI Return Book'), price: 1075, cost: 600 });
    const bill = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 2 }]);
    const ctx = await ownerContext(browser, A);
    const page = await openHistory(ctx, bill.billNumber);
    await (await rowMenu(page, bill.billNumber)).filter({ hasText: 'Return sale' }).click();
    const modal = page.locator('[data-return-modal]');
    await expect(modal.locator('[data-bill-title]')).toContainText(bill.billNumber);
    await expect(modal.locator('[data-return-line]')).toHaveCount(1);
    await expect(modal.locator('[data-return-line]')).toContainText('Qty 2');
    await expect(modal.locator('[data-return-note]')).toHaveText(COPY.wholeBill);
    await expect(modal.locator('[data-return-refund]')).toContainText(COPY.refundCash);
    await expect(modal.locator('[data-return-refund] [data-amount]')).toHaveText('Rs 2,150');
    await modal.getByRole('button', { name: 'Confirm return' }).click();
    await expect(modal.getByText(COPY.reasonRequired)).toBeVisible();
    await shot(page, 'ui-return-reason-required');
    await modal.getByLabel('Reason for return').fill('Wrong item issued');
    await shot(page, 'ui-return-ready');
    await page.route('**/bookshop/sales/*/return', (r) => r.abort('internetdisconnected'));
    await modal.getByRole('button', { name: 'Confirm return' }).click();
    await expect(modal.locator('[data-return-failure]')).toHaveText('We could not process the return. Please check your connection and try again.');
    await expect(modal.getByLabel('Reason for return')).toHaveValue('Wrong item issued');
    await shot(page, 'ui-return-network-failure');
    await page.unroute('**/bookshop/sales/*/return');
    await modal.getByRole('button', { name: 'Confirm return' }).click();
    await expect(page.getByText('Sale returned').first()).toBeVisible({ timeout: 20_000 });
    await expect(modal).toBeHidden();
    await expect(row(page, bill.billNumber)).toContainText('Returned');
    await shot(page, 'ui-return-done');
    const items = await rowMenu(page, bill.billNumber);
    await expect(items.filter({ hasText: 'View bill' })).toBeVisible();
    await expect(items.filter({ hasText: 'Replace item' })).toHaveCount(0);
    await expect(items.filter({ hasText: 'Return sale' })).toHaveCount(0);
    await ctx.close();
  });

  test('Recent bills on the POS dashboard: newest first with bill, customer and amount; a row opens the bill', async ({ browser }) => {
    const X = await b.createPricedItem(A, { name: name('Recent X'), price: 1240, cost: 900 });
    const linked = await b.sale(A, [{ type: 'Item', itemId: X.id, quantity: 1 }], { studentId: seed.student.id, feeAccount: true });
    const dash = await b.dashboard(A, today());
    await evidence('recent-bills', dash.raw.recentBills);
    expect(dash.raw.recentBills[0]).toMatchObject({ reference: linked.billNumber, customer: seed.student.name, total: 1240 });
    const ctx = await ownerContext(browser, A);
    const page = await ctx.newPage();
    await page.goto('/bookshop/point-of-sale');
    const panel = page.locator('section, div', { has: page.getByText('Recent bills', { exact: true }) }).last();
    await expect(page.getByText(linked.billNumber).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Rs 1,240').first()).toBeVisible();
    await shot(page, 'ui-recent-bills', true);
    await page.getByText(linked.billNumber).first().click();
    await expect(page).toHaveURL(new RegExp(linked.id));
    await ctx.close();
  });
});

// ── Permissions ──────────────────────────────────────────────────────────────────────────────

/** DB SETUP: campus C's owner holds `roleId` instead of the creator's Head Admin (stand-in for a staff member). */
async function actAs(roleId: string | null) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const creator = roleId ? '000000000000000000000552' : C.userId;
  console.log(`[DB SETUP mongo] tenant ${seed.c.tenantId}: CreatedBy -> ${roleId ? 'another id' : 'the owner'}`);
  await run(process.env.QA_MONGOSH!, [process.env.QA_MONGO_URL!, '--quiet', '--eval', `db.tenants.updateOne({_id: ObjectId('${seed.c.tenantId}')}, {$set: {CreatedBy: '${creator}'}})`]);
  if (roleId) {
    await f.dbSetup(`campus C owner holds custom role ${roleId}`, `
      delete from "AccessRoleAssignments" where "TenantId" = ${q(seed.c.tenantId)} and "UserId" = ${q(C.userId)};
      insert into "AccessRoleAssignments" ("Id","TenantId","UserId","AccessRoleId","SystemRoleName","Scope","CreatedDate","CreatedBy")
      values (gen_random_uuid(), ${q(seed.c.tenantId)}, ${q(C.userId)}, ${q(roleId)}::uuid, null, 'Tenant', now(), 'qa552')`);
  }
  await C.refreshToken();
}

test.describe('Permissions', () => {
  test('Replace needs Bookshop Edit and Return needs Approve: hidden in the menu and 403 from the API', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const X = await b.createPricedItem(C, { name: name('Perm X'), price: 200, cost: 100 });
    const Y = await b.createPricedItem(C, { name: name('Perm Y'), price: 300, cost: 100 });
    const bill = await b.sale(C, [{ type: 'Item', itemId: X.id, quantity: 1 }]);
    const out: any = {};
    try {
      for (const [label, roleId] of [['viewer', seed.c.seeRoleId], ['clerk', seed.c.editRoleId]] as const) {
        await actAs(roleId);
        const replace = await b.replace(C, bill.id, { saleLineId: bill.lines[0].lineId, type: 'Item', itemId: Y.id, differenceTender: 'Cash', lowStockReason: null });
        const ret = await b.returnSale(C, bill.id, 'Permission probe');
        const ctx = await ownerContext(browser, C);
        const page = await openHistory(ctx, bill.billNumber);
        const items = await rowMenu(page, bill.billNumber);
        await expect(items.filter({ hasText: 'View bill' })).toBeVisible();
        out[label] = { replace: replace.status(), return: ret.status(), menu: await items.allInnerTexts() };
        await shot(page, `perm-${label}-menu`);
        await ctx.close();
      }
    } finally {
      await actAs(null);
    }
    await evidence('permissions', out);
    expect(out.viewer.replace).toBe(403);
    expect(out.viewer.return).toBe(403);
    expect(out.viewer.menu.join('|')).not.toMatch(/Replace item|Return sale/);
    // The clerk's replace went through (Edit); the return stays refused (Approve).
    expect(out.clerk.replace).toBe(200);
    expect(out.clerk.return).toBe(403);
    expect(out.clerk.menu.join('|')).toContain('Replace item');
    expect(out.clerk.menu.join('|')).not.toContain('Return sale');
  });
});
