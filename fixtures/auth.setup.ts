import { test as setup } from '@playwright/test';
import path from 'node:path';
import { LoginPage } from '../pages/login.page';

const authFile = path.join(__dirname, '..', '.auth', 'user.json');

setup('authenticate seeded QA user', async ({ page }) => {
  const username = process.env.QA_EMAIL;
  const password = process.env.QA_PASSWORD;

  if (!username || !password) {
    throw new Error(
      'QA_EMAIL and QA_PASSWORD must be set. Copy .env.example to .env and fill in the seeded QA account.',
    );
  }

  // Full OIDC round trip: web → auth host → web, so both origins' state is captured.
  const loginPage = new LoginPage(page);
  await loginPage.gotoFromWebApp();
  await loginPage.login(username, password);
  await loginPage.expectLoggedIn();

  await page.context().storageState({ path: authFile });
});
