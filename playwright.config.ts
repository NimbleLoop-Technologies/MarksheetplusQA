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
    // PR 571 Copy code uses navigator.clipboard.writeText; granted so "Code copied." can be asserted.
    // Denial is covered in invite-code-drawer (c2): fallback notice, no crash.
    permissions: ['clipboard-read', 'clipboard-write'],
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
      // shell-notes, payroll, ui-migration, whatsapp-quota and whatsapp-receipts have their own projects (quota/receipts self-seed; no .auth/user.json).
      // attendance-backdating and challan-name need the local stack's Postgres and run serially (projects below).
      testIgnore: [/shell-notes\//, /payroll\//, /ui-migration\//, /whatsapp-quota\//, /whatsapp-receipts\//, /attendance-backdating\//, /challan-name\//],
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
      // PR 561 UI migration QA fixes (CU-86ey2erpk): POS tender size, custom subject rows, struck-off profile class.
      // Seeded CI owner; each test makes its own class / student / item. Gated in ci/run-regression.sh (has_feature).
      name: 'ui-migration',
      testDir: './tests/authenticated/ui-migration',
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
      // PR 555 WhatsApp fee receipts. Self-seeding like whatsapp-quota (throwaway owner + campus per file,
      // back-office operator from QA_BACKOFFICE_EMAIL/PASSWORD), plus fee data through the RestApi and psql
      // (fixtures/fees.ts) and the Worker's fee scheduler. Local stack only. Run with --workers=1.
      name: 'whatsapp-receipts',
      testDir: './tests/authenticated/whatsapp-receipts',
      // Live probe: only valid when the worker template name is cleared. Run explicitly with QA_EMPTY_TEMPLATE_PROBE=1.
      testIgnore: /empty-template-probe/,
      fullyParallel: false,
      retries: 0,
      timeout: 15 * 60_000,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // PR 547 (ClickUp z94x8eapp5) challans under family or student name. Self-seeding: each spec file
      // registers its own throwaway owner + trial campus (fixtures/campus-owner.ts) and waits for the
      // Worker's 1-minute challan scheduler. Local stack only (netns qa555, psql). Run with --workers=1.
      name: 'challan-name',
      testDir: './tests/authenticated/challan-name',
      fullyParallel: false,
      retries: 0,
      timeout: 12 * 60_000,
      expect: { timeout: 15_000 },
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
      // PR 557 (ClickUp z94x8ed10y) Payments screen removed; "View coming next cycle" on the Fees cards.
      // Self-seeding: one throwaway campus + a fresh parent linked by invite code; waits for the Worker's
      // challan scheduler and the family fee mirror (mp-familyapp-db via QA_PG_*). Local stack only, --workers=1.
      name: 'family-fees',
      testDir: './tests/family-fees',
      fullyParallel: false,
      retries: 0,
      timeout: 4 * 60_000,
      use: { ...devices['Desktop Chrome'], baseURL: familyURL },
    },
    {
      // PR 558 (ClickUp 86exmwjgc + 86extv6wg) Bookshop Stock Movements log and its CSV export. Self-seeding: one
      // throwaway campus with items, variants and dated movements (API), a second campus for tenant checks, and
      // role stand-ins in Postgres/Mongo for the permission cases. Local stack only (QA_PG_*, QA_MONGOSH), --workers=1.
      // PR 552 (ClickUp 86extv6fx + 86extv6a8) Return / Replace a Sale: return-replace.spec.ts self-seeds two campuses (a fee-account
      // student, custom roles for the permission cases) and skips itself on builds without the feature.
      name: 'bookshop',
      testDir: './tests/bookshop',
      fullyParallel: false,
      retries: 0,
      timeout: 4 * 60_000,
      use: { ...devices['Desktop Chrome'], acceptDownloads: true },
    },
    {
      // PR 479 (ClickUp 86eyjvhn0 + 86eyjvhn2) Family App merged upcoming exams and per-child filter.
      // Self-seeding: two throwaway campuses, two classes, three linked children (plus a one-child family),
      // published datesheets with overlapping and past papers. Local stack only, --workers=1.
      name: 'family-exams',
      testDir: './tests/family-exams',
      fullyParallel: false,
      retries: 0,
      timeout: 4 * 60_000,
      use: { ...devices['Desktop Chrome'], baseURL: familyURL },
    },
    {
      // PR 549 (CU-z94x8ean2x) role assignments to invited staff: Roles tab, role page members / drawer, and the
      // 20261120_BindLegacyStaffAccounts data migration over pre-RBAC members. Self-seeding throwaway campus; re-runs the
      // post-deployment hook (reads the stack's deploy credentials from QA_CI_WORK_DIR). Local stack only, serial.
      name: 'access-roles',
      testDir: './tests/access-roles',
      fullyParallel: false,
      retries: 0,
      timeout: 5 * 60_000,
      use: { ...devices['Desktop Chrome'], timezoneId: 'Asia/Karachi' },
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
