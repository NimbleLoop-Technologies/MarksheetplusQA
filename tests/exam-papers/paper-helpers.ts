/**
 * Helpers for the exam paper builder specs: a throwaway campus owner with a session, a class and a draft paper with one part.
 */
import { expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { newCampusOwner, cacheOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { signInToWebApp } from '../../pages/fees/AccountOffice';
import * as f from '../../fixtures/fees';

export const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.resolve(EV, '..', 'seed');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
const WEB = process.env.QA_BASE_URL ?? 'https://localhost:7236';

let owner: CampusOwner;


export async function shot(page: Page, name: string) {
  mkdirSync(EV, { recursive: true });
  await page.screenshot({ path: path.join(EV, `${name}.png`) });
}

export async function ownerPage(browser: Browser, extra: Parameters<Browser['newContext']>[0] = {}): Promise<Page> {
  const ctx = await browser.newContext({ ...extra, ignoreHTTPSErrors, baseURL: WEB, viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Karachi' });
  const page = await ctx.newPage();
  await signInToWebApp(page, owner.credentials());
  return page;
}

/** Throwaway owner + session + class + a draft paper with one part. Returns the paper URL. */
export async function setupPaper(browser: Browser, label: string): Promise<string> {
  mkdirSync(EV, { recursive: true });
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  owner = await newCampusOwner(label);
  await f.ok(await owner.api.post('sessions/create', {
    data: {
      sessionName: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30',
      terms: [
        { termName: 'Term 1', termStartDate: '2026-09-01', termEndDate: '2026-12-31', passingCriteria: 40 },
        { termName: 'Term 2', termStartDate: '2027-01-01', termEndDate: '2027-06-30', passingCriteria: 40 },
      ],
    },
  }), 'sessions/create');
  await f.ok(await owner.api.post('classes/create', {
    data: { className: 'One', grade: '1', sections: [{ sectionName: 'A', size: 40 }], subjects: null },
  }), 'class One');
  const cached = cacheOwner(owner);
  writeFileSync(path.join(SEED_DIR, `seed-${label}.json`), JSON.stringify({
    email: cached.email, phone: cached.phone, tenantId: cached.tenantId, password: cached.password,
  }), { mode: 0o600 });
  try { chmodSync(SEED_DIR, 0o700); } catch { /* */ }

  const page = await ownerPage(browser);
  await page.goto('/exams/papers');
  await expect(page.getByRole('button', { name: /Create exam paper/i }).first()).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: /Create exam paper/i }).first().click();
  await expect(page.locator('#paper-title')).toBeVisible({ timeout: 30_000 });
  await page.locator('#paper-title').fill(`QA Parts Test ${label}`);
  if (await page.locator('#paper-session option').count() > 1) await page.locator('#paper-session').selectOption({ index: 1 });
  await page.waitForTimeout(800);
  if (await page.locator('#paper-term option').count() > 1) await page.locator('#paper-term').selectOption({ index: 1 });
  const classOpts = await page.locator('#paper-class option').allInnerTexts();
  const idx = classOpts.findIndex((o) => /One/.test(o));
  await page.locator('#paper-class').selectOption({ index: idx > 0 ? idx : 1 });
  await page.waitForTimeout(800);
  if (await page.locator('#paper-subject option').count() > 1) await page.locator('#paper-subject').selectOption({ index: 1 });
  await page.locator('#paper-total-marks').fill('10');
  await page.locator('#paper-duration').fill('30');
  await page.locator('form button[type="submit"]:visible, [role="dialog"] button[type="submit"]:visible, dialog button[type="submit"]:visible').last().click();
  await page.waitForURL(/\/exams\/papers\/[0-9a-f-]{8,}/, { timeout: 30_000 });
  const paperUrl = page.url();
  await page.locator('[data-action="add-part"]:visible').first().click();
  const dlg = page.locator('dialog[open]').last();
  await expect(dlg).toBeVisible({ timeout: 15_000 });
  const inputs = dlg.locator('input:visible');
  await inputs.nth(0).fill('Part A');
  await inputs.nth(1).fill('10');
  await inputs.nth(2).fill('30');
  await dlg.locator('button[type="submit"]:visible').last().click();
  await expect(page.locator('[data-action="add-question"]:visible').first()).toBeVisible({ timeout: 15_000 });
  writeFileSync(path.join(EV, `paper-url-${label}.txt`), paperUrl);
  await page.context().close();
  return paperUrl;
}

export async function saveEvidence(name: string, data: unknown) {
  mkdirSync(EV, { recursive: true });
  writeFileSync(path.join(EV, name), JSON.stringify(data, null, 2));
}
