/**
 * Bookshop seeding helpers (local stack): items, variant items and stock movements through the owner's
 * RestApi bearer, plus read-only helpers for the Stock Movements log (PR 558).
 */
import { randomUUID } from 'node:crypto';
import { expect, type APIResponse } from '@playwright/test';
import type { CampusOwner } from './campus-owner';
import { letters, ok, sql, sqlQuote as q } from './fees';

export const REASONS = ['Opening Stock', 'Purchase Receipt', 'Return from Student', 'Sale', 'Return to Supplier', 'Damage', 'Loss', 'Stock Correction'] as const;
export type Reason = (typeof REASONS)[number];

export interface Item { id: string; name: string; sku: string; variants: { id: string; name: string; sku: string }[] }

/** UTC calendar date `days` before today (the server's "Date cannot be in the future" rule is UTC). */
export const utcDate = (daysAgo = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
};

export async function createItem(owner: CampusOwner, o: { name?: string; sku?: string; openingStock?: number; price?: number } = {}): Promise<Item> {
  const name = o.name ?? `QA Item ${letters(5)}`;
  const sku = o.sku ?? `QA-${letters(8).toUpperCase()}`;
  const body = await ok(
    await owner.api.post('bookshop/inventory', {
      data: {
        itemName: name, sku, category: 'Stationery', description: null, openingStock: o.openingStock ?? 100, reorderLevel: 0,
        costPrice: 100, retailPrice: o.price ?? 300, hasVariants: false, options: [], variants: [],
      },
    }),
    `create item ${name}`,
  );
  return { id: (body.item ?? body).id, name, sku, variants: [] };
}

/** An item with one option ("Size") and the given variants, each with its own SKU and opening stock. */
export async function createVariantItem(owner: CampusOwner, o: { name?: string; sku?: string; sizes?: string[]; openingStock?: number } = {}): Promise<Item> {
  const name = o.name ?? `QA Tie ${letters(5)}`;
  const sku = o.sku ?? `QA-${letters(8).toUpperCase()}`;
  const sizes = o.sizes ?? ['Small', 'Large'];
  const variants = sizes.map((s) => ({ name: s, sku: `${sku}-${s.toUpperCase().slice(0, 1)}${letters(2).toUpperCase()}`, values: [s], openingStock: o.openingStock ?? 20, costPrice: 50, retailPrice: 150 }));
  await ok(
    await owner.api.post('bookshop/inventory', {
      data: {
        itemName: name, sku, category: 'Uniform', description: null, openingStock: null, reorderLevel: 0, costPrice: null, retailPrice: null,
        hasVariants: true, options: [{ name: 'Size', values: sizes }], variants,
      },
    }),
    `create variant item ${name}`,
  );
  const rows = await sql(`select "Id","ParentItemId",coalesce("VariantName",''),"Sku" from "BookshopItems" where "TenantId" = ${q(owner.tenantId)} and ("Sku" = ${q(sku)} or "Sku" like ${q(sku + '-%')})`);
  const parent = rows.find((r) => r[3] === sku && !r[1]);
  expect(parent, `parent row of ${name}: ${JSON.stringify(rows)}`).toBeTruthy();
  return {
    id: parent![0], name, sku,
    variants: rows.filter((r) => r[1] === parent![0]).map((r) => ({ id: r[0], name: r[2], sku: r[3] })),
  };
}

/** POST /bookshop/inventory/{itemId}/stock-movements (the Update stock form). Quantity is the magnitude except for Stock Correction. */
export async function recordMovement(
  owner: CampusOwner,
  itemId: string,
  o: { reason: Reason; quantity: number; date?: string; variantId?: string | null; notes?: string | null; reference?: string | null },
): Promise<APIResponse> {
  return owner.api.post(`bookshop/inventory/${itemId}/stock-movements`, {
    data: {
      variantId: o.variantId ?? null, reasonCode: o.reason, quantity: o.quantity, movementDate: `${o.date ?? utcDate()}T00:00:00Z`,
      reference: o.reference ?? null, notes: o.notes ?? null,
    },
  });
}

export async function movement(owner: CampusOwner, itemId: string, o: Parameters<typeof recordMovement>[2]): Promise<void> {
  const res = await recordMovement(owner, itemId, o);
  expect(res.status(), `stock movement ${o.reason} on ${itemId}: ${await res.text()}`).toBe(200);
}

