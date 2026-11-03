/**
 * PR 550 / ClickUp z94x8ebqpt — flows that need a parent account of their own.
 *  - AC3 (cycle 2, ut6): a parent with no account registers from the invite link (OTP), is sent through
 *    family setup when they press Connect, comes back to the same code and connects.
 *  - Lockout: 5 bad codes lock the caller out for 15 minutes. It runs on a freshly registered
 *    parent: the lockout is per caller, so it cannot block the shared seeded parent's other tests.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../../fixtures/family';
import { seedStudent, uniquePakistaniMobile, waitForInviteWhatsApp, type SeededStudent } from '../../fixtures/devenv';
import { uniqueSuffix } from '../../fixtures/test-data';
import { StudentsRegisterPage } from '../../pages/StudentsRegisterPage';
import { LoginPage } from '../../pages/LoginPage';
import { RegisterPage, VerifyWhatsAppPage } from '../../pages/RegisterPage';
import { JoinWithCodePage } from '../../pages/family/JoinWithCodePage';
import { FamilyDashboardPage } from '../../pages/family/FamilyDashboardPage';
import { FamilySetupPage } from '../../pages/family/FamilySetupPage';

const OTP = process.env.QA_OTP ?? '000000';
const INVALID = "That code isn't valid. Check it and try again.";
const LOCKED = 'Too many attempts. Try again in 15 minutes.';

const bare = (code: string) => code.replace('-', '');

async function issueCode(adminPage: Page, student: SeededStudent): Promise<string> {
  const register = new StudentsRegisterPage(adminPage);
  await register.goto();
  const code = await (await register.openFamilyInviteDrawer(student)).generate();
  await waitForInviteWhatsApp(code);
  return code;
}

/** Opens `/join?code=…` signed out, registers a brand-new parent and verifies the OTP. */
async function registerFromInviteLink(context: BrowserContext, whatsAppNumber: string, code: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/join?code=${code.replace('-', '')}`);
  await new LoginPage(page).goToRegister();
  await new RegisterPage(page).register({
    firstName: 'Qaparent',
    lastName: `Probe${uniqueSuffix().replace(/[^a-z]/g, '').slice(0, 4) || 'x'}`,
    whatsAppNumber,
    password: `Qa-${uniqueSuffix()}-Pw1!`,
  });
  await new VerifyWhatsAppPage(page).verify(OTP);
  return page;
}

test.describe.configure({ timeout: 120_000 });

test.describe('Invite codes for a parent without an account', () => {
  test('a parent who registers from the invite link is sent through family setup, back to the code, and can connect the child (AC3)', async ({ anonContext, adminPage }) => {
    const phone = uniquePakistaniMobile();
    const student = await seedStudent({ parentPhone: phone });
    const code = await issueCode(adminPage, student);

    const page = await registerFromInviteLink(anonContext, phone, code);

    const join = new JoinWithCodePage(page);
    await join.expectLoaded();
    await expect(join.cardValue('Child')).toHaveText(student.firstName);
    await join.connect();

    // No family profile yet: Connect sends the parent to setup, carrying the code back.
    await expect(page).toHaveURL(new RegExp(`/family/setup\\?returnUrl=${encodeURIComponent(`/join?code=${bare(code)}`)}$`));
    await new FamilySetupPage(page).completeWithFatherOnly({
      fatherName: 'Qafather Probe',
      cnic: `35202-${phone.slice(4)}-1`,
      whatsApp: phone,
      homeAddress: '3 Test Road',
      city: 'Lahore',
      province: 'Punjab',
      familyName: 'Probe',
    });

    await expect(page).toHaveURL(new RegExp(`/join\\?code=${bare(code)}$`));
    await expect(join.cardValue('Child')).toHaveText(student.firstName);
    await join.connect();

    const dashboard = new FamilyDashboardPage(page);
    await dashboard.expectLoaded();
    await expect(dashboard.child(student.fullName)).toHaveCount(1);
  });

  test('after 5 wrong codes the parent is locked out, even for a valid code', async ({ anonContext, adminPage }) => {
    test.slow();
    const phone = uniquePakistaniMobile();
    const student = await seedStudent({ parentPhone: phone });
    const validCode = await issueCode(adminPage, student);

    // Register with a well-formed code that does not exist: the landing redeem is miss #1.
    const page = await registerFromInviteLink(anonContext, phone, 'ZZZ-ZZ9');
    const join = new JoinWithCodePage(page);
    await join.expectLoaded();
    await expect(join.codeInput).toHaveAccessibleDescription(INVALID);

    for (let miss = 2; miss <= 5; miss++) {
      await join.submitCode(`ZZZ-ZZ${miss + 2}`);
      await expect(join.codeInput).toHaveAccessibleDescription(INVALID);
    }

    await join.submitCode('ZZZ-ZZ8');
    await expect(join.codeInput).toHaveAccessibleDescription(LOCKED);

    await join.submitCode(validCode);
    await expect(join.codeInput).toHaveAccessibleDescription(LOCKED);
    await expect(join.connectButton).toHaveCount(0);
  });
});
