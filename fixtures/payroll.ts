/**
 * PR 544 (Generate & Publish Payroll) seeding helpers for the local branch-testing stack.
 *
 *  - Staff: add staff with salary / designation / category / joining date, statutory rates, mark Left, revise salary.
 *  - Payroll: publish a policy, create / edit / deactivate library items, generate / edit / preview / publish runs,
 *    mark paid, post adjustments, read payslips.
 *  - DB: `sql()` runs a query against the stack's Postgres schools DB through psql (PGPASSWORD comes from the
 *    run-spec.sh wrapper; never logged). Read-only assertions mostly; writes are only used by the clearly marked
 *    "DB manipulation" helpers (previous-month run seeding, removing a salary, assigning a custom role).
 *
 * Every spec file owns one throwaway campus (newCampusOwner): a tenant has ONE run per month, current month only.
 */
import { execFile } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, request as pwRequest, type APIRequestContext, type APIResponse, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { AUTH_APP, REST_API, type CampusOwner } from './campus-owner';
import { LoginPage } from '../pages/LoginPage';

const run = promisify(execFile);

// ── Fixed lookups (seeded globally on every tenant) ─────────────────────────────────────────────
export const DESIGNATION = {
  principal: '11111111-1111-1111-1111-111111111111',
  headOfDepartment: '11111111-1111-1111-1111-111111111113',
  seniorTeacher: '11111111-1111-1111-1111-111111111114',
  teacher: '11111111-1111-1111-1111-111111111115',
  assistantTeacher: '11111111-1111-1111-1111-111111111116',
  accountant: '22222222-2222-2222-2222-222222222222',
  librarian: '22222222-2222-2222-2222-222222222224',
  driver: '22222222-2222-2222-2222-222222222229',
} as const;
const NON_TEACHING = new Set<string>([DESIGNATION.accountant, DESIGNATION.librarian, DESIGNATION.driver]);
const EMPLOYMENT_FULL_TIME = '33333333-3333-3333-3333-333333333331';

// ── Dates: the stack runs on Asia/Karachi. The payroll month is the current calendar month there. ────
export function karachiToday(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return new Date(`${parts}T00:00:00Z`);
}
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export function monthStart(offsetMonths = 0): Date {
  const t = karachiToday();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + offsetMonths, 1));
}
export const daysInMonth = (m: Date) => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).getUTCDate();
export const dayOf = (m: Date, day: number) => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), day));
/** "November 2026" */
export const monthLabel = (m: Date) => m.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** "November" */
export const monthName = (m: Date) => m.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
/** "PKR 41,030" — the app's money format (no decimals, thousand separators). */
export const pkr = (n: number) => `PKR ${Math.round(n).toLocaleString('en-US')}`;
/**
 * A money figure as a regex that accepts either currency prefix. The ticket specifies "PKR"; the app renders "Rs"
 * (bug P-CURRENCY). Only the dedicated currency test asserts the prefix, so that one bug does not mask every other
 * check that reads a figure off the screen.
 */
