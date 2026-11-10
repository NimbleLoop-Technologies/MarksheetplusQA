/**
 * PR 555 / CU-z94x8e9yhj — WhatsApp fee receipts, end to end on the local stack:
 * RestApi payment → OutboxMessages (FeePaymentReceivedEvent) → Worker relay → WhatsAppReceiptSubscriptions
 * → Mongo scheduledwhatsappmessages (Kind 6) → WhatsAppSendSubscriptions (trial / toggle / quota gates)
 * → LoggingWhatsAppSender (fake: logs "FAKE WhatsApp template", ignores the PDF, returns Accepted).
 *
 * Self-seeding, serial, ONE fresh campus for the whole file (starts as a TRIAL, activated mid-file):
 *   - 3 classes; family F3 = 3 siblings (Class 1/2/3); family F1 = 1 student; family F0 = 1 student.
 *   - a school fee policy (tuition 1,500) with ChallanGenerationDay = today's UTC day, so the Worker
 *     scheduler issues this month's challans within ~1–2 minutes.
 * DB PRECONDITIONS (this campus only, logged as [DB SETUP]):
 *   - F0's FatherMobile/MotherMobile set NULL (GuardianMobile set) → "family without a primary guardian mobile".
 *   - F1's student / father names set to Urdu + HTML special characters → template Sanitize + PDF encoding.
 *   - Mongo allocations' Used set to Granted → quota exhausted.
 */
import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  BackOffice, evidencePath, mongo, newCampusOwner, quotaDb, signInToWebApp, workerLogMentions, WA_KIND, WA_STATUS, WEBAPP, type CampusOwner, type QuotaPackageRow,
} from '../../../fixtures/quota';
import {
  addStudent, bodyParam, createSchoolPolicy, dbSetup, familyMobile, familyOutstanding, getReceipt, pay, payBody, paymentsByClientId, personName, q,
  receiptDedupeKey, receiptOutbox, receiptRow, receiptRows, setupSchool, sql, waitForChallans, waitOutboxProcessed, waitReceiptProcessed,
  waitReceiptRow, type ReceiptRow, type Student,
} from '../../../fixtures/fees';

test.use({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial' });

let owner: CampusOwner;
let ops: BackOffice;
let pkg: QuotaPackageRow;
let f3: Student[];
let f1: Student;
let f0: Student;
let f3Mobile: string;
let f3Father: string;
/** The main sent receipt (F3 partial payment). */
let mainPaymentId: string;
let mainClientPaymentId: string;
let mainReceipt: any;
let mainRow: ReceiptRow;

const TUITION = 1500;
const URDU_STUDENT = 'علی <Raza> & Sons';
const URDU_FATHER = 'محمد "Imran" O\'Neil';

const setPrefs = async (disabledKinds: number[]) => {
  const res = await owner.api.put('campus/notification-preferences', { data: { disabledKinds } });
  expect(res.status(), await res.text()).toBe(200);
};
const quota = async () => (await owner.api.get('subscription/quota')).json();
const saveEvidence = async (name: string, content: string) => writeFile(evidencePath(name), content);
const payOk = async (familyId: string, amount: number, o: Parameters<typeof pay>[3] = {}) => {
  const res = await pay(owner.api, familyId, amount, o);
  const text = await res.text();
  expect(res.status(), `pay ${amount} → ${text.slice(0, 400)}`).toBe(200);
  return JSON.parse(text);
};

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  owner = await newCampusOwner('qa555r');
  ops = await BackOffice.signIn();
  const school = await setupSchool(owner, 3);
  f3Mobile = familyMobile();
  f3Father = personName('Father');
  f3 = [];
  for (const c of school.classes) f3.push(await addStudent(owner, { name: personName('Sibling'), classId: c.id, fatherName: f3Father, fatherMobile: f3Mobile }));
  expect(new Set(f3.map((s) => s.familyId)).size, 'siblings share one family').toBe(1);
  f1 = await addStudent(owner, { name: personName('Single'), classId: school.classes[0].id, fatherName: personName('Dad'), fatherMobile: familyMobile() });
  f0 = await addStudent(owner, { name: personName('Nomobile'), classId: school.classes[1].id, fatherName: personName('Papa'), fatherMobile: familyMobile() });

  await dbSetup('F0: no father/mother mobile (guardian mobile only)', `update "Families" set "FatherMobile" = '', "MotherMobile" = NULL, "GuardianMobile" = '03351234500' where "Id" = ${q(f0.familyId)}`);
  await dbSetup('F1: Urdu + HTML special characters in student and father names', `update "Students" set "Name" = ${q(URDU_STUDENT)} where "Id" = ${q(f1.id)}; update "Families" set "FatherName" = ${q(URDU_FATHER)} where "Id" = ${q(f1.familyId)}`);

  await createSchoolPolicy(owner, TUITION);
  await waitForChallans(owner.tenantId, [f3[0].familyId, f1.familyId, f0.familyId]);
});

