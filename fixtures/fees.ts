/**
 * PR 555 (ClickUp z94x8e9yhj) "WhatsApp fee receipts" helpers for the LOCAL branch-testing stack.
 * Adapted from the PR 547 fees helpers (qa/pr-547 fixtures/fees.ts): API seeding through the owner's
 * RestApi bearer, Postgres reads/writes through psql, Mongo reads through fixtures/quota.ts `mongo`.
 *
 *  - setupSchool():      session + N classes (one section each) on a throwaway campus
 *  - addStudent():       quick-add; same father mobile => same Family (siblings)
 *  - createSchoolPolicy(): school fee policy whose ChallanGenerationDay is today's UTC day, so the Worker
 *                        scheduler (1-minute interval) issues the current cycle within a minute or two
 *  - waitForChallans():  polls FeeChallans until the scheduler issued them
 *  - pay():              POST fee-payments/families/{id}/payments
 *  - receiptOutbox()/receiptRows(): the FeePaymentReceivedEvent outbox rows and the queued WhatsApp rows
 *
 * Every SQL statement that WRITES is marked "DB SETUP" and is logged to the test output.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomInt, randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { mongo, WA_KIND, type CampusOwner } from './quota';

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
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.split('\n').filter((l) => l.length > 0).map((l) => l.split('\t'));
}

/** A write used only to arrange data. Logged so the report can quote the exact SQL. */
export async function dbSetup(reason: string, statement: string): Promise<string[][]> {
  console.log(`[DB SETUP] ${reason}\n${statement.trim()}`);
  return sql(statement);
}

export const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

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
export const familyMobile = () => `0335${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;

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

// ── Fee policy ───────────────────────────────────────────────────────────────────────────────

const ALLOWED_DAYS = [1, 5, 10, 15, 30];

/** The generation day that makes the scheduler issue a cycle today (today's UTC day must be an allowed day). */
export function todaysGenerationDay(): number {
  const day = new Date().getUTCDate();
  if (!ALLOWED_DAYS.includes(day)) {
    throw new Error(`today's UTC day ${day} is not an allowed challan generation day (${ALLOWED_DAYS}); these specs need DB setup to bill today`);
  }
  return day;
}

export async function createSchoolPolicy(owner: CampusOwner, tuition = 1500): Promise<string> {
  const body = await ok(
    await owner.api.post('fee-policies', {
      data: {
        policyName: `QA555 School ${letters(5)}`, publishNow: true, description: null, policyType: 0, rootPolicyId: null, scope: 0, classIds: [],
        occurrence: 0, challanGenerationDay: todaysGenerationDay(), dueDay: 25, tuitionFee: tuition, enableFineRule: false, fineType: null,
        fineAmount: null, graceDays: null, effectiveFrom: `${todayUtc()}T00:00:00Z`, effectiveUntil: null, additionalFundIds: [],
        bankName: 'QA Bank', accountTitle: 'QA School Account', accountNumber: null, bankBranch: 'Main',
      },
    }),
    'fee-policies (school)',
  );
  return body.id as string;
}

// ── Challans ─────────────────────────────────────────────────────────────────────────────────

export interface ChallanRow { id: string; familyId: string; number: string; cycleLabel: string; total: number; outstanding: number }

export async function challans(tenantId: string): Promise<ChallanRow[]> {
  const rows = await sql(`
    select c."Id", c."FamilyId", c."ChallanNumber", c."CycleLabel", c."TotalAmount", c."OutstandingAmount"
    from "FeeChallans" c where c."TenantId" = ${q(tenantId)} order by c."ChallanNumber"`);
  return rows.map((r) => ({ id: r[0], familyId: r[1], number: r[2], cycleLabel: r[3], total: Number(r[4]), outstanding: Number(r[5]) }));
}

/** Polls until every family in `familyIds` has a challan (the scheduler ticks every minute). */
export async function waitForChallans(tenantId: string, familyIds: string[], timeout = 300_000): Promise<ChallanRow[]> {
  let found: ChallanRow[] = [];
  await expect
    .poll(async () => {
      found = await challans(tenantId);
      return familyIds.filter((f) => !found.some((c) => c.familyId === f)).length;
    }, { message: `scheduler never issued challans for ${familyIds.join(',')} (tenant ${tenantId})`, timeout, intervals: [5_000, 10_000] })
    .toBe(0);
  return found;
}

/** Σ RemainingAmount over the family's challan lines (fresh DB read) = what the family still owes. */
export async function familyOutstanding(familyId: string): Promise<number> {
  const rows = await sql(`select coalesce(sum(l."RemainingAmount"), 0) from "FeeChallanLines" l join "FeeChallans" c on c."Id" = l."FeeChallanId" where c."FamilyId" = ${q(familyId)}`);
  return Number(rows[0][0]);
}

// ── Fee payment API ──────────────────────────────────────────────────────────────────────────

export interface PayOptions { clientPaymentId?: string; isOfflinePayment?: boolean; note?: string; waivers?: { challanLineId: string; reason: string }[] }

export function payBody(amount: number, o: PayOptions = {}) {
  return {
    clientPaymentId: o.clientPaymentId ?? randomUUID(),
    paymentDate: new Date().toISOString(),
    amountReceived: amount,
    note: o.note ?? 'QA Auto receipt',
    isOfflinePayment: o.isOfflinePayment ?? false,
    fineWaivers: o.waivers ?? [],
  };
}

