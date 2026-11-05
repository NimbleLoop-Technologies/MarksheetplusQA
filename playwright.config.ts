import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

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
      // whatsapp-quota seeds its own campus/operator sessions (project below); it must not need .auth/user.json.
      // attendance-backdating needs the local stack's Postgres and runs serially (project below).
      testIgnore: /(whatsapp-quota|attendance-backdating)\//,
      use: {
        ...devices['Desktop Chrome'],
        storageState: path.join(__dirname, '.auth', 'user.json'),
      },
      dependencies: ['setup'],
    },
    {
      // PR 538 WhatsApp quota. Self-seeding: each spec registers a throwaway owner + campus via the
      // AuthApp/RestApi and signs the back-office operator in from QA_BACKOFFICE_EMAIL/PASSWORD.
      // Local stack only (Mongo preconditions, worker log). Run with --workers=1.
      name: 'whatsapp-quota',
      testDir: './tests/authenticated/whatsapp-quota',
      fullyParallel: false,
      retries: 0,
      timeout: 10 * 60_000,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // PR 548 back-dated attendance. Self-seeding: each file creates a "QA548 <suffix>" class and back-dates its
      // sections in Postgres (QA_PG_*). Local stack only; run inside the PR netns with --workers=1.
      name: 'attendance-backdating',
      testDir: './tests/authenticated/attendance-backdating',
      fullyParallel: false,
      retries: 0,
      timeout: 3 * 60_000,
      use: {
        ...devices['Desktop Chrome'],
        storageState: path.join(__dirname, '.auth', 'user.json'),
      },
      dependencies: ['setup'],
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
