/**
 * PR 579 / ClickUp z94x8e8qw2 — the exam paper "Add part" / "Edit part" drawer gives a missing part name and missing or
 * invalid marks their own message, each under its own field (V2 must-pass; UAT reopen on QA Integration, 23 Nov).
 *
 * UAT (Natasha, Principal at Nobel High School): the error showed only under the wrong field (fixed earlier), but both cases
 * used the same generic text "Enter a part name and valid marks.". Expected: "Enter a part name." for a missing name, and
 * "Enter marks greater than 0." for missing/invalid marks; only the relevant message shows.
 *
 * Covered for BOTH entry paths (Add part on a new paper, Edit part on an existing part):
 *   valid marks + empty name, valid marks + whitespace name, valid name + empty marks, + 0 marks, + negative marks,
 *   both empty (each its own message), fixing one field clears only that field's message, the boundary messages
 *   (121-char name, 10,001 marks) and a valid save. The old generic sentence must never appear.
 * Plus the server: the part endpoint answers 400 (not 500) for an empty name / 0 marks.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { setupPaper, ownerPage, shot, saveEvidence } from './paper-helpers';

const NAME_MSG = 'Enter a part name.';
const MARKS_MSG = 'Enter marks greater than 0.';
const OLD_MSG = 'Enter a part name and valid marks.';

test.describe.configure({ mode: 'serial' });

let paperUrl: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  paperUrl = await setupPaper(browser, 'pr579');
});

function drawer(page: Page): Locator {
  return page.locator('[data-papers-drawer="part"]').last();
}

async function openAdd(page: Page) {
  await page.goto(paperUrl);
  await page.locator('[data-action="add-part"]:visible').first().click();
  await expect(page.locator('#part-name')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
}

async function openEdit(page: Page) {
  await page.goto(paperUrl);
  const edit = page.locator('[data-action="edit-part"]:visible').first();
  await expect(edit).toBeVisible({ timeout: 20_000 });
  await edit.click();
  await expect(page.locator('#part-name')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
}

async function setFields(page: Page, name: string | null, marks: string | null) {
  if (name !== null) await page.locator('#part-name').fill(name);
  if (marks !== null) await page.locator('#part-marks').fill(marks);
}

async function submit(page: Page) {
  await page.locator('[data-action="save-part"]').click();
  await page.waitForTimeout(600);
}

/** The text of the field's wrapper (label + input + message), and its aria-invalid. */
async function fieldInfo(page: Page, id: string) {
  return page.evaluate((fid) => {
    const input = document.getElementById(fid) as HTMLInputElement | null;
    if (!input) return null;
    // Climb to the smallest ancestor that holds the label for this input.
    let host: HTMLElement | null = input.parentElement;
    while (host && !host.querySelector(`label[for="${fid}"]`) && host.parentElement) host = host.parentElement;
    const described = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
      .map((d) => document.getElementById(d)?.textContent?.trim() ?? '').join(' | ');
    return { text: (host?.innerText ?? '').replace(/\s+/g, ' ').trim(), invalid: input.getAttribute('aria-invalid'), described };
  }, id);
}

async function expectMessages(page: Page, label: string, want: { name: string | null; marks: string | null }) {
  const name = await fieldInfo(page, 'part-name');
  const marks = await fieldInfo(page, 'part-marks');
  const all = await drawer(page).innerText();
  await saveEvidence(`pr579-${label}.json`, { want, name, marks });
  await shot(page, `pr579-${label}`);
  expect(all, 'old generic sentence must be gone').not.toContain(OLD_MSG);
  if (want.name) {
    expect(name!.text, 'name field shows its message').toContain(want.name);
    expect(name!.invalid).toBe('true');
  } else {
    expect(name!.text).not.toContain(NAME_MSG);
    expect(name!.invalid === 'true', 'name not invalid').toBe(false);
  }
  if (want.marks) {
    expect(marks!.text, 'marks field shows its message').toContain(want.marks);
    expect(marks!.invalid).toBe('true');
  } else {
    expect(marks!.text).not.toContain(MARKS_MSG);
    expect(marks!.invalid === 'true', 'marks not invalid').toBe(false);
  }
  // Mutually exclusive: the other field's sentence appears nowhere when only one is wrong.
  if (want.name && !want.marks) expect(all).not.toContain(MARKS_MSG);
  if (want.marks && !want.name) expect(all).not.toContain(NAME_MSG);
}