test.afterAll(async () => {
  if (pkg) await ops?.archivePackage(pkg).catch(() => undefined);
  await ops?.dispose();
  await owner?.api.dispose();
});

test('AC3: a brand-new campus has Fee receipt OFF before anyone saves', async () => {
  const list = (await (await owner.api.get('campus/notification-preferences')).json()).items;
  expect(list.find((i: any) => i.kind === WA_KIND.FeePaymentReceipt)).toMatchObject({ label: 'Fee receipt', enabled: false });
});

test('AC4 trial: with Fee receipt ON, a TRIAL campus queues the receipt but it is Skipped TrialAccount and charges nothing', async () => {
  await setPrefs([WA_KIND.ResultPublished, WA_KIND.PendingDues]);
  const receipt = await payOk(f1.familyId, 200);
  const row = await waitReceiptProcessed(owner.tenantId, receipt.paymentId);
  expect(row).toMatchObject({ Kind: WA_KIND.FeePaymentReceipt, Status: WA_STATUS.Skipped, SkipReason: 'TrialAccount', QuotaAllocationId: null });
  expect(await quotaDb.creditsUsed(owner.tenantId)).toBe(0);
});

test('setup: activate the campus (back office), approve a 5-day add-on that expires before the plan month', async () => {
  test.setTimeout(5 * 60_000);
  await ops.activate(await quotaDb.subscriptionId(owner.tenantId));
  await expect.poll(async () => (await quota()).included, { timeout: 90_000, intervals: [5_000] }).toBe(100);
  pkg = await ops.newPackage(10, 10, 5);
  expect((await owner.api.post('subscription/quota/requests', { data: { packageId: pkg.id } })).status()).toBe(201);
  const req = (await ops.requests('Requested')).find((r) => r.tenantId === owner.tenantId)!;
  expect((await ops.approve(req.id)).status()).toBe(200);
  // The Worker caches entitlement for up to 60 s; wait it out so a skip can only be the toggle/quota.
  await new Promise((r) => setTimeout(r, 65_000));
});

test('AC3: on an ACTIVE campus with Fee receipt OFF, the receipt row ends Skipped DisabledByCampus and no credit is used', async () => {
  await setPrefs([WA_KIND.ResultPublished, WA_KIND.FeePaymentReceipt, WA_KIND.PendingDues]);
  const receipt = await payOk(f1.familyId, 100);
  const row = await waitReceiptProcessed(owner.tenantId, receipt.paymentId);
  expect(row).toMatchObject({ Status: WA_STATUS.Skipped, SkipReason: 'DisabledByCampus', QuotaAllocationId: null });
  expect(await quotaDb.creditsUsed(owner.tenantId)).toBe(0);
});

