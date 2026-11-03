/**
 * PR 538 (WhatsApp quota) helpers for the LOCAL branch-testing stack. API and Mongo only, no page objects.
 *
 *  - newCampusOwner():   registers a throwaway school owner on the AuthApp (fixed OTP), creates a
 *                        fresh trial campus, and returns a RestApi bearer token for it. The password is
 *                        random per run and never logged.
 *  - backOffice():       signs the seeded operator (QA_BACKOFFICE_EMAIL / QA_BACKOFFICE_PASSWORD) into
 *                        the AuthApp and wraps /backoffice/api/*.
 *  - quotaDb:            Mongo reads, plus precondition writes that MUST only target a campus the
 *                        test created (exhaust an allocation, queue a ScheduledWhatsAppMessage).
 *
 * Mirrors /workspace/devenv/seed.sh (AccountEndpoints /account/*, /subscription/start, /campus/create,
 * RestApi /auth/login persona 1).
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { expect, request as pwRequest, type APIRequestContext } from '@playwright/test';

const run = promisify(execFile);

export const AUTH_APP = process.env.QA_AUTH_URL ?? 'https://localhost:7104';
export const REST_API = process.env.QA_REST_API_URL ?? 'https://localhost:7244';
const OTP = process.env.QA_OTP ?? '000000';
const MONGO_URL = process.env.QA_MONGO_URL ?? 'mongodb://localhost:27017/mp-accounts-db';
const WORKER_LOG = process.env.QA_WORKER_LOG || '/workspace/devenv/worker.log';

const ctx = () => pwRequest.newContext({ ignoreHTTPSErrors: true });

/** Throwaway 03xx mobile in a range reserved for these specs (03{40-49}538xxxx); callers retry on a 409 clash. */
const quotaMobile = () => `03${randomInt(40, 50)}538${String(randomInt(0, 10_000)).padStart(4, '0')}`;
const randomPassword = () => `Qa!${randomBytes(9).toString('base64url')}9a`;
const letters = (n: number) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[randomInt(26)]).join('');

function jwtClaim(token: string, name: string): string | undefined {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  return payload[name];
}

export interface CampusOwner {
  email: string;
  phone: string;
  userId: string;
  tenantId: string;
  schoolName: string;
  /** RestApi bearer token (persona Campus, tenant claim = the new campus). */
  token: string;
  /** RestApi client with the bearer header set. */
  api: APIRequestContext;
  /** Re-issues the RestApi token (e.g. after an activation so the claims are fresh). */
  refreshToken(): Promise<void>;
  /** Signs this owner into a fresh AuthApp context (cookie), for persona checks against /backoffice. */
  authAppSession(): Promise<APIRequestContext>;
  /** For UI sign-in. A function (not a field) so the password never lands in a printed object. */
  credentials(): { identifier: string; password: string };
}

async function restApiLogin(phone: string, password: string): Promise<string> {
  const c = await ctx();
  try {
    const res = await c.post(`${REST_API}/auth/login`, { data: { username: phone, password, persona: 1 } });
    expect(res.status(), `RestApi /auth/login for ${phone}`).toBe(200);
    return (await res.json()).accessToken as string;
  } finally {
    await c.dispose();
  }
}