const CASES: { id: string; name: string | null; marks: string | null; want: { name: string | null; marks: string | null } }[] = [
  { id: 'name-empty', name: '', marks: '15', want: { name: NAME_MSG, marks: null } },
  { id: 'name-spaces', name: '   ', marks: '15', want: { name: NAME_MSG, marks: null } },
  { id: 'marks-empty', name: 'Objective', marks: '', want: { name: null, marks: MARKS_MSG } },
  { id: 'marks-zero', name: 'Objective', marks: '0', want: { name: null, marks: MARKS_MSG } },
  { id: 'marks-negative', name: 'Objective', marks: '-5', want: { name: null, marks: MARKS_MSG } },
  { id: 'both-empty', name: '', marks: '', want: { name: NAME_MSG, marks: MARKS_MSG } },
  { id: 'name-too-long', name: 'N'.repeat(121), marks: '15', want: { name: 'Part name must be 120 characters or fewer.', marks: null } },
  { id: 'marks-too-high', name: 'Objective', marks: '10001', want: { name: null, marks: 'Marks must be 10,000 or fewer.' } },
];

for (const path of ['add', 'edit'] as const) {
  test(`${path} part: each invalid case shows only its own message under its own field`, async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const page = await ownerPage(browser);
    for (const c of CASES) {
      await test.step(`${path} / ${c.id}`, async () => {
        if (path === 'add') await openAdd(page); else await openEdit(page);
        await setFields(page, c.name, c.marks);
        await submit(page);
        await expectMessages(page, `${path}-${c.id}`, c.want);
        // Nothing saved: the drawer is still open.
        await expect(page.locator('#part-name')).toBeVisible();
      });
    }
    await page.context().close();
  });

  test(`${path} part: fixing one field clears only that field's message, then the save goes through`, async ({ browser }) => {
    test.setTimeout(4 * 60_000);
    const page = await ownerPage(browser);
    if (path === 'add') await openAdd(page); else await openEdit(page);
    await setFields(page, '', '');
    await submit(page);
    await expectMessages(page, `${path}-fix-0-both`, { name: NAME_MSG, marks: MARKS_MSG });
    await page.locator('#part-name').fill(path === 'add' ? 'Part QA' : 'Part A edited');
    await page.locator('#part-name').blur();
    await page.waitForTimeout(500);
    await expectMessages(page, `${path}-fix-1-name-fixed`, { name: null, marks: MARKS_MSG });
    await page.locator('#part-marks').fill('12');
    await page.locator('#part-marks').blur();
    await page.waitForTimeout(500);
    await expectMessages(page, `${path}-fix-2-both-fixed`, { name: null, marks: null });
    await submit(page);
    await expect(page.getByText(path === 'add' ? 'Paper part added.' : 'Paper part updated.').first()).toBeVisible({ timeout: 15_000 });
    await shot(page, `pr579-${path}-fix-3-saved`);
    await page.context().close();
  });
}

test('server: the part endpoint answers 400 (not 500) for an empty name or 0 marks', async ({ browser }) => {
  const page = await ownerPage(browser);
  const paperId = paperUrl.match(/papers\/([0-9a-f-]{8,})/)![1];
  const results: Record<string, number> = {};
  // Observe the real route from the UI's own save first.
  let route = '';
  page.on('request', (r) => { if (r.method() === 'POST' && /part/i.test(r.url()) && r.url().includes(paperId)) route = r.url(); });
  await openAdd(page);
  await setFields(page, 'Probe', '5');
  await submit(page);
  await expect(page.getByText('Paper part added.').first()).toBeVisible({ timeout: 15_000 });
  expect(route, 'saw the part POST').not.toBe('');
  const token = await page.evaluate(() => {
    for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) {
      const v = s.getItem(s.key(i)!) ?? '';
      const m = v.match(/"access_token"\s*:\s*"([^"]+)"/) ?? v.match(/^(eyJ[\w-]+\.[\w-]+\.[\w-]+)$/);
      if (m) return m[1];
    }
    return null;
  });
  test.skip(!token, 'no bearer token readable from storage');
  for (const [k, body] of Object.entries({
    'empty-name': { name: '', durationMinutes: null, totalMarks: 10, startOnNewPage: false },
    'zero-marks': { name: 'X', durationMinutes: null, totalMarks: 0, startOnNewPage: false },
  })) {
    const r = await page.request.post(route, { data: body, headers: { Authorization: `Bearer ${token}` }, ignoreHTTPSErrors: true });
    results[k] = r.status();
  }
  await saveEvidence('pr579-server-status.json', { route: route.replace(/^https?:\/\/[^/]+/, ''), results });
  for (const s of Object.values(results)) { expect(s).toBeGreaterThanOrEqual(400); expect(s).toBeLessThan(500); }
  await page.context().close();
});
