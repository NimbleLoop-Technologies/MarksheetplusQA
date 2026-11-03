/**
 * PR 550 / ClickUp z94x8ebqpt — parent side of the family invite code, driven end to end:
 * the school owner issues the code in a second context, the seeded parent redeems it.
 * AC3 (auth required), AC4 (validate before proceeding), AC5/AC6 (existing-child match), AC7 (connect),
 * AC8 (expiry), AC9 (new code after expiry).
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/family';
import { expireInvite, seedStudent, waitForInviteWhatsApp, type SeededStudent } from '../../fixtures/devenv';
import { StudentsRegisterPage } from '../../pages/StudentsRegisterPage';
import { FamilyInviteCodeDrawer } from '../../pages/FamilyInviteCodeDrawer';
import { LoginPage } from '../../pages/LoginPage';
import { JoinWithCodePage } from '../../pages/family/JoinWithCodePage';
import { FamilyDashboardPage } from '../../pages/family/FamilyDashboardPage';

const SCHOOL = 'Testenv High School - Main';
const INVALID = "That code isn't valid. Check it and try again.";
const USED = 'This code has already been used. Ask the school for a new one if you still need to connect.';
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

  test('Connect adds the child to the dashboard and the school no longer offers an invite code', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto(bare(code));

    await join.connect();

    const dashboard = new FamilyDashboardPage(page);
    await dashboard.expectLoaded();
    await expect(dashboard.child(student.fullName)).toBeVisible();

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

    await join.connectButton.dblclick();

    const dashboard = new FamilyDashboardPage(page);
    await dashboard.expectLoaded();
    await expect(dashboard.child(student.fullName)).toHaveCount(1);
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
    await expect(join.codeInput).toHaveAccessibleDescription(/.+/);
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

  test('Connect from a card opened before the school regenerated the code is refused', async ({ page, adminPage, student }) => {
    const { code: oldCode, drawer } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto(bare(oldCode));
    await expect(join.connectButton).toBeVisible();

    const newCode = await drawer.regenerate(oldCode);
    await waitForInviteWhatsApp(newCode);
    await join.connect();

    // The registrar was told "The old code no longer works", so the stale card must not connect.
    await expect(page).toHaveURL(/\/join/);
    const dashboard = new FamilyDashboardPage(page);
    await dashboard.goto();
    await expect(dashboard.child(student.fullName)).toHaveCount(0);
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

test.describe('Existing-child matching (AC5/AC6, Phase 2 — deferred in PR 550)', () => {
  test('an invited student matching an existing child by name and date of birth offers to link to that child (AC5)', async ({ page, adminPage }) => {
    // Same name + DOB as ADM-0001 Ali Khan, already in the seeded parent's family (cf. QA-1005).
    const twin = await seedStudent({ firstName: 'Ali', lastName: 'Khan', dateOfBirth: '2015-01-01' });
    const { code } = await issueCode(adminPage, twin);
    const join = new JoinWithCodePage(page);

    await join.goto(bare(code));

    await expect(join.cardValue('Child')).toHaveText('Ali');
    await expect(join.existingChildOption('Ali Khan')).toBeVisible();
  });

  test('creating a new child profile is always available, even when a match exists (AC6)', async ({ page, adminPage }) => {
    const twin = await seedStudent({ firstName: 'Ali', lastName: 'Khan', dateOfBirth: '2015-01-01' });
    const { code } = await issueCode(adminPage, twin);
    const join = new JoinWithCodePage(page);

    await join.goto(bare(code));

    await expect(join.newChildNotice).toBeVisible();
    await expect(join.connectButton).toBeEnabled();
  });
});
