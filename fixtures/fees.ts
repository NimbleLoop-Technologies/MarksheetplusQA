/**
 * PR 547 (ClickUp z94x8eapp5) "challans under family or student name" helpers. Local stack only
 * (netns qa555): API seeding through the owner's RestApi bearer, Postgres reads/writes through psql.
 *
 *  - setupSchool():      session + N classes (one section each) on a fresh throwaway campus
 *  - addStudent():       quick-add; same father mobile => same Family (siblings)
 *  - createSchoolPolicy / createClassPolicy / updatePolicy: fee policy API
 *  - waitForChallans():  polls FeeChallans until the Worker scheduler (1-minute interval) issued them
 *  - shiftIssuedCycleBack(): DB SETUP — moves the tenant's issued challans one month back so the
 *                        scheduler issues the current cycle again (a second cycle without waiting a month)
 *  - pay():              POST /fee-payments/families/{id}/payments
 *
 * Every SQL statement that WRITES is marked "DB SETUP" and is logged to the test output.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { cacheOwner, ownerFromCache, type CachedOwner, type CampusOwner } from './campus-owner';

const run = promisify(execFile);

export const SCHOOLS_DB = process.env.QA_SCHOOLS_DB ?? 'mp-shared-schools-db';
const PG_HOST = process.env.QA_PG_HOST ?? '127.0.0.1';

/** Today's UTC date (the scheduler's run date), yyyy-mm-dd. */
export const todayUtc = () => new Date().toISOString().slice(0, 10);

// ── psql ─────────────────────────────────────────────────────────────────────────────────────