test('AC1 + AC4: with Fee receipt ON, a partial payment for 3 siblings queues ONE Kind-6 row that is Sent and charges exactly one credit from the earliest-expiring allocation', async () => {
  test.setTimeout(6 * 60_000);
  await setPrefs([WA_KIND.ResultPublished, WA_KIND.PendingDues]);
  const outstandingBefore = await familyOutstanding(f3[0].familyId);
  expect(outstandingBefore).toBe(TUITION * 3);
  mainClientPaymentId = randomUUID();
  const t0 = Date.now();
  mainReceipt = await payOk(f3[0].familyId, 3200, { clientPaymentId: mainClientPaymentId });
  console.log(`[timing] POST payment took ${Date.now() - t0} ms`);
  mainPaymentId = mainReceipt.paymentId;
  await saveEvidence('ac1-payment-response.json', JSON.stringify(mainReceipt, null, 2));

  // Outbox: exactly one FeePaymentReceivedEvent, staged with the payment.
  const outbox = await waitOutboxProcessed(mainPaymentId);
  expect(await receiptOutbox(mainPaymentId)).toHaveLength(1);
  // The family's father mobile is stored normalized (+92…) by quick-add.
  expect(outbox.payload.Receipt).toMatchObject({ PaymentId: mainPaymentId, ContactNumber: `+92${f3Mobile.slice(1)}`, TotalPaid: 3200 });
  await saveEvidence('ac1-outbox-payload.json', JSON.stringify(outbox.payload, null, 2));

  mainRow = await waitReceiptProcessed(owner.tenantId, mainPaymentId);
  await saveEvidence('ac1-mongo-row.json', JSON.stringify({ ...mainRow, message: { ...mainRow.message, Document: { FileName: mainRow.message?.Document?.FileName, HtmlLength: mainRow.message?.Document?.Html.length } } }, null, 2));
  await saveEvidence('ac1-receipt-document.html', mainRow.message!.Document!.Html);
  expect(mainRow).toMatchObject({
    Kind: WA_KIND.FeePaymentReceipt, DedupeKey: receiptDedupeKey(owner.tenantId, mainPaymentId), RecipientReference: mainPaymentId,
    Status: WA_STATUS.Sent,
  });
  expect(mainRow.message!.ToPhoneNumber).toBe(`+92${f3Mobile.slice(1)}`);
  expect(mainRow.message!.Document!.FileName).toBe('fee-receipt.pdf');
  expect(bodyParam(mainRow, 'receipt_number')).toBe(mainReceipt.receiptNumber);
  expect(bodyParam(mainRow, 'amount')).toBe('Rs. 3,200');
  expect(bodyParam(mainRow, 'school_name')).toBe(owner.schoolName);
  expect((await receiptRows(owner.tenantId)).filter((r) => r.RecipientReference === mainPaymentId)).toHaveLength(1);

  // Exactly one credit, from the allocation that expires first (the 5-day add-on, not the plan month).
  const allocations = await quotaDb.allocations(owner.tenantId);
  expect(allocations.reduce((n, a) => n + a.Used, 0)).toBe(1);
  const earliest = [...allocations].sort((a, b) => Date.parse(a.ExpiresAtUtc) - Date.parse(b.ExpiresAtUtc))[0];
  expect(earliest.Source, 'earliest-expiring allocation is the add-on').toBe(1);
  expect(mainRow.QuotaAllocationId).toBe(earliest._id);
  expect(earliest.Used).toBe(1);
  expect((await quota()).used).toBe(1);

  const log = await workerLogMentions(`fee-receipt:${mainReceipt.receiptNumber}`);
  console.log(`[worker log] ${log.join('\n')}`);
});

