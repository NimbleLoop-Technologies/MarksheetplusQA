/**
 * Fixtures for family-invite specs. No page objects here (write-regression-test boundary).
 *
 *  - student:     a freshly seeded, unlinked student per test (father mobile = the seeded parent).
 *  - adminPage:   a page in a second browser context signed in as the school owner, for specs in the
 *                 `family` project that also drive the school WebApp.
 *  - anonContext: a signed-out family-app context (deep link before sign-in, new-parent registration).
 */
import { test as base, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { seedStudent, type SeededStudent } from './devenv';

const ADMIN_STATE = path.join(__dirname, '..', '.auth', 'user.json');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';

type FamilyFixtures = {
  student: SeededStudent;
  adminPage: Page;
  anonContext: BrowserContext;
};

export const test = base.extend<FamilyFixtures>({
  student: async ({}, use) => {
    await use(await seedStudent());
  },

  adminPage: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: ADMIN_STATE, baseURL: process.env.QA_BASE_URL, ignoreHTTPSErrors });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  anonContext: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      baseURL: process.env.QA_FAMILY_URL,
      ignoreHTTPSErrors,
    });
    await use(context);
    await context.close();
  },
});

export { expect } from '@playwright/test';