export async function pay(api: APIRequestContext, familyId: string, amount: number, o: PayOptions = {}): Promise<APIResponse> {
  return api.post(`fee-payments/families/${encodeURIComponent(familyId)}/payments`, { data: payBody(amount, o) });
}

export async function getReceipt(api: APIRequestContext, paymentId: string): Promise<any> {
  return ok(await api.get(`fee-payments/payments/${encodeURIComponent(paymentId)}/receipt`), `GET receipt ${paymentId}`);
}

// ── Receipt outbox (Postgres) ────────────────────────────────────────────────────────────────

export interface OutboxRow { id: string; processedOn: string; attempts: number; payload: any }

/** FeePaymentReceivedEvent outbox rows for one payment. */
export async function receiptOutbox(paymentId: string): Promise<OutboxRow[]> {
  const rows = await sql(`
    select "Id", coalesce("ProcessedOn"::text, ''), "Attempts", "PayloadJson"::text from "OutboxMessages"
    where "EventType" = 'FeePaymentReceivedEvent' and "PayloadJson"->'Receipt'->>'PaymentId' = ${q(paymentId)}`);
  return rows.map((r) => ({ id: r[0], processedOn: r[1], attempts: Number(r[2]), payload: JSON.parse(r[3]) }));
}

/** Waits until the relay published the payment's receipt event (ProcessedOn set). */
export async function waitOutboxProcessed(paymentId: string, timeout = 120_000): Promise<OutboxRow> {
  let row: OutboxRow | undefined;
  await expect
    .poll(async () => (row = (await receiptOutbox(paymentId))[0])?.processedOn ?? '', { message: `receipt outbox for ${paymentId} never relayed`, timeout, intervals: [2_000, 5_000] })
    .not.toBe('');
  return row!;
}

export async function paymentsByClientId(tenantId: string, clientPaymentId: string): Promise<string[]> {
  return (await sql(`select "Id" from "FeePayments" where "TenantId" = ${q(tenantId)} and "ClientPaymentId" = ${q(clientPaymentId)}`)).map((r) => r[0]);
}

// ── Queued WhatsApp receipt rows (Mongo, accounts DB) ────────────────────────────────────────

export interface ReceiptRow {
  _id: string;
  Kind: number;
  DedupeKey: string;
  RecipientReference: string;
  TenantId: string;
  Status: number;
  SkipReason: string | null;
  QuotaAllocationId: string | null;
  AttemptCount: number;
  LastError: string | null;
  SentToNumber: string | null;
  /** Parsed MessageJson (WhatsAppTemplateMessage). */
  message: {
    ToPhoneNumber: string;
    TemplateName: string;
    LanguageCode: string;
    BodyParameters: { Name: string; Value: string }[];
    Document: { Html: string; FileName: string } | null;
    RecipientContext: string;
  } | null;
}

export const receiptDedupeKey = (tenantId: string, paymentId: string) => `fee-receipt:${tenantId}:${paymentId}`;

/** Every FeePaymentReceipt row of a tenant (newest last). */
export async function receiptRows(tenantId: string): Promise<ReceiptRow[]> {
  const out = await mongo(`print(EJSON.stringify(db.scheduledwhatsappmessages.find({TenantId: ${JSON.stringify(tenantId)}, Kind: ${WA_KIND.FeePaymentReceipt}}).sort({_id: 1}).toArray(), {relaxed: true}))`);
  const docs = JSON.parse(out) as any[];
  return docs.map((d) => ({
    ...d,
    _id: typeof d._id === 'object' && d._id?.$oid ? d._id.$oid : String(d._id),
    message: d.MessageJson ? JSON.parse(d.MessageJson) : null,
  }));
}

export async function receiptRow(tenantId: string, paymentId: string): Promise<ReceiptRow | undefined> {
  return (await receiptRows(tenantId)).find((r) => r.DedupeKey === receiptDedupeKey(tenantId, paymentId));
}

/** Waits until the payment's receipt row exists. */
export async function waitReceiptRow(tenantId: string, paymentId: string, timeout = 120_000): Promise<ReceiptRow> {
  let row: ReceiptRow | undefined;
  await expect.poll(async () => !!(row = await receiptRow(tenantId, paymentId)), { message: `no receipt row for ${paymentId}`, timeout, intervals: [2_000, 5_000] }).toBe(true);
  return row!;
}

/** Waits until the worker moves the payment's receipt row out of Pending/Sending (Sent, Skipped or Failed). */
export async function waitReceiptProcessed(tenantId: string, paymentId: string, timeout = 5 * 60_000): Promise<ReceiptRow> {
  let row: ReceiptRow | undefined;
  await expect
    .poll(async () => (row = await receiptRow(tenantId, paymentId))?.Status ?? -1, { message: `receipt row for ${paymentId} never processed`, timeout, intervals: [3_000, 5_000, 10_000] })
    .toBeGreaterThanOrEqual(2);
  return row!;
}

export const bodyParam = (row: ReceiptRow, name: string) => row.message?.BodyParameters.find((p) => p.Name === name)?.Value;
