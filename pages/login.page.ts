import { Page, Locator, expect } from '@playwright/test';
import { AUTH_URL, WEB_URL } from './urls';

/** Two-step sign-in on the auth host: username → Continue → password → Sign in. */
export class LoginPage {
  readonly page: Page;
  readonly usernameInput: Locator;
  readonly continueButton: Locator;
  readonly passwordInput: Locator;
  readonly signInButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.usernameInput = page.getByLabel('WhatsApp Number or Email');
    this.continueButton = page.getByRole('button', { name: 'Continue' });
    // The visible "Password" label is aria-hidden; the input keeps a visually hidden label.
    this.passwordInput = page.getByLabel('Password', { exact: true });
    this.signInButton = page.getByRole('button', { name: 'Sign in' });
  }

  /** Starts where a real user does: the web app, which redirects to the auth host. */
  async gotoFromWebApp(): Promise<void> {
    await this.page.goto(WEB_URL);
    await expect(this.page).toHaveURL(/\/auth\/login/, { timeout: 30_000 });
  }

  /** Opens the auth host directly. Enough for validation checks; cannot complete an OIDC round trip. */
  async goto(): Promise<void> {
    await this.page.goto(`${AUTH_URL}/auth/login`);
    await expect(this.usernameInput).toBeVisible();
  }

  async submitUsername(username: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.continueButton.click();
  }

  async submitPassword(password: string): Promise<void> {
    await expect(this.passwordInput).toBeVisible();
    await this.passwordInput.fill(password);
    await this.signInButton.click();
  }

  async login(username: string, password: string): Promise<void> {
    await this.submitUsername(username);
    await this.submitPassword(password);
  }

  /** Inline validation or server message rendered under a field. */
  fieldError(message: string | RegExp): Locator {
    return this.page.getByText(message, { exact: true });
  }

  async expectLoggedIn(): Promise<void> {
    const webOrigin = new URL(WEB_URL).origin;
    await expect(this.page).toHaveURL(
      (url) => url.origin === webOrigin && !/^\/(auth|authentication)\//.test(url.pathname),
      { timeout: 30_000 },
    );
  }

  async expectOnPasswordStep(): Promise<void> {
    await expect(this.page).toHaveURL(/\/auth\/login-form/);
    await expect(this.passwordInput).toBeVisible();
  }
}
