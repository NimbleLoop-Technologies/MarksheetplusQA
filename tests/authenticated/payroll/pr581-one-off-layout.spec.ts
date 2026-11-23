/**
 * PR 581 / ClickUp z94x8eeerp (payroll, cycle 2) — the row panel's "Add a one-off" form.
 * Ticket: "the Incentive and Deduction text is not center-aligned in the Add a One-Off row panel; the buttons overlap with
 * the Reason field" (screenshot only). Product fix @ c7984142: Type RadioGroup Layout Cards → Inline; action row gets mt-4.
 *
 *   AC1 Type is an inline radio group (a visible radio + label, not cards); "Incentive" / "Deduction" text is vertically
 *       centred on its radio, sits to its right, and the options do not overlap.
 *   AC2 Keyboard operable (Tab / Shift+Tab / arrows / Space, no force-clicks); the selection persists after an empty submit
 *       and after a panel rebuild (register search reload); Incentive and Deduction each save with the chosen type (panel
 *       and API figures). A fresh open defaults to Incentive.
 *   AC3 The product has NO edit path for a saved one-off (a saved line only has its "applied" checkbox), so: a failed save
 *       keeps the selected type, and a fresh open after Cancel (or after a save) defaults to Incentive.
 *   AC4 "Add one-off" / "Cancel" do not overlap the Reason field (or its message) or each other; ≥ 8 px gap under Reason;
 *       measured and screenshotted at 1440, 1280, 768, 390 and 360, before and after the empty-submit messages.
 *   AC5 No HTTP 500 from any request the page makes during these flows (watched on every test).
 * Measurements → QA_EVIDENCE_DIR/pr581-measures.json; screenshots → QA_EVIDENCE_DIR/pr581-*.png.
 */
import { expect, test, type Page, type Response } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import * as P from '../../../fixtures/payroll';
import { PayrollRunPage } from '../../../pages/payroll/PayrollRunPage';

const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', '..', 'test-results', 'evidence');
interface Data { nadia: P.Staff; omar: P.Staff; runId: string }
let w: P.World<Data>;
// Merged with the file on load: a failing test restarts the worker, which would otherwise drop earlier widths' numbers.
const MEASURES = path.join(EV, 'pr581-measures.json');
const measures: Record<string, unknown> = existsSync(MEASURES) ? JSON.parse(readFileSync(MEASURES, 'utf8')) : {};

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  w = await P.world<Data>('pr581-one-off', () => newCampusOwner('pay'), async (owner) => {
    await P.publishPolicy(owner.api, {});
    const nadia = await P.addStaff(owner.api, { salary: 30000, designationId: P.DESIGNATION.teacher, incomeTaxPercent: 0, name: P.qaName('Nadia') });
    const omar = await P.addStaff(owner.api, { salary: 40000, designationId: P.DESIGNATION.teacher, incomeTaxPercent: 0, name: P.qaName('Omar') });
    const runId = await P.generateRun(owner.api);
    return { nadia, omar, runId };
  });
});

// ── HTTP 500 watch (AC5): every page this file opens records 5xx responses; each test asserts none at its end. ─────
const fiveXX: string[] = [];
function watch(page: Page) {
  page.on('response', (r: Response) => { if (r.status() >= 500) fiveXX.push(`${r.request().method()} ${r.url()} → ${r.status()}`); });
}
test.beforeEach(() => { fiveXX.length = 0; });
test.afterEach(async () => {
  expect(fiveXX, 'no HTTP 5xx during the test').toEqual([]);
});

