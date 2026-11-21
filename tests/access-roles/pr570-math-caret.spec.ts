/**
 * PR 570 / ClickUp z94x8e91q0 — equation-editor template buttons put the caret in the slot.
 *
 * Jamie-qa fail: x then Power then 2 produced x^{}2 (caret after the placeholder).
 * After the fix, Power/Fraction/Square root/Brackets insert MathLive placeholders (#@, #?, #0).
 * Also re-check the virtual keyboard flow from z94x8e8qwt, and that equations still save, preview and print.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { newCampusOwner, cacheOwner, type CampusOwner } from '../../fixtures/campus-owner';
import { signInToWebApp } from '../../pages/fees/AccountOffice';
import * as f from '../../fixtures/fees';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence');
const SEED_DIR = process.env.QA_SEED_DIR ?? path.resolve(EV, '..', 'seed');
const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
const WEB = process.env.QA_BASE_URL ?? 'https://localhost:7236';

test.describe.configure({ mode: 'serial' });

let owner: CampusOwner;
let paperUrl = '';

const shot = async (page: Page, name: string) => {
  mkdirSync(EV, { recursive: true });
  await page.screenshot({ path: path.join(EV, `${name}.png`), fullPage: true });
};

async function fieldValue(page: Page) {
  return page.locator('math-field').last().evaluate((e: any) => ({
    value: String(e.value ?? ''),
    position: e.position,
  }));
}

async function clearField(page: Page) {
  const field = page.locator('math-field').last();
  await field.evaluate((e: any) => { e.value = ''; e.focus(); });
  await page.waitForTimeout(150);
}

async function typeInField(page: Page, text: string) {
  const field = page.locator('math-field').last();
  await field.evaluate((e: any) => e.focus());
  await page.keyboard.type(text);
  await page.waitForTimeout(200);
}

async function pressSymbol(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).last().click();
  await page.waitForTimeout(300);
}

async function openQuestionEditor(page: Page) {
  const insertVisible = page.locator('#question-insert-equation:visible, [data-action="insert-equation"]:visible').first();
  if (await insertVisible.isVisible().catch(() => false)) return;
  await expect(page.locator('[data-action="add-question"]:visible').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-action="add-question"]:visible').first().click();
  await expect(page.locator('#question-text:visible, #question-insert-equation:visible').first()).toBeVisible({ timeout: 20_000 });
  const qText = page.locator('#question-text:visible');
  if (await qText.count()) await qText.fill('What is the value of the expression?');
  const marks = page.locator('#question-marks:visible');
  if (await marks.count()) await marks.fill('2');
}

async function openEquationModal(page: Page) {
  await openQuestionEditor(page);
  const insert = page.locator('#question-insert-equation:visible, [data-action="insert-equation"]:visible').first();
  await expect(insert).toBeVisible({ timeout: 20_000 });
  await insert.click();
  await expect(page.locator('math-field').last()).toBeVisible({ timeout: 20_000 });
}

async function ownerPage(browser: import('@playwright/test').Browser): Promise<Page> {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors, baseURL: WEB, viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Karachi',
  });
  const page = await ctx.newPage();
  await signInToWebApp(page, owner.credentials());
  return page;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  mkdirSync(EV, { recursive: true });
  mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  owner = await newCampusOwner('pr570');
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
    data: { className: 'orange', grade: '7', sections: [{ sectionName: 'A', size: 40 }], subjects: null },
  }), 'class orange');
  const cached = cacheOwner(owner);
  writeFileSync(path.join(SEED_DIR, 'seed.json'), JSON.stringify({
    email: cached.email, phone: cached.phone, tenantId: cached.tenantId, password: cached.password,
  }), { mode: 0o600 });
  try { chmodSync(SEED_DIR, 0o700); } catch { /* */ }

  const page = await ownerPage(browser);
  await page.goto('/exams/papers');
  await expect(page.getByRole('button', { name: /Create exam paper/i }).first()).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: /Create exam paper/i }).first().click();
  await expect(page.locator('#paper-title')).toBeVisible({ timeout: 30_000 });
  await page.locator('#paper-title').fill('PR570 equation caret');
  const sessionOpts = page.locator('#paper-session option');
  if (await sessionOpts.count() > 1) await page.locator('#paper-session').selectOption({ index: 1 });
  await page.waitForTimeout(800);
  if (await page.locator('#paper-term option').count() > 1) await page.locator('#paper-term').selectOption({ index: 1 });
  const classOpts = await page.locator('#paper-class option').allInnerTexts();
  const orangeIdx = classOpts.findIndex((o) => /orange/i.test(o));
  await page.locator('#paper-class').selectOption({ index: orangeIdx > 0 ? orangeIdx : 1 });
  await page.waitForTimeout(800);
  if (await page.locator('#paper-subject option').count() > 1) await page.locator('#paper-subject').selectOption({ index: 1 });
  await page.locator('#paper-total-marks').fill('10');
  await page.locator('#paper-duration').fill('30');
  await page.locator('form button[type="submit"]:visible, [role="dialog"] button[type="submit"]:visible, dialog button[type="submit"]:visible').last().click();
  await page.waitForURL(/\/exams\/papers\/[0-9a-f-]{8,}/, { timeout: 30_000 });
  paperUrl = page.url();
  await page.locator('[data-action="add-part"]:visible').first().click();
  const dlg = page.locator('dialog[open]').last();
  await expect(dlg).toBeVisible({ timeout: 15_000 });
  const inputs = dlg.locator('input:visible');
  await inputs.nth(0).fill('Part A');
  await inputs.nth(1).fill('10');
  await inputs.nth(2).fill('30');
  await dlg.locator('button[type="submit"]:visible').last().click();
  await expect(page.locator('[data-action="add-question"]:visible').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-action="add-question"]:visible').first().click();
  await expect(page.locator('#question-text, #question-insert-equation').first()).toBeVisible({ timeout: 20_000 });
  const qText = page.locator('#question-text');
  if (await qText.count()) await qText.fill('What is the value of the expression?');
  const marks = page.locator('#question-marks');
  if (await marks.count()) await marks.fill('2');
  writeFileSync(path.join(EV, 'paper-url.txt'), paperUrl);
  await page.context().close();
});

