/**
 * Fixtures for family-invite specs. No page objects here (write-regression-test boundary).
 *
 *  - student:     a freshly seeded, unlinked student per test (father mobile = the seeded parent).
 *  - adminPage:   a page in a second browser context signed in as the school owner, for specs in the
 *                 `family` project that also drive the school WebApp.
 *  - anonContext: a signed-out family-app context (deep link before sign-in, new-parent registration).
 *  - freshParent: (worker-scoped) a brand-new parent with a completed, empty family — for specs that
 *                 must not touch the shared seeded parent's family (AC5–AC7).
 */
import { test as base, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createFamilyParent, seedStudent, type FreshParent, type SeededStudent } from './devenv';

const ADMIN_STATE = path.join(__dirname, '..', '.auth', 'user.json');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';

type FamilyFixtures = {
  student: SeededStudent;
  adminPage: Page;
  anonContext: BrowserContext;
};

type FamilyWorkerFixtures = {
  freshParent: FreshParent;
};

export const test = base.extend<FamilyFixtures, FamilyWorkerFixtures>({
  freshParent: [
    async ({}, use, workerInfo) => {
      // A failed test restarts the worker; re-registering a parent each time burns the AuthApp's
      // 30-per-15-min OTP limit (shared with other runs on the stack). Reuse one parent per run:
      // the project output dir is wiped at the start of every run.
      const cache = path.join(workerInfo.project.outputDir, '.fresh-parent.json');
      let parent: FreshParent;
      try {
        parent = JSON.parse(await readFile(cache, 'utf8')) as FreshParent;
      } catch {
        parent = await createFamilyParent();
        await mkdir(path.dirname(cache), { recursive: true });
        await writeFile(cache, JSON.stringify(parent), { mode: 0o600 });
      }
      await use(parent);
    },
    { scope: 'worker', timeout: 180_000 },
  ],

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