export const moneyRe = (n: number, prefix = '') => new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(PKR|Rs) ${Math.round(Math.abs(n)).toLocaleString('en-US')}(?!\\d|,\\d)`);
/** "− PKR 3,000" / "+ PKR 2,000" (U+2212 minus, as the app renders). */
export const signed = (n: number) => (n < 0 ? `− ${pkr(-n)}` : `+ ${pkr(n)}`);
/** Away-from-zero rounding to whole rupees, as the server rounds. */
export const round0 = (n: number) => Math.sign(n) * Math.round(Math.abs(n) + 1e-9);

// ── Unique, recognisable staff data ─────────────────────────────────────────────────────────────
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const letters = (n: number) => Array.from({ length: n }, () => LETTERS[randomInt(LETTERS.length)]).join('');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Letters only (names reject digits). The "Qa" prefix marks QA-created data. */
export const qaName = (first?: string) => `Qa ${cap(first ?? letters(6))} ${cap(letters(5))}`;
const mobile = () => `03${randomInt(10, 50)}${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
const cnic = () => `${randomInt(31101, 45505)}-${String(randomInt(0, 10_000_000)).padStart(7, '0')}-${randomInt(1, 10)}`;

export interface StaffSeed {
  name?: string;
  salary: number;
  designationId?: string;
  /** yyyy-mm-dd; must not be in the future (AddStaff rule). Defaults to 1 Jan of last year. */
  joined?: string;
  incomeTaxPercent?: number | null;
  eobiPerMonth?: number | null;
  providentFundPercent?: number | null;
}
export interface Staff { id: string; name: string; salary: number; designationId: string }

async function ok(res: APIResponse, what: string): Promise<any> {
  const text = await res.text();
  expect(res.status(), `${what}: ${text.slice(0, 500)}`).toBeLessThan(300);
  return text ? JSON.parse(text) : null;
}

export async function addStaff(api: APIRequestContext, seed: StaffSeed): Promise<Staff> {
  const designationId = seed.designationId ?? DESIGNATION.teacher;
  const name = seed.name ?? qaName();
  const joined = seed.joined ?? `${karachiToday().getUTCFullYear() - 1}-01-01`;
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await api.post('staff', {
      data: {
        staffId: `QA-${letters(4).toUpperCase()}${randomInt(100, 999)}`,
        fullName: name, cnic: cnic(), dateOfBirth: '1990-05-05', gender: 'Female', maritalStatus: null, bloodGroup: null,
        nationality: 'Pakistani', religion: 'Islam', profilePhotoUrl: null, cnicCopyUrl: null,
        mobileNumber: mobile(), alternateNumber: null, email: null,
        presentAddress: '1 QA Road, Lahore', permanentAddress: '1 QA Road, Lahore',
        emergencyContactName: 'Qa Contact', emergencyContactRelation: 'Sibling', emergencyContactPhone: mobile(),
        category: NON_TEACHING.has(designationId) ? 'Non-Teaching' : 'Teaching', designationId, dateOfJoining: joined,
        employmentTypeId: EMPLOYMENT_FULL_TIME, reportingManagerId: null, monthlySalary: seed.salary,
        highestQualification: 'Masters', specialization: null, university: 'Punjab University', yearOfCompletion: 2012,
        totalExperience: '5', previousInstitution: null,
      },
    });
    if (res.status() < 300) {
      const body = await res.json();
      const staff = { id: body.id as string, name: body.fullName as string, salary: seed.salary, designationId };
      if (seed.incomeTaxPercent != null || seed.eobiPerMonth != null || seed.providentFundPercent != null)
        await setStatutory(api, staff.id, seed);
      return staff;
    }
    lastError = `${res.status()} ${await res.text()}`;
    // Random CNIC / phone / staff id can clash with an earlier run's staff: retry with fresh values.
    if (res.status() >= 500) break;
  }
  throw new Error(`addStaff ${name}: ${lastError.slice(0, 600)}`);
}

export async function setStatutory(api: APIRequestContext, staffId: string, rates: Pick<StaffSeed, 'incomeTaxPercent' | 'eobiPerMonth' | 'providentFundPercent'>) {
  await ok(await api.put(`staff/${staffId}/salary/statutory-deductions`, {
    data: { incomeTaxPercent: rates.incomeTaxPercent ?? null, eobiPerMonth: rates.eobiPerMonth ?? null, providentFundPercent: rates.providentFundPercent ?? null },
  }), `statutory ${staffId}`);
}

export async function reviseSalary(api: APIRequestContext, staffId: string, monthlySalary: number, effectiveFrom: string, reason = 'QA revision') {
  const profile = await ok(await api.get(`staff/${staffId}/salary`), 'get salary');
  await ok(await api.post(`staff/${staffId}/salary/revisions`, { data: { latestRevisionId: profile.latestRevisionId, monthlySalary, effectiveFrom, reason } }), `revise salary ${staffId}`);
}

/** Number of salary revisions on record for a staff member (1 = only the initial salary). */
export async function salaryRevisionCount(api: APIRequestContext, staffId: string): Promise<number> {
  const profile = await ok(await api.get(`staff/${staffId}/salary`), 'get salary');
  return profile.revisionHistory.length;
}

/** Last working day must not be in the future (MarkStaffAsLeft rule). */
export async function markLeft(api: APIRequestContext, staffId: string, lastWorkingDay: string) {
  await ok(await api.post(`staff/${staffId}/mark-as-left`, { data: { lastWorkingDay, reason: 'Resigned', note: 'QA leaver' } }), `mark left ${staffId}`);
}

// ── Policy and library ──────────────────────────────────────────────────────────────────────────
export interface PolicySeed {
  prorationEnabled?: boolean;
  dayRateBasis?: 'ThirtyDay' | 'WorkingDays';
  weeklyOffDays?: string[];
  sandwichLeaveEnabled?: boolean;
  incomeTaxEnabled?: boolean;
  eobiEnabled?: boolean;
  providentFundEnabled?: boolean;
}
export async function publishPolicy(api: APIRequestContext, p: PolicySeed = {}): Promise<{ policyId: string; versionNumber: number }> {
  const body = await ok(await api.post('payroll-policy/publish', {
    data: {
      prorationEnabled: p.prorationEnabled ?? true,
      // Numeric enum on the wire (no string converter on this request): ThirtyDay = 0, WorkingDays = 1.
      dayRateBasis: (p.dayRateBasis ?? 'ThirtyDay') === 'WorkingDays' ? 1 : 0,
      weeklyOffDays: p.weeklyOffDays ?? ['Sun'],
      sandwichLeaveEnabled: p.sandwichLeaveEnabled ?? false,
      incomeTaxEnabled: p.incomeTaxEnabled ?? false,
      eobiEnabled: p.eobiEnabled ?? false,
      providentFundEnabled: p.providentFundEnabled ?? false,
    },
  }), 'publish policy');
  return { policyId: body.policyId ?? body.id, versionNumber: body.versionNumber };
}

