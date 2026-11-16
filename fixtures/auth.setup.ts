import { test as setup, expect } from '@playwright/test';
import path from 'node:path';
import { LoginPage } from '../pages/LoginPage';

const authFile = path.join(__dirname, '..', '.auth', 'user.json');

setup('authenticate school admin', { tag: '@smoke' }, async ({ page }) => {
  const email = process.env.QA_EMAIL;
  const password = process.env.QA_PASSWORD;
  if (!email || !password) throw new Error('QA_EMAIL / QA_PASSWORD missing from .env');
  await page.goto('/');
  await new LoginPage(page).signIn(email, password);
  await page.waitForURL((u) => u.origin === new URL(process.env.QA_BASE_URL!).origin && !u.pathname.startsWith('/authentication'), { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toHaveCount(0);
  await page.context().storageState({ path: authFile });
});