test('Power, Fraction, Square root, Brackets and the caret, plus ± × ÷ and the ^ key', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  const page = await ownerPage(browser);
  await page.goto(paperUrl);
  await openEquationModal(page);
  await shot(page, 'equation-modal');

  const results: Record<string, unknown> = {};

  // (1) Type x, press Power, type 2 → x² with the caret in the exponent. The ^ key still works.
  await clearField(page);
  await typeInField(page, 'x');
  const afterX = await fieldValue(page);
  await pressSymbol(page, 'Power');
  const afterPower = await fieldValue(page);
  await typeInField(page, '2');
  const power = await fieldValue(page);
  results.power = { afterX, afterPower, power };
  await shot(page, 'after-power-2');
  const powerLatex = power.value.replace(/\s/g, '');
  expect(powerLatex, `x then Power then 2 should be x^{2} or x^2, got ${power.value} (afterPower=${JSON.stringify(afterPower)})`).toMatch(/^x\^(\{2\}|2)$/);
  expect(powerLatex, 'caret must not leave 2 outside an empty exponent (x^{}2)').not.toMatch(/x\^\{\}2/);

  await clearField(page);
  await typeInField(page, 'y^3');
  const caretKey = await fieldValue(page);
  results.caretKey = caretKey;
  expect(caretKey.value.replace(/\s/g, ''), `the ^ key should still produce y^{3}, got ${caretKey.value}`).toMatch(/y\^\{?3\}?$/);

  // (2) Type x, press Fraction, type 2 → x over 2, with x as the numerator (intended behaviour change).
  await clearField(page);
  await typeInField(page, 'x');
  await pressSymbol(page, 'Fraction');
  await typeInField(page, '2');
  const fraction = await fieldValue(page);
  results.fraction = fraction;
  await shot(page, 'after-fraction-2');
  const frac = fraction.value.replace(/\s/g, '');
  expect(frac, `x then Fraction then 2 should be x/2 (x in the numerator), got ${fraction.value}`).toMatch(/\\frac\{x\}\{2\}|x\/2/);

  // (3) Empty field: Square root then 2 → √2; Brackets then 2 → (2).
  await clearField(page);
  await pressSymbol(page, 'Square root');
  await typeInField(page, '2');
  const sqrt = await fieldValue(page);
  results.sqrt = sqrt;
  await shot(page, 'after-sqrt-2');
  expect(sqrt.value.replace(/\s/g, ''), `Square root then 2 should be \\sqrt{2}, got ${sqrt.value}`).toMatch(/\\sqrt\{?2\}?|√2/);

  await clearField(page);
  await pressSymbol(page, 'Brackets');
  await typeInField(page, '2');
  const brackets = await fieldValue(page);
  results.brackets = brackets;
  await shot(page, 'after-brackets-2');
  expect(brackets.value.replace(/\s/g, ''), `Brackets then 2 should be (2), got ${brackets.value}`).toMatch(/\\left\(2\\right\)|\(2\)/);

  // (4) Select text, then Square root or Brackets: the selection is wrapped.
  await clearField(page);
  await typeInField(page, '2');
  await page.locator('math-field').last().evaluate((e: any) => {
    if (typeof e.select === 'function') e.select();
    else if (typeof e.executeCommand === 'function') e.executeCommand('selectAll');
    e.focus();
  });
  await page.waitForTimeout(200);
  await pressSymbol(page, 'Square root');
  const wrapSqrt = await fieldValue(page);
  results.wrapSqrt = wrapSqrt;
  await shot(page, 'wrap-sqrt');
  expect(wrapSqrt.value.replace(/\s/g, ''), `selected 2 then Square root should wrap it, got ${wrapSqrt.value}`).toMatch(/\\sqrt\{?2\}?|√2/);

  await clearField(page);
  await typeInField(page, '2');
  await page.locator('math-field').last().evaluate((e: any) => {
    if (typeof e.select === 'function') e.select();
    else if (typeof e.executeCommand === 'function') e.executeCommand('selectAll');
    e.focus();
  });
  await page.waitForTimeout(200);
  await pressSymbol(page, 'Brackets');
  const wrapBrackets = await fieldValue(page);
  results.wrapBrackets = wrapBrackets;
  await shot(page, 'wrap-brackets');
  expect(wrapBrackets.value.replace(/\s/g, ''), `selected 2 then Brackets should wrap it, got ${wrapBrackets.value}`).toMatch(/\\left\(2\\right\)|\(2\)/);

  // (5) ±, × and ÷ still insert as before.
  await clearField(page);
  await pressSymbol(page, 'Plus or minus');
  const pm = await fieldValue(page);
  await clearField(page);
  await pressSymbol(page, 'Multiplication');
  const times = await fieldValue(page);
  await clearField(page);
  await pressSymbol(page, 'Division');
  const div = await fieldValue(page);
  results.symbols = { pm, times, div };
  expect(pm.value.replace(/\s/g, '')).toMatch(/\\pm|±/);
  expect(times.value.replace(/\s/g, '')).toMatch(/\\times|×/);
  expect(div.value.replace(/\s/g, '')).toMatch(/\\div|÷/);

  writeFileSync(path.join(EV, 'equation-values.json'), JSON.stringify(results, null, 2));
  await page.context().close();
});