export interface ItemSeed {
  name: string;
  type: 'Incentive' | 'Deduction';
  amountType: 'FlatAmount' | 'Percentage';
  amount: number;
  appliesTo: 'NoOne' | 'Everyone' | 'Designation' | 'Category' | 'BaseSalaryRange';
  designationId?: string;
  category?: 'Teaching' | 'NonTeaching';
  minimumSalary?: number;
  maximumSalary?: number;
  description?: string;
}
const itemBody = (i: ItemSeed) => ({
  name: i.name, description: i.description ?? null, type: i.type, amountType: i.amountType, amount: i.amount, appliesTo: i.appliesTo,
  designationId: i.designationId ?? null, category: i.category ?? null, minimumSalary: i.minimumSalary ?? null, maximumSalary: i.maximumSalary ?? null,
});
export async function createItem(api: APIRequestContext, item: ItemSeed): Promise<string> {
  const body = await ok(await api.post('payroll-items', { data: itemBody(item) }), `create item ${item.name}`);
  return body.id ?? body.itemId;
}
export async function updateItem(api: APIRequestContext, id: string, item: ItemSeed) {
  await ok(await api.put(`payroll-items/${id}`, { data: itemBody(item) }), `update item ${item.name}`);
}
export async function deactivateItem(api: APIRequestContext, id: string) {
  await ok(await api.post(`payroll-items/${id}/deactivate`), `deactivate item ${id}`);
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────
export async function generateRun(api: APIRequestContext): Promise<string> {
  const res = await api.post('payroll-runs/current');
  const body = await ok(res, 'generate run');
  return body.runId;
}
export interface RegisterRow {
  id: string; staffMemberId: string; staffName: string; designation: string; monthlySalary: number | null; net: number | null;
  exception: string; unpaidDays: number; exceptionDate: string | null; unpaidDates: string[]; postingPending: boolean;
  salary: number | null; incentives: number | null; deductions: number | null; paymentStatus: string;
}
export interface Register {
  runId: string; month: string; status: string; policyVersion: number; sandwichLeaveEnabled: boolean; lastSavedUtc: string;
  totalStaff: number; fullMonthCount: number; exceptionCount: number; filteredCount: number; rows: RegisterRow[];
  publishedOnUtc: string | null; publishedBy: string | null; paidCount: number; totalNet: number; paidAmount: number;
  outstandingAmount: number; statutoryWithheld: number;
}
export async function register(api: APIRequestContext, runId: string, q = 'pageSize=50'): Promise<Register> {
  return ok(await api.get(`payroll-runs/${runId}/register?${q}`), 'register');
}
export async function rowFor(api: APIRequestContext, runId: string, staff: Staff | string): Promise<RegisterRow> {
  const id = typeof staff === 'string' ? staff : staff.id;
  const row = (await register(api, runId)).rows.find((r) => r.staffMemberId === id);
  expect(row, `row for staff ${id}`).toBeTruthy();
  return row!;
}
export interface Line { id: string; label: string; type: string; isApplied: boolean; isOneOff: boolean; amount: number; reason: string | null }
export interface Figures { rowId: string; net: number | null; exception: string; unpaidDays: number; unpaidDates: string[]; fullMonthCount: number; exceptionCount: number; lastSavedUtc: string; lines: Line[] }
export const figures = async (api: APIRequestContext, runId: string, rowId: string): Promise<Figures> =>
  ok(await api.get(`payroll-runs/${runId}/rows/${rowId}/figures`), 'figures');
export const putAbsence = (api: APIRequestContext, runId: string, rowId: string, body: { unpaidDays?: unknown; unpaidDates?: unknown }) =>
  api.put(`payroll-runs/${runId}/rows/${rowId}/absence`, { data: body });
export async function absence(api: APIRequestContext, runId: string, rowId: string, unpaidDays: number): Promise<Figures> {
  return ok(await putAbsence(api, runId, rowId, { unpaidDays }), 'absence');
}
export async function setLine(api: APIRequestContext, runId: string, rowId: string, lineId: string, isApplied: boolean): Promise<Figures> {
  return ok(await api.put(`payroll-runs/${runId}/rows/${rowId}/lines/${lineId}`, { data: { isApplied } }), 'set line');
}
export const postOneOff = (api: APIRequestContext, runId: string, rowId: string, body: Record<string, unknown>) =>
  api.post(`payroll-runs/${runId}/rows/${rowId}/one-offs`, { data: body });
export async function oneOff(api: APIRequestContext, runId: string, rowId: string, o: { type: 'Incentive' | 'Deduction'; label: string; amount: number; reason: string }): Promise<Figures> {
  return ok(await postOneOff(api, runId, rowId, o), 'one-off');
}
export const preview = (api: APIRequestContext, runId: string) => api.get(`payroll-runs/${runId}/preview`);
export const previewRows = async (api: APIRequestContext, runId: string) =>
  ok(await api.get(`payroll-runs/${runId}/preview/rows?page=1&pageSize=50`), 'preview rows');
export const breakdown = async (api: APIRequestContext, runId: string, rowId: string) =>
  ok(await api.get(`payroll-runs/${runId}/rows/${rowId}/breakdown`), 'breakdown');
export const publish = (api: APIRequestContext, runId: string) => api.post(`payroll-runs/${runId}/publish`);
export async function publishOk(api: APIRequestContext, runId: string) {
  return ok(await publish(api, runId), 'publish run');
}
export const markPaid = (api: APIRequestContext, runId: string, rowId: string) => api.post(`payroll-runs/${runId}/rows/${rowId}/paid`);
export const payslip = async (api: APIRequestContext, runId: string, rowId: string): Promise<{ rowId: string; staffName: string; month: string; lines: { label: string; amount: number; kind: string }[] }> =>
  ok(await api.get(`payroll-runs/${runId}/rows/${rowId}/payslip`), 'payslip');
export const postAdjustment = (api: APIRequestContext, runId: string, body: { staffMemberId?: unknown; direction?: unknown; amount?: unknown; reason?: unknown; submissionId?: unknown }) =>
  api.post(`payroll-runs/${runId}/adjustments`, { data: { submissionId: randomUUID().replace(/-/g, ''), ...body } });

/** One full happy path: policy (if given) → generate → publish. Returns the run id. */
export async function generateAndPublish(api: APIRequestContext): Promise<string> {
  const runId = await generateRun(api);
  await publishOk(api, runId);
  return runId;
}

/** Writes a probe output (API / SQL) to the cycle's evidence folder. Never pass tokens or passwords. */
export const EVIDENCE_DIR = process.env.QA_EVIDENCE_DIR ?? '/workspace/qa-cycles/pr-544/cycle-1/evidence';
export async function saveEvidence(name: string, content: string) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, name), content);
}
export const shot = (name: string) => path.join(EVIDENCE_DIR, name);

