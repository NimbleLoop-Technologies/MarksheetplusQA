import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '.env') });
// One id per `playwright test` invocation (set in the runner, inherited by workers): fixtures/payroll.ts caches each
// payroll spec file's throwaway owner under it, so a worker restart after a failure reuses the same tenant.
process.env.QA_PAYROLL_RUN ??= `${Date.now()}`;

const baseURL = process.env.QA_BASE_URL ?? 'https://qa-integration.marksheetplus.com';
const familyURL = process.env.QA_FAMILY_URL ?? 'https://family-integration.marksheetplus.com';
// Local branch-testing stacks use self-signed dev certs.
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
const localWorkers = Math.min(Math.max(Number(process.env.QA_WORKERS ?? 2) || 2, 1), 2);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  // Capped even locally: this suite runs against a SHARED live environment using a
  // single seeded account. Uncapped local workers would hammer it harder than CI.
  workers: process.env.CI ? 2 : localWorkers,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['list'],
  ],
  use: {
    baseURL,
    ignoreHTTPSErrors,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'setup',
      testDir: './fixtures',
      testMatch: /.*\.setup\.ts/,
      // No retries: a failed login is a hard stop. Retrying risks account lockout.
      retries: 0,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'anonymous',
      testDir: './tests/anonymous',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'authenticated',
      testDir: './tests/authenticated',
      // shell-notes and payroll have their own projects (self-seeded tenants, no retries).
      testIgnore: /(shell-notes|payroll)\//,
      use: {
        ...devices['Desktop Chrome'],
        storageState: path.join(__dirname, '.auth', 'user.json'),
      },
      dependencies: ['setup'],
    },
    {
      // PR 543 shell Notes drawer. Desktop + phone, storage probes, bug repros.
      // notes-privacy.spec.ts self-seeds a throwaway two-campus owner (local stack).
      name: 'shell-notes',
      testDir: './tests/authenticated/shell-notes',
      retries: 0,
      timeout: 2 * 60_000,
      use: {
        ...devices['Desktop Chrome'],
        storageState: path.join(__dirname, '.auth', 'user.json'),
      },
      dependencies: ['setup'],
    },
    {
      // PR 544 Generate & Publish Payroll (10 stories). Every spec file self-seeds a throwaway campus
      // owner (local stack only): a tenant has one run per month and only the current month.
      name: 'payroll',
      testDir: './tests/authenticated/payroll',
      retries: 0,
      fullyParallel: false,
      timeout: 3 * 60_000,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'family-setup',
      testDir: './fixtures',
      testMatch: /.*\.family-setup\.ts/,
      retries: 0,
      use: { ...devices['Desktop Chrome'], baseURL: familyURL },
    },
    {
      // Family (parent) app. Specs that also need the admin app use the
      // `adminPage` fixture from fixtures/family.ts.
      name: 'family',
      testDir: './tests/family',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: familyURL,
        storageState: path.join(__dirname, '.auth', 'parent.json'),
      },
      dependencies: ['setup', 'family-setup'],
    },
  ],
});
