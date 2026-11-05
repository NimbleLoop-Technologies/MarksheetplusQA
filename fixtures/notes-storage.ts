/**
 * PR 543 shell Notes: browser-storage helpers (no UI, no page objects).
 *
 * The drawer keeps notes in localStorage under `<prefix>:<userId>:<tenantId>`; the prefix is
 * `mp-dashboard-notes:v1` at PR head 4c9e4b69 and may be renamed (review comment), so keys are found by
 * pattern. Each Playwright test has its own browser context, so these only touch the test's own storage.
 */
import { type BrowserContext, type Page, expect } from '@playwright/test';
import { AUTH_APP, newCampusOwner, type CampusOwner } from './quota';

export const NOTES_KEY_PATTERN = /notes/i;

export interface StoredNote { Id: string; Content: string }

/** Must be called on the WebApp origin (after page.goto). Removes every notes key for this browser. */
export async function clearNotes(page: Page) {
  await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    for (const k of Object.keys(localStorage)) if (re.test(k)) localStorage.removeItem(k);
  }, NOTES_KEY_PATTERN.source);
}

export async function notesKeys(page: Page): Promise<string[]> {
  return page.evaluate((src) => Object.keys(localStorage).filter((k) => new RegExp(src, 'i').test(k)), NOTES_KEY_PATTERN.source);
}

/** The single notes key of the signed-in account + campus (fails if there is not exactly one). */
export async function notesKey(page: Page): Promise<string> {
  const keys = await notesKeys(page);
  expect(keys, 'exactly one notes key in localStorage').toHaveLength(1);
  return keys[0];
}

export async function readNotesRaw(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

export async function readNotes(page: Page, key: string): Promise<StoredNote[]> {
  const raw = await readNotesRaw(page, key);
  return raw ? (JSON.parse(raw) as StoredNote[]) : [];
}

export async function writeNotesRaw(page: Page, key: string, value: string) {
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value] as const);
}

/** Counts localStorage.setItem calls on notes keys from now on, in every page of the context. */
export async function trackNotesWrites(context: BrowserContext) {
  await context.addInitScript((src) => {
    const w = window as unknown as { __qaNotesWrites: number };
    w.__qaNotesWrites = 0;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (new RegExp(src, 'i').test(k)) w.__qaNotesWrites++;
      return original.call(this, k, v);
    };
  }, NOTES_KEY_PATTERN.source);
}

export async function notesWriteCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __qaNotesWrites?: number }).__qaNotesWrites ?? 0);
}

export async function resetNotesWriteCount(page: Page) {
  await page.evaluate(() => { (window as unknown as { __qaNotesWrites: number }).__qaNotesWrites = 0; });
}

const FILLER_KEY = '__qa543_quota_filler';

/** Fills localStorage with a filler value so only about `leaveFree` characters remain. Undo with releaseStorage(). */
export async function fillStorage(page: Page, leaveFree: number) {
  await page.evaluate(([key, free]) => {
    localStorage.removeItem(key);
    let lo = 0;
    let hi = 12_000_000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      try { localStorage.setItem(key, 'x'.repeat(mid)); lo = mid; } catch { hi = mid - 1; }
    }
    localStorage.setItem(key, 'x'.repeat(Math.max(0, lo - free)));
  }, [FILLER_KEY, leaveFree] as const);
}

export async function releaseStorage(page: Page) {
  await page.evaluate((key) => localStorage.removeItem(key), FILLER_KEY);
}

/**
 * A throwaway owner ("Quota Owner", email qa543-owner+…) with TWO campuses: "Main" (from newCampusOwner())
 * plus "North", added through the same AuthApp session. ~3 OTP-limited calls.
 */
export async function newTwoCampusOwner(): Promise<CampusOwner & { secondCampusName: string }> {
  const owner = await newCampusOwner('qa543');
  const auth = await owner.authAppSession();
  try {
    const start = await auth.post(`${AUTH_APP}/subscription/start`, { data: { addCampus: true } });
    expect(start.status(), `subscription/start (2nd campus): ${await start.text()}`).toBeLessThan(300);
    const campus = await auth.post(`${AUTH_APP}/campus/create`, {
      data: {
        schoolName: owner.schoolName, campusName: 'North', ownerName: 'Quota Owner', phoneNumber: owner.phone, emailAddress: owner.email,
        address: '2 Quota Road', city: 'Lahore', province: 'Punjab', zipCode: null, officialPhoneNumber: null,
        emergencyContactNumber: null, logoBase64: null, logoFileName: null, logoContentType: null, logoUrl: null,
      },
    });
    expect(campus.status(), `campus/create (2nd campus): ${await campus.text()}`).toBeLessThan(300);
  } finally {
    await auth.dispose();
  }
  return Object.assign(owner, { secondCampusName: 'North' });
}

