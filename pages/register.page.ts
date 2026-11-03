import { Page, Locator, expect } from '@playwright/test';
import { AUTH_URL } from './urls';

export interface NewAccount {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  password: string;
}

/** Sign-up card "Create your account" on the auth host. */
export class RegisterPage {
  readonly page: Page;
  readonly firstNameInput: Locator;
  readonly lastNameInput: Locator;
  readonly phoneInput: Locator;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly confirmPasswordInput: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.firstNameInput = page.getByLabel('First Name');
    this.lastNameInput = page.getByLabel('Last Name');
    this.phoneInput = page.getByLabel('WhatsApp Number');
    this.emailInput = page.getByLabel('Email Address (optional)');
    this.passwordInput = page.getByLabel('Password', { exact: true });
    this.confirmPasswordInput = page.getByLabel('Confirm Password');
    this.submitButton = page.getByRole('button', { name: 'Create account' });
  }

  async goto(): Promise<void> {
    await this.page.goto(`${AUTH_URL}/auth/register`);
    await expect(this.firstNameInput).toBeVisible();
  }

  async fill(account: Partial<NewAccount> & { confirmPassword?: string }): Promise<void> {
    if (account.firstName !== undefined) await this.firstNameInput.fill(account.firstName);
    if (account.lastName !== undefined) await this.lastNameInput.fill(account.lastName);
    if (account.phone !== undefined) await this.phoneInput.fill(account.phone);
    if (account.email !== undefined) await this.emailInput.fill(account.email);
    if (account.password !== undefined) await this.passwordInput.fill(account.password);
    const confirm = account.confirmPassword ?? account.password;
    if (confirm !== undefined) await this.confirmPasswordInput.fill(confirm);
  }

  async submit(): Promise<void> {
    await this.submitButton.click();
  }

  async register(account: NewAccount): Promise<void> {
    await this.fill(account);
    await this.submit();
  }

  fieldError(message: string | RegExp): Locator {
    return this.page.getByText(message, { exact: true });
  }

  /** The username typed on the sign-in step lands in the matching field. */
  async prefilledUsername(): Promise<string> {
    const email = await this.emailInput.inputValue();
    return email || this.phoneInput.inputValue();
  }

  async expectOnRegister(): Promise<void> {
    await expect(this.page).toHaveURL(/\/auth\/register/);
    await expect(this.submitButton).toBeVisible();
  }

  /** OTP off (integration): moves on. OTP on: /auth/verify-whatsapp. Either way it leaves the form. */
  async expectRegistered(): Promise<void> {
    await expect(this.page).not.toHaveURL(/\/auth\/register/, { timeout: 30_000 });
  }
}