// ── Postgres (stack-local) ──────────────────────────────────────────────────────────────────────
const PSQL_ARGS = ['-h', process.env.QA_PG_HOST ?? '127.0.0.1', '-U', process.env.QA_PG_USER ?? 'postgres', '-d', process.env.QA_PG_DB ?? 'mp-shared-schools-db', '-At', '-v', 'ON_ERROR_STOP=1'];
/** Runs SQL and returns its rows as objects (wrapped in json_agg). Use for SELECTs. */
export async function sql<T = Record<string, any>>(query: string): Promise<T[]> {
  const { stdout } = await run('psql', [...PSQL_ARGS, '-c', `select coalesce(json_agg(qa_row), '[]'::json) from (${query}) qa_row`], { maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout.trim() || '[]');
}
/** Runs a statement (INSERT / UPDATE). ONLY for clearly marked DB-manipulation setup. Returns psql's stdout. */
export async function sqlExec(statement: string): Promise<string> {
  const { stdout } = await run('psql', [...PSQL_ARGS, '-c', statement], { maxBuffer: 5 * 1024 * 1024 });
  return stdout;
}
export const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface LedgerLeg { code: string; debit: number; credit: number; memo: string; parentCode: string | null }
/** The legs of the ledger transaction filed under this origin event id ([] when it has not landed). */
export async function ledgerLegs(tenantId: string, originEventId: string): Promise<LedgerLeg[]> {
  const rows = await sql<any>(`
    select a."Code" as code, e."Debit"::float as debit, e."Credit"::float as credit, e."Memo" as memo, p."Code" as "parentCode"
    from "LedgerTransactions" t join "LedgerEntries" e on e."TransactionId" = t."Id"
    join "LedgerAccounts" a on a."Id" = e."AccountId" left join "LedgerAccounts" p on p."Id" = a."ParentAccountId"
    where t."TenantId" = ${q(tenantId)} and t."OriginEventId" = ${q(originEventId)} order by e."Debit" desc, a."Code"`);
  return rows;
}
/** Waits for the Worker to post the outbox event (relay ~5 s + consumer). */
export async function waitForLedger(tenantId: string, originEventId: string, timeoutMs = 60_000): Promise<LedgerLeg[]> {
  let legs: LedgerLeg[] = [];
  await expect.poll(async () => (legs = await ledgerLegs(tenantId, originEventId)).length, { timeout: timeoutMs, intervals: [1000, 2000] }).toBeGreaterThan(0);
  return legs;
}
export const originPublish = (runId: string, staffId: string) => `payroll:${runId}:${staffId}`;
export const originPaid = (runId: string, staffId: string) => `payroll-paid:${runId}:${staffId}`;
export const originAdjustment = (runId: string, submissionId: string) => `payroll-adjustment:${runId}:${submissionId}`;
export async function auditEntries(runId: string): Promise<{ action: string; actor: string; snapshot: any; at: string }[]> {
  return sql(`select "Action" as action, "ActorUserId" as actor, "SnapshotJson" as snapshot, "CreatedAtUtc" as at
              from "PayrollRunAuditEntries" where "PayrollRunId" = ${q(runId)} order by "CreatedAtUtc", "Id"`);
}
export async function ledgerTxCount(tenantId: string, likeOrigin: string): Promise<number> {
  const r = await sql<{ n: number }>(`select count(*)::int as n from "LedgerTransactions" where "TenantId" = ${q(tenantId)} and "OriginEventId" like ${q(likeOrigin)}`);
  return r[0].n;
}
export async function accountBalance(tenantId: string, code: string): Promise<number | null> {
  const r = await sql<{ b: number }>(`select b."Balance"::float as b from "LedgerAccountBalances" b join "LedgerAccounts" a on a."Id" = b."AccountId" where a."TenantId" = ${q(tenantId)} and a."Code" = ${q(code)}`);
  return r.length ? r[0].b : null;
}

// ── DB manipulation (clearly marked; the product only ever creates current-month runs) ──────────
/**
 * DB MANIPULATION. Clones a PUBLISHED current-month run of this tenant into `month` (rows and lines copied as they
 * are, statuses kept), so specs can exercise the "previous published run" paths (change column, eligibility note,
 * past runs ordering, earlier-days carry-forward). The clone gets fresh ids. `netOverrides` lets a spec set a staff
 * member's previous net; `publishedAt` sets the clone's publish timestamp.
 */
export async function clonePublishedRunToMonth(sourceRunId: string, month: Date, opts: { publishedAt?: Date; netOverrides?: Record<string, number>; dropMatchedItemIds?: string[]; addMatched?: { staffMemberId: string; itemId: string; label: string; amount: number }[] } = {}): Promise<{ runId: string; sql: string }> {
  const runId = randomUUID();
  const at = (opts.publishedAt ?? new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 3, 6))).toISOString();
  const overrides = Object.entries(opts.netOverrides ?? {})
    .map(([staffId, net]) => `update "PayrollRunRows" set "Net" = ${net}, "BaseNet" = ${net}, "FrozenEarnings" = ${net}, "FrozenIncentives" = 0, "FrozenDeductions" = 0, "FrozenIncomeTax" = 0, "FrozenEobi" = 0, "FrozenProvidentFund" = 0 where "PayrollRunId" = ${q(runId)} and "StaffMemberId" = ${q(staffId)};`)
    .join('\n');
  const drops = (opts.dropMatchedItemIds ?? []).map((id) =>
    `delete from "PayrollRunRowLines" l using "PayrollRunRows" r where l."PayrollRunRowId" = r."Id" and r."PayrollRunId" = ${q(runId)} and l."SourcePayrollItemId" = ${q(id)};`).join('\n');
  const adds = (opts.addMatched ?? []).map((a) =>
    `insert into "PayrollRunRowLines" ("Id","TenantId","PayrollRunRowId","SourcePayrollItemId","Type","Label","AmountType","Amount","IsApplied","Reason","SortOrder","CreatedDate","CreatedBy","MatchedByRule","FrozenAmount")
     select gen_random_uuid(), r."TenantId", r."Id", ${q(a.itemId)}, 'Incentive', ${q(a.label)}, 'FlatAmount', ${a.amount}, true, null, 99, now(), 'qa-db-seed', true, ${a.amount}
     from "PayrollRunRows" r where r."PayrollRunId" = ${q(runId)} and r."StaffMemberId" = ${q(a.staffMemberId)};`).join('\n');
  const statement = `
begin;
insert into "PayrollRuns" ("Id","TenantId","Month","Status","PayrollPolicyId","LastSavedUtc","CreatedDate","CreatedBy","PublishedAtUtc","PublishedBy","PublishedByUserId")
  select ${q(runId)}, "TenantId", ${q(iso(month))}::timestamptz, "Status", "PayrollPolicyId", ${q(at)}::timestamptz, ${q(at)}::timestamptz, 'qa-db-seed', ${q(at)}::timestamptz, "PublishedBy", "PublishedByUserId"
  from "PayrollRuns" where "Id" = ${q(sourceRunId)};
create temp table qa_row_map as select "Id" as old_id, gen_random_uuid() as new_id from "PayrollRunRows" where "PayrollRunId" = ${q(sourceRunId)};
insert into "PayrollRunRows" ("Id","TenantId","PayrollRunId","StaffMemberId","SortOrder","MonthlySalary","Net","ExceptionKind","UnpaidDays","ExceptionDate","EarlierDays","EarlierDaysAmount","CreatedDate","CreatedBy","BaseNet","UnpaidDatesCsv","EobiPerMonth","IncomeTaxPercent","ProvidentFundPercent","FrozenDeductions","FrozenEarnings","FrozenEobi","FrozenIncentives","FrozenIncomeTax","FrozenProvidentFund","PaymentStatus","EarlierFromDate","PaidOnUtc")
  select m.new_id, r."TenantId", ${q(runId)}, r."StaffMemberId", r."SortOrder", r."MonthlySalary", r."Net", 'None', 0, null, 0, 0, ${q(at)}::timestamptz, 'qa-db-seed', r."BaseNet", null, r."EobiPerMonth", r."IncomeTaxPercent", r."ProvidentFundPercent", r."FrozenDeductions", r."FrozenEarnings", r."FrozenEobi", r."FrozenIncentives", r."FrozenIncomeTax", r."FrozenProvidentFund", 'Paid', null, ${q(at)}::timestamptz
  from "PayrollRunRows" r join qa_row_map m on m.old_id = r."Id";
insert into "PayrollRunRowLines" ("Id","TenantId","PayrollRunRowId","SourcePayrollItemId","Type","Label","AmountType","Amount","IsApplied","Reason","SortOrder","CreatedDate","CreatedBy","MatchedByRule","FrozenAmount")
  select gen_random_uuid(), l."TenantId", m.new_id, l."SourcePayrollItemId", l."Type", l."Label", l."AmountType", l."Amount", l."IsApplied", l."Reason", l."SortOrder", ${q(at)}::timestamptz, 'qa-db-seed', l."MatchedByRule", l."FrozenAmount"
  from "PayrollRunRowLines" l join qa_row_map m on m.old_id = l."PayrollRunRowId";
${overrides}
${drops}
${adds}
commit;`;
  await sqlExec(statement);
  return { runId, sql: statement };
}