test('AC1: the queued receipt document matches the receipt API field by field (render → PDF + PNG evidence)', async ({ page }) => {
  const html = mainRow.message!.Document!.Html;
  const api = await getReceipt(owner.api, mainPaymentId);
  await saveEvidence('ac1-receipt-api.json', JSON.stringify(api, null, 2));
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: evidencePath('ac1-whatsapp-receipt.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
  await page.screenshot({ path: evidencePath('ac1-whatsapp-receipt.png'), fullPage: true });

  const text = (await page.locator('main.fee-receipt-pdf').innerText()).replace(/\s+/g, ' ');
  const facts = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('dt')).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent ?? ''])));
  await saveEvidence('ac1-receipt-facts.json', JSON.stringify(facts, null, 2));
  const dd = async (label: string) => facts[label];
  expect(await dd('Receipt No.')).toBe(api.receiptNumber);
  const d = new Date(api.paymentDate);
  expect(await dd('Date')).toBe(`${String(d.getUTCDate()).padStart(2, '0')} ${d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${d.getUTCFullYear()}`);
  expect(await dd('Father name')).toBe(f3Father);
  expect(text).toContain(owner.schoolName);
  expect(text).toContain(`Total paid PKR 3,200`);
  // Balance remaining = the family balance AT payment time (4,500 − 3,200).
  expect(api.balanceRemaining).toBe(TUITION * 3 - 3200);
  expect(await familyOutstanding(f3[0].familyId)).toBe(TUITION * 3 - 3200);
  expect(text).toContain(`Remaining family balance PKR ${(TUITION * 3 - 3200).toLocaleString('en-US')}`);
  expect(text).toContain(`Received by: `);

  // Every allocated line: student, class, fee period, charge, amount — and the amounts add up to the total paid.
  const rows = await page.locator('table').first().locator('tbody tr').allInnerTexts();
  const paidLines = api.lines.filter((l: any) => !l.isWaived);
  expect(rows).toHaveLength(paidLines.length);
  const amounts = await page.locator('table').first().locator('tbody td.amount').allInnerTexts();
  expect(amounts.reduce((n, a) => n + Number(a.replace(/,/g, '')), 0)).toBe(3200);
  for (const s of f3) expect.soft(text, `student ${s.name} on the receipt`).toContain(s.name);
  expect(text).not.toContain('Provisional receipt');
  await saveEvidence('ac1-receipt-lines.txt', rows.join('\n'));
});

test('R3: the Marksheet+ brand logo in the receipt PDF loads (no broken image)', async ({ page }) => {
  test.fail(true, 'R3 open: the relative _content/ brand-logo URL cannot load in a standalone receipt document');
  await page.setContent(mainRow.message!.Document!.Html, { waitUntil: 'load' });
  const logo = page.locator('img.receipt-brand-logo');
  await expect(logo).toHaveCount(1);
  console.log(`[R3] brand logo src="${await logo.getAttribute('src')}"`);
  await page.locator('header').screenshot({ path: evidencePath('r3-receipt-header-brand-logo.png') });
  // A relative "_content/..." URL has no base in a standalone HTML document (Gotenberg renders index.html with outbound access off).
  expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), 'brand logo image loaded').toBe(true);
});

test('AC2: repeating the same ClientPaymentId (sequential) returns the same payment and stages no second event or row', async () => {
  const again = await payOk(f3[0].familyId, 3200, { clientPaymentId: mainClientPaymentId });
  expect(again.paymentId).toBe(mainPaymentId);
  expect(await paymentsByClientId(owner.tenantId, mainClientPaymentId)).toHaveLength(1);
  await new Promise((r) => setTimeout(r, 15_000));
  expect(await receiptOutbox(mainPaymentId)).toHaveLength(1);
  expect((await receiptRows(owner.tenantId)).filter((r) => r.RecipientReference === mainPaymentId)).toHaveLength(1);
  expect(await quotaDb.creditsUsed(owner.tenantId)).toBe(1);
});

