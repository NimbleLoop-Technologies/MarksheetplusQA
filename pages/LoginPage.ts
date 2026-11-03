import { expect, type Page } from '@playwright/test';

/** Shared AuthApp sign-in (https://<auth>/auth/login), used by the school WebApp and the FamilyApp. */
export class LoginPage {
  constructor(private readonly page: Page) {}

  async expectLoaded() {
    await expect(this.page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
  }

  /** "Not a member? Start your free trial today" → /auth/register (keeps the returnUrl). */
  async goToRegister() {
    await this.expectLoaded();
    await this.page.getByRole('link', { name: 'Start your free trial today' }).click();
  }

  async signIn(identifier: string, password: string) {
    await this.expectLoaded();
    await this.page.getByRole('textbox', { name: 'WhatsApp Number or Email' }).fill(identifier);
    await this.page.getByRole('button', { name: 'Continue' }).click();
    await this.page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
    await this.page.getByRole('button', { name: 'Sign in' }).click();
  }
}