/** Registers + verifies a new owner and creates a fresh trial campus. ~2 OTP-limited calls. */
export async function newCampusOwner(label = 'qa538'): Promise<CampusOwner> {
  const password = randomPassword();
  let phone = quotaMobile();
  const email = `${label}-owner+${letters(6)}@testenv.local`;
  const schoolName = `Quota ${letters(5)} School`;
  const auth = await ctx();

  const register = () => auth.post(`${AUTH_APP}/account/register`, {
    data: { firstName: 'Quota', lastName: 'Owner', phoneNumber: phone, email, password, recaptchaToken: null, returnUrl: null },
  });
  let reg = await register();
  // A random number can collide with an earlier run's owner (409 "phone number already exists").
  for (let attempt = 1; reg.status() === 409 && attempt < 3; attempt++) {
    phone = quotaMobile();
    reg = await register();
  }
  expect(reg.status(), `register ${email}: ${await reg.text()}`).toBeLessThan(300);
  const pendingUserId = (await reg.json()).pendingUserId as string;
  const verify = await auth.post(`${AUTH_APP}/account/verify-email`, { data: { pendingUserId, code: OTP } });
  expect(verify.status(), `verify ${email}: ${await verify.text()}`).toBeLessThan(300);

  const start = await auth.post(`${AUTH_APP}/subscription/start`, { data: { addCampus: true } });
  expect(start.status(), `subscription/start: ${await start.text()}`).toBeLessThan(300);
  const campus = await auth.post(`${AUTH_APP}/campus/create`, {
    data: {
      schoolName, campusName: 'Main', ownerName: 'Quota Owner', phoneNumber: phone, emailAddress: email,
      address: '1 Quota Road', city: 'Lahore', province: 'Punjab', zipCode: null, officialPhoneNumber: null,
      emergencyContactNumber: null, logoBase64: null, logoFileName: null, logoContentType: null, logoUrl: null,
    },
  });
  expect(campus.status(), `campus/create: ${await campus.text()}`).toBeLessThan(300);
  const tenantId = (await campus.json()).tenantId as string;
  await auth.dispose();

  let token = await restApiLogin(phone, password);
  expect(jwtClaim(token, 'tenant')).toBe(tenantId);
  const owner: CampusOwner = {
    email, phone, tenantId, schoolName, token,
    userId: jwtClaim(token, 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier')!,
    api: await pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: `${REST_API}/`, extraHTTPHeaders: { Authorization: `Bearer ${token}` } }),
    async refreshToken() {
      token = await restApiLogin(phone, password);
      owner.token = token;
      await owner.api.dispose();
      owner.api = await pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: `${REST_API}/`, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    },
    credentials: () => ({ identifier: phone, password }),
    async authAppSession() {
      const c = await ctx();
      const res = await c.post(`${AUTH_APP}/account/login`, { data: { username: phone, password, returnUrl: null } });
      expect(res.status(), 'owner AuthApp login').toBe(200);
      return c;
    },
  };
  return owner;
}

// ── Back office ──────────────────────────────────────────────────────────────────────────────

export interface QuotaPackageRow { id: string; name: string; quantity: number; price: number; validityDays: number; isArchived: boolean }
export interface QuotaRequestRow { id: string; tenantId: string; status: string; quantity: number; price: number; [k: string]: unknown }

export class BackOffice {
  constructor(readonly http: APIRequestContext) {}

  static async signIn(): Promise<BackOffice> {
    const email = process.env.QA_BACKOFFICE_EMAIL;
    const password = process.env.QA_BACKOFFICE_PASSWORD;
    if (!email || !password) throw new Error('QA_BACKOFFICE_EMAIL / QA_BACKOFFICE_PASSWORD missing (back-office operator)');
    const c = await ctx();
    const res = await c.post(`${AUTH_APP}/account/login`, { data: { username: email, password, returnUrl: null } });
    expect(res.status(), 'operator AuthApp login').toBe(200);
    return new BackOffice(c);
  }

  /** The operator's AuthApp cookie, for a browser context that should open the back office signed in. */
  storageState() { return this.http.storageState(); }

  url(path: string) { return `${AUTH_APP}/backoffice/api/${path}`; }

  async packages(): Promise<QuotaPackageRow[]> {
    const res = await this.http.get(this.url('quota-packages'));
    expect(res.status()).toBe(200);
    return res.json();
  }

  createPackage(body: Record<string, unknown>) { return this.http.post(this.url('quota-packages'), { data: body }); }
  updatePackage(id: string, body: Record<string, unknown>) { return this.http.put(this.url(`quota-packages/${id}`), { data: body }); }

  /** Creates a package with a unique name and returns its row. */
  async newPackage(quantity: number, price: number, validityDays = 90): Promise<QuotaPackageRow> {
    const name = `QA538 ${letters(6)}`;
    const res = await this.createPackage({ name, quantity, price, validityDays });
    expect(res.status(), `create package: ${await res.text()}`).toBe(200);
    const row = (await this.packages()).find((p) => p.name === name);
    expect(row, `package ${name} listed`).toBeTruthy();
    return row!;
  }

  async archivePackage(p: QuotaPackageRow) {
    const res = await this.updatePackage(p.id, { name: p.name, quantity: p.quantity, price: p.price, validityDays: p.validityDays, isArchived: true });
    expect(res.status()).toBe(200);
  }

  async requests(status?: string): Promise<QuotaRequestRow[]> {
    const res = await this.http.get(this.url('quota-requests') + (status ? `?status=${status}` : ''));
    expect(res.status()).toBe(200);
    return res.json();
  }

  approve(id: string, paymentReference: string | null = 'QA538-PAY') { return this.http.post(this.url(`quota-requests/${id}/approve`), { data: { paymentReference } }); }
  reject(id: string, reason: string | null) { return this.http.post(this.url(`quota-requests/${id}/reject`), { data: { reason } }); }

