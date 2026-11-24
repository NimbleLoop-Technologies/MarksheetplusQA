/**
 * DEMO-1 (CU-z94x8eebc9, PR 573 cycle 3 @ c3ae71a7): the AuthApp OIDC side of the sample-campus subscription gate,
 * and #576 logout (now on main, merged into the PR) when the active campus is a sample.
 *
 *   S1 / AC6  /connect/authorize lets a sample with NO subscription straight in (is_sample claim, no subscription claims),
 *             and the OIDC refresh_token grant re-runs the gate on the CURRENT default campus:
 *             sample → 200 + is_sample; real trial → 200 without is_sample; real campus with no plan → rejected.
 *   S5        Logging out while the sample is active revokes the school refresh token, clears the browser tokens and
 *             "Return to home" shows the login form (no silent sign-in). Signing straight back into the owner's REAL
 *             campus works (no banner), and logging out there revokes too.
 *
 * Self-seeding: one owner (beforeAll) with R (real trial), S (sample) and N (real, no plan).
 * DB PRECONDITIONS on these campuses only, the same as demo1-sample-guards-api.spec.ts:
 *   - S and N: the signup subscription is deleted (a sample school has none; N is the real no-plan control);
 *   - S: Mongo `tenants.IsSample = true`, then wait out the policy's 1-minute "not a sample" cache.
 * The default campus is moved with the RestApi /auth/switch-campus (it persists the default), never in the DB.
 */
import { test, expect, request as pwRequest, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { evidencePath, newCampusOwner, WEBAPP, AUTH_APP, type CampusOwner } from '../../fixtures/quota';
import { LoginPage } from '../../pages/LoginPage';
import {
  SAMPLE_BANNER, SAMPLE_CACHE_MS, addCampus, deleteSubscriptionOf, flagSample, jwtClaims, restLogin, restSwitchCampus,
} from '../../fixtures/sample-campus';

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: WEBAPP, ignoreHTTPSErrors: true });

const ACCESS_KEY = 'mp.access_token';
const REFRESH_KEY = 'mp.refresh_token';
const WEB_CLIENT = 'marksheet-webapp';

let A: CampusOwner;
let R: string;
let S: string;
let N: string;

const notice = (page: Page) => page.locator('[data-sample-campus-notice]');

function writeEvidence(name: string, data: unknown) {
  if (process.env.QA_EVIDENCE_DIR) mkdirSync(process.env.QA_EVIDENCE_DIR, { recursive: true });
  writeFileSync(evidencePath(name), JSON.stringify(data, null, 2));
}

/** Claims that matter here only — never the token itself. */
const gateClaims = (token: string) => {
  const c = jwtClaims(token);
  return { tenant: c.tenant, is_sample: c.is_sample ?? null, subscription_status: c.subscription_status ?? null, read_only: c.read_only ?? c.subscription_read_only ?? null };
};

function unwrap(raw: string | null): string | null {
  if (raw == null || raw === '') return null;
  try { const p = JSON.parse(raw); if (typeof p === 'string') return p; } catch { /* raw string */ }
  return raw;
}

async function browserTokens(page: Page) {
  return page.evaluate(([a, r]) => ({ access: sessionStorage.getItem(a), refresh: localStorage.getItem(r) }), [ACCESS_KEY, REFRESH_KEY])
    .then((t) => ({ access: unwrap(t.access), refresh: unwrap(t.refresh) }));
}

/** OIDC refresh_token grant against the AuthApp, as the WebApp does it. Returns status + the new tokens (kept in memory only). */
async function oidcRefresh(refreshToken: string) {
  const ctx = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  try {
    const res = await ctx.post(`${AUTH_APP}/connect/token`, { form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: WEB_CLIENT } });
    const json = await res.json().catch(() => ({} as any));
    return { status: res.status(), error: (json.error ?? null) as string | null, access: (json.access_token ?? null) as string | null, refresh: (json.refresh_token ?? null) as string | null };
  } finally {
    await ctx.dispose();
  }
}