/** A real cash sale at the point of sale (opens today's POS day if needed). */
export async function cashSale(owner: CampusOwner, itemId: string, quantity = 1, variantId: string | null = null): Promise<void> {
  const day = await owner.api.post('bookshop/point-of-sale/day', { data: { openingFloat: 0 } });
  expect(day.status(), `open POS day: ${await day.text()}`).toBeLessThan(500);
  await ok(
    await owner.api.post('bookshop/point-of-sale/sales', {
      data: {
        clientSaleId: randomUUID(), movementDate: new Date().toISOString(), reference: null, lowStockReason: null, studentId: null,
        tenderType: 'Cash', amountReceived: 100_000, lines: [{ type: 'Item', itemId, variantId, kitId: null, quantity }],
      },
    }),
    `cash sale ${itemId}`,
  );
}

export interface AuditRow { actorUserId: string; actorName: string; exportedAtUtc: string; dateFrom: string; dateTo: string; filters: any; rowCount: number; fileName: string }

export async function exportAudits(tenantId: string): Promise<AuditRow[]> {
  const rows = await sql(`select "ActorUserId","ActorName","ExportedAtUtc"::text,"DateFrom"::text,"DateTo"::text,"FiltersJson","RowCount"::text,"FileName"
    from "BookshopStockMovementsExportAuditEntries" where "TenantId" = ${q(tenantId)} order by "ExportedAtUtc"`);
  return rows.map(([actorUserId, actorName, exportedAtUtc, dateFrom, dateTo, filters, rowCount, fileName]) => ({
    actorUserId, actorName, exportedAtUtc, dateFrom, dateTo, filters: JSON.parse(filters || 'null'), rowCount: Number(rowCount), fileName,
  }));
}

/** RFC 4180 parser (quoted fields, doubled quotes, CRLF or LF line breaks inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── Return / Replace a Sale (PR 552: ClickUp 86extv6fx Replace an Item or Kit, 86extv6a8 Return a Sale) ─────────

/** Pakistan (operational) calendar date `days` before today: the server dates replacements and returns by PKT. */
export const pktDate = (daysAgo = 0) => {
  const d = new Date(Date.now() + 5 * 3600_000);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
};

/** A single item with an explicit cost and price (profit = price - cost). */
export async function createPricedItem(owner: CampusOwner, o: { name: string; price: number; cost: number; stock?: number; category?: string }): Promise<Item> {
  const sku = `QA-${letters(8).toUpperCase()}`;
  const body = await ok(
    await owner.api.post('bookshop/inventory', {
      data: {
        itemName: o.name, sku, category: o.category ?? 'Stationery', description: null, openingStock: o.stock ?? 50, reorderLevel: 0,
        costPrice: o.cost, retailPrice: o.price, hasVariants: false, options: [], variants: [],
      },
    }),
    `create item ${o.name}`,
  );
  return { id: (body.item ?? body).id, name: o.name, sku, variants: [] };
}

export interface Kit { id: string; name: string; sku: string }

export async function createKit(owner: CampusOwner, o: { name: string; price: number; components: { itemId: string; quantity: number }[]; category?: string }): Promise<Kit> {
  const sku = `QA-KIT-${letters(6).toUpperCase()}`;
  const res = await owner.api.post('bookshop/kits', {
    data: { name: o.name, sku, category: o.category ?? 'Grade 1', description: null, kitPrice: o.price, components: o.components },
  });
  const body = await ok(res, `create kit ${o.name}`);
  return { id: (body.kit ?? body).id, name: o.name, sku };
}

export type SaleLine = { type: 'Item' | 'Kit'; itemId?: string | null; variantId?: string | null; kitId?: string | null; quantity: number; lowStockReason?: string | null };

export interface Sale { id: string; billNumber: string; total: number; lines: { lineId: string; name: string; total: number; quantity: number }[] }