  createPlan(body: Record<string, unknown>) { return this.http.post(this.url('plans'), { data: body }); }
  updatePlan(id: string, body: Record<string, unknown>) { return this.http.put(this.url(`plans/${id}`), { data: body }); }
  async plans(): Promise<Array<{ id: string; name: string; isArchived: boolean; isDefault: boolean; price: number; cycle: string; trialDays: number; features: string[]; quotas: Array<{ resource: number; label: string; granted: number }> }>> {
    const res = await this.http.get(this.url('plans'));
    expect(res.status()).toBe(200);
    return res.json();
  }

  async activate(subscriptionId: string) {
    const res = await this.http.post(this.url(`customers/${subscriptionId}/activate`), { data: {} });
    expect(res.status(), `activate ${subscriptionId}: ${await res.text()}`).toBe(200);
  }

  changePlan(subscriptionId: string, planId: string) {
    return this.http.post(this.url(`customers/${subscriptionId}/change-plan`), { data: { planId, reason: 'QA538' } });
  }

  async dispose() { await this.http.dispose(); }
}

// ── Mongo ────────────────────────────────────────────────────────────────────────────────────

export async function mongo(script: string): Promise<string> {
  const { stdout } = await run('npx', ['-y', 'mongosh', MONGO_URL, '--quiet', '--eval', script], { timeout: 120_000 });
  return stdout.trim();
}
const mongoJson = async <T>(expr: string): Promise<T> => JSON.parse(await mongo(`print(EJSON.stringify(${expr}, {relaxed: true}))`)) as T;

export interface AllocationDoc { _id: string; TenantId: string; Source: number; AllocationKey: string; Granted: number; Used: number; StartsAtUtc: string; ExpiresAtUtc: string }
export interface WhatsAppRowDoc { _id: string; Kind: number; DedupeKey: string; Status: number; SkipReason: string | null; QuotaAllocationId: string | null; TenantId: string }

export const WA_STATUS = { Pending: 0, Sending: 1, Sent: 2, Skipped: 3, Failed: 4 } as const;
export const WA_KIND = { WelcomeTrial: 0, ResultPublished: 1, PendingDues: 2, StaffInvite: 3, ParentLinkInvite: 5 } as const;