test('AC2: three CONCURRENT requests with one ClientPaymentId record one payment, one event, one receipt row', async () => {
  test.setTimeout(5 * 60_000);
  const clientPaymentId = randomUUID();
  const body = payBody(50, { clientPaymentId });
  const responses = await Promise.all([0, 1, 2].map(() => owner.api.post(`fee-payments/families/${f1.familyId}/payments`, { data: body })));
  const statuses = responses.map((r) => r.status());
  console.log(`[concurrent] statuses ${statuses.join(',')}`);
  expect(statuses.every((s) => s < 500), `no 5xx: ${statuses}`).toBe(true);
  const ids = await paymentsByClientId(owner.tenantId, clientPaymentId);
  expect(ids).toHaveLength(1);
  await waitOutboxProcessed(ids[0]);
  expect(await receiptOutbox(ids[0])).toHaveLength(1);
  const row = await waitReceiptProcessed(owner.tenantId, ids[0]);
  expect(row.Status).toBe(WA_STATUS.Sent);
  expect((await receiptRows(owner.tenantId)).filter((r) => r.RecipientReference === ids[0])).toHaveLength(1);
  expect(await quotaDb.creditsUsed(owner.tenantId)).toBe(2);
});

test('AC2: a family without a father/mother mobile gets no receipt row (the event is still relayed)', async () => {
  const receipt = await payOk(f0.familyId, 100);
  const outbox = await waitOutboxProcessed(receipt.paymentId);
  expect(outbox.payload.Receipt.ContactNumber).toBe('');
  await new Promise((r) => setTimeout(r, 20_000));
  expect(await receiptRow(owner.tenantId, receipt.paymentId)).toBeUndefined();
});

test('AC2: a rejected payment (validation / unknown family / malformed id) stages no receipt event and never 500s', async () => {
  const before = (await sql(`select count(*) from "OutboxMessages" where "TenantId" = ${q(owner.tenantId)} and "EventType" = 'FeePaymentReceivedEvent'`))[0][0];
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['amount 0', f1.familyId, payBody(0)],
    ['amount too large', f1.familyId, payBody(1_000_000_000)],
    ['future date', f1.familyId, { ...payBody(10), paymentDate: '2099-01-01T00:00:00Z' }],
    ['unknown family guid', randomUUID(), payBody(10)],
    ['malformed family id', 'not-a-guid', payBody(10)],
    ['sql-ish family id', "x' or '1'='1", payBody(10)],
    ['empty client id', f1.familyId, { ...payBody(10), clientPaymentId: '' }],
    ['waiver on unknown line', f1.familyId, payBody(10, { waivers: [{ challanLineId: 'nope', reason: 'QA' }] })],
  ];
  for (const [label, familyId, data] of cases) {
    const res = await owner.api.post(`fee-payments/families/${encodeURIComponent(familyId)}/payments`, { data });
    console.log(`[reject] ${label} → ${res.status()} ${(await res.text()).slice(0, 160)}`);
    expect(res.status(), label).toBeGreaterThanOrEqual(400);
    expect(res.status(), label).toBeLessThan(500);
  }
  await new Promise((r) => setTimeout(r, 5_000));
  const after = (await sql(`select count(*) from "OutboxMessages" where "TenantId" = ${q(owner.tenantId)} and "EventType" = 'FeePaymentReceivedEvent'`))[0][0];
  expect(after).toBe(before);
});

test('edge: Urdu / HTML special characters are encoded in the PDF and sent as plain template text; offline payment is marked provisional', async ({ page }) => {
  const receipt = await payOk(f1.familyId, 300, { isOfflinePayment: true });
  const row = await waitReceiptProcessed(owner.tenantId, receipt.paymentId);
  expect(row.Status).toBe(WA_STATUS.Sent);
  const html = row.message!.Document!.Html;
  await saveEvidence('edge-urdu-offline-document.html', html);
  expect(html).not.toContain('<Raza>');
  expect(html).toContain('&lt;Raza&gt;');
  await page.setContent(html);
  await page.screenshot({ path: evidencePath('edge-urdu-offline-receipt.png'), fullPage: true });
  const text = await page.locator('main').innerText();
  expect(text).toContain('علی');
  expect(text).toContain('Provisional receipt');
  expect(receipt.isProvisionalReceipt).toBe(true);
  expect(bodyParam(row, 'amount')).toBe('Rs. 300');
});