async function openForm(browser: import('@playwright/test').Browser, staff: P.Staff, viewport = { width: 1280, height: 800 }) {
  const page = await P.openApp(browser, w, P.runPath(w.data.runId), { viewport });
  watch(page);
  const run = new PayrollRunPage(page);
  await run.expectDraftLoaded();
  await run.openRow(staff.name);
  await run.addOneOffLink().click();
  await expect(run.oneOffField('Reason')).toBeVisible();
  return { page, run };
}

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The radio input's box, its label text's box (the text node's own rect, not the label padding) and the label's chrome. */
async function radioGeometry(page: Page, name: string) {
  const radio = page.locator('[data-row-panel]').getByRole('radio', { name });
  return radio.evaluate((input: HTMLInputElement) => {
    const label = (input.labels && input.labels[0]) || input.closest('label') || document.querySelector(`label[for="${input.id}"]`);
    const r = input.getBoundingClientRect();
    let t: DOMRect | null = null;
    if (label) {
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        if ((n.textContent ?? '').trim()) { const range = document.createRange(); range.selectNodeContents(n); t = range.getBoundingClientRect(); break; }
      }
    }
    const cs = getComputedStyle(input);
    const ls = label ? getComputedStyle(label as Element) : null;
    return {
      radio: { x: r.x, y: r.y, width: r.width, height: r.height },
      radioOpacity: cs.opacity, radioAppearance: cs.appearance,
      text: t ? { x: t.x, y: t.y, width: t.width, height: t.height } : null,
      labelText: label?.textContent?.trim() ?? null,
      labelBorder: ls ? `${ls.borderTopWidth} ${ls.borderTopStyle}` : null,
    };
  });
}

