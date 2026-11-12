/**
 * PR 550 / ClickUp z94x8ebqpt — parent side of the family invite code, driven end to end:
 * the school owner issues the code in a second context, the seeded parent redeems it.
 * AC3 (auth required), AC4 (validate before proceeding), AC7 (connect as a new child), AC8 (expiry),
 * AC9 (new code after expiry). Cycle 2 regressions: ut8 (pasted codes), utb (declined wording), uta
 * (drawer after a rejection). AC5–AC7 existing-child linking lives in existing-child-link.spec.ts.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/family';
import { expireInvite, waitForInviteWhatsApp, type SeededStudent } from '../../fixtures/devenv';
import { StudentsRegisterPage } from '../../pages/StudentsRegisterPage';
import { FamilyInviteCodeDrawer } from '../../pages/FamilyInviteCodeDrawer';
import { LoginPage } from '../../pages/LoginPage';
import { JoinWithCodePage } from '../../pages/family/JoinWithCodePage';
import { FamilyDashboardPage } from '../../pages/family/FamilyDashboardPage';

const SCHOOL = 'Testenv High School - Main';
const INVALID = "That code isn't valid. Check it and try again.";
const USED = 'This code has already been used. Ask the school for a new one if you still need to connect.';
const DECLINED = 'This code was declined as "not my child", so it no longer works. If that was a mistake, ask the school for a new code.';
const DRAWER_REJECTED = "The parent said this isn't their child. Check the father's mobile number, then generate a new code.";
const WITHDRAWN = 'The school has withdrawn this code. Ask them to send you a new one.';
const EXPIRED = `This code has expired. Ask ${SCHOOL} to send you a new one.`;
const EMPTY = 'Enter the code from your WhatsApp message.';

/** Owner opens the student's drawer and generates a code; resolves once the parent can redeem it. */
async function issueCode(adminPage: Page, student: SeededStudent): Promise<{ code: string; drawer: FamilyInviteCodeDrawer }> {
  const register = new StudentsRegisterPage(adminPage);
  await register.goto();
  const drawer = await register.openFamilyInviteDrawer(student);
  const code = await drawer.generate();
  await waitForInviteWhatsApp(code);
  return { code, drawer };
}

const bare = (code: string) => code.replace('-', '');

// Each test seeds a student (seed.sh) and loads two WASM apps; 30 s is too tight on the local stack.
test.describe.configure({ timeout: 90_000 });

/**
 * A just-linked child shows as "Child" until the school's profile snapshot is projected (outbox relay,
 * a few seconds) and the dashboard does not refresh itself, so reload until the name appears once.
 */