test('R4: a fractional amount (250.75) is not rounded away on the receipt or in the message', async ({ page }) => {
  test.fail(true, 'R4 open: the receipt PDF and the template amount format with N0');
  const receipt = await payOk(f1.familyId, 250.75);
  const row = await waitReceiptProcessed(owner.tenantId, receipt.paymentId);
  console.log(`[fraction] api totalPaid=${receipt.totalPaid} message amount=${bodyParam(row, 'amount')}`);
  await page.setContent(row.message!.Document!.Html);
  const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  console.log(`[fraction] pdf total: ${text.match(/Total paid PKR [\d,.]+/)?.[0]}`);
  await page.screenshot({ path: evidencePath('edge-fraction-receipt.png'), fullPage: true });
  expect(receipt.totalPaid).toBe(250.75);
  expect(bodyParam(row, 'amount')).toMatch(/250\.75/);
  expect(text).toMatch(/Total paid PKR 250\.75/);
});

test('AC5 logo: an external or missing campus logo URL is omitted from the receipt (never fetched), the receipt is still sent', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const setLogo = (url: string | null) =>
    mongo(`db.campuses.updateOne({Tenant: ObjectId(${JSON.stringify(owner.tenantId)})}, {$set: {LogoUrl: ${JSON.stringify(url)}}})`);
  const missingGuid = `${randomUUID()}.png`;
  try {
    for (const url of ['https://qa555-attacker.invalid/logo.png', `https://localhost:7244/campus-logos/${missingGuid}`]) {
      console.log(`[DB SETUP] Mongo campuses.LogoUrl = ${url} (own campus)`);
      await setLogo(url);
      const receipt = await payOk(f1.familyId, 10);
      const row = await waitReceiptProcessed(owner.tenantId, receipt.paymentId);
      expect(row.Status, url).toBe(WA_STATUS.Sent);
      const html = row.message!.Document!.Html;
      expect(html, url).not.toContain('alt="School logo"');
      expect(html, url).not.toContain('qa555-attacker');
      await page.setContent(html);
      await page.locator('header').screenshot({ path: evidencePath(`ac5-logo-${url.includes('attacker') ? 'external' : 'missing-guid'}.png`) });
    }
    expect((await workerLogMentions('Receipt logo unavailable')).length, 'missing GUID logo logged as unavailable').toBeGreaterThan(0);
  } finally {
    await setLogo(null);
  }
});

test('AC4: with every allocation used up, the receipt is Skipped QuotaExhausted, the alert is on, and a later top-up does NOT resend it', async () => {
  test.setTimeout(8 * 60_000);
  await quotaDb.setUsed(owner.tenantId, 0, 'granted');
  await quotaDb.setUsed(owner.tenantId, 1, 'granted');
  const usedBefore = await quotaDb.creditsUsed(owner.tenantId);
  expect(await quota()).toMatchObject({ remaining: 0, isExhausted: true });
  const status0 = await (await owner.api.get('subscription/quota/status')).json();
  expect(status0.isExhausted).toBe(true);

  const receipt = await payOk(f1.familyId, 40);
  const row = await waitReceiptProcessed(owner.tenantId, receipt.paymentId);
  expect(row).toMatchObject({ Status: WA_STATUS.Skipped, SkipReason: 'QuotaExhausted', QuotaAllocationId: null });
  expect(await quotaDb.creditsUsed(owner.tenantId)).toBe(usedBefore);
  const status1 = await (await owner.api.get('subscription/quota/status')).json();
  expect(status1).toEqual({ isExhausted: true, skippedThisMonth: status0.skippedThisMonth + 1 });

  // Top up: the skipped receipt is dropped, not resent.
  expect((await owner.api.post('subscription/quota/requests', { data: { packageId: pkg.id } })).status()).toBe(201);
  const req = (await ops.requests('Requested')).find((r) => r.tenantId === owner.tenantId)!;
  expect((await ops.approve(req.id)).status()).toBe(200);
  expect((await quota()).isExhausted).toBe(false);
  await new Promise((r) => setTimeout(r, 150_000)); // > 2 queue-scheduler ticks
  const after = await receiptRow(owner.tenantId, receipt.paymentId);
  expect(after).toMatchObject({ Status: WA_STATUS.Skipped, SkipReason: 'QuotaExhausted', AttemptCount: row.AttemptCount });
  expect((await receiptRows(owner.tenantId)).filter((r) => r.RecipientReference === receipt.paymentId)).toHaveLength(1);
  expect(await quotaDb.creditsUsed(owner.tenantId)).toBe(usedBefore);
  // And the back-office customer detail counts the receipt skip like any metered kind.
  const detail = await ops.customerDetail(await quotaDb.subscriptionId(owner.tenantId));
  await saveEvidence('ac4-backoffice-customer-detail.json', JSON.stringify(detail, null, 2));
});

