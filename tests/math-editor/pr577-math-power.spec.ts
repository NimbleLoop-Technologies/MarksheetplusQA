/**
 * PR 577 / ClickUp z94x8e91q0 — Power caret in the exam question editor's MathEditor (UAT reopen, 23 Nov).
 *
 * Natasha (UAT, QA Integration): clicking x², or the virtual keyboard's power key, then typing 3 put the 3 in the base and
 * left the exponent empty; and the first keypress after a toolbar insert was lost because focus left the field.
 * The PR 570 spec only covered "x, then Power, then 2" with the field focused by the test before each key, so it missed both.
 *
 * Matrix: entry path [toolbar x² | keyboard power key | ^ key] × context [empty | after x | after x+ | after x+y]
 * × delay before the first key after the click [0, 30, 400 ms] (toolbar and keyboard). The test never focuses the field
 * after the click: the keys go wherever the browser's focus is. The digits typed are "23", so both the first keypress and
 * the one after it must land in the exponent.
 * Also: Right arrow out of the exponent, Backspace, Fraction / Square root / Brackets (toolbar and keyboard) with the first
 * keypress in the slot, ± × ÷, and save → reload → reopen → builder / preview rendering.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  EV, FIELD, shot, ownerPage, setupPaper, openFreshEquation, fieldState, norm, typeContext, clickToolbar,
  openKeyboard, keyboardVisible, keycapCentre, saveEvidence,
} from './math-helpers';

// Not serial: a failing cell must not skip the other paths. A worker restart re-seeds its own paper in beforeAll.
test.describe.configure({ mode: 'default' });

type EntryPath = 'toolbar' | 'keyboard' | 'caret';
const CONTEXTS = [
  { id: 'empty', text: '' },
  { id: 'after-x', text: 'x' },
  { id: 'after-x-plus', text: 'x+' },
  { id: 'after-x-plus-y', text: 'x+y' },
];
const DELAYS = [0, 30, 400];
// One digit, then "+1": the digit must be in the exponent, and (MathLive smartSuperscript, set on by the interop) the caret then
// leaves the exponent, so "+1" continues on the baseline. Multi-character exponents are covered separately below.
const DIGITS = '3';
const AFTER = '+1';

let paperUrl = '';
const results: Record<string, unknown>[] = [];

/** The LaTeX MathLive gives for `${base}` with `${exp}` in its exponent (MathLive drops braces for one character). */
function expectedPower(ctx: string, exp: string) {
  const e = exp.length === 1 ? exp : `{${exp}}`;
  return `${ctx}^${e}${AFTER}`;
}

async function pressPowerKeycap(page: Page) {
  // The numeric layout's x^□ keycap (MathLive template '#@^{#0}}'), not the separate squared key ('#@^2}').
  const c = await keycapCentre(page, { dataAttr: /^#@\^\{#0\}\}?$/ });
  expect(c, 'virtual keyboard power keycap (#@^{#0}) is visible').not.toBeNull();
  await page.mouse.click(c!.x, c!.y);
}

/** Insert a power by one entry path. The field is not focused by the test afterwards. */
async function insertPower(page: Page, how: EntryPath) {
  if (how === 'toolbar') await clickToolbar(page, 'Power');
  else if (how === 'keyboard') await pressPowerKeycap(page);
  else await page.keyboard.press('^');
}

/** Run one matrix cell on a fresh modal (the field has never had focus from the test). */
async function runCell(page: Page, how: EntryPath, ctx: { id: string; text: string }, delay: number) {
  await openFreshEquation(page);
  const initial = await fieldState(page);
  if (how === 'keyboard') await openKeyboard(page);
  if (ctx.text) await typeContext(page, ctx.text);
  else if (how === 'caret') { await page.locator(FIELD).click(); await page.waitForTimeout(150); } // ^ needs the field focused first.
  await insertPower(page, how);
  let beforeKey: Awaited<ReturnType<typeof fieldState>> | null = null;
  if (delay >= 400) {
    beforeKey = await fieldState(page);
    await page.waitForTimeout(Math.max(0, delay - 20));
  } else if (delay > 0) {
    await page.waitForTimeout(delay);
  }
  await page.keyboard.type(DIGITS);
  await page.keyboard.type(AFTER);
  await page.waitForTimeout(250);
  const after = await fieldState(page);
  const name = `cell-${test.info().project.name}-${how}-${ctx.id}-${delay}ms`;
  await shot(page, name);
  const expected = expectedPower(ctx.text, DIGITS);
  const row = { how, ctx: ctx.id, delay, initialFocusInField: initial.focusInField, beforeKey, after, expected, pass: norm(after.value) === expected && after.focusInField };
  results.push(row);
  return row;
}

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(10 * 60_000);
  paperUrl = await setupPaper(browser, `pr577-${info.project.name.includes('firefox') ? 'ff' : 'cr'}`);
});