async function expectChildOnDashboard(dashboard: FamilyDashboardPage, fullName: string) {
  await expect(async () => {
    await dashboard.goto();
    await expect(dashboard.child(fullName)).toHaveCount(1, { timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
}

test.describe('Join with an invite code', () => {
  test('the deep link shows the invite card: school, first name only, class, masked admission number, expiry', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);

    await join.goto(bare(code));

    await expect(join.schoolName).toHaveText(SCHOOL);
    await expect(join.cardValue('Child')).toHaveText(student.firstName);
    await expect(join.main).not.toContainText(student.fullName);
    await expect(join.cardValue('Class')).toHaveText('Class 5-5 (A)');
    await expect(join.cardValue('Admission number')).not.toContainText(student.admissionId);
    await expect(join.cardValue('Code expires')).toHaveText(/^\d{2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} [AP]M$/);
    await expect(join.newChildNotice).toContainText(`${student.firstName} will be added to your family as a new child.`);
  });

  test('a code typed in lowercase with a space instead of the dash is accepted', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto();

    await join.submitCode(code.replace('-', ' ').toLowerCase());

    await expect(join.cardValue('Child')).toHaveText(student.firstName);
  });

  test('a code pasted with surrounding whitespace is accepted', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto();

    // Copying from a WhatsApp message commonly picks up a leading/trailing space.
    await join.submitCode(` ${code} `);

    await expect(join.cardValue('Child')).toHaveText(student.firstName);
  });

  for (const [label, mangle] of [
    ['spaces around and inside the code', (c: string) => `  ${c.slice(0, 3)} - ${c.slice(4)}  `.toLowerCase()],
    ['a doubled dash', (c: string) => c.replace('-', '--')],
    ['a space between every character', (c: string) => c.replace('-', '').split('').join(' ')],
  ] as const) {
    test(`a code pasted with ${label} is accepted (ut8)`, async ({ page, adminPage, student }) => {
      const { code } = await issueCode(adminPage, student);
      const join = new JoinWithCodePage(page);
      await join.goto();

      await join.submitCode(mangle(code));

      await expect(join.codeInput).toHaveCount(0);
      await expect(join.cardValue('Child')).toHaveText(student.firstName);
    });
  }

  test('an unknown code is rejected with "That code isn\'t valid"', async ({ page }) => {
    const join = new JoinWithCodePage(page);
    await join.goto();

    await join.submitCode('ZZZ-ZZ9');

    await expect(join.codeInput).toHaveAccessibleDescription(INVALID);
    await expect(join.connectButton).toHaveCount(0);
  });

  test('an empty code asks for the code without calling the server', async ({ page }) => {
    const join = new JoinWithCodePage(page);
    await join.goto();
    const redeemCalls: string[] = [];
    page.on('request', (r) => r.url().includes('/family/link-invites/redeem') && redeemCalls.push(r.url()));

    await join.submitCode('   ');

    await expect(join.codeInput).toHaveAccessibleDescription(EMPTY);
    expect(redeemCalls).toHaveLength(0);
  });

  test('a very long code in the link is rejected cleanly, without an unhandled error', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && /unhandled|exception/i.test(m.text()) && pageErrors.push(m.text()));
    const join = new JoinWithCodePage(page);

    await join.goto('A'.repeat(2000));

    await expect(join.codeInput).toHaveAccessibleDescription(INVALID);
    expect(pageErrors).toEqual([]);
  });

  test('Connect adds the child to the dashboard and the school no longer offers an invite code', { tag: '@smoke' }, async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto(bare(code));
    await expect(join.connectButton).toBeVisible();

    // connect() returns on the click. The dashboard (and the school's loss of the invite action)
    // follow the accept response and the navigation to /dashboard, not the click itself.
    const accepted = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/link-invites\/[^/]+\/accept$/.test(r.url()),
      { timeout: 30_000 },
    );
    await join.connect();
    expect((await accepted).ok(), 'accept').toBeTruthy();

    const dashboard = new FamilyDashboardPage(page);
    await dashboard.expectLoaded();
    await expectChildOnDashboard(dashboard, student.fullName);

    const register = new StudentsRegisterPage(adminPage);
    await register.goto();
    await expect.poll(() => register.rowActionNames(student), { timeout: 30_000 }).not.toContain('Family invite code');
  });

  test('a code that was already used is refused with the already-used message', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto(bare(code));
    await join.connect();
    await new FamilyDashboardPage(page).expectLoaded();

    await join.goto();
    await join.submitCode(code);

    await expect(join.codeInput).toHaveAccessibleDescription(USED);
  });

  test('going back after connecting does not offer to connect again', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto(bare(code));
    await join.connect();
    await new FamilyDashboardPage(page).expectLoaded();

    await page.goBack();

    await join.expectLoaded();
    await expect(join.codeInput).toHaveAccessibleDescription(USED);
    await expect(join.connectButton).toHaveCount(0);
  });

  test('double-clicking Connect links the child exactly once', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto(bare(code));
    const acceptCalls: string[] = [];
    page.on('request', (r) => r.method() === 'POST' && /\/link-invites\/[^/]+\/accept$/.test(r.url()) && acceptCalls.push(r.url()));

    const accepted = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/link-invites\/[^/]+\/accept$/.test(r.url()),
      { timeout: 30_000 },
    );
    await join.connectButton.dblclick();
    expect((await accepted).ok(), 'accept').toBeTruthy();

    const dashboard = new FamilyDashboardPage(page);
    await dashboard.expectLoaded();
    await expectChildOnDashboard(dashboard, student.fullName);
    expect(acceptCalls).toHaveLength(1);
  });

  test('"Not my child" asks to confirm and Cancel returns to the card', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto(bare(code));

    await join.startReject();
    await expect(join.main).toContainText("We'll tell the school this isn't your child so they can correct the number.");
    await join.cancelRejectButton.click();

    await expect(join.rejectConfirmation).toBeHidden();
    await expect(join.connectButton).toBeVisible();
  });

  test('confirming "Not my child" does not link the child and the code stops working', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto(bare(code));

    await join.startReject();
    await join.confirmRejectButton.click();

    const dashboard = new FamilyDashboardPage(page);
    await dashboard.expectLoaded();
    await expect(dashboard.child(student.fullName)).toHaveCount(0);

    await join.goto();
    await join.submitCode(code);
    await expect(join.connectButton).toHaveCount(0);
    // utb: a declined code says so; it must not claim the code "has already been used".
    await expect(join.codeInput).toHaveAccessibleDescription(DECLINED);
  });

  test('after the parent says "Not my child", the school drawer explains it and offers a new code (uta)', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto(bare(code));
    await join.startReject();
    await join.confirmRejectButton.click();
    await new FamilyDashboardPage(page).expectLoaded();

    const register = new StudentsRegisterPage(adminPage);
    await expect(async () => {
      await register.goto();
      const drawer = await register.openFamilyInviteDrawer(student);
      await expect(drawer.statusMessage).toHaveText(DRAWER_REJECTED, { timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
    const drawer = new FamilyInviteCodeDrawer(adminPage);
    await expect(drawer.code).toHaveCount(0);
    await expect(drawer.generateButton).toBeVisible();
  });

  test('"Use a different code" returns to an empty form and does not re-fill from the link', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto(bare(code));
    await expect(join.connectButton).toBeVisible();

    await join.useDifferentCode();

    await expect(join.codeInput).toBeVisible();
    await expect(join.codeInput).toHaveValue('');
    await expect(join.connectButton).toHaveCount(0);
  });

  test('a regenerated code replaces the old one: the old code is invalid, the new one works', async ({ page, adminPage, student }) => {
    const { code: oldCode, drawer } = await issueCode(adminPage, student);
    const newCode = await drawer.regenerate(oldCode);
    await waitForInviteWhatsApp(newCode);
    const join = new JoinWithCodePage(page);

    await join.goto();
    await join.submitCode(oldCode);
    await expect(join.codeInput).toHaveAccessibleDescription(INVALID);

    await join.submitCode(newCode);
    await expect(join.cardValue('Child')).toHaveText(student.firstName);
  });

  // Accepted as-is by product (Umair, 3 Nov 2026, cycle 2 Q2): the addressee can still connect from a card opened
  // before a regenerate. Kept as fixme so it can be re-enabled if that decision changes.
  test.fixme('Connect from a card opened before the school regenerated the code is refused', async ({ page, adminPage, student }) => {
    const { code: oldCode, drawer } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto(bare(oldCode));
    await expect(join.connectButton).toBeVisible();

    const newCode = await drawer.regenerate(oldCode);
    await waitForInviteWhatsApp(newCode);
    const accept = page.waitForResponse((r) => /\/link-invites\/[^/]+\/accept$/.test(r.url()) && r.request().method() === 'POST');
    await join.connect();

    // The registrar was told "The old code no longer works", so the stale card must not connect.
    // Asserted on the accept answer itself: a just-linked child shows as "Child" on the dashboard until
    // its snapshot is projected, so the dashboard check alone passed falsely once (cycle 3).
    expect((await accept).status(), 'accept from a stale card').not.toBe(200);
    await expect(page).toHaveURL(/\/join/);
    const dashboard = new FamilyDashboardPage(page);
    await dashboard.goto();
    await expect(dashboard.child(student.fullName)).toHaveCount(0);
  });

  test('a stale card opened by someone other than the addressee cannot connect after the school regenerates', async ({ browser, freshParent, adminPage, student }) => {
    // The code went to the seeded parent's number; a different parent (wrong number / forwarded
    // message) opens the card, then the school regenerates. Their Connect must be refused.
    const { code: oldCode, drawer } = await issueCode(adminPage, student);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: process.env.QA_FAMILY_URL, ignoreHTTPSErrors: true });
    const other = await context.newPage();
    await other.goto(`/join?code=${bare(oldCode)}`);
    await new LoginPage(other).signIn(freshParent.email, freshParent.password);
    const join = new JoinWithCodePage(other);
    await expect(join.connectButton).toBeVisible({ timeout: 30_000 });

    const newCode = await drawer.regenerate(oldCode);
    await waitForInviteWhatsApp(newCode);
    await join.connect();

    await expect(other).toHaveURL(/\/join/);
    await expect(join.cardError).toBeVisible();
    const dashboard = new FamilyDashboardPage(other);
    await dashboard.goto();
    await expect(dashboard.child(student.fullName)).toHaveCount(0);
    await context.close();
  });

  test('a cancelled code is refused as withdrawn', async ({ page, adminPage, student }) => {
    const { code, drawer } = await issueCode(adminPage, student);
    await drawer.startCancelInvite();
    await drawer.confirmCancelInvite();
    await expect(drawer.notice).toHaveText('Invite cancelled.');
    const join = new JoinWithCodePage(page);

    await join.goto();
    // The withdrawal reaches the family plane on the relay's next poll (~5 s). Until then the code
    // still opens the card, so step back to the form between attempts.
    await expect(async () => {
      if (await join.useDifferentCodeButton.isVisible()) await join.useDifferentCode();
      await join.submitCode(code);
      await expect(join.codeInput).toHaveAccessibleDescription(WITHDRAWN, { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
  });

  test('an expired code is refused, naming the school and asking for a new code (AC8)', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    await expireInvite(student.id);
    const join = new JoinWithCodePage(page);

    await join.goto(bare(code));

    await expect(join.codeInput).toHaveAccessibleDescription(EXPIRED);
    await expect(join.connectButton).toHaveCount(0);
  });

  test('after a code expires the school can generate a new one and the parent can use it (AC9)', async ({ page, adminPage, student }) => {
    const { code: expiredCode } = await issueCode(adminPage, student);
    await expireInvite(student.id);

    const register = new StudentsRegisterPage(adminPage);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    await expect(drawer.code).toHaveCount(0);
    const newCode = await drawer.generate();
    expect(newCode).not.toBe(expiredCode);
    await waitForInviteWhatsApp(newCode);

    const join = new JoinWithCodePage(page);
    await join.goto(bare(newCode));
    await expect(join.cardValue('Child')).toHaveText(student.firstName);
  });

  test('two admin tabs regenerating at once leave exactly one working code, and the drawer shows it', async ({ page, adminPage, student }) => {
    const { code: first } = await issueCode(adminPage, student);
    const tabB = await adminPage.context().newPage();
    const registerB = new StudentsRegisterPage(tabB);
    await registerB.goto();
    const drawerB = await registerB.openFamilyInviteDrawer(student);
    await expect(drawerB.code).toHaveText(first);
    const drawerA = new FamilyInviteCodeDrawer(adminPage);

    await Promise.all([drawerA.startRegenerate(), drawerB.startRegenerate()]);
    const [codeA, codeB] = await Promise.all([
      drawerA.confirmRegenerate().then(() => expect(drawerA.code).not.toHaveText(first)).then(() => drawerA.currentCode()),
      drawerB.confirmRegenerate().then(() => expect(drawerB.code).not.toHaveText(first)).then(() => drawerB.currentCode()),
    ]);

    // A fresh look at the drawer is the registrar's source of truth.
    const fresh = new StudentsRegisterPage(tabB);
    await fresh.goto();
    const current = await (await fresh.openFamilyInviteDrawer(student)).currentCode();
    expect([codeA, codeB]).toContain(current);
    await waitForInviteWhatsApp(current);

    const join = new JoinWithCodePage(page);
    await join.goto();
    // Redeem the dead codes first: each miss counts toward the lockout and only a live hit resets it.
    for (const dead of new Set([first, codeA, codeB].filter((c) => c !== current))) {
      await expect(async () => {
        await join.submitCode(dead);
        await expect(join.codeInput).toHaveAccessibleDescription(INVALID, { timeout: 3_000 });
      }).toPass({ timeout: 20_000 });
    }
    await join.submitCode(current);
    await expect(join.cardValue('Child')).toHaveText(student.firstName);
  });

  test('signed out, the deep link sends the parent to sign in and back to the same code (AC3)', async ({ anonContext, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const page = await anonContext.newPage();

    await page.goto(`/join?code=${bare(code)}`);
    const login = new LoginPage(page);
    const join = new JoinWithCodePage(page);
    await login.expectLoaded();
    await expect(join.connectButton).toHaveCount(0);
    await login.signIn(process.env.QA_PARENT_EMAIL!, process.env.QA_PARENT_PASSWORD!);

    await join.expectLoaded();
    await expect(page).toHaveURL(new RegExp(`/join\\?code=${bare(code)}`));
    await expect(join.cardValue('Child')).toHaveText(student.firstName);
  });
});