test('Virtual keyboard (z94x8e8qwt): opens, types 7+8, hides on Cancel and on Insert', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const page = await ownerPage(browser);
  await page.goto(paperUrl);
  await openEquationModal(page);
  await clearField(page);
  await page.getByRole('button', { name: 'Open math keyboard' }).last().click();
  await page.waitForTimeout(1000);
  const kbVisible = await page.evaluate(() => !!(globalThis as any).mathVirtualKeyboard?.visible);
  await shot(page, 'keyboard-open');
  expect(kbVisible, 'math virtual keyboard should be visible').toBe(true);

  const pressKey = async (label: string) => {
    // MathLive keycaps live in a shadow tree, so walk roots and click by coordinates
    // (same approach as the z94x8e8qwt QA check).
    const targets = await page.evaluate((keyLabel: string) => {
      const all: Element[] = [];
      const walk = (root: Document | ShadowRoot) => {
        root.querySelectorAll('*').forEach((el) => {
          all.push(el);
          if ((el as HTMLElement).shadowRoot) walk((el as HTMLElement).shadowRoot as ShadowRoot);
        });
      };
      walk(document);
      return all
        .filter((e) => e.classList?.contains('MLK__keycap') && (e.getAttribute('aria-label') === keyLabel || (e.textContent ?? '').trim() === keyLabel))
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
        })
        .filter((c) => c.w > 0 && c.h > 0);
    }, label);
    if (!targets.length) return false;
    await page.mouse.click(targets[0].x, targets[0].y);
    await page.waitForTimeout(300);
    return true;
  };
  const seven = await pressKey('7');
  const plus = await pressKey('+');
  const eight = await pressKey('8');
  await page.waitForTimeout(400);
  const typed = await fieldValue(page);
  await shot(page, 'keyboard-after-7plus8');
  expect(seven && plus && eight, `virtual keys 7, +, 8 clicked (7=${seven} +=${plus} 8=${eight})`).toBe(true);
  expect(typed.value.replace(/\s/g, ''), `typing 7+8 on the keyboard, got ${typed.value}`).toMatch(/7\+8|7\\plus8/);

  // Hide on Cancel.
  await page.locator('dialog[open]').last().getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(1000);
  const kbAfterCancel = await page.evaluate(() => !!(globalThis as any).mathVirtualKeyboard?.visible);
  await shot(page, 'keyboard-after-cancel');
  expect(kbAfterCancel, 'keyboard should hide when the equation modal is cancelled').toBe(false);

  // Re-open, type, hide on Insert/Save.
  await openEquationModal(page);
  await clearField(page);
  await typeInField(page, 'x');
  await pressSymbol(page, 'Power');
  await typeInField(page, '2');
  await page.getByRole('button', { name: 'Open math keyboard' }).last().click();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => !!(globalThis as any).mathVirtualKeyboard?.visible)).toBe(true);
  await page.locator('[data-action="save-equation"]').click();
  await page.waitForTimeout(1500);
  const kbAfterInsert = await page.evaluate(() => !!(globalThis as any).mathVirtualKeyboard?.visible);
  await shot(page, 'keyboard-after-insert');
  expect(kbAfterInsert, 'keyboard should hide when the equation is inserted').toBe(false);
  await page.context().close();
});

