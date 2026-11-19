/**
 * Short cycle-2 close-out: WebApp receipt page/print paper + R5 (pre-existing 500).
 * Self-seeding; does not need WhatsApp credits (the receipt page is independent of the send).
 */
import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { evidencePath, signInToWebApp, WEBAPP, type CampusOwner } from '../../../fixtures/quota';
import {
  addStudent, createSchoolPolicy, familyMobile, getReceipt, pay, personName, q,
  setupSchool, waitForChallans,
} from '../../../fixtures/fees';

test.use({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial' });

let owner: CampusOwner;
let familyId: string;
let paymentId: string;
let receiptNumber: string;

const saveEvidence = async (name: string, content: string) => writeFile(evidencePath(name), content);

test.beforeAll(async () => {
  test.setTimeout(8 * 60_000);
  const { newCampusOwner } = await import('../../../fixtures/quota');
  owner = await newCampusOwner('qa555c');
  const school = await setupSchool(owner, 1);
  const student = await addStudent(owner, {
    name: personName('Closeout'),
    classId: school.classes[0].id,
    fatherName: personName('Dad'),
    fatherMobile: familyMobile(),
  });
  familyId = student.familyId;
  await createSchoolPolicy(owner, { tuition: 1500 });
  await waitForChallans(owner.tenantId, 1, `c."FamilyId" = ${q(familyId)}`);
  const res = await pay(owner.api, familyId, 500);
  const text = await res.text();
  expect(res.status(), text.slice(0, 400)).toBe(200);
  const body = JSON.parse(text);
  paymentId = body.paymentId;
  const receipt = await getReceipt(owner.api, paymentId);
  receiptNumber = receipt.receiptNumber;
});

test.afterAll(async () => {
  await owner?.api.dispose();
});

test('R5 (pre-existing): GET fee-payments/payments/{malformed id}/receipt answers 400/404, not 500', async () => {
  test.fail(true, 'R5 open: GetFeePaymentReceipt turns a non-GUID id into a FormatException → 500 (also on main)');
  const statuses: Record<string, number> = {};
  for (const id of [randomUUID(), 'not-a-guid', '%20', 'a'.repeat(300)]) {
    statuses[id.slice(0, 20)] = (await owner.api.get(`fee-payments/payments/${encodeURIComponent(id)}/receipt`)).status();
  }
  console.log(`[R5] ${JSON.stringify(statuses)}`);
  await saveEvidence('r5-receipt-status.json', JSON.stringify(statuses, null, 2));
  for (const [id, status] of Object.entries(statuses)) expect(status, `GET receipt ${id}`).toBeLessThan(500);
});

test('AC1: the WebApp receipt page and its print paper show the same receipt', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const page: Page = await browser.newPage({ baseURL: WEBAPP, ignoreHTTPSErrors: true });
  try {
    await signInToWebApp(page, owner);
    await page.goto(`/accounts/fee-payment/receipts/${paymentId}`);
    const facts = page.locator('[data-receipt-summary], [data-receipt-details]');
    await expect(facts).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-receipt-fact="number"]')).toContainText(receiptNumber);
    await page.screenshot({ path: evidencePath('ac1-webapp-receipt-page.png'), fullPage: true });
    await saveEvidence('ac1-webapp-receipt-page.txt', await facts.innerText());
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: evidencePath('ac1-webapp-print-receipt.pdf'), format: 'A4', printBackground: true });
    await page.screenshot({ path: evidencePath('ac1-webapp-print-receipt.png'), fullPage: true });
    const paperHost = page.locator('#fee-receipt-print [data-fee-receipt-sheet], #fee-receipt-print [data-receipt-print-layout]');
    await expect(paperHost).toBeAttached({ timeout: 15_000 });
    const paper = (await paperHost.evaluate((el: HTMLElement) => el.innerText)).replace(/\s+/g, ' ');
    await saveEvidence('ac1-webapp-print-receipt.txt', paper);
    expect(paper).toContain(receiptNumber);
  } finally {
    await page.close();
  }
});
