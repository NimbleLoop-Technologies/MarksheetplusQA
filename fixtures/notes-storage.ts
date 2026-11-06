/**
 * PR 543 shell Notes helpers (cycle 2+: server-side notes via GET/POST/PUT/DELETE /notes).
 * RestApi JSON is camelCase (id, content, version, lastUpdated).
 */
import { type Page, expect, request } from '@playwright/test';
import { AUTH_APP, REST_API, newCampusOwner, type CampusOwner } from './campus-owner';

export const NOTES_KEY_PATTERN = /notes/i;
export const NOTES_API = `${REST_API}/notes`;
const ACCESS_TOKEN_KEY = 'mp.access_token';

export interface StoredNote { id: string; content: string; version: number; lastUpdated?: string }

export async function notesKeys(page: Page): Promise<string[]> {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const keys: string[] = [];
    for (const store of [localStorage, sessionStorage]) {
      for (const k of Object.keys(store)) if (re.test(k)) keys.push(k);
    }
    return keys;
  }, NOTES_KEY_PATTERN.source);
}

async function accessToken(page: Page): Promise<string | null> {
  return page.evaluate((key) => sessionStorage.getItem(key), ACCESS_TOKEN_KEY);
}

export async function listServerNotes(page: Page): Promise<StoredNote[]> {
  const token = await accessToken(page);
  expect(token, 'sessionStorage mp.access_token').toBeTruthy();
  const list = await page.request.get(NOTES_API, { headers: { Authorization: `Bearer ${token}` } });
  expect(list.ok(), `GET /notes ${list.status()}`).toBeTruthy();
  return (await list.json()) as StoredNote[];
}

/** Deletes every note for the signed-in user via RestApi. Also clears leftover localStorage notes keys. */
export async function clearNotes(page: Page) {
  await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    for (const k of Object.keys(localStorage)) if (re.test(k)) localStorage.removeItem(k);
  }, NOTES_KEY_PATTERN.source);
  const token = await accessToken(page);
  if (!token) return;
  const headers = { Authorization: `Bearer ${token}` };
  const list = await page.request.get(NOTES_API, { headers });
  if (!list.ok()) return;
  const notes = (await list.json()) as StoredNote[];
  for (const n of notes) {
    const res = await page.request.delete(`${NOTES_API}/${encodeURIComponent(n.id)}?version=${n.version}`, { headers });
    if (!res.ok() && res.status() !== 204) {
      // Conflict: refetch and retry once with current version
      const again = await page.request.get(NOTES_API, { headers });
      const fresh = ((await again.json()) as StoredNote[]).find((x) => x.id === n.id);
      if (fresh) await page.request.delete(`${NOTES_API}/${encodeURIComponent(fresh.id)}?version=${fresh.version}`, { headers });
    }
  }
}

export async function listNotesWithToken(token: string): Promise<{ status: number; body: unknown }> {
  const ctx = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    const res = await ctx.get(NOTES_API, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(async () => await res.text());
    return { status: res.status(), body };
  } finally {
    await ctx.dispose();
  }
}

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
