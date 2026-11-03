import { Page } from '@playwright/test';
import { RegisterPage, NewAccount } from '../pages/register.page';
import { uniqueEmail, uniqueName, uniquePhone, VALID_PASSWORD } from './test-data';

/** A fresh, never-used account. */
export function newAccount(): NewAccount {
  return {
    firstName: uniqueName('Qa'),
    lastName: 'Auto',
    phone: uniquePhone(),
    email: uniqueEmail(),
    password: VALID_PASSWORD,
  };
}

/**
 * Registers a brand-new account through the UI and returns its details.
 * Creates a real tenant on the shared environment — only call it behind QA_ALLOW_SIGNUP.
 */
export async function registerNewAccount(page: Page): Promise<NewAccount> {
  const account = newAccount();
  const registerPage = new RegisterPage(page);
  await registerPage.goto();
  await registerPage.register(account);
  await registerPage.expectRegistered();
  return account;
}