/**
 * DB MANIPULATION. Moves this tenant's CURRENT-month run (draft or published) to `month`, freeing the current month
 * for a fresh Generate. Used to give a tenant a "previous published run" built by the real product code.
 */
export async function moveRunToMonth(runId: string, month: Date, publishedAt?: Date): Promise<string> {
  const at = publishedAt ? `, "PublishedAtUtc" = ${q(publishedAt.toISOString())}::timestamptz` : '';
  const statement = `update "PayrollRuns" set "Month" = ${q(iso(month))}::timestamptz${at} where "Id" = ${q(runId)};`;
  await sqlExec(statement);
  return statement;
}

/** DB MANIPULATION. Makes a staff member's salary "not set" for payroll by moving every salary revision into the future. */
export async function hideSalary(staffId: string): Promise<string> {
  const statement = `update "StaffSalaryRevisions" set "EffectiveFrom" = '2099-01-01' where "StaffMemberId" = ${q(staffId)};`;
  await sqlExec(statement);
  return statement;
}

// ── Second users (permissions) ──────────────────────────────────────────────────────────────────
export interface Member { phone: string; userId: string; api: APIRequestContext; credentials(): { identifier: string; password: string } }

async function restLogin(phone: string, password: string): Promise<string> {
  const c = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  try {
    const res = await c.post(`${REST_API}/auth/login`, { data: { username: phone, password, persona: 1 } });
    expect(res.status(), `RestApi /auth/login for ${phone}`).toBe(200);
    return (await res.json()).accessToken as string;
  } finally {
    await c.dispose();
  }
}

