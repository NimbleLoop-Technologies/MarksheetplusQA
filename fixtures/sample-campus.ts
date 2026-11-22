/**
 * DEMO-1 (CU-z94x8eebc9, PR 573) sample-campus helpers for the LOCAL branch-testing stack.
 *
 * DEMO-1 adds no UI to create a sample school: ops flips `IsSample` on an existing Mongo `tenants` document
 * (CampusSetup/README.md "Sample schools"). These helpers do exactly that, and ONLY on campuses the spec created.
 * The policy caches "not a sample" for 1 minute per process (API, Worker, AuthApp), so callers wait
 * SAMPLE_CACHE_MS after a flip before asserting any guard.
 */
import { expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { AUTH_APP, REST_API, mongo, type CampusOwner } from './quota';

export const SAMPLE_CACHE_MS = 70_000;
export const SAMPLE_BANNER = 'Sample School: practice data. Nothing here is real and nothing is sent to parents or staff.';
export const INVITES_OFF = 'Invites are turned off in the sample school.';

export function jwtClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

/** Adds one more campus to `owner` through the AuthApp signup flow (subscription/start + campus/create). */
export async function addCampus(owner: CampusOwner, campusName: string): Promise<string> {
  const auth = await owner.authAppSession();
  try {
    const start = await auth.post(`${AUTH_APP}/subscription/start`, { data: { addCampus: true } });
    expect(start.status(), `subscription/start: ${await start.text()}`).toBeLessThan(300);
    const campus = await auth.post(`${AUTH_APP}/campus/create`, {
      data: {
        schoolName: owner.schoolName, campusName, ownerName: 'Quota Owner', phoneNumber: owner.phone, emailAddress: owner.email,
        address: '1 Sample Road', city: 'Lahore', province: 'Punjab', zipCode: null, officialPhoneNumber: null,
        emergencyContactNumber: null, logoBase64: null, logoFileName: null, logoContentType: null, logoUrl: null,
      },
    });
    expect(campus.status(), `campus/create: ${await campus.text()}`).toBeLessThan(300);
    return (await campus.json()).tenantId as string;
  } finally {
    await auth.dispose();
  }
}

/** PRECONDITION WRITE (own campus only): the DEMO-1 ops step, `IsSample: true` on the tenant document. */
export async function flagSample(tenantId: string, value: boolean | null | 'unset' = true) {
  const update = value === 'unset' ? `{ $unset: { IsSample: '' } }` : `{ $set: { IsSample: ${value === null ? 'null' : value} } }`;
  const out = await mongo(`print(db.tenants.updateOne({ _id: ObjectId(${JSON.stringify(tenantId)}) }, ${update}).matchedCount)`);
  expect(out, `tenant ${tenantId} exists`).toBe('1');
}

export async function tenantDoc(tenantId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await mongo(`print(EJSON.stringify(db.tenants.findOne({ _id: ObjectId(${JSON.stringify(tenantId)}) }, { DbInfo: 0 }), {relaxed: true}))`));
}

/** PRECONDITION WRITE (own campus only): a sample school has no subscription; removes the one signup stamped on it. */
export async function deleteSubscriptionOf(tenantId: string) {
  const out = await mongo(`print(db.subscriptions.deleteMany({ TenantId: ${JSON.stringify(tenantId)} }).deletedCount)`);
  expect(Number(out), `subscription of ${tenantId} removed`).toBeGreaterThanOrEqual(1);
}

export interface RestTokens { accessToken: string; refreshToken: string }

/** RestApi HS256 login (persona Campus); returns the raw response so a spec can assert the status. */
export async function restLogin(owner: CampusOwner): Promise<{ status: number; body: any }> {
  const c = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  try {
    const { identifier, password } = owner.credentials();
    const res = await c.post(`${REST_API}/auth/login`, { data: { username: identifier, password, persona: 1 } });
    return { status: res.status(), body: await res.json().catch(() => null) };
  } finally {
    await c.dispose();
  }
}

export async function restSwitchCampus(accessToken: string, tenantId: string): Promise<{ status: number; body: any }> {
  const c = await pwRequest.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  try {
    const res = await c.post(`${REST_API}/auth/switch-campus`, { data: { tenantId } });
    return { status: res.status(), body: await res.json().catch(() => null) };
  } finally {
    await c.dispose();
  }
}

export async function restRefresh(refreshToken: string, tenantId?: string): Promise<{ status: number; body: any }> {
  const c = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  try {
    const res = await c.post(`${REST_API}/auth/refresh-token`, { data: { refreshToken, persona: 1, tenantId: tenantId ?? null } });
    return { status: res.status(), body: await res.json().catch(() => null) };
  } finally {
    await c.dispose();
  }
}

/** A RestApi client for `accessToken` (e.g. a campus-switched token). */
export const apiFor = (accessToken: string): Promise<APIRequestContext> =>
  pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: `${REST_API}/`, extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