/** Runs SQL against the schools DB; returns rows as arrays of strings (unaligned, tab separated). */
export async function sql(statement: string, db = SCHOOLS_DB): Promise<string[][]> {
  const { stdout } = await run('psql', ['-h', PG_HOST, '-U', 'postgres', '-d', db, '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.split('\n').filter((l) => l.length > 0).map((l) => l.split('\t'));
}

/** A write used only to arrange data. Logged so the report can quote the exact SQL. */
export async function dbSetup(reason: string, statement: string): Promise<string[][]> {
  console.log(`[DB SETUP] ${reason}\n${statement.trim()}`);
  return sql(statement);
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ── API helpers ──────────────────────────────────────────────────────────────────────────────

export async function ok(res: APIResponse, what: string): Promise<any> {
  const body = await res.text();
  expect(res.status(), `${what}: HTTP ${res.status()} ${body.slice(0, 600)}`).toBeLessThan(300);
  return body ? JSON.parse(body) : null;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
export const letters = (n: number) => Array.from({ length: n }, () => LETTERS[randomInt(26)]).join('');
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Letters-only person name (QuickAdd rejects digits). */
export const personName = (prefix: string) => `${prefix} ${titleCase(letters(6))}`;
/** Unique 03xx mobile for a family (father mobile groups siblings). */
export const familyMobile = () => `0331${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;

export interface SchoolSetup {
  sessionId: string;
  classes: { id: string; name: string }[];
}

/** Session + `classCount` classes named "Class 1".."Class N" (grades 1..N), one section A each. */
export async function setupSchool(owner: CampusOwner, classCount = 3): Promise<SchoolSetup> {
  const api = owner.api;
  const session = await ok(
    await api.post('sessions/create', {
      data: {
        sessionName: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30',
        terms: [
          { termName: 'Term 1', termStartDate: '2026-09-01', termEndDate: '2026-12-31', passingCriteria: 40 },
          { termName: 'Term 2', termStartDate: '2027-01-01', termEndDate: '2027-06-30', passingCriteria: 40 },
        ],
      },
    }),
    'sessions/create',
  );
  const classes: { id: string; name: string }[] = [];
  for (let i = 1; i <= classCount; i++) {
    const name = `Class ${i}`;
    const created = await ok(
      await api.post('classes/create', { data: { className: name, grade: String(i), sections: [{ sectionName: 'A', size: 40 }], subjects: null } }),
      `classes/create ${name}`,
    );
    classes.push({ id: created.id, name });
  }
  return { sessionId: session.id, classes };
}

export interface Student {
  id: string;
  name: string;
  admissionId: string;
  classId: string;
  familyId: string;
}

/** Quick-adds a student. Siblings share `fatherMobile`. Retries the known roll-number race (HTTP 500). */
export async function addStudent(owner: CampusOwner, opts: { name: string; classId: string; fatherName: string; fatherMobile: string }): Promise<Student> {
  const admissionId = `CN-${Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[randomInt(31)]).join('')}`;
  let res: APIResponse | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await owner.api.post('students/quick-add', {
      data: {
        fullName: opts.name, admissionId, fatherName: opts.fatherName, mobileNumber: opts.fatherMobile, classId: opts.classId,
        admissionDate: '2026-09-01', dateOfBirth: '2016-03-10T00:00:00Z', gender: 0,
      },
    });
    if (res.status() !== 500) break;
  }
  const body = await ok(res!, `quick-add ${opts.name}`);
  const fam = await sql(`select "FamilyId" from "Students" where "Id" = ${q(body.id)}`);
  return { id: body.id, name: opts.name, admissionId: body.admissionId ?? admissionId, classId: opts.classId, familyId: fam[0][0] };
}

// ── Fee policies ─────────────────────────────────────────────────────────────────────────────

export const SCOPE = { SchoolWide: 0, ClassSpecific: 1 } as const;
export const POLICY_TYPE = { Root: 0, Class: 1 } as const;
const ALLOWED_DAYS = [1, 5, 10, 15, 30];

export interface PolicyOptions {
  name?: string;
  tuition?: number;
  perStudent?: boolean | undefined;
  dueDay?: number;
  publish?: boolean;
  bank?: boolean;
}

/** The generation day that makes the scheduler issue a cycle today (today's UTC day must be an allowed day). */
export function todaysGenerationDay(): number {
  const day = new Date().getUTCDate();
  if (!ALLOWED_DAYS.includes(day)) {
    throw new Error(`today's UTC day ${day} is not an allowed challan generation day (${ALLOWED_DAYS}); these specs need DB setup to bill today`);
  }
  return day;
}

export async function createSchoolPolicy(owner: CampusOwner, o: PolicyOptions = {}): Promise<{ id: string; status: number; body: any }> {
  const data: Record<string, unknown> = {
    policyName: o.name ?? `QA School ${letters(5)}`,
    publishNow: o.publish ?? true,
    description: null,
    policyType: POLICY_TYPE.Root,
    rootPolicyId: null,
    scope: SCOPE.SchoolWide,
    classIds: [],
    occurrence: 0,
    challanGenerationDay: todaysGenerationDay(),
    dueDay: o.dueDay ?? 25,
    tuitionFee: o.tuition ?? 1000,
    enableFineRule: false,
    fineType: null,
    fineAmount: null,
    graceDays: null,
    effectiveFrom: `${todayUtc()}T00:00:00Z`,
    effectiveUntil: null,
    additionalFundIds: [],
    bankName: o.bank === false ? null : 'QA Bank',
    accountTitle: o.bank === false ? null : 'QA School Account',
    accountNumber: null,
    bankBranch: o.bank === false ? null : 'Main',
  };
  if (o.perStudent !== undefined) data.generateChallansPerStudent = o.perStudent;
  const res = await owner.api.post('fee-policies', { data });
  const text = await res.text();
  return { id: res.ok() ? JSON.parse(text).id : '', status: res.status(), body: text ? safeJson(text) : null };
}

export async function createClassPolicy(
  owner: CampusOwner,
  rootPolicyId: string,
  classIds: string[],
  o: PolicyOptions = {},
): Promise<{ id: string; status: number; body: any }> {
  const data: Record<string, unknown> = {
    policyName: o.name ?? `QA Class ${letters(5)}`,
    publishNow: o.publish ?? true,
    description: null,
    policyType: POLICY_TYPE.Class,
    rootPolicyId,
    scope: SCOPE.ClassSpecific,
    classIds,
    occurrence: 0,
    challanGenerationDay: todaysGenerationDay(),
    dueDay: o.dueDay ?? 25,
    tuitionFee: o.tuition ?? 2000,
    enableFineRule: false,
    fineType: null,
    fineAmount: null,
    graceDays: null,
    effectiveFrom: `${todayUtc()}T00:00:00Z`,
    effectiveUntil: null,
    additionalFundIds: [],
  };
  if (o.perStudent !== undefined) data.generateChallansPerStudent = o.perStudent;
  const res = await owner.api.post('fee-policies', { data });
  const text = await res.text();
  return { id: res.ok() ? JSON.parse(text).id : '', status: res.status(), body: text ? safeJson(text) : null };
}

export async function policyDetail(owner: CampusOwner, policyId: string): Promise<any> {
  return ok(await owner.api.get(`fee-policies/${policyId}`), `GET fee-policies/${policyId}`);
}

/**
 * PUT /fee-policies/{id} from the current detail with `changes` applied. Returns the raw response;
 * the new version's id is in the body (`id`).
 */
export async function updatePolicy(owner: CampusOwner, policyId: string, changes: Record<string, unknown>): Promise<APIResponse> {
  const d = await policyDetail(owner, policyId);
  const isRoot = String(d.policyType) === 'Root' || d.policyType === 0;
  const data: Record<string, unknown> = {
    policyName: d.policyName,
    status: d.status ?? 'Active',
    description: d.description ?? null,
    policyType: isRoot ? POLICY_TYPE.Root : POLICY_TYPE.Class,
    rootPolicyId: d.rootPolicyId ?? null,
    scope: isRoot ? SCOPE.SchoolWide : SCOPE.ClassSpecific,
    classIds: (d.appliedClasses ?? d.classes ?? []).map((c: any) => c.classId ?? c.id),
    occurrence: 0,
    challanGenerationDay: d.challanGenerationDay,
    dueDay: d.dueDay,
    tuitionFee: d.tuitionFee ?? d.resolvedTuitionFee,
    enableFineRule: d.enableFineRule ?? false,
    fineType: null,
    fineAmount: null,
    graceDays: null,
    effectiveFrom: d.effectiveFrom,
    effectiveUntil: d.effectiveUntil ?? null,
    additionalFundIds: d.additionalFundIds ?? [],
    bankName: d.bankName ?? null,
    accountTitle: d.accountTitle ?? null,
    accountNumber: d.accountNumber ?? null,
    bankBranch: d.bankBranch ?? null,
    ...changes,
  };
  return owner.api.put(`fee-policies/${policyId}`, { data });
}

/** Latest version id of a policy's version group (updates create a new version). */
export async function latestPolicyVersion(policyId: string): Promise<{ id: string; perStudent: boolean; version: number }> {
  const rows = await sql(`
    select p."Id", p."GenerateChallansPerStudent", p."VersionNumber" from "FeePolicies" p
    where p."VersionGroupId" = (select "VersionGroupId" from "FeePolicies" where "Id" = ${q(policyId)})
    order by p."VersionNumber" desc limit 1`);
  return { id: rows[0][0], perStudent: rows[0][1] === 't', version: Number(rows[0][2]) };
}

// ── Challans ─────────────────────────────────────────────────────────────────────────────────

export interface ChallanRow {
  id: string;
  familyId: string;
  primaryStudentId: string | null;
  perStudent: boolean;
  number: string;
  cycleStart: string;
  cycleLabel: string;
  dueDate: string;
  total: number;
  outstanding: number;
  status: string;
  /** Σ line.RemainingAmount */
  remaining: number;
  /** Distinct StudentIds on the lines. */
  lineStudents: string[];
}

export async function challans(tenantId: string, where = 'true'): Promise<ChallanRow[]> {
  const rows = await sql(`
    select c."Id", c."FamilyId", coalesce(c."PrimaryStudentId"::text, ''), c."GenerateChallansPerStudent", c."ChallanNumber",
           to_char(c."CycleStartDate" at time zone 'UTC', 'YYYY-MM-DD'), c."CycleLabel", to_char(c."DueDate" at time zone 'UTC', 'YYYY-MM-DD'),
           c."TotalAmount", c."OutstandingAmount", c."Status",
           coalesce((select sum(l."RemainingAmount") from "FeeChallanLines" l where l."FeeChallanId" = c."Id"), 0),
           coalesce((select string_agg(distinct l."StudentId"::text, ',') from "FeeChallanLines" l where l."FeeChallanId" = c."Id"), '')
    from "FeeChallans" c where c."TenantId" = ${q(tenantId)} and (${where})
    order by c."CycleStartDate", c."ChallanNumber"`);
  return rows.map((r) => ({
    id: r[0], familyId: r[1], primaryStudentId: r[2] || null, perStudent: r[3] === 't', number: r[4], cycleStart: r[5], cycleLabel: r[6],
    dueDate: r[7], total: Number(r[8]), outstanding: Number(r[9]), status: r[10], remaining: Number(r[11]), lineStudents: r[12] ? r[12].split(',') : [],
  }));
}

/** Polls until the tenant has at least `count` challans matching `where` (the scheduler ticks every minute). */
export async function waitForChallans(tenantId: string, count: number, where = 'true', timeout = 240_000): Promise<ChallanRow[]> {
  let found: ChallanRow[] = [];
  await expect
    .poll(async () => (found = await challans(tenantId, where)).length, {
      message: `scheduler never issued ${count} challan(s) (${where}) for tenant ${tenantId}`,
      timeout,
      intervals: [5_000, 10_000],
    })
    .toBeGreaterThanOrEqual(count);
  return found;
}

/** Waits for one more full scheduler pass over the tenant (its run row's ModifiedDate moves on). */
export async function waitForSchedulerPass(tenantId: string, timeout = 180_000): Promise<void> {
  const before = (await sql(`select coalesce("ModifiedDate", "CreatedDate") from "FeeChallanGenerationRuns" where "TenantId" = ${q(tenantId)}`))[0]?.[0] ?? '';
  await expect
    .poll(async () => (await sql(`select coalesce("ModifiedDate", "CreatedDate") from "FeeChallanGenerationRuns" where "TenantId" = ${q(tenantId)}`))[0]?.[0] ?? '', {
      message: `no scheduler pass over tenant ${tenantId}`,
      timeout,
      intervals: [5_000],
    })
    .not.toBe(before);
}

/**
 * DB SETUP: moves every challan of the tenant issued for `fromCycle` (yyyy-mm-01) one month back
 * (cycle start, issue, due dates, label and the yyMM challan-number prefix), so the scheduler issues
 * `fromCycle` again on its next pass: the stand-in for "the next cycle" in a single day.
 */
export async function shiftIssuedCycleBack(tenantId: string, fromCycle: string, months = 1): Promise<string> {
  const from = new Date(`${fromCycle}T00:00:00Z`);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - months, 1));
  const yymm = (d: Date) => `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const label = (d: Date) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + ' ' + d.getUTCFullYear();
  const statement = `
    update "FeeChallanLines" set "Label" = replace("Label", ${q(label(from))}, ${q(label(to))})
    where "FeeChallanId" in (select "Id" from "FeeChallans" where "TenantId" = ${q(tenantId)} and "CycleStartDate" = ${q(fromCycle)}::timestamptz);
    update "FeeChallans" set
      "CycleStartDate" = "CycleStartDate" - interval '${months} month',
      "IssueDate" = "IssueDate" - interval '${months} month',
      "DueDate" = "DueDate" - interval '${months} month',
      "CycleLabel" = replace("CycleLabel", ${q(label(from))}, ${q(label(to))}),
      "ChallanNumber" = regexp_replace("ChallanNumber", '^${yymm(from)}-', '${yymm(to)}-')
    where "TenantId" = ${q(tenantId)} and "CycleStartDate" = ${q(fromCycle)}::timestamptz`;
  await dbSetup(`shift the ${fromCycle} cycle of tenant ${tenantId} ${months} month(s) back`, statement);
  return statement;
}

// ── Fee payment API ──────────────────────────────────────────────────────────────────────────

export interface PendingPage {
  generateChallansPerStudent: boolean;
  items: any[];
  totalCount: number;
  summary: any;
}

export async function pending(api: APIRequestContext, query = 'page=1&pageSize=100'): Promise<PendingPage> {
  const body = await ok(await api.get(`fee-payments/pending-challans?${query}`), 'pending-challans');
  return body as PendingPage;
}

export async function outstanding(api: APIRequestContext, familyId: string, challanId?: string): Promise<APIResponse> {
  return api.get(`fee-payments/families/${encodeURIComponent(familyId)}/outstanding${challanId === undefined ? '' : `?challanId=${encodeURIComponent(challanId)}`}`);
}

export async function prints(api: APIRequestContext, familyId: string, challanId?: string): Promise<APIResponse> {
  return api.get(`fee-payments/families/${encodeURIComponent(familyId)}/challan-prints${challanId === undefined ? '' : `?challanId=${encodeURIComponent(challanId)}`}`);
}

export async function pay(
  api: APIRequestContext,
  familyId: string,
  amount: number,
  o: { challanId?: string; clientPaymentId?: string; waivers?: { challanLineId: string; reason: string }[] } = {},
): Promise<APIResponse> {
  const data: Record<string, unknown> = {
    clientPaymentId: o.clientPaymentId ?? randomUUID(),
    paymentDate: new Date().toISOString(),
    amountReceived: amount,
    note: 'QA Auto challan-name',
    isOfflinePayment: false,
    fineWaivers: o.waivers ?? [],
  };
  if (o.challanId !== undefined) data.challanId = o.challanId;
  return api.post(`fee-payments/families/${encodeURIComponent(familyId)}/payments`, { data });
}

/** Σ RemainingAmount per challan id (fresh DB read). */
export async function remainingByChallan(tenantId: string): Promise<Record<string, number>> {
  const rows = await sql(`
    select c."Id", coalesce(sum(l."RemainingAmount"), 0) from "FeeChallans" c left join "FeeChallanLines" l on l."FeeChallanId" = c."Id"
    where c."TenantId" = ${q(tenantId)} group by c."Id"`);
  return Object.fromEntries(rows.map((r) => [r[0], Number(r[1])]));
}

// ── Bookshop (fee-account purchases: README "BookshopRouting") ──────────────────────────────

export const FEE_ACCOUNT_TENDER = 'Charge to fee account';

/** One single (no-variant) item with stock, and today's point-of-sale day opened. Returns the item id. */
export async function setupBookshop(owner: CampusOwner, price = 300): Promise<string> {
  const item = await ok(
    await owner.api.post('bookshop/inventory', {
      data: {
        itemName: `QA Auto Notebook ${letters(4)}`, sku: `QA-${letters(8).toUpperCase()}`, category: 'Stationery', description: null,
        openingStock: 500, reorderLevel: 0, costPrice: 100, retailPrice: price, hasVariants: false, options: [], variants: [],
      },
    }),
    'bookshop item',
  );
  const day = await owner.api.post('bookshop/point-of-sale/day', { data: { openingFloat: 0 } });
  // 409/400 when already open is fine.
  expect(day.status(), `open POS day: ${await day.text()}`).toBeLessThan(500);
  return (item.item ?? item).id;
}

/** A fee-account (credit) bookshop sale for one student: lands as an unbilled purchase on the family. */
export async function feeAccountSale(owner: CampusOwner, studentId: string, itemId: string, quantity = 1): Promise<any> {
  return ok(
    await owner.api.post('bookshop/point-of-sale/sales', {
      data: {
        clientSaleId: randomUUID(), movementDate: new Date().toISOString(), reference: null, lowStockReason: null, studentId,
        tenderType: FEE_ACCOUNT_TENDER, amountReceived: null, lines: [{ type: 'Item', itemId, variantId: null, kitId: null, quantity }],
      },
    }),
    `fee-account sale for ${studentId}`,
  );
}

// ── Per-file seeded state that survives a worker restart ─────────────────────────────────────

/**
 * Runs `seed` once per test run and caches its JSON result (with the owner) in the project's output
 * dir (wiped at the start of each run, gitignored, mode 0600: it holds the throwaway owner's password).
 * A failed test restarts the worker; the next test reuses the same campus instead of seeding a new one
 * (each seed costs AuthApp OTP calls and a scheduler wait).
 */
export async function seededOnce<T>(
  outputDir: string,
  name: string,
  seed: () => Promise<{ owner: CampusOwner; data: T }>,
): Promise<{ owner: CampusOwner; data: T }> {
  const file = path.join(outputDir, `.${name}.json`);
  try {
    const cached = JSON.parse(await readFile(file, 'utf8')) as { owner: CachedOwner; data: T };
    return { owner: await ownerFromCache(cached.owner), data: cached.data };
  } catch {
    const result = await seed();
    await mkdir(outputDir, { recursive: true });
    await writeFile(file, JSON.stringify({ owner: cacheOwner(result.owner), data: result.data }), { mode: 0o600 });
    return result;
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export { q as sqlQuote };
