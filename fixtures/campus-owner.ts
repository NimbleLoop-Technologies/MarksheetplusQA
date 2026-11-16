/**
 * Shared local-stack helpers: register a throwaway campus owner on AuthApp and
 * return a RestApi bearer for it. Used by shell-notes privacy specs. Not the
 * WhatsApp-quota suite (those stay on qa/pr-538 until that PR passes).
 */
import { randomBytes, randomInt } from 'node:crypto';
import { expect, request as pwRequest, type APIRequestContext } from '@playwright/test';


export const AUTH_APP = process.env.QA_AUTH_URL ?? 'https://localhost:7104';
export const REST_API = process.env.QA_REST_API_URL ?? 'https://localhost:7244';
const OTP = process.env.QA_OTP ?? '000000';

const ctx = () => pwRequest.newContext({ ignoreHTTPSErrors: true });

/** Throwaway 03xx mobile in a range reserved for these specs (03{40-49}538xxxx); callers retry on a 409 clash. */
const throwawayMobile = () => `03${randomInt(40, 50)}538${String(randomInt(0, 10_000)).padStart(4, '0')}`;
const randomPassword = () => `Qa!${randomBytes(9).toString('base64url')}9a`;
const letters = (n: number) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[randomInt(26)]).join('');

function jwtClaim(token: string, name: string): string | undefined {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  return payload[name];
}

export interface CampusOwner {
  email: string;
  phone: string;
  userId: string;
  tenantId: string;
  schoolName: string;
  /** RestApi bearer token (persona Campus, tenant claim = the new campus). */
  token: string;
  /** RestApi client with the bearer header set. */
  api: APIRequestContext;
  /** Re-issues the RestApi token (e.g. after an activation so the claims are fresh). */
  refreshToken(): Promise<void>;
  /** Signs this owner into a fresh AuthApp context (cookie), for persona checks against /backoffice. */
  authAppSession(): Promise<APIRequestContext>;
  /** For UI sign-in. A function (not a field) so the password never lands in a printed object. */
  credentials(): { identifier: string; password: string };
}

async function restApiLogin(phone: string, password: string): Promise<string> {
  const c = await ctx();
  try {
    const res = await c.post(`${REST_API}/auth/login`, { data: { username: phone, password, persona: 1 } });
    expect(res.status(), `RestApi /auth/login for ${phone}`).toBe(200);
    return (await res.json()).accessToken as string;
  } finally {
    await c.dispose();
  }
}

/** Registers + verifies a new owner and creates a fresh trial campus. ~2 OTP-limited calls. */
export async function newCampusOwner(label = 'qa'): Promise<CampusOwner> {
  const password = randomPassword();
  let phone = throwawayMobile();
  const email = `${label}-owner+${letters(6)}@testenv.local`;
  const schoolName = `Quota ${letters(5)} School`;
  const auth = await ctx();

  const register = () => auth.post(`${AUTH_APP}/account/register`, {
    data: { firstName: 'Quota', lastName: 'Owner', phoneNumber: phone, email, password, recaptchaToken: null, returnUrl: null },
  });
  let reg = await register();
  // A random number can collide with an earlier run's owner (409 "phone number already exists").
  for (let attempt = 1; reg.status() === 409 && attempt < 3; attempt++) {
    phone = throwawayMobile();
    reg = await register();
  }
  expect(reg.status(), `register ${email}: ${await reg.text()}`).toBeLessThan(300);
  const pendingUserId = (await reg.json()).pendingUserId as string;
  const verify = await auth.post(`${AUTH_APP}/account/verify-email`, { data: { pendingUserId, code: OTP } });
  expect(verify.status(), `verify ${email}: ${await verify.text()}`).toBeLessThan(300);

  const start = await auth.post(`${AUTH_APP}/subscription/start`, { data: { addCampus: true } });
  expect(start.status(), `subscription/start: ${await start.text()}`).toBeLessThan(300);
  const campus = await auth.post(`${AUTH_APP}/campus/create`, {
    data: {
      schoolName, campusName: 'Main', ownerName: 'Quota Owner', phoneNumber: phone, emailAddress: email,
      address: '1 Quota Road', city: 'Lahore', province: 'Punjab', zipCode: null, officialPhoneNumber: null,
      emergencyContactNumber: null, logoBase64: null, logoFileName: null, logoContentType: null, logoUrl: null,
    },
  });
  expect(campus.status(), `campus/create: ${await campus.text()}`).toBeLessThan(300);
  const tenantId = (await campus.json()).tenantId as string;
  await auth.dispose();

  const token = await restApiLogin(phone, password);
  expect(jwtClaim(token, 'tenant')).toBe(tenantId);
  return buildOwner({ email, phone, tenantId, schoolName, token, password });
}

/** Everything needed to rebuild a CampusOwner in a restarted worker. Holds the password: write it only to the gitignored test output (mode 0600). */
export interface CachedOwner {
  email: string;
  phone: string;
  tenantId: string;
  schoolName: string;
  token: string;
  password: string;
}

/** Re-creates a CampusOwner from cacheOwner() output (same token; refreshToken() logs in again). */
export async function ownerFromCache(c: CachedOwner): Promise<CampusOwner> {
  return buildOwner(c);
}

const OWNER_CACHE = new WeakMap<CampusOwner, CachedOwner>();

/** The serialisable form of an owner made by newCampusOwner()/ownerFromCache(). */
export function cacheOwner(owner: CampusOwner): CachedOwner {
  const c = OWNER_CACHE.get(owner);
  if (!c) throw new Error('owner was not created by newCampusOwner');
  return { ...c, token: owner.token };
}

async function buildOwner(c: CachedOwner): Promise<CampusOwner> {
  const { email, phone, tenantId, schoolName, password } = c;
  let token = c.token;
  const owner: CampusOwner = {
    email, phone, tenantId, schoolName, token,
    userId: jwtClaim(token, 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier')!,
    api: await pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: `${REST_API}/`, extraHTTPHeaders: { Authorization: `Bearer ${token}` } }),
    async refreshToken() {
      token = await restApiLogin(phone, password);
      owner.token = token;
      await owner.api.dispose();
      owner.api = await pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: `${REST_API}/`, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    },
    credentials: () => ({ identifier: phone, password }),
    async authAppSession() {
      const c = await ctx();
      const res = await c.post(`${AUTH_APP}/account/login`, { data: { username: phone, password, returnUrl: null } });
      expect(res.status(), 'owner AuthApp login').toBe(200);
      return c;
    },
  };
  OWNER_CACHE.set(owner, { email, phone, tenantId, schoolName, token, password });
  return owner;
}

// ── Back office ──────────────────────────────────────────────────────────────────────────────