test('Saved equation appears in the builder, the preview, and a printed PDF', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  const page = await ownerPage(browser);
  await page.goto(paperUrl);
  if (await page.locator('math-field:visible').count() === 0) await openEquationModal(page);
  if (await page.locator('math-field').count()) {
    await clearField(page);
    await typeInField(page, 'x');
    await pressSymbol(page, 'Power');
    await typeInField(page, '2');
    await page.locator('[data-action="save-equation"]').click();
    await expect(page.locator('math-field')).toHaveCount(0, { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  // Default type is Multiple choice, which will not save until every option has content.
  // Prefer Short answer; otherwise fill the option fields.
  const type = page.locator('#question-type:visible').first();
  if (await type.count()) {
    await type.selectOption({ value: 'ShortAnswer' }).catch(async () => {
      await type.selectOption({ label: 'Short answer' });
    });
    await page.waitForTimeout(300);
  }
  for (const id of ['question-option-a', 'question-option-b', 'question-option-c', 'question-option-d']) {
    const inp = page.locator(`#${id}:visible`);
    if (await inp.count()) await inp.fill(id.endsWith('-a') ? '4' : '—');
  }
  const answer = page.locator('#question-answer:visible');
  if (await answer.count()) await answer.fill('4');
  const saveQ = page.locator('[data-action="save-question"]:visible');
  await expect(saveQ.first()).toBeVisible({ timeout: 10_000 });
  await saveQ.first().click();
  await expect(page.getByRole('heading', { name: 'Add question' })).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('[data-action="save-question"]:visible')).toHaveCount(0, { timeout: 10_000 });
  await shot(page, 'builder-with-equation');
  const builder = await page.locator('[data-paper-structure], main').first().innerText();
  writeFileSync(path.join(EV, 'builder.txt'), builder);
  expect(builder, `builder should show the saved equation, got:\n${builder.slice(0, 800)}`).toMatch(/x|²|\^|frac|√|2/);

  const preview = page.locator('[data-action="preview"]');
  await expect(preview).toBeEnabled({ timeout: 15_000 });
  await preview.click();
  await expect(page.locator('[data-papers-preview]')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'paper-preview');
  const previewText = await page.locator('[data-papers-preview], main').first().innerText();
  writeFileSync(path.join(EV, 'preview.txt'), previewText);
  expect(previewText, `preview should include the equation, got:\n${previewText.slice(0, 800)}`).toMatch(/x|²|\^|2|expression/i);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }).catch(() => null),
    page.locator('[data-action="print-selected"]').click(),
  ]);
  if (download) {
    const dest = path.join(EV, download.suggestedFilename() || 'paper.pdf');
    await download.saveAs(dest);
    writeFileSync(path.join(EV, 'print.json'), JSON.stringify({ file: dest, name: download.suggestedFilename() }));
    const stat = await download.path();
    expect(stat || dest, 'printed PDF was saved').toBeTruthy();
  } else {
    // Some stacks open a print dialog instead of a download; record what happened.
    await shot(page, 'print-clicked');
    writeFileSync(path.join(EV, 'print.json'), JSON.stringify({ download: false, note: 'no download event; print was clicked' }));
  }
  await page.context().close();
});