async function check(page: Page, run: PayrollRunPage, tag: string) {
  const inc = await radioGeometry(page, 'Incentive');
  const ded = await radioGeometry(page, 'Deduction');
  const reason = (await run.oneOffField('Reason').boundingBox())!;
  // Everything the Reason field renders under it (an error message), i.e. the field's wrapper.
  const reasonBlock = await run.oneOffField('Reason').evaluate((el) => {
    let host: HTMLElement | null = el.parentElement;
    while (host && !host.querySelector('label') && host.parentElement) host = host.parentElement;
    const r = (host ?? el).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const submit = (await run.oneOffSubmit().boundingBox())!;
  const cancel = (await run.oneOffCancel().boundingBox())!;
  const vw = page.viewportSize()!.width;
  const gaps = { submitBelowReasonInput: submit.y - (reason.y + reason.height), submitBelowReasonBlock: submit.y - (reasonBlock.y + reasonBlock.height), cancelBelowReasonBlock: cancel.y - (reasonBlock.y + reasonBlock.height), submitToCancel: cancel.x - (submit.x + submit.width) };
  const m = { inc, ded, reason, reasonBlock, submit, cancel, viewport: vw, gaps };
  measures[tag] = m;
  mkdirSync(EV, { recursive: true });
  writeFileSync(MEASURES, JSON.stringify(measures, null, 2));
  for (const [n, g] of [['Incentive', inc], ['Deduction', ded]] as const) {
    expect(g.text, `${tag}: ${n} label text`).not.toBeNull();
    // Inline, not cards: the radio itself is drawn (not a 1px sr-only input inside a bordered card).
    expect.soft(g.radio.width, `${tag}: ${n} radio is a visible control (inline layout, not cards)`).toBeGreaterThanOrEqual(10);
    const dc = Math.abs((g.radio.y + g.radio.height / 2) - (g.text!.y + g.text!.height / 2));
    expect.soft(dc, `${tag}: ${n} label centred on its radio (Δ ${dc.toFixed(1)} px)`).toBeLessThanOrEqual(2);
    expect.soft(g.text!.x, `${tag}: ${n} label right of its radio`).toBeGreaterThan(g.radio.x + g.radio.width - 1);
  }
  expect.soft(overlap(inc.text!, ded.radio) || overlap(inc.text!, ded.text!) || overlap(inc.radio, ded.radio), `${tag}: options do not overlap`).toBe(false);
  for (const [n, b] of [['Add one-off', submit], ['Cancel', cancel]] as const) {
    expect.soft(overlap(b, reasonBlock), `${tag}: ${n} does not overlap the Reason field block`).toBe(false);
    expect.soft(b.y - (reason.y + reason.height), `${tag}: ${n} sits below the Reason input with a gap`).toBeGreaterThanOrEqual(8);
    expect.soft(b.x + b.width, `${tag}: ${n} inside the viewport`).toBeLessThanOrEqual(vw + 0.5);
  }
  expect.soft(overlap(submit, cancel), `${tag}: buttons do not overlap each other`).toBe(false);
  return m;
}

test.describe('PR 581 one-off form — layout (AC1, AC4)', () => {
  for (const vp of [
    { w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 768, h: 1024 }, { w: 390, h: 844 }, { w: 360, h: 740 },
  ]) {
    test(`one-off form layout at ${vp.w}px: inline type labels centred, buttons clear of Reason (before and after errors)`, async ({ browser }) => {
      const { page, run } = await openForm(browser, w.data.nadia, { width: vp.w, height: vp.h });
      await run.oneOffSubmit().scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const open = await check(page, run, `${vp.w}-open`);
      if (vp.w >= 640) {
        // Inline group: both options on one row, Deduction after Incentive.
        expect.soft(Math.abs(open.inc.radio.y - open.ded.radio.y), `${vp.w}: Incentive and Deduction on one row`).toBeLessThanOrEqual(2);
        expect.soft(open.ded.radio.x, `${vp.w}: Deduction after Incentive`).toBeGreaterThan(open.inc.text!.x + open.inc.text!.width);
      } else {
        // The shared RadioGroup Inline layout is "space-y-6 sm:flex": below 640 px it stacks by design. Stacked cleanly:
        // Deduction's row starts below Incentive's text, radios left-aligned.
        expect.soft(open.ded.radio.y, `${vp.w}: Deduction stacked below Incentive`).toBeGreaterThan(open.inc.text!.y + open.inc.text!.height);
        expect.soft(Math.abs(open.inc.radio.x - open.ded.radio.x), `${vp.w}: stacked radios left-aligned`).toBeLessThanOrEqual(1);
      }
      const form = run.oneOffField('Reason').locator('xpath=ancestor::form[1]');
      if (vp.w === 1280) {
        const group = run.oneOffType('Incentive').locator('xpath=ancestor::fieldset[1] | ancestor::*[@role="radiogroup"][1]').first();
        writeFileSync(path.join(EV, 'pr581-radiogroup-dom.txt'), await group.evaluate((el) => el.outerHTML).catch((e) => `no fieldset/radiogroup ancestor: ${e}`));
      }
      await form.screenshot({ path: path.join(EV, `pr581-one-off-${vp.w}-open.png`) });
      await page.screenshot({ path: path.join(EV, `pr581-page-${vp.w}-open.png`) });
      // Empty submit: every field shows its message; the buttons must still clear the Reason field's message.
      await run.oneOffSubmit().click();
      await expect(run.panelText('Enter a reason. A one-off without one cannot be explained at year end.')).toBeVisible();
      await page.waitForTimeout(300);
      await check(page, run, `${vp.w}-errors`);
      await form.screenshot({ path: path.join(EV, `pr581-one-off-${vp.w}-errors.png`) });
      // Deduction selected by clicking its label text (a real click, no force).
      await page.locator('[data-row-panel]').getByText('Deduction', { exact: true }).click();
      await expect(run.oneOffType('Deduction')).toBeChecked();
      await expect(run.oneOffType('Incentive')).not.toBeChecked();
      await check(page, run, `${vp.w}-deduction`);
      await form.screenshot({ path: path.join(EV, `pr581-one-off-${vp.w}-deduction.png`) });
      await page.context().close();
    });
  }
});

test.describe('PR 581 one-off form — behaviour (AC2, AC3, AC5)', () => {
  test('fresh open defaults to Incentive; the group is a single tab stop driven by Shift+Tab, arrows and Space (no mouse)', async ({ browser }) => {
    const { page, run } = await openForm(browser, w.data.omar);
    const inc = run.oneOffType('Incentive');
    const ded = run.oneOffType('Deduction');
    await expect(inc).toBeChecked();
    await expect(ded).not.toBeChecked();
    // Into the group from the field after it.
    await run.oneOffField('Label').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(inc, 'Shift+Tab from Label lands on the checked radio').toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(ded).toBeFocused();
    await expect(ded, 'ArrowRight selects Deduction').toBeChecked();
    await expect(inc).not.toBeChecked();
    await page.keyboard.press('ArrowLeft');
    await expect(inc, 'ArrowLeft selects Incentive').toBeChecked();
    await page.keyboard.press('ArrowDown');
    await expect(ded, 'ArrowDown selects Deduction').toBeChecked();
    await page.keyboard.press('Space');
    await expect(ded, 'Space keeps the focused option selected').toBeChecked();
    // One tab stop: Tab leaves the group to Label (does not visit Incentive).
    await page.keyboard.press('Tab');
    await expect(run.oneOffField('Label')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(ded, 'Shift+Tab returns to the selected option (Deduction)').toBeFocused();
    const ring = await ded.evaluate((el) => { const s = getComputedStyle(el); return { outline: `${s.outlineStyle} ${s.outlineWidth}`, boxShadow: s.boxShadow }; });
    writeFileSync(path.join(EV, 'pr581-keyboard-focus-style.json'), JSON.stringify(ring, null, 2));
    await page.locator('[data-row-panel]').screenshot({ path: path.join(EV, 'pr581-keyboard-deduction-focused.png') });
    await page.context().close();
  });

  test('keyboard-only Deduction submit saves with type Deduction (panel "−" line and API figures)', async ({ browser }) => {
    const { page, run } = await openForm(browser, w.data.omar);
    const rowId = (await P.rowFor(w.owner.api, w.data.runId, w.data.omar)).id;
    await run.oneOffField('Label').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('ArrowRight');
    await expect(run.oneOffType('Deduction')).toBeChecked();
    await page.keyboard.press('Tab');
    await page.keyboard.type('Qa Kbd Uniform');
    await page.keyboard.press('Tab');
    await page.keyboard.type('450');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Uniform replacement charged');
    await page.keyboard.press('Tab');
    await expect(run.oneOffSubmit()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(run.oneOffField('Label')).toHaveCount(0, { timeout: 15_000 });
    await expect(run.panelText('Qa Kbd Uniform')).toBeVisible();
    expect(await run.lineAmountText('Qa Kbd Uniform')).toMatch(/^[−-] (PKR|Rs) 450$/);
    const l = (await P.figures(w.owner.api, w.data.runId, rowId)).lines.find((x) => x.label === 'Qa Kbd Uniform');
    expect(l).toMatchObject({ isOneOff: true, type: 'Deduction', amount: 450, reason: 'Uniform replacement charged' });
    await page.context().close();
  });

  test('Deduction stays selected after an empty submit and after an invalid amount', async ({ browser }) => {
    const { page, run } = await openForm(browser, w.data.omar);
    await page.locator('[data-row-panel]').getByText('Deduction', { exact: true }).click();
    await run.oneOffSubmit().click();
    await expect(run.panelText('Enter a label so this line is explainable later.')).toBeVisible();
    await expect(run.panelText('Enter an amount.')).toBeVisible();
    await expect(run.oneOffType('Deduction'), 'after empty submit').toBeChecked();
    await expect(run.oneOffType('Incentive')).not.toBeChecked();
    await run.fillOneOff({ label: 'Qa Persist', amount: '-5', reason: 'Persist check' });
    await run.oneOffSubmit().click();
    await expect(run.panelText('Enter an amount above zero.')).toBeVisible();
    await expect(run.oneOffType('Deduction'), 'after invalid amount').toBeChecked();
    await page.locator('[data-row-panel]').screenshot({ path: path.join(EV, 'pr581-persist-after-invalid.png') });
    // Nothing was posted.
    const rowId = (await P.rowFor(w.owner.api, w.data.runId, w.data.omar)).id;
    expect((await P.figures(w.owner.api, w.data.runId, rowId)).lines.filter((x) => x.label === 'Qa Persist')).toHaveLength(0);
    await page.context().close();
  });

  test('Deduction and typed fields survive a panel rebuild (register search reload while the form is open)', async ({ browser }) => {
    const { page, run } = await openForm(browser, w.data.omar);
    await page.locator('[data-row-panel]').getByText('Deduction', { exact: true }).click();
    await run.fillOneOff({ label: 'Qa Rebuild', amount: '123', reason: 'Rebuild check' });
    // Tag the live form node: if the Table really rebuilds the panel, the new node will not carry the tag.
    await run.oneOffField('Reason').locator('xpath=ancestor::form[1]').evaluate((el) => el.setAttribute('data-qa-before-rebuild', '1'));
    const reload = page.waitForResponse((r) => /\/register\?.*search=/i.test(r.url()), { timeout: 15_000 }).catch(() => null);
    await run.searchFor(w.data.omar.name);
    const res = await reload;
    mkdirSync(EV, { recursive: true });
    writeFileSync(path.join(EV, 'pr581-rebuild-probe.txt'), `register reload while the one-off form was open: ${res ? `${res.status()} ${res.request().method()} ${res.url().replace(/^https?:\/\/[^/]+/, '')}` : 'no register search request seen'}\n`);
    await page.waitForTimeout(800);
    const rebuilt = (await page.locator('[data-qa-before-rebuild]').count()) === 0;
    writeFileSync(path.join(EV, 'pr581-rebuild-probe.txt'), `panel form node replaced by the reload (a real rebuild): ${rebuilt}\n`, { flag: 'a' });
    await expect(run.oneOffField('Label')).toHaveValue('Qa Rebuild');
    await expect(run.oneOffField('Amount (PKR)')).toHaveValue('123');
    await expect(run.oneOffType('Deduction'), 'Deduction after rebuild').toBeChecked();
    await expect(run.oneOffType('Incentive')).not.toBeChecked();
    await page.locator('[data-row-panel]').screenshot({ path: path.join(EV, 'pr581-persist-after-rebuild.png') });
    await run.oneOffCancel().click();
    await page.context().close();
  });

  test('a failed save keeps Deduction and the typed fields; the retry saves as Deduction (AC3 fallback)', async ({ browser }) => {
    const { page, run } = await openForm(browser, w.data.omar);
    const rowId = (await P.rowFor(w.owner.api, w.data.runId, w.data.omar)).id;
    // Simulated network failure of the one-off POST only (no server or DB change).
    await page.route(/\/one-offs$/, (route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue()));
    await page.locator('[data-row-panel]').getByText('Deduction', { exact: true }).click();
    await run.fillOneOff({ label: 'Qa Failed save', amount: '210', reason: 'Network failed first time' });
    await run.oneOffSubmit().click();
    await expect(run.saveFailed).toBeVisible({ timeout: 15_000 });
    await expect(run.oneOffField('Label')).toHaveValue('Qa Failed save');
    await expect(run.oneOffType('Deduction'), 'type kept after a failed save').toBeChecked();
    await page.screenshot({ path: path.join(EV, 'pr581-failed-save-keeps-type.png') });
    await page.unroute(/\/one-offs$/);
    await run.oneOffSubmit().click();
    await expect(run.oneOffField('Label')).toHaveCount(0, { timeout: 15_000 });
    const l = (await P.figures(w.owner.api, w.data.runId, rowId)).lines.filter((x) => x.label === 'Qa Failed save');
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ type: 'Deduction', amount: 210 });
    await page.context().close();
  });

  test('Cancel then reopen, and a reopen after a Deduction save, both default to Incentive with empty fields (AC3 fallback)', async ({ browser }) => {
    const { page, run } = await openForm(browser, w.data.omar);
    await page.locator('[data-row-panel]').getByText('Deduction', { exact: true }).click();
    await run.fillOneOff({ label: 'Qa Cancelled' });
    await run.oneOffCancel().click();
    await expect(run.oneOffField('Label')).toHaveCount(0);
    await run.addOneOffLink().click();
    await expect(run.oneOffType('Incentive'), 'after Cancel').toBeChecked();
    await expect(run.oneOffType('Deduction')).not.toBeChecked();
    await expect(run.oneOffField('Label')).toHaveValue('');
    // Saved one-offs have no edit affordance: the line row only carries its applied checkbox.
    await expect(run.lineCheckbox('Qa Kbd Uniform')).toBeVisible();
    await expect(run.lineRow('Qa Kbd Uniform').getByRole('button')).toHaveCount(0);
    await expect(run.lineRow('Qa Kbd Uniform').getByRole('link')).toHaveCount(0);
    await page.locator('[data-row-panel]').getByText('Deduction', { exact: true }).click();
    await run.fillOneOff({ label: 'Qa Reopen ded', amount: '50', reason: 'Then reopen' });
    await run.oneOffSubmit().click();
    await expect(run.oneOffField('Label')).toHaveCount(0, { timeout: 15_000 });
    await run.addOneOffLink().click();
    await expect(run.oneOffType('Incentive'), 'after a Deduction save').toBeChecked();
    await page.context().close();
  });

  test('an Incentive one-off still saves with the inline type (panel "+" line and API type Incentive)', async ({ browser }) => {
    const { page, run } = await openForm(browser, w.data.nadia);
    const rowId = (await P.rowFor(w.owner.api, w.data.runId, w.data.nadia)).id;
    await expect(run.oneOffType('Incentive')).toBeChecked();
    // Pick Deduction then back to Incentive by clicking the label, so the saved type is the user's choice, not only the default.
    await page.locator('[data-row-panel]').getByText('Deduction', { exact: true }).click();
    await page.locator('[data-row-panel]').getByText('Incentive', { exact: true }).click();
    await run.fillOneOff({ label: 'Qa Exam duty', amount: '1500', reason: 'Invigilation in November' });
    await run.oneOffSubmit().click();
    await expect(run.oneOffField('Label')).toHaveCount(0, { timeout: 15_000 });
    await expect(run.panelText('Qa Exam duty')).toBeVisible();
    expect(await run.lineAmountText('Qa Exam duty')).toMatch(/^\+ (PKR|Rs) 1,500$/);
    const l = (await P.figures(w.owner.api, w.data.runId, rowId)).lines.find((x) => x.label === 'Qa Exam duty');
    expect(l).toMatchObject({ isOneOff: true, type: 'Incentive', amount: 1500, reason: 'Invigilation in November' });
    await page.screenshot({ path: path.join(EV, 'pr581-saved-incentive.png') });
    await page.context().close();
  });

  test('a Deduction one-off still saves with the inline type (Deduction "Qa Broken charger" PKR 700)', async ({ browser }) => {
    const { page, run } = await openForm(browser, w.data.nadia);
    const before = await P.figures(w.owner.api, w.data.runId, (await P.rowFor(w.owner.api, w.data.runId, w.data.nadia)).id);
    await expect(run.oneOffType('Incentive')).toBeChecked();
    await run.fillOneOff({ type: 'Deduction', label: 'Qa Broken charger', amount: '700', reason: 'Lost the staffroom charger' });
    await run.oneOffSubmit().click();
    await expect(run.oneOffField('Label')).toHaveCount(0, { timeout: 15_000 });
    await expect(run.panelText('Qa Broken charger')).toBeVisible();
    expect(await run.lineAmountText('Qa Broken charger')).toMatch(/^[−-] (PKR|Rs) 700$/);
    const after = await P.figures(w.owner.api, w.data.runId, before.rowId);
    const l = after.lines.find((x) => x.label === 'Qa Broken charger');
    expect(l?.isOneOff).toBe(true);
    expect(l?.type).toBe('Deduction');
    expect(l?.amount).toBe(700);
    expect(after.net).toBe((before.net ?? 0) - 700);
    await page.screenshot({ path: path.join(EV, 'pr581-saved.png') });
    await page.context().close();
  });
});