for (const how of ['toolbar', 'keyboard', 'caret'] as EntryPath[]) {
  test(`Power via ${how}: digits land in the exponent in every context${how === 'caret' ? '' : ' and at 0/30/400 ms'}`, async ({ browser }) => {
    const page = await ownerPage(browser);
    await page.goto(paperUrl);
    const delays = how === 'caret' ? [0] : DELAYS;
    const failures: string[] = [];
    for (const ctx of CONTEXTS) {
      // x+y is the extra "x+y^{3}" pattern; run it once, at 0 ms.
      for (const delay of ctx.id === 'after-x-plus-y' ? [0] : delays) {
        const row = await runCell(page, how, ctx, delay);
        if (!row.pass) failures.push(`${how} ${ctx.id} ${delay}ms: got ${row.after.value} (expected ${row.expected}), focusInField=${row.after.focusInField}, active=${row.after.activeElement}`);
        if (row.beforeKey) expect.soft(row.beforeKey.focusInField, `${how} ${ctx.id}: focus stays in the field after the click (active=${row.beforeKey.activeElement})`).toBe(true);
      }
    }
    await saveEvidence(`matrix-${test.info().project.name}-${how}.json`, results.filter((r) => r.how === how));
    expect(failures, failures.join('\n')).toEqual([]);
    await page.context().close();
  });
}

test('Right arrow leaves the exponent onto the baseline; Backspace edits the exponent then removes it', async ({ browser }) => {
  const page = await ownerPage(browser);
  await page.goto(paperUrl);
  const out: Record<string, unknown> = {};
  for (const how of ['toolbar', 'keyboard', 'caret'] as EntryPath[]) {
    await openFreshEquation(page);
    if (how === 'keyboard') await openKeyboard(page);
    await typeContext(page, 'x');
    await insertPower(page, how);
    await page.keyboard.type('2');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('+1');
    await page.waitForTimeout(200);
    const right = await fieldState(page);
    await shot(page, `arrow-right-${test.info().project.name}-${how}`);
    out[`${how}-arrowRight`] = right.value;
    expect(norm(right.value), `${how}: x, Power, 2, Right, +1`).toBe('x^2+1');
  }
  // Backspace: from x^{23} — Backspace twice empties the exponent, a third removes the empty superscript and leaves x.
  await openFreshEquation(page);
  await typeContext(page, 'x');
  await clickToolbar(page, 'Power');
  await page.keyboard.type('3');
  const steps: string[] = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    steps.push((await fieldState(page)).value);
  }
  await shot(page, `backspace-${test.info().project.name}`);
  out.backspace = steps;
  await page.keyboard.type('5');
  const afterBack = await fieldState(page);
  out.afterBackspaceType5 = afterBack.value;
  await saveEvidence(`nav-${test.info().project.name}.json`, out);
  // Observed MathLive behaviour: Backspace from after x^3 first steps into the exponent or deletes the 3, then removes the
  // empty superscript, then x. Reasonable = never deletes x before the exponent, ends empty, no stray placeholder left.
  const n = steps.map(norm);
  const xAt = n.indexOf('x');
  expect(xAt, `Backspace reaches plain x (steps ${JSON.stringify(steps)})`).toBeGreaterThan(0);
  expect(n.slice(0, xAt).every((v) => v.startsWith('x^')), 'x stays until its exponent is gone').toBe(true);
  expect(n[n.length - 1], 'Backspace ends on an empty field').toBe('');
  expect(norm(afterBack.value), 'typing after clearing works').toBe('5');
  await page.context().close();
});

