import { expect, type Locator, type Page } from '@playwright/test';

export interface NewAccount {
  firstName: string;
  lastName: string;
  whatsAppNumber: string;
  email?: string;
  password: string;
}

/** Shared AuthApp registration (https://<auth>/auth/register), reached from "Start your free trial today". */
export class RegisterPage {
  readonly heading: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Create your account', level: 1 });
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  async register(account: NewAccount) {
    await this.expectLoaded();
    await this.page.getByRole('textbox', { name: 'First Name' }).fill(account.firstName);
    await this.page.getByRole('textbox', { name: 'Last Name' }).fill(account.lastName);
    await this.page.getByRole('textbox', { name: 'WhatsApp Number' }).fill(account.whatsAppNumber);
    if (account.email) await this.page.getByRole('textbox', { name: 'Email Address (optional)' }).fill(account.email);
    await this.page.getByRole('textbox', { name: 'Password', exact: true }).fill(account.password);
    await this.page.getByRole('textbox', { name: 'Confirm Password' }).fill(account.password);
    await this.page.getByRole('button', { name: 'Create account' }).click();
  }
}

/** AuthApp /auth/verify-whatsapp: six single-digit boxes. */
export class VerifyWhatsAppPage {
  readonly heading: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Verify your WhatsApp number', level: 1 });
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  /** Fills each box separately: typing the code in one go races the boxes' auto-advance. */
  async verify(code: string) {
    await this.expectLoaded();
    for (const [i, digit] of [...code].entries()) {
      await this.page.getByRole('textbox', { name: `Digit ${i + 1} of 6` }).fill(digit);
    }
    // Some builds auto-submit on the sixth digit; only click if we are still here.
    const verify = this.page.getByRole('button', { name: 'Verify' });
    if (await verify.isVisible() && /verify-whatsapp/.test(this.page.url())) await verify.click().catch(() => undefined);
  }
}
