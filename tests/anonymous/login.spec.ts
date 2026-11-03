import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/login.page';
import { uniqueEmail } from '../../fixtures/test-data';

const seededUser = process.env.QA_EMAIL ?? '';
const seededPassword = process.env.QA_PASSWORD ?? '';

test.describe('Sign in', () => {
  test('a seeded user can sign in and lands back on the web app', { tag: '@critical' }, async ({ page }) => {
    test.skip(!seededUser || !seededPassword, 'QA_EMAIL / QA_PASSWORD not set');
    const loginPage = new LoginPage(page);
    await loginPage.gotoFromWebApp();
    await loginPage.login(seededUser, seededPassword);
    await loginPage.expectLoggedIn();
  });

  test('a known username moves on to the password step', async ({ page }) => {
    test.skip(!seededUser, 'QA_EMAIL not set');
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.submitUsername(seededUser);
    await loginPage.expectOnPasswordStep();
  });

  test('an unknown email is routed to sign-up with the email prefilled', async ({ page }) => {
    const email = uniqueEmail();
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.submitUsername(email);
    await expect(page).toHaveURL(/\/auth\/register\?username=/);
  });

  test('an empty username is rejected', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.submitUsername('');
    await expect(loginPage.fieldError('Please enter your email or phone to continue.')).toBeVisible();
  });

  test('a malformed email is rejected', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.submitUsername('name@example');
    await expect(
      loginPage.fieldError('Please enter a valid email address (e.g., name@example.com).'),
    ).toBeVisible();
  });

  test('a malformed phone number is rejected', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.submitUsername('0300123');
    await expect(loginPage.fieldError(/^Enter a valid phone number\./)).toBeVisible();
  });

  test('an empty password is rejected', async ({ page }) => {
    test.skip(!seededUser, 'QA_EMAIL not set');
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(seededUser, '');
    await expect(loginPage.fieldError('Password is required.')).toBeVisible();
  });
});

// Wrong passwords count towards lockout of the shared seeded account: one attempt per run, no retries.
test.describe('Sign in — wrong password', () => {
  test.describe.configure({ retries: 0 });

  test('sign-in is rejected with a wrong password', async ({ page }) => {
    test.skip(!seededUser, 'QA_EMAIL not set');
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(seededUser, 'Definitely-not-1t');
    await expect(loginPage.fieldError('Invalid password. Please try again.')).toBeVisible();
    await loginPage.expectOnPasswordStep();
  });
});
