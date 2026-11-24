/**
 * Helpers for the exam question editor's MathEditor (MathLive) specs: a throwaway campus with a draft paper,
 * a fresh Insert equation modal per check, the toolbar / virtual keyboard / ^ key entry paths, and field reads.
 *
 * The helpers never focus the field before a key is typed after a toolbar or keycap click: the UAT bug
 * (CU-z94x8e91q0, 23 Nov) was that this first keypress was lost because focus left the field.
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

export const FIELD = 'dialog[open] [data-papers-equation] math-field';

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
  await page.locator('#paper-title').fill(`UAT Equation Test ${label}`);
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

/** Open the question drawer (Add question) if it is not open yet. */
export async function openQuestionEditor(page: Page) {
  const insert = page.locator('[data-action="insert-equation"]:visible').first();
  if (await insert.isVisible().catch(() => false)) return;
  await expect(page.locator('[data-action="add-question"]:visible').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-action="add-question"]:visible').first().click();
  await expect(page.locator('#question-text:visible, [data-action="insert-equation"]:visible').first()).toBeVisible({ timeout: 20_000 });
  const qText = page.locator('#question-text:visible');
  if (await qText.count()) await qText.fill('Simplify the expression.');
  const marks = page.locator('#question-marks:visible');
  if (await marks.count()) await marks.fill('2');
}

/** Close any open equation modal (Cancel) and open a fresh one; the field has never had focus from the test. */
export async function openFreshEquation(page: Page) {
  const open = page.locator('dialog[open] [data-papers-equation]');
  if (await open.count()) {
    await page.locator('dialog[open]').filter({ has: page.locator('[data-papers-equation]') }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('dialog[open] [data-papers-equation]')).toHaveCount(0, { timeout: 10_000 });
  }
  await openQuestionEditor(page);
  await page.locator('[data-action="insert-equation"]:visible').first().click();
  await expect(page.locator(FIELD)).toBeVisible({ timeout: 20_000 });
  // MathLive upgrades the element asynchronously; wait until it answers .value.
  await expect.poll(() => page.locator(FIELD).evaluate((e: any) => typeof e.executeCommand === 'function'), { timeout: 20_000 }).toBe(true);
  await page.waitForTimeout(300);
}

export async function fieldState(page: Page) {
  return page.locator(FIELD).evaluate((e: any) => {
    const ae = document.activeElement as HTMLElement | null;
    return {
      value: String(e.value ?? ''),
      position: e.position as number,
      focusInField: ae === e || !!(ae && e.contains(ae)) || (typeof e.hasFocus === 'function' && e.hasFocus()),
      activeElement: ae ? `${ae.tagName.toLowerCase()}${ae.getAttribute('aria-label') ? `[${ae.getAttribute('aria-label')}]` : ''}` : null,
    };
  });
}

export const norm = (s: string) => s.replace(/\s+/g, '');

/** Click the field (a real user click) and type the context text. */
export async function typeContext(page: Page, text: string) {
  if (!text) return;
  await page.locator(FIELD).click();
  await page.waitForTimeout(150);
  await page.keyboard.type(text);
  await page.waitForTimeout(150);
}

export async function clickToolbar(page: Page, name: string) {
  await page.locator('dialog[open] [data-math-toolbar]').getByRole('button', { name, exact: true }).click();
}

export async function keyboardVisible(page: Page) {
  return page.evaluate(() => !!(globalThis as any).mathVirtualKeyboard?.visible);
}

export async function openKeyboard(page: Page) {
  if (await keyboardVisible(page)) return;
  await page.locator('dialog[open] [data-math-toolbar]').getByRole('button', { name: 'Open math keyboard' }).click();
  await expect.poll(() => keyboardVisible(page), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(500);
}

/** Find a visible MathLive keycap (shadow tree) by a predicate over its attributes/text; returns its centre. */
export async function keycapCentre(page: Page, match: { ariaLabel?: RegExp; text?: RegExp; dataAttr?: RegExp }) {
  const spec = { ariaLabel: match.ariaLabel?.source, text: match.text?.source, dataAttr: match.dataAttr?.source };
  return page.evaluate((m) => {
    const all: Element[] = [];
    const walk = (root: Document | ShadowRoot) => root.querySelectorAll('*').forEach((el) => {
      all.push(el);
      if ((el as HTMLElement).shadowRoot) walk((el as HTMLElement).shadowRoot as ShadowRoot);
    });
    walk(document);
    for (const e of all) {
      if (!e.classList?.contains('MLK__keycap')) continue;
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const aria = e.getAttribute('aria-label') ?? '';
      const text = (e.textContent ?? '').trim();
      const data = Array.from(e.attributes).filter((a) => a.name.startsWith('data-')).map((a) => a.value).join(' ');
      if (m.ariaLabel && !new RegExp(m.ariaLabel).test(aria)) continue;
      if (m.text && !new RegExp(m.text).test(text)) continue;
      if (m.dataAttr && !new RegExp(m.dataAttr).test(data)) continue;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return null;
  }, spec);
}

export async function saveEvidence(name: string, data: unknown) {
  mkdirSync(EV, { recursive: true });
  writeFileSync(path.join(EV, name), JSON.stringify(data, null, 2));
}
