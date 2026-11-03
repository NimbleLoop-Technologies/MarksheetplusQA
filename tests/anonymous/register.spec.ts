import { test, expect } from '@playwright/test';
import { RegisterPage } from '../../pages/register.page';
import { newAccount, registerNewAccount } from '../../fixtures/register';

test.describe('Sign-up validation', () => {
  test('submitting an empty form shows every required-field message', async ({ page }) => {
    const registerPage = new RegisterPage(page);
    await registerPage.goto();
    await registerPage.submit();
    for (const message of [
      'First name is required.',
      'Last name is required.',
      'WhatsApp number cannot be blank.',
      'Password is required.',
    ]) {
      await expect(registerPage.fieldError(message)).toBeVisible();
    }
    await registerPage.expectOnRegister();
  });

  test('a confirmation that does not match the password is rejected', async ({ page }) => {
    const registerPage = new RegisterPage(page);
    await registerPage.goto();
    await registerPage.fill({ ...newAccount(), confirmPassword: 'QaAuto2026y' });
    await registerPage.submit();
    await expect(registerPage.fieldError('Passwords do not match.')).toBeVisible();
    await registerPage.expectOnRegister();
  });

  test('a password without an uppercase letter is rejected', async ({ page }) => {
    const registerPage = new RegisterPage(page);
    await registerPage.goto();
    await registerPage.fill({ ...newAccount(), password: 'qaauto2026x' });
    await registerPage.submit();
    await expect(
      registerPage.fieldError(
        'Password must contain at least one uppercase letter, one lowercase letter, and one number.',
      ),
    ).toBeVisible();
  });

  test('a password shorter than 8 characters is rejected', async ({ page }) => {
    const registerPage = new RegisterPage(page);
    await registerPage.goto();
    await registerPage.fill({ ...newAccount(), password: 'QaAut1x' });
    await registerPage.submit();
    await expect(registerPage.fieldError('Password must be at least 8 characters long.')).toBeVisible();
  });

  test('a first name with digits is rejected', async ({ page }) => {
    const registerPage = new RegisterPage(page);
    await registerPage.goto();
    await registerPage.fill({ ...newAccount(), firstName: 'Qa2' });
    await registerPage.submit();
    await expect(registerPage.fieldError('First name contains invalid characters.')).toBeVisible();
  });
});

test.describe('Sign-up', () => {
  test('a new account can be registered through the form', { tag: '@critical' }, async ({ page }) => {
    test.skip(process.env.QA_ALLOW_SIGNUP !== 'true', 'Creates a real tenant; set QA_ALLOW_SIGNUP=true to run');
    const account = await registerNewAccount(page);
    expect(account.phone).toMatch(/^03\d{9}$/);
  });
});
