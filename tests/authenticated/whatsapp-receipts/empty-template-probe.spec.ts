/**
 * Live probe for cycle-2 R1: worker FeePaymentReceiptTemplateName is empty.
 * Skipped unless QA_EMPTY_TEMPLATE_PROBE=1 so full regression does not pick it up.
 * Expectation: the receipt row stays Pending, no credit is kept, the fake sender is not called.
 */
import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { BackOffice, evidencePath, quotaDb, WA_KIND, WA_STATUS, type CampusOwner, type QuotaPackageRow } from '../../../fixtures/quota';
import {
  addStudent, createSchoolPolicy, familyMobile, pay, personName, q, receiptRow, setupSchool, waitForChallans, waitReceiptRow,
} from '../../../fixtures/fees';

test.skip(process.env.QA_EMPTY_TEMPLATE_PROBE !== '1', 'live probe: set QA_EMPTY_TEMPLATE_PROBE=1 after restarting the worker with an empty template name');

test.use({ ignoreHTTPSErrors: true });

test('R1 live: an empty FeePaymentReceiptTemplateName leaves the row Pending and does not charge a credit', async () => {
  test.setTimeout(8 * 60_000);
  let owner: CampusOwner | undefined;
  let ops: BackOffice | undefined;
  let pkg: QuotaPackageRow | undefined;
  try {
    const { newCampusOwner } = await import('../../../fixtures/quota');
    owner = await newCampusOwner('qa555e');
    ops = await BackOffice.signIn();
    const school = await setupSchool(owner, 1);
    const student = await addStudent(owner, {
      name: personName('EmptyTpl'),
      classId: school.classes[0].id,
      fatherName: personName('Dad'),
      fatherMobile: familyMobile(),
    });
    await createSchoolPolicy(owner, { tuition: 1500 });
    await waitForChallans(owner.tenantId, 1, `c."FamilyId" = ${q(student.familyId)}`);

    await ops.activate(await quotaDb.subscriptionId(owner.tenantId));
    await expect.poll(async () => (await (await owner!.api.get('subscription/quota')).json()).included, { timeout: 90_000, intervals: [5_000] }).toBe(100);
    pkg = await ops.newPackage(10, 10, 5);
    expect((await owner.api.post('subscription/quota/requests', { data: { packageId: pkg.id } })).status()).toBe(201);
    const req = (await ops.requests('Requested')).find((r) => r.tenantId === owner!.tenantId)!;
    expect((await ops.approve(req.id)).status()).toBe(200);
    // Worker entitlement cache is up to 60 s.
    await new Promise((r) => setTimeout(r, 65_000));

    const prefs = await owner.api.put('campus/notification-preferences', { data: { disabledKinds: [WA_KIND.ResultPublished, WA_KIND.PendingDues] } });
    expect(prefs.status()).toBe(200);
    const usedBefore = await quotaDb.creditsUsed(owner.tenantId);

    const res = await pay(owner.api, student.familyId, 200);
    const text = await res.text();
    expect(res.status(), text.slice(0, 400)).toBe(200);
    const paymentId = JSON.parse(text).paymentId;
    const row0 = await waitReceiptRow(owner.tenantId, paymentId, 120_000);
    // Give the worker (1-minute tick) time to attempt the send and defer.
    await new Promise((r) => setTimeout(r, 80_000));
    const row = (await receiptRow(owner.tenantId, paymentId)) ?? row0;
    const usedAfter = await quotaDb.creditsUsed(owner.tenantId);
    const evidence = {
      paymentId,
      usedBefore,
      usedAfter,
      Status: row.Status,
      SkipReason: row.SkipReason,
      QuotaAllocationId: row.QuotaAllocationId,
      TemplateName: row.message?.TemplateName ?? null,
      AttemptCount: row.AttemptCount,
      LastError: row.LastError,
    };
    await writeFile(evidencePath('r1-empty-template-row.json'), JSON.stringify(evidence, null, 2));
    console.log(`[R1 empty template] ${JSON.stringify(evidence)}`);
    expect(row.Status, 'empty template must leave the row Pending, not mark it Sent').toBe(WA_STATUS.Pending);
    expect(row.QuotaAllocationId, 'deferred send must release the quota claim').toBeNull();
    expect(usedAfter).toBe(usedBefore);
  } finally {
    if (pkg && ops) await ops.archivePackage(pkg).catch(() => undefined);
    await ops?.dispose();
    await owner?.api.dispose();
  }
});