/**
 * Adds a Teacher staff member, sends them an app-access invite, and accepts it on AuthApp with a new password.
 * The Teacher system role has NO payroll permission. With `customRoleId`, the user's role assignment is then
 * switched to that custom role in Postgres (DB MANIPULATION: the product has no endpoint to change a user's role).
 */
export async function inviteMember(owner: CampusOwner, opts: { customRoleId?: string } = {}): Promise<Member & { staffId: string; assignmentSql?: string }> {
  const staff = await addStaff(owner.api, { salary: 30000, designationId: DESIGNATION.teacher, name: qaName('Viewer') });
  const known = new Set((await sql<{ u: string }>(`select "UserId" as u from "AccessRoleAssignments" where "TenantId" = ${q(owner.tenantId)}`)).map((r) => r.u));
  known.add(owner.userId);
  const invite = await ok(await owner.api.post(`staff/${staff.id}/app-access/invite`), 'send staff invite');
  // Link format: {authApp}/staff/app-access/invites/{token}
  const token = decodeURIComponent(new URL(invite.inviteUrl, AUTH_APP).pathname.split('/').filter(Boolean).pop()!);
  const password = `Qa!${randomUUID().slice(0, 10)}9a`;
  const auth = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  const accept = await auth.post(`${AUTH_APP}/staff/app-access/invites/${token}/accept`, { data: { password, email: `qa-staff+${letters(8)}@testenv.local` } });
  expect(accept.status(), `accept invite: ${(await accept.text()).slice(0, 300)}`).toBe(200);
  await auth.dispose();
  const phoneRow = await sql<{ phone: string }>(`select "PrimaryPhone" as phone from "StaffMembers" where "Id" = ${q(staff.id)}`);
  const phone = phoneRow[0].phone;
  // The school-DB role assignment is provisioned asynchronously by the Worker.
  let userId = '';
  await expect.poll(async () => {
    const rows = await sql<{ u: string }>(`select "UserId" as u from "AccessRoleAssignments" where "TenantId" = ${q(owner.tenantId)}`);
    userId = rows.map((r) => r.u).find((u) => !known.has(u)) ?? '';
    return userId;
  }, { timeout: 90_000, intervals: [1000, 2000] }).not.toBe('');
  let assignmentSql: string | undefined;
  if (opts.customRoleId) {
    assignmentSql = `update "AccessRoleAssignments" set "SystemRoleName" = null, "AccessRoleId" = ${q(opts.customRoleId)} where "TenantId" = ${q(owner.tenantId)} and "UserId" = ${q(userId)};`;
    await sqlExec(assignmentSql);
  }
  const token2 = await restLogin(phone, password);
  return {
    phone, userId, staffId: staff.id, assignmentSql,
    api: await pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: `${REST_API}/`, extraHTTPHeaders: { Authorization: `Bearer ${token2}` } }),
    credentials: () => ({ identifier: phone, password }),
  };
}