/** Persists `tenantId` as A's default campus via the RestApi SwitchCampus (the next sign-in / OIDC refresh uses it). */
async function makeDefault(tenantId: string) {
  const login = await restLogin(A);
  expect(login.status).toBe(200);
  const sw = await restSwitchCampus(login.body.accessToken, tenantId);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
}

async function freshPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: WEBAPP, ignoreHTTPSErrors: true, timezoneId: 'Asia/Karachi' });
  return ctx.newPage();
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.waitForURL(/\/auth\/login/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible({ timeout: 60_000 });
  const { identifier, password } = A.credentials();
  await new LoginPage(page).signIn(identifier, password);
  await page.waitForURL((u) => u.origin === new URL(WEBAPP).origin && !u.pathname.startsWith('/authentication') && !u.pathname.startsWith('/auth/'), { timeout: 60_000 });
  await expect(page.locator('[data-shell-user-menu]').first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await browserTokens(page)).refresh, { timeout: 30_000 }).toBeTruthy();
}

async function logout(page: Page) {
  await page.locator('[data-shell-user-menu]').first().click();
  await page.locator('el-menu [data-shell-logout]').click();
  await expect(page.locator('[data-oidc-signed-out]')).toBeVisible({ timeout: 45_000 });
}

test.beforeAll(async () => {
  test.setTimeout(6 * 60_000);
  A = await newCampusOwner('qa573o');
  R = A.tenantId;
  S = await addCampus(A, 'Sample');
  N = await addCampus(A, 'Noplan');
  console.log(`[DB SETUP] owner ${A.email}: R=${R} (real trial), S=${S} (sample), N=${N} (real, no plan)`);
  console.log('[DB SETUP] S and N: delete the signup subscription; S: tenants.IsSample = true');
  await deleteSubscriptionOf(S);
  await deleteSubscriptionOf(N);
  await flagSample(S);
  await new Promise((r) => setTimeout(r, SAMPLE_CACHE_MS));
});

test.afterAll(async () => {
  await A?.api.dispose();
});

test('S1 / AC6: /connect/authorize lets a no-plan sample in; the OIDC refresh grant re-runs the gate on the current default campus', async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  await makeDefault(S);
  const page = await freshPage(browser);
  await signIn(page);
  await expect(notice(page)).toHaveText(SAMPLE_BANNER, { timeout: 60_000 });
  const { access, refresh } = await browserTokens(page);
  expect(access && refresh, 'browser holds OIDC tokens').toBeTruthy();
  const authorizeClaims = gateClaims(access!);
  expect(authorizeClaims).toMatchObject({ tenant: S, is_sample: 'true', subscription_status: null });
  await page.screenshot({ path: evidencePath('pr573-c3-s1-authorize-sample-banner.png') });
  // The browser's refresh token is redeemed below (refresh tokens roll), so this browser is closed first.
  await page.context().close();

  // 1) Sample still the default → 200, is_sample, no subscription claims.
  const onSample = await oidcRefresh(refresh!);
  expect(onSample.status, `sample refresh: ${onSample.error}`).toBe(200);
  const sampleClaims = gateClaims(onSample.access!);
  expect(sampleClaims).toMatchObject({ tenant: S, is_sample: 'true', subscription_status: null });

  // 2) Default moved to the REAL trial campus → 200, no is_sample, trial claims back.
  await makeDefault(R);
  const onReal = await oidcRefresh(onSample.refresh!);
  expect(onReal.status, `real refresh: ${onReal.error}`).toBe(200);
  const realClaims = gateClaims(onReal.access!);
  expect(realClaims.tenant).toBe(R);
  expect(realClaims.is_sample).toBeNull();
  expect(realClaims.subscription_status).toBe('trialing');

  // 3) Control: default moved to the REAL campus with no plan → the gate blocks the refresh (no token issued).
  await makeDefault(N);
  const onNoPlan = await oidcRefresh(onReal.refresh!);
  expect(onNoPlan.access, 'no access token for a real campus with no plan').toBeNull();
  expect(onNoPlan.status, `no-plan refresh: ${onNoPlan.error}`).toBeGreaterThanOrEqual(400);
  expect(onNoPlan.status).toBeLessThan(500);

  writeEvidence('pr573-c3-s1-oidc-refresh-gate.json', {
    authorize: authorizeClaims,
    refreshWithDefaultSample: { status: onSample.status, claims: sampleClaims },
    refreshWithDefaultRealTrial: { status: onReal.status, claims: realClaims },
    refreshWithDefaultRealNoPlan: { status: onNoPlan.status, error: onNoPlan.error, accessIssued: Boolean(onNoPlan.access) },
  });
});