test('AC1: the WebApp receipt page and its print paper show the same receipt (screenshots + print PDF)', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  const page: Page = await browser.newPage({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
  try {
    await signInToWebApp(page, owner);
    await page.goto(`/accounts/fee-payment/receipts/${mainPaymentId}`);
    const facts = page.locator('[data-receipt-details]');
    await expect(facts).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-receipt-fact="number"]')).toContainText(mainReceipt.receiptNumber);
    await page.screenshot({ path: evidencePath('ac1-webapp-receipt-page.png'), fullPage: true });
    await saveEvidence('ac1-webapp-receipt-page.txt', await facts.innerText());
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: evidencePath('ac1-webapp-print-receipt.pdf'), format: 'A4', printBackground: true });
    await page.screenshot({ path: evidencePath('ac1-webapp-print-receipt.png'), fullPage: true });
    const paper = (await page.locator('[data-receipt-print-layout]').innerText()).replace(/\s+/g, ' ');
    await saveEvidence('ac1-webapp-print-receipt.txt', paper);
    expect(paper).toContain(mainReceipt.receiptNumber);
  } finally {
    await page.close();
  }
});

test('R5 (pre-existing): GET fee-payments/payments/{malformed id}/receipt answers 400/404, not 500', async () => {
  test.fail(true, 'R5 open: GetFeePaymentReceipt turns a non-GUID id into a FormatException → 500 (also on main)');
  const statuses: Record<string, number> = {};
  for (const id of [randomUUID(), 'not-a-guid', '%20', 'a'.repeat(300)]) {
    statuses[id.slice(0, 20)] = (await owner.api.get(`fee-payments/payments/${encodeURIComponent(id)}/receipt`)).status();
  }
  console.log(`[R5] ${JSON.stringify(statuses)}`);
  for (const [id, status] of Object.entries(statuses)) expect(status, `GET receipt ${id}`).toBeLessThan(500);
});

test('R1 (AC5): with FeePaymentReceiptTemplateName unset (default ""), receipts are not sent and no credit is used (design doc: "remain Pending until configured")', async () => {
  test.fail(true, 'R1 open: no guard for an empty FeePaymentReceiptTemplateName');
  // The rows above were sent by the fake sender with an EMPTY template name and each charged a credit.
  console.log(`[R1] main row: Status=${mainRow.Status} TemplateName="${mainRow.message?.TemplateName}" QuotaAllocationId=${mainRow.QuotaAllocationId}`);
  const fake = await workerLogMentions(`fee-receipt:${mainReceipt.receiptNumber}`);
  console.log(`[R1] worker log: ${fake.join(' | ')}`);
  expect(mainRow.message?.TemplateName).toBe('');
  expect(mainRow.Status, 'receipt with no configured template must stay Pending').toBe(WA_STATUS.Pending);
});