/** Custom role cloned from Head Admin with payroll See (and Edit when `edit`). Other modules are left out. */
export async function createPayrollRole(api: APIRequestContext, edit: boolean, payroll = true): Promise<string> {
  const label = !payroll ? 'None' : edit ? 'Edit' : 'See';
  const body = await ok(await api.post('access-roles', {
    data: {
      sourceSystemRole: 'Head Admin', roleName: `QA Payroll ${label} ${letters(4)}`, description: `QA: Account Office fee See; payroll ${label}`,
      permissions: [
        { moduleKey: 'payroll-management', see: payroll, edit: payroll && edit, approve: false, export: false, publish: false },
        { moduleKey: 'fee-management', see: true, edit: false, approve: false, export: false, publish: false },
      ],
    },
  }), 'create access role');
  return body.id;
}
export const createPayrollSeeOnlyRole = (api: APIRequestContext) => createPayrollRole(api, false);

// ── Per-file "world": one throwaway owner + its seeded data, survives worker restarts ────────────
/*
 * Playwright restarts the worker after a failing test, which re-runs beforeAll. Creating a new owner each time
 * would burn the AuthApp OTP limiter (30 / 15 min per IP) and lose the tenant's one-run-per-month state, so the
 * owner's login and the seeded ids are cached for THIS run under .auth/payroll/ (gitignored, like every other
 * Playwright auth artefact). QA_PAYROLL_RUN is set once per `playwright test` invocation in playwright.config.ts.
 */
const WORLD_DIR = path.join(__dirname, '..', '.auth', 'payroll');
interface WorldFile<T> { phone: string; password: string; email: string; tenantId: string; schoolName: string; data?: T }

function jwtClaim(token: string, name: string): string | undefined {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))[name];
}

async function ownerFromLogin(f: WorldFile<unknown>): Promise<CampusOwner> {
  let token = await restLogin(f.phone, f.password);
  const make = (t: string) => pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: `${REST_API}/`, extraHTTPHeaders: { Authorization: `Bearer ${t}` } });
  const owner: CampusOwner = {
    email: f.email, phone: f.phone, tenantId: f.tenantId, schoolName: f.schoolName, token,
    userId: jwtClaim(token, 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier')!,
    api: await make(token),
    async refreshToken() { token = await restLogin(f.phone, f.password); owner.token = token; await owner.api.dispose(); owner.api = await make(token); },
    credentials: () => ({ identifier: f.phone, password: f.password }),
    async authAppSession() { throw new Error('not used by payroll specs'); },
  };
  return owner;
}