test('S5: logging out of a sample campus revokes the refresh token and shows the login form; the real campus signs in and logs out normally', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  await makeDefault(S);
  const page = await freshPage(browser);
  const connectLogout: string[] = [];
  page.on('request', (req) => { try { const u = new URL(req.url()); if (u.pathname === '/connect/logout') connectLogout.push(u.origin); } catch { /* ignore */ } });

  await signIn(page);
  await expect(notice(page)).toHaveText(SAMPLE_BANNER, { timeout: 60_000 });
  const sampleBefore = await browserTokens(page);
  expect(gateClaims(sampleBefore.access!)).toMatchObject({ tenant: S, is_sample: 'true' });
  await page.screenshot({ path: evidencePath('pr573-c3-s5-sample-before-logout.png') });

  await logout(page);
  await page.screenshot({ path: evidencePath('pr573-c3-s5-sample-signed-out.png') });
  expect(connectLogout.length, 'the app went through /connect/logout').toBeGreaterThan(0);
  const sampleAfter = await browserTokens(page);
  expect(sampleAfter.access, 'access token cleared').toBeNull();
  expect(sampleAfter.refresh, 'refresh token cleared').toBeNull();
  const revokedSample = await oidcRefresh(sampleBefore.refresh!);
  expect(revokedSample.status, 'sample refresh token revoked at logout').toBe(400);
  expect(revokedSample.error).toBe('invalid_grant');
  expect(revokedSample.access).toBeNull();

  await page.locator('[data-action="return-home"]').click();
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-shell-user-menu]')).toHaveCount(0);
  await expect(notice(page)).toHaveCount(0);
  await page.screenshot({ path: evidencePath('pr573-c3-s5-return-home-login-form.png') });

  // Real campus, same browser: signs in normally, no banner, and its own logout revokes as well.
  await makeDefault(R);
  const { identifier, password } = A.credentials();
  await new LoginPage(page).signIn(identifier, password);
  await page.waitForURL((u) => u.origin === new URL(WEBAPP).origin && !u.pathname.startsWith('/authentication') && !u.pathname.startsWith('/auth/'), { timeout: 60_000 });
  await expect(page.locator('[data-shell-user-menu]').first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await browserTokens(page)).refresh, { timeout: 30_000 }).toBeTruthy();
  const realBefore = await browserTokens(page);
  const realClaims = gateClaims(realBefore.access!);
  expect(realClaims.tenant).toBe(R);
  expect(realClaims.is_sample).toBeNull();
  await page.waitForTimeout(2_000);
  await expect(notice(page)).toHaveCount(0);
  await page.screenshot({ path: evidencePath('pr573-c3-s5-real-after-sample-logout.png') });

  await logout(page);
  const revokedReal = await oidcRefresh(realBefore.refresh!);
  expect(revokedReal.status, 'real campus refresh token revoked at logout').toBe(400);
  expect(revokedReal.error).toBe('invalid_grant');

  writeEvidence('pr573-c3-s5-logout-sample-and-real.json', {
    connectLogoutCalls: connectLogout.length,
    sample: { claimsBefore: gateClaims(sampleBefore.access!), browserTokensCleared: sampleAfter.access === null && sampleAfter.refresh === null, refreshAfterLogout: { status: revokedSample.status, error: revokedSample.error } },
    real: { claimsBefore: realClaims, refreshAfterLogout: { status: revokedReal.status, error: revokedReal.error } },
  });
  await page.context().close();
});