export const quotaDb = {
  async subscriptionId(tenantId: string): Promise<string> {
    return mongo(`print(db.subscriptions.findOne({TenantId: ${JSON.stringify(tenantId)}})._id.toString())`);
  },
  async allocations(tenantId: string): Promise<AllocationDoc[]> {
    const docs = await mongoJson<Array<Omit<AllocationDoc, '_id'> & { _id: { $oid: string } | string }>>(`db.quotaallocations.find({TenantId: ${JSON.stringify(tenantId)}}).sort({StartsAtUtc: 1}).toArray()`);
    // Relaxed EJSON: ObjectId → {$oid}, Date → {$date}. Normalize both to strings.
    const date = (v: unknown) => (typeof v === 'object' && v && '$date' in v ? String((v as { $date: string }).$date) : String(v));
    return docs.map((d) => ({ ...d, _id: typeof d._id === 'string' ? d._id : d._id.$oid, StartsAtUtc: date(d.StartsAtUtc), ExpiresAtUtc: date(d.ExpiresAtUtc) }));
  },
  /** PRECONDITION WRITE (own campus only): sets Used on the tenant's allocations matching `source`. */
  async setUsed(tenantId: string, source: 0 | 1, used: number | 'granted') {
    const set = used === 'granted' ? `[{ $set: { Used: '$Granted' } }]` : `{ $set: { Used: ${used} } }`;
    await mongo(`db.quotaallocations.updateMany({TenantId: ${JSON.stringify(tenantId)}, Source: ${source}}, ${set})`);
  },
  /** PRECONDITION WRITE (own campus only): moves an add-on's expiry, to test consumption order. */
  async setAddOnExpiry(tenantId: string, expiresAt: Date) {
    await mongo(`db.quotaallocations.updateMany({TenantId: ${JSON.stringify(tenantId)}, Source: 1}, { $set: { ExpiresAtUtc: new Date(${JSON.stringify(expiresAt.toISOString())}) } })`);
  },
  /**
   * PRECONDITION WRITE (own campus only): queues a due Pending metered row with a valid template payload,
   * exactly as the result/fee producers would, then nudges nothing — the worker scheduler republishes due rows.
   */
  async queueWhatsApp(tenantId: string, kind: number, toPhone = '+923455380000'): Promise<string> {
    const dedupeKey = `qa538:${kind}:${tenantId}:${letters(10)}`;
    // Shape of WhatsAppTemplateMessage (Features/Abstractions/IWhatsAppSender.cs), as WhatsAppTemplates.PendingDues/ResultPublished build it.
    const message = {
      ToPhoneNumber: toPhone,
      TemplateName: kind === WA_KIND.PendingDues ? 'pending_dues_en' : 'result_published_en',
      LanguageCode: 'en',
      HeaderParameter: null,
      BodyParameters: [
        { Name: 'total_dues', Value: 'Rs. 1,000' },
        { Name: 'month', Value: 'November 2026' },
        { Name: 'school_name', Value: 'QA538 School' },
      ],
      UrlButtonParameter: null,
      RecipientContext: dedupeKey,
    };
    await mongo(`db.scheduledwhatsappmessages.insertOne({
      Kind: ${kind}, DedupeKey: ${JSON.stringify(dedupeKey)}, RecipientReference: 'qa538', TenantId: ${JSON.stringify(tenantId)},
      MessageJson: ${JSON.stringify(JSON.stringify(message))}, SendAfterUtc: new Date(Date.now() - 60000), Status: 0,
      QuotaAllocationId: null, SkipReason: null, AttemptCount: 0, LastAttemptAtUtc: null, LastError: null, SentAtUtc: null,
      SentToNumber: null, CreatedDate: new Date(), CreatedBy: 'qa538' })`);
    return dedupeKey;
  },
  /**
   * PRECONDITION WRITE (own campus only): puts the campus in the state the Worker leaves after it ran
   * out of quota — this month's plan allocation fully used (created with QuotaManager's deterministic
   * id if the first send has not created it yet), every add-on used up, and `skipped` messages
   * recorded as Skipped/QuotaExhausted this month. Used by UI specs that must not wait on Worker ticks.
   */
  async simulateExhausted(tenantId: string, granted = 100, skipped = 2) {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const key = `plan:${tenantId}:0:${monthStart.toISOString().slice(0, 7)}`;
    const id = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24);
    const t = JSON.stringify(tenantId);
    await mongo(`
      db.quotaallocations.updateOne({ _id: ObjectId('${id}') }, { $setOnInsert: { TenantId: ${t}, Resource: 0, Source: 0, AllocationKey: '${key}',
        Granted: ${granted}, StartsAtUtc: new Date('${monthStart.toISOString()}'), ExpiresAtUtc: new Date('${monthEnd.toISOString()}'),
        CreatedDate: new Date(), CreatedBy: 'qa538', TopUpRequestId: null } }, { upsert: true });
      db.quotaallocations.updateMany({ TenantId: ${t} }, [{ $set: { Used: '$Granted' } }]);
      for (let i = 0; i < ${skipped}; i++) db.scheduledwhatsappmessages.insertOne({ Kind: 1, DedupeKey: 'qa538-skip:' + ${t} + ':' + i + ':' + Date.now(),
        RecipientReference: 'qa538', TenantId: ${t}, MessageJson: null, SendAfterUtc: new Date(), Status: 3, SkipReason: 'QuotaExhausted',
        QuotaAllocationId: null, AttemptCount: 1, LastAttemptAtUtc: new Date(), LastError: null, SentAtUtc: null, SentToNumber: null,
        CreatedDate: new Date(), CreatedBy: 'qa538' });`);
  },
  async whatsAppRow(dedupeKey: string): Promise<WhatsAppRowDoc | null> {
    return mongoJson<WhatsAppRowDoc | null>(`db.scheduledwhatsappmessages.findOne({DedupeKey: ${JSON.stringify(dedupeKey)}})`);
  },
  /** Waits until the worker moves the row out of Pending/Sending (scheduler tick + send). */
  async waitProcessed(dedupeKey: string, timeout = 7 * 60_000): Promise<WhatsAppRowDoc> {
    let row: WhatsAppRowDoc | null = null;
    await expect
      .poll(async () => (row = await quotaDb.whatsAppRow(dedupeKey))?.Status ?? -1, {
        message: `worker never processed ${dedupeKey}`,
        timeout,
        intervals: [5_000, 10_000, 15_000],
      })
      .toBeGreaterThanOrEqual(WA_STATUS.Sent);
    return row!;
  },
};

export async function workerLogMentions(text: string): Promise<string[]> {
  const log = await readFile(WORKER_LOG, 'utf8');
  return log.split('\n').filter((l) => l.includes(text));
}
