/**
 * PR 561 (CU-86ey2erpk UI migration QA fixes) helpers: seeded-owner RestApi client plus throwaway classes,
 * students and bookshop items. Local stack only (CI owner from ci/qa-data/accounts.env).
 */
import { randomInt, randomUUID } from 'node:crypto';
import { expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { openPosDay } from './pos-day';

export const REST_API = process.env.QA_REST_API_URL ?? 'https://localhost:7244';
export const letters = (n: number) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[randomInt(26)]).join('');
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export async function ownerApi(): Promise<APIRequestContext> {
  const username = process.env.QA_EMAIL;
  const password = process.env.QA_PASSWORD;
  if (!username || !password) throw new Error('QA_EMAIL / QA_PASSWORD missing');
  const login = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  const res = await login.post(`${REST_API}/auth/login`, { data: { username, password, persona: 1 } });
  expect(res.status(), 'RestApi /auth/login (seeded owner)').toBe(200);
  const token = (await res.json()).accessToken as string;
  await login.dispose();
  return pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: `${REST_API}/`, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

export interface SeededClass { id: string; name: string; grade: string; sectionId: string }

/** A class with one section A. The server stores names lower-cased. */
export async function createClass(api: APIRequestContext, grade = '8', subjects: string[] | null = null): Promise<SeededClass> {
  const name = `Qa561 ${title(letters(6))}`;
  const created = await api.post('classes/create', { data: { className: name, grade, sections: [{ sectionName: 'A', size: 40 }], subjects } });
  expect(created.status(), `create class ${name}: ${await created.text()}`).toBe(201);
  const id = (await created.json()).id as string;
  const sections = (await (await api.get('attendance-register/sections')).json()) as Array<{ sectionId: string; classId: string }>;
  const s = sections.find((x) => x.classId === id);
  expect(s, `section of ${name}`).toBeTruthy();
  return { id, name, grade, sectionId: s!.sectionId };
}

const pupilMobile = () => `03${randomInt(10, 40)}561${String(randomInt(0, 10_000)).padStart(4, '0')}`;

export async function quickAddStudent(api: APIRequestContext, classId: string): Promise<{ id: string; fullName: string; admissionId: string }> {
  const fullName = `${title(letters(6))} ${title(letters(5))}`;
  const admissionId = `Q561${letters(4).toUpperCase()}`;
  const res = await api.post('students/quick-add', {
    data: { fullName, admissionId, fatherName: 'Qa Father', mobileNumber: pupilMobile(), classId, admissionDate: new Date().toISOString().slice(0, 10), dateOfBirth: '2014-02-02T00:00:00Z', gender: 0 },
  });
  expect(res.status(), `quick-add ${fullName}: ${await res.text()}`).toBe(201);
  return { id: (await res.json()).id as string, fullName, admissionId };
}

export async function strikeOff(api: APIRequestContext, studentId: string, reason = 'Left School'): Promise<void> {
  const res = await api.post(`students/${studentId}/struck-off`, { data: { reason, comments: 'QA PR 561' } });
  expect(res.status(), `strike off ${studentId}: ${await res.text()}`).toBe(200);
}

export async function profile(api: APIRequestContext, studentId: string): Promise<any> {
  const res = await api.get(`students/${studentId}/profile`);
  expect(res.status(), `GET profile ${studentId}`).toBe(200);
  return res.json();
}

export async function subjectsView(api: APIRequestContext, classId: string): Promise<Array<{ name: string; isLinked: boolean }>> {
  const res = await api.get(`classes/${classId}/subjects/view`);
  expect(res.status(), `GET subjects of ${classId}`).toBe(200);
  return (await res.json()).subjects;
}

/** A stocked bookshop item, and today's POS day open (idempotent). */
export async function stockedItem(api: APIRequestContext, price = 300): Promise<{ id: string; name: string; sku: string }> {
  const name = `Qa561 Pencil ${letters(5)}`;
  const sku = `Q561-${letters(6).toUpperCase()}`;
  const res = await api.post('bookshop/inventory', {
    data: { itemName: name, sku, category: 'Stationery', description: null, openingStock: 100, reorderLevel: 0, costPrice: 100, retailPrice: price, hasVariants: false, options: [], variants: [] },
  });
  expect(res.status(), `create item ${name}: ${await res.text()}`).toBeLessThan(300);
  const body = await res.json();
  const day = await openPosDay(api, 0);
  expect(day.status(), `open POS day: ${await day.text()}`).toBeLessThan(500);
  return { id: (body.item ?? body).id, name, sku };
}

export const newClientSaleId = () => randomUUID();