export interface World<T> { owner: CampusOwner; data: T; statePath: string }

/**
 * The file's owner and seeded data. `seed` runs once per `playwright test` invocation; later calls (including after a
 * worker restart) reuse the cached owner and ids. `newOwner` is injected to keep this module free of OTP calls.
 */
export async function world<T>(key: string, newOwner: () => Promise<CampusOwner & { credentials(): { identifier: string; password: string } }>, seed: (owner: CampusOwner) => Promise<T>): Promise<World<T>> {
  const runId = process.env.QA_PAYROLL_RUN ?? 'adhoc';
  mkdirSync(WORLD_DIR, { recursive: true });
  const file = path.join(WORLD_DIR, `${runId}-${key}.json`);
  const statePath = path.join(WORLD_DIR, `${runId}-${key}-ui.json`);
  if (existsSync(file)) {
    const f = JSON.parse(readFileSync(file, 'utf8')) as WorldFile<T>;
    const owner = await ownerFromLogin(f);
    if (f.data !== undefined) return { owner, data: f.data, statePath };
    const data = await seed(owner);
    writeFileSync(file, JSON.stringify({ ...f, data }), { mode: 0o600 });
    return { owner, data, statePath };
  }
  const owner = await patientOwner(newOwner);
  const { identifier, password } = owner.credentials();
  const f: WorldFile<T> = { phone: identifier, password, email: owner.email, tenantId: owner.tenantId, schoolName: owner.schoolName };
  writeFileSync(file, JSON.stringify(f), { mode: 0o600 });
  const data = await seed(owner);
  writeFileSync(file, JSON.stringify({ ...f, data }), { mode: 0o600 });
  return { owner, data, statePath };
}

/**
 * newCampusOwner() with patience for the AuthApp OTP limiter (30 calls / 15 min per IP; each owner costs 2). On a 429
 * it waits a minute and tries again, up to ~16 minutes. Call from beforeAll after test.setTimeout(20 min).
 */
export async function patientOwner(make: () => Promise<CampusOwner>): Promise<CampusOwner> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await make();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (attempt >= 16 || !/429|Too Many|rate|incorrect Content-type/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
}

/** Saves a world's (mutated) data back to its cache file, e.g. after a test adds a lazily seeded variant. */
export async function persistWorld<T>(key: string, data: T) {
  const file = path.join(WORLD_DIR, `${process.env.QA_PAYROLL_RUN ?? 'adhoc'}-${key}.json`);
  const f = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...f, data }), { mode: 0o600 });
}

// ── UI ──────────────────────────────────────────────────────────────────────────────────────────
export const PAYROLL_PATH = '/accounts/staff-payroll';
export const runPath = (runId: string) => `/accounts/staff-payroll/run/${runId}`;

export async function signInUi(page: Page, creds: { identifier: string; password: string }, target = PAYROLL_PATH) {
  await page.goto(target);
  await new LoginPage(page).signIn(creds.identifier, creds.password);
  await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible({ timeout: 60_000 });
  if (!page.url().includes(target)) await page.goto(target);
}

/**
 * A signed-in page for this world. Reuses the saved storage state (AuthApp SSO cookie) when there is one; signs in
 * with the password only when the app asks for it, then saves the state for the next test.
 */
export async function openApp(browser: Browser, w: { owner: { credentials(): { identifier: string; password: string } }; statePath: string }, target = PAYROLL_PATH, contextOptions: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: 'Asia/Karachi', ...contextOptions, ...(existsSync(w.statePath) ? { storageState: w.statePath } : {}) });
  const page = await context.newPage();
  await page.goto(target);
  const login = page.getByRole('heading', { name: 'Sign in to your account' });
  // The AuthApp sign-in page has a banner too; the signed-in shell is the one with the user menu.
  // Phones show the "More options" kebab instead of the user menu.
  const shell = page.getByRole('button', { name: /^(Open user menu|More options)$/ }).first();
  await expect(login.or(shell)).toBeVisible({ timeout: 60_000 });
  if (await login.isVisible()) {
    await new LoginPage(page).signIn(w.owner.credentials().identifier, w.owner.credentials().password);
    await expect(shell).toBeVisible({ timeout: 60_000 });
    await context.storageState({ path: w.statePath });
  }
  if (!page.url().includes(target)) await page.goto(target);
  return page;
}
