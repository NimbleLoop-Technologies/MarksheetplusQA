/**
 * PR 563 (TailwindUi.Blazor 2026.11.20.45): Family App visual sweep. Screenshots of the parent's main screens for an offline
 * diff against the main build (QA_PR563_BUILD = main | pr), and no Blazor error banner or page error on any of them.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const EVIDENCE = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '../../test-results/pr563');
const BUILD = process.env.QA_PR563_BUILD ?? 'pr';
const ROUTES = ['/dashboard', '/fees', '/exams', '/payments', '/purchases', '/family/management'];

test('PR563-FAMILY-SWEEP: the Family App main screens render without an error banner; screenshots for the offline diff', async ({ page }) => {
  test.setTimeout(4 * 60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors: string[] = [];
  // The stack's self-signed certificate stops the service worker registering; that is the test stack, not the app.
    page.on('pageerror', (e) => { if (!/ServiceWorker/.test(e.message)) errors.push(`${page.url()}: ${e.message}`); });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  for (const route of ROUTES) {
    await page.goto(route);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);
    await expect.soft(page.locator('#blazor-error-ui:visible'), `${route}: Blazor error banner`).toHaveCount(0);
    await page.screenshot({ path: path.join(EVIDENCE, `pr563-${BUILD}-family${route.replace(/\//g, '-')}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(EVIDENCE, `pr563-${BUILD}-family-dashboard-phone.png`), fullPage: true, animations: 'disabled' });
  expect.soft(errors, 'page errors').toEqual([]);
});