/** A point-of-sale bill dated `date` (YYYY-MM-DD; a past date makes "yesterday's bill"). Cash unless a student + fee tender. */
export async function sale(owner: CampusOwner, lines: SaleLine[], o: { date?: string; studentId?: string | null; feeAccount?: boolean } = {}): Promise<Sale> {
  const body = await ok(
    await owner.api.post('bookshop/point-of-sale/sales', {
      data: {
        clientSaleId: randomUUID(), movementDate: `${o.date ?? pktDate()}T00:00:00Z`, reference: null, lowStockReason: null,
        studentId: o.studentId ?? null, tenderType: o.feeAccount ? 'Charge to fee account' : 'Cash', amountReceived: o.feeAccount ? null : 1_000_000,
        lines: lines.map((l) => ({ type: l.type, itemId: l.itemId ?? null, variantId: l.variantId ?? null, kitId: l.kitId ?? null, quantity: l.quantity, lowStockReason: l.lowStockReason ?? null })),
      },
    }),
    'point-of-sale sale',
  );
  const [row] = await sql(`select "Id" from "BookshopSales" where "TenantId" = ${q(owner.tenantId)} and "BillNumber" = ${q(body.reference)}`);
  expect(row, `sale row for ${body.reference}`).toBeTruthy();
  return getSale(owner, row[0]);
}

/** GET /bookshop/sales/{id}: the bill as Sales History reads it. */
export async function getSale(owner: CampusOwner, saleId: string): Promise<Sale & { raw: any }> {
  const raw = await ok(await owner.api.get(`bookshop/sales/${saleId}`), `get sale ${saleId}`);
  return {
    id: saleId, billNumber: raw.reference, total: Number(raw.total), raw,
    lines: (raw.lines ?? []).map((l: any) => ({ lineId: l.lineId, name: l.name, total: Number(l.total), quantity: l.quantity })),
  };
}

export const replace = (owner: CampusOwner, saleId: string, body: Record<string, unknown>) =>
  owner.api.post(`bookshop/sales/${saleId}/replace`, { data: { variantId: null, kitId: null, itemId: null, differenceTender: null, studentId: null, lowStockReason: null, ...body } });

export const returnSale = (owner: CampusOwner, saleId: string, reason: string | null) =>
  owner.api.post(`bookshop/sales/${saleId}/return`, { data: { reason } });

export interface DayFigures { revenue: number; profit: number; cashSales: number; cashRefunds: number; chargedToFees: number; bills: number; returnsCount: number; returnsTotal: number; expectedInDrawer: number; isClosed: boolean }

export async function dayClose(owner: CampusOwner, date: string): Promise<DayFigures> {
  const d = await ok(await owner.api.get(`bookshop/day-close?businessDate=${date}`), `day-close ${date}`);
  return {
    revenue: Number(d.revenue), profit: Number(d.profit), cashSales: Number(d.cashSales), cashRefunds: Number(d.cashRefunds), chargedToFees: Number(d.chargedToFees),
    bills: d.bills, returnsCount: d.returnsCount, returnsTotal: Number(d.returnsTotal), expectedInDrawer: Number(d.expectedInDrawer), isClosed: d.isClosed,
  };
}

export async function dashboard(owner: CampusOwner, date: string): Promise<{ revenue: number; profit: number; cashInDrawer: number; bills: number; raw: any }> {
  const d = await ok(await owner.api.get(`bookshop/point-of-sale/dashboard?businessDate=${date}`), `dashboard ${date}`);
  return { revenue: Number(d.revenue), profit: Number(d.profit), cashInDrawer: Number(d.cashInDrawer), bills: d.billsIssuedToday, raw: d };
}

export async function stockOf(itemId: string): Promise<number> {
  const [r] = await sql(`select "StockQuantity" from "BookshopItems" where "Id" = ${q(itemId)}`);
  return Number(r[0]);
}

export interface MovementRow { itemId: string; reason: string; quantity: number; reference: string; notes: string; createdByName: string; kitId: string; saleLineId: string; date: string }

export async function movementsFor(tenantId: string, reference: string): Promise<MovementRow[]> {
  const rows = await sql(`select "BookshopItemId"::text,"Reason","Quantity"::text,coalesce("Reference",''),coalesce("Notes",''),coalesce("CreatedByName",''),coalesce("BookshopKitId"::text,''),coalesce("SaleLineId"::text,''),"MovementDate"::date::text
    from "BookshopStockMovements" where "TenantId" = ${q(tenantId)} and "Reference" = ${q(reference)} order by "CreatedDate"`);
  return rows.map(([itemId, reason, quantity, ref, notes, createdByName, kitId, saleLineId, date]) => ({ itemId, reason, quantity: Number(quantity), reference: ref, notes, createdByName, kitId, saleLineId, date }));
}