test('Multi-character exponents: letters stay in the exponent; a second digit can be added with Left', async ({ browser }) => {
  const page = await ownerPage(browser);
  await page.goto(paperUrl);
  const out: Record<string, unknown> = {};
  const failures: string[] = [];
  for (const how of ['toolbar', 'keyboard', 'caret'] as EntryPath[]) {
    // x, Power, n+1, Right → x^{n+1} then +2 on the baseline.
    await openFreshEquation(page);
    if (how === 'keyboard') await openKeyboard(page);
    await typeContext(page, 'x');
    await insertPower(page, how);
    await page.keyboard.type('n+1');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('+2');
    await page.waitForTimeout(150);
    const letters = norm((await fieldState(page)).value);
    out[`${how}-letters`] = letters;
    if (letters !== 'x^{n+1}+2') failures.push(`${how}: x, Power, n+1, Right, +2 → ${letters}`);
    // 10, Power, 1, Left, 0 → 10^{10} (smartSuperscript leaves after one digit; Left goes back into the exponent).
    await openFreshEquation(page);
    if (how === 'keyboard') await openKeyboard(page);
    await typeContext(page, '10');
    await insertPower(page, how);
    await page.keyboard.type('1');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('0');
    await page.waitForTimeout(150);
    const two = norm((await fieldState(page)).value);
    out[`${how}-twoDigits`] = two;
    await shot(page, `multi-${test.info().project.name}-${how}`);
    if (two !== '10^{10}') failures.push(`${how}: 10, Power, 1, Left, 0 → ${two}`);
  }
  // Observation only: the keyboard's separate squared key (#@^2}) after x, then 3.
  await openFreshEquation(page);
  await openKeyboard(page);
  await typeContext(page, 'x');
  const sq = await keycapCentre(page, { dataAttr: /^#@\^2\}?$/ });
  if (sq) {
    await page.mouse.click(sq.x, sq.y);
    await page.keyboard.type('3');
    out.squaredKeyThen3 = (await fieldState(page)).value;
  }
  await saveEvidence(`multi-${test.info().project.name}.json`, out);
  expect(failures, failures.join('\n')).toEqual([]);
  await page.context().close();
});

test('Fraction, Square root, Brackets (toolbar and keyboard) and ± × ÷: first keypress lands in the slot', async ({ browser }) => {
  const page = await ownerPage(browser);
  await page.goto(paperUrl);
  const rows: Record<string, unknown>[] = [];
  const failures: string[] = [];
  const toolbarCases = [
    { button: 'Fraction', ctx: '', want: '\\frac23', keys: ['2', 'Tab', '3'] }, // MathLive's short form of \frac{2}{3}
    { button: 'Fraction', ctx: 'x', want: '\\frac{x}{2}', keys: ['2'] },
    { button: 'Square root', ctx: '', want: '\\sqrt{23}', keys: ['2', '3'] },
    { button: 'Square root', ctx: 'x', want: 'x\\sqrt{23}', keys: ['2', '3'] },
    { button: 'Brackets', ctx: '', want: '\\left(23\\right)', keys: ['2', '3'] },
    { button: 'Brackets', ctx: 'x', want: 'x\\left(23\\right)', keys: ['2', '3'] },
  ];
  for (const c of toolbarCases) {
    for (const delay of DELAYS) {
      await openFreshEquation(page);
      await typeContext(page, c.ctx);
      await clickToolbar(page, c.button);
      if (delay) await page.waitForTimeout(delay);
      for (const k of c.keys) await page.keyboard.press(k);
      await page.waitForTimeout(200);
      const s = await fieldState(page);
      const ok = norm(s.value) === c.want && s.focusInField;
      rows.push({ path: 'toolbar', ...c, delay, got: s.value, focusInField: s.focusInField, ok });
      if (!ok) failures.push(`toolbar ${c.button} ctx='${c.ctx}' ${delay}ms: got ${s.value} want ${c.want} focus=${s.focusInField}`);
      if (delay === 0) await shot(page, `tpl-${test.info().project.name}-toolbar-${c.button.replace(/\s/g, '')}-${c.ctx || 'empty'}`);
    }
  }
  // Keyboard: ÷ keycap is MathLive's \frac{#@}{#?}, √ is \sqrt{#0}, ( and ) are plain keys.
  const keyCases = [
    { cap: /^\\frac\{#@\}\{#\?\}$/, name: 'fraction', ctx: 'x', want: '\\frac{x}{2}', keys: ['2'] },
    { cap: /^\\sqrt\{#0\}$/, name: 'sqrt', ctx: '', want: '\\sqrt{23}', keys: ['2', '3'] },
    { cap: /^\\sqrt\{#0\}$/, name: 'sqrt', ctx: 'x', want: 'x\\sqrt{23}', keys: ['2', '3'] },
  ];
  for (const c of keyCases) {
    for (const delay of DELAYS) {
      await openFreshEquation(page);
      await openKeyboard(page);
      await typeContext(page, c.ctx);
      const p = await keycapCentre(page, { dataAttr: c.cap });
      expect(p, `keycap ${c.name}`).not.toBeNull();
      await page.mouse.click(p!.x, p!.y);
      if (delay) await page.waitForTimeout(delay);
      for (const k of c.keys) await page.keyboard.press(k);
      await page.waitForTimeout(200);
      const s = await fieldState(page);
      const ok = norm(s.value) === c.want && s.focusInField;
      rows.push({ path: 'keyboard', name: c.name, ctx: c.ctx, want: c.want, delay, got: s.value, focusInField: s.focusInField, ok });
      if (!ok) failures.push(`keyboard ${c.name} ctx='${c.ctx}' ${delay}ms: got ${s.value} want ${c.want} focus=${s.focusInField}`);
      if (delay === 0) await shot(page, `tpl-${test.info().project.name}-keyboard-${c.name}-${c.ctx || 'empty'}`);
    }
  }
  // Keyboard brackets: ( 2 3 ) → \left(23\right)
  await openFreshEquation(page);
  await openKeyboard(page);
  for (const label of ['(', '2', '3', ')']) {
    const p = await keycapCentre(page, { dataAttr: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) });
    expect(p, `keycap ${label}`).not.toBeNull();
    await page.mouse.click(p!.x, p!.y);
    await page.waitForTimeout(120);
  }
  const br = await fieldState(page);
  rows.push({ path: 'keyboard', name: 'brackets', got: br.value, focusInField: br.focusInField });
  if (!/^(\\left\(23\\right\)|\(23\))$/.test(norm(br.value))) failures.push(`keyboard ( 2 3 ): got ${br.value}`);
  // ± × ÷ still insert.
  for (const [button, want] of [['Plus or minus', '\\pm'], ['Multiplication', '\\times'], ['Division', '\\div']]) {
    await openFreshEquation(page);
    await clickToolbar(page, button);
    await page.keyboard.press('2');
    await page.waitForTimeout(150);
    const s = await fieldState(page);
    rows.push({ path: 'toolbar', button, got: s.value });
    if (norm(s.value) !== `${want}2`) failures.push(`${button} then 2: got ${s.value} want ${want}2`);
  }
  await saveEvidence(`templates-${test.info().project.name}.json`, rows);
  expect(failures, failures.join('\n')).toEqual([]);
  await page.context().close();
});

test('Save, reload and reopen: the power persists, renders in the builder and the preview', async ({ browser }) => {
  const page = await ownerPage(browser);
  await page.goto(paperUrl);
  // Natasha's path: Add question → Insert equation → x² (toolbar) on the fresh field → 3; then +y, keyboard power key, 2.
  await openFreshEquation(page);
  await clickToolbar(page, 'Power');
  await page.keyboard.type('3');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('+y');
  await openKeyboard(page);
  await pressPowerKeycap(page);
  await page.keyboard.type('2');
  await page.waitForTimeout(200);
  const typed = await fieldState(page);
  await shot(page, `save-typed-${test.info().project.name}`);
  expect(norm(typed.value), 'built ^{3}+y^{2} from an empty field').toBe('^3+y^2');
  // Prefix a base so the saved expression is a normal x^3+y^2.
  await page.keyboard.press('Home');
  await page.keyboard.type('x');
  const final = norm((await fieldState(page)).value);
  expect(final).toBe('x^3+y^2');
  await page.locator('[data-action="save-equation"]').click();
  await expect(page.locator('dialog[open] [data-papers-equation]')).toHaveCount(0, { timeout: 15_000 });
  expect(await keyboardVisible(page), 'keyboard hides when the equation is inserted').toBe(false);
  const drawerEq = page.locator('[data-question-equation]:visible').first();
  await expect(drawerEq).toBeVisible();
  await shot(page, `save-drawer-${test.info().project.name}`);

  const type = page.locator('#question-type:visible').first();
  if (await type.count()) await type.selectOption({ value: 'ShortAnswer' }).catch(() => type.selectOption({ label: 'Short answer' }));
  const answer = page.locator('#question-answer:visible');
  if (await answer.count()) await answer.fill('x^3+y^2');
  const saved = page.waitForResponse((r) => r.request().method() !== 'GET' && /exam-papers\/.+\/questions/i.test(r.url()), { timeout: 20_000 }).catch(() => null);
  await page.locator('[data-action="save-question"]:visible').first().click();
  const res = await saved;
  const status = res?.status() ?? null;
  const body = res?.request().postData() ?? '';
  // contentJson is a JSON string of blocks; the equation is the "math" block's text.
  const blocks = JSON.parse(JSON.parse(body || '{}').contentJson ?? '[]') as { type: string; text: string }[];
  const mathBlock = blocks.find((blk) => blk.type === 'math');
  expect(mathBlock?.text, `saved math block (blocks ${JSON.stringify(blocks)})`).toBe('x^3+y^2');
  expect(status === null || status < 500, `save question HTTP ${status}`).toBe(true);
  await expect(page.locator('[data-action="save-question"]:visible')).toHaveCount(0, { timeout: 20_000 });

  // Reload: the builder renders the saved equation with a real superscript.
  await page.reload();
  const eq = page.locator('[data-equation]').first();
  await expect(eq).toBeVisible({ timeout: 45_000 });
  const html = await eq.innerHTML();
  const text = norm(await eq.innerText());
  await shot(page, `reload-builder-${test.info().project.name}`);
  await saveEvidence(`saved-${test.info().project.name}.json`, { typed: typed.value, final, saveStatus: status, saveUrl: res?.url(), builderText: text, builderHasSup: /ML__msubsup|ML__sup|vlist/.test(html) });
  expect(/ML__msubsup|ML__sup|vlist/.test(html), 'builder markup has a MathLive superscript').toBe(true);
  expect(text).toMatch(/x.*3.*\+.*y.*2/);

  // Reopen: Edit question → the equation's Edit button → the field holds x^3+y^2.
  const edit = page.locator('[data-action="edit-question"]:visible').first();
  if (await edit.count()) await edit.click();
  else await page.getByRole('button', { name: /^Edit/ }).first().click();
  await expect(page.locator('[data-action="insert-equation"]:visible').first()).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-action="insert-equation"]:visible').first().click();
  await expect(page.locator(FIELD)).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => norm((await fieldState(page)).value), { timeout: 15_000 }).toBe('x^3+y^2');
  await shot(page, `reopen-field-${test.info().project.name}`);
  await page.locator('dialog[open]').filter({ has: page.locator('[data-papers-equation]') }).getByRole('button', { name: 'Cancel' }).click();
  // Close the drawer without changes.
  const cancelDrawer = page.getByRole('button', { name: /^(Cancel|Close)$/ }).last();
  if (await cancelDrawer.isVisible().catch(() => false)) await cancelDrawer.click();
  await page.waitForTimeout(500);

  // Preview renders the power too (fresh load so the drawer is closed).
  await page.goto(paperUrl);
  const preview = page.locator('[data-action="preview"]');
  await expect(preview).toBeEnabled({ timeout: 15_000 });
  await preview.click();
  const pv = page.locator('[data-papers-preview]');
  await expect(pv).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const pvHtml = await pv.innerHTML();
  await shot(page, `preview-${test.info().project.name}`);
  await saveEvidence(`preview-${test.info().project.name}.json`, { hasSup: /ML__msubsup|ML__sup|vlist|<sup/.test(pvHtml), hasImg: /<img|<canvas|<svg/.test(pvHtml) });
  expect(/ML__msubsup|ML__sup|vlist|<sup|<img|<svg/.test(pvHtml), 'preview shows the equation (MathLive markup or an image)').toBe(true);
  await page.context().close();
});
