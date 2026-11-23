/**
 * PR 576 / CU-z94x8eee57 — school-app logout must end the school session.
 *
 * Live browser tests against real AuthApp tokens (no mocks). Self-seeds throwaway
 * campus owners on the local CI stack. Covers AC1–AC4 and the agreed edge cases.
 */
import { test, expect, type Page, request as pwRequest } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LoginPage } from '../../pages/LoginPage';
import { newCampusOwner, type CampusOwner } from '../../fixtures/campus-owner';

const WEB = process.env.QA_BASE_URL ?? 'https://localhost:7236';
const FAMILY = process.env.QA_FAMILY_URL ?? 'https://localhost:7100';
const AUTH = process.env.QA_AUTH_URL ?? 'https://localhost:7104';
const API = process.env.QA_REST_API_URL ?? 'https://localhost:7244';
const EV = process.env.QA_EVIDENCE_DIR ?? path.join(__dirname, '..', '..', 'test-results', 'evidence-logout');

const ACCESS_KEY = 'mp.access_token';
const REFRESH_KEY = 'mp.refresh_token';
const WEB_CLIENT = 'marksheet-webapp';
const FAMILY_CLIENT = 'marksheet-familyapp';

test.describe.configure({ mode: 'serial' });

function unwrapStored(raw: string | null): string | null {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
  } catch {
    /* stored as a raw string */
  }
  return raw;
}

async function readToken(page: Page, area: 'local' | 'session', key: string): Promise<string | null> {
  let lastErr: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      const raw = await page.evaluate(({ area, key }) => {
        return area === 'local' ? localStorage.getItem(key) : sessionStorage.getItem(key);
      }, { area, key });
      return unwrapStored(raw);
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      if (!/Execution context was destroyed|Target closed|framedetached/i.test(msg)) throw err;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  throw lastErr;
}

async function schoolTokens(page: Page): Promise<{ access: string | null; refresh: string | null }> {
  return {
    access: await readToken(page, 'session', ACCESS_KEY),
    refresh: await readToken(page, 'local', REFRESH_KEY),
  };
}

function decodeJwt(token: string): { iat?: number; exp?: number; [k: string]: unknown } {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function accessLifetime(token: string): { iat: number; exp: number; lifetimeSeconds: number } {
  const claims = decodeJwt(token);
  const iat = Number(claims.iat);
  const exp = Number(claims.exp);
  return { iat, exp, lifetimeSeconds: exp - iat };
}

function writeEvidence(name: string, data: unknown) {
  mkdirSync(EV, { recursive: true });
  writeFileSync(path.join(EV, name), JSON.stringify(data, null, 2));
}

async function shot(page: Page, name: string) {
  mkdirSync(EV, { recursive: true });
  await page.screenshot({ path: path.join(EV, name), fullPage: true });
}

async function redeemRefresh(refreshToken: string, clientId: string) {
  const ctx = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  try {
    const res = await ctx.post(`${AUTH}/connect/token`, {
      form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
    });
    const text = await res.text();
    let json: { error?: string; error_description?: string; access_token?: string; refresh_token?: string; expires_in?: number } = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return {
      status: res.status(),
      error: json.error ?? null,
      errorDescription: json.error_description ?? null,
      hasAccessToken: Boolean(json.access_token),
      expiresIn: json.expires_in ?? null,
    };
  } finally {
    await ctx.dispose();
  }
}

async function probeAccessToken(accessToken: string) {
  const ctx = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  try {
    const userinfo = await ctx.get(`${AUTH}/connect/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const sessions = await ctx.get(`${API}/sessions`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { userinfo: userinfo.status(), sessions: sessions.status() };
  } finally {
    await ctx.dispose();
  }
}


async function tenantOf(page: Page): Promise<string | undefined> {
  const access = (await schoolTokens(page)).access;
  if (!access) return undefined;
  try {
    const claims = decodeJwt(access);
    return claims.tenant != null ? String(claims.tenant) : undefined;
  } catch {
    return undefined;
  }
}

/** The campus chip and user email appear twice (desktop shell + mobile menu). */
async function expectSignedInAs(page: Page, owner: CampusOwner) {
  await expect(page.locator('[data-shell-user-menu]').first()).toBeVisible();
  await page.locator('[data-shell-user-menu]').first().click();
  await expect(page.getByText(owner.email, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  const tenant = await tenantOf(page);
  expect(tenant, 'access-token tenant claim').toBe(owner.tenantId);
  await page.keyboard.press('Escape');
}

async function signInSchool(page: Page, owner: CampusOwner) {
  const { identifier, password } = owner.credentials();
  await page.goto(WEB + '/');
  const login = page.getByRole('heading', { name: 'Sign in to your account' });
  const alreadyIn = page.locator('[data-shell-user-menu]');
  await expect(login.or(alreadyIn)).toBeVisible({ timeout: 60_000 });
  if (await alreadyIn.count()) return;
  await new LoginPage(page).signIn(identifier, password);
  await waitForSchoolSignedIn(page);
}

async function waitForSchoolSignedIn(page: Page) {
  const webOrigin = new URL(WEB).origin;
  await page.waitForURL((u) => u.origin === webOrigin && !u.pathname.startsWith('/authentication') && !u.pathname.startsWith('/auth/'), { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toHaveCount(0);
  await expect(page.locator('[data-shell-user-menu]').first()).toBeVisible({ timeout: 45_000 });
  await expect.poll(async () => (await schoolTokens(page)).refresh, { timeout: 30_000 }).toBeTruthy();
}

async function logoutSchool(page: Page) {
  await page.locator('[data-shell-user-menu]').first().click();
  await page.locator('el-menu [data-shell-logout]').click();
  await expect(page.locator('[data-oidc-signed-out]')).toBeVisible({ timeout: 45_000 });
}

async function expectLoginForm(page: Page) {
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('textbox', { name: 'WhatsApp Number or Email' })).toBeVisible();
  await expect(page.locator('[data-shell-user-menu]')).toHaveCount(0);
}

async function waitForBlazorBoot(page: Page) {
  const splash = page.getByText(/Loading\s+\d+%\s+completed/i);
  // The WASM splash is replaced after boot; it may appear more than once across OIDC redirects.
  await expect(splash).toHaveCount(0, { timeout: 60_000 }).catch(() => {});
  if (await splash.count()) {
    await expect(splash).toHaveCount(0, { timeout: 60_000 });
  }
}

async function signInFamily(page: Page, owner: CampusOwner) {
  const { identifier, password } = owner.credentials();
  const familyOrigin = new URL(FAMILY).origin;
  await page.goto(FAMILY + '/');
  await waitForBlazorBoot(page);
  const login = page.getByRole('heading', { name: 'Sign in to your account' });
  // SSO cookie from the school-app sign-in may complete this silently, with a few redirects.
  try {
    await page.waitForURL((u) => {
      const onFamily = u.origin === familyOrigin;
      const inAuth = u.pathname.startsWith('/authentication') || u.pathname.startsWith('/auth/');
      return (u.origin === new URL(AUTH).origin) || (onFamily && (inAuth || true));
    }, { timeout: 15_000 });
  } catch { /* already moving */ }
  await waitForBlazorBoot(page);
  if (await login.isVisible().catch(() => false)) {
    await new LoginPage(page).signIn(identifier, password);
  }
  await page.waitForURL((u) => u.origin === familyOrigin && !u.pathname.startsWith('/authentication') && !u.pathname.startsWith('/auth/'), { timeout: 60_000 });
  await waitForBlazorBoot(page);
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toHaveCount(0);
  await expect(async () => {
    const tokens = await schoolTokens(page);
    expect(tokens.refresh).toBeTruthy();
  }).toPass({ timeout: 45_000 });
}

test.describe('PR 576 logout revocation (z94x8eee57)', { tag: '@smoke' }, () => {
  let ownerA: CampusOwner;
  let ownerB: CampusOwner;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    mkdirSync(EV, { recursive: true });
    ownerA = await newCampusOwner('pr576a');
    ownerB = await newCampusOwner('pr576b');
    writeEvidence('owners.json', {
      a: { email: ownerA.email, schoolName: ownerA.schoolName, tenantId: ownerA.tenantId },
      b: { email: ownerB.email, schoolName: ownerB.schoolName, tenantId: ownerB.tenantId },
    });
  });

  test('AC1+AC2+C+D: Return to home shows the login form, refresh is revoked, Back is safe, re-login works', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await signInSchool(page, ownerA);
    const before = await schoolTokens(page);
    expect(before.access, 'access token present before logout').toBeTruthy();
    expect(before.refresh, 'refresh token present before logout').toBeTruthy();
    const lifetime = accessLifetime(before.access!);
    const accessBefore = await probeAccessToken(before.access!);
    writeEvidence('ac2-access-token-lifetime.json', {
      ...lifetime,
      lifetimeHuman: `${Math.round(lifetime.lifetimeSeconds / 60)} minutes`,
      iatIso: new Date(lifetime.iat * 1000).toISOString(),
      expIso: new Date(lifetime.exp * 1000).toISOString(),
      probeBeforeLogout: accessBefore,
    });

    await shot(page, 'ac1-signed-in-before-logout.png');
    await logoutSchool(page);
    await shot(page, 'ac1-signed-out-page.png');

    const afterLogout = await schoolTokens(page);
    expect(afterLogout.access, 'access token cleared on the logout tab').toBeNull();
    expect(afterLogout.refresh, 'refresh token cleared on the logout tab').toBeNull();

    const refreshAfter = await redeemRefresh(before.refresh!, WEB_CLIENT);
    const accessAfter = await probeAccessToken(before.access!);
    writeEvidence('ac2-refresh-and-access-after-logout.json', {
      refresh: refreshAfter,
      accessProbe: accessAfter,
      tokensClearedInBrowser: afterLogout,
    });
    expect(refreshAfter.status, 'revoked refresh must be rejected').toBe(400);
    expect(refreshAfter.error).toBe('invalid_grant');
    expect(refreshAfter.hasAccessToken).toBeFalsy();

    // AC1: Return to home must show the login form, with no silent sign-in.
    await page.locator('[data-action="return-home"]').click();
    await expectLoginForm(page);
    await shot(page, 'ac1-return-to-home-login-form.png');
    const url = page.url();
    expect(url, 'Return to home stayed on the login form').toMatch(/auth\/login|connect\/authorize|login/i);
    await expect(page.locator('[data-shell-user-menu]')).toHaveCount(0);
    expect((await schoolTokens(page)).refresh).toBeNull();

    // Edge (c): Back must not restore a protected page with data.
    await page.goBack();
    // Give the WASM app a moment to settle or redirect if bfcache restored anything.
    const settled = await expect.poll(async () => {
      const signedOut = await page.locator('[data-oidc-signed-out]').count();
      const loginVisible = await page.getByRole('heading', { name: 'Sign in to your account' }).isVisible().catch(() => false);
      const shell = await page.locator('[data-shell-user-menu]').count();
      const campus = await page.locator('[data-shell-campus-current]').textContent().catch(() => '');
      const tokens = await schoolTokens(page);
      return { signedOut, loginVisible, shell, campus, hasAccess: Boolean(tokens.access), hasRefresh: Boolean(tokens.refresh) };
    }, { timeout: 20_000 }).toMatchObject({ hasAccess: false, hasRefresh: false });
    await shot(page, 'edge-c-after-back.png');
    writeEvidence('edge-c-back.json', { url: page.url(), settled: 'see poll', shellUserVisible: await page.locator('[data-shell-user-menu]').count() });
    await expect(page.locator('[data-shell-user-menu]')).toHaveCount(0);
    await expect(page.getByText(ownerA.schoolName, { exact: false })).toHaveCount(0);
    const onSafePage = await page.locator('[data-oidc-signed-out]').count() || await page.getByRole('heading', { name: 'Sign in to your account' }).isVisible();
    expect(onSafePage, 'Back landed on the signed-out page or the login form, not a protected view').toBeTruthy();

    // Edge (d): sign in again normally right after logging out.
    if (await page.locator('[data-oidc-signed-out]').count()) {
      await page.locator('[data-action="return-home"]').click();
      await expectLoginForm(page);
    }
    await new LoginPage(page).signIn(ownerA.credentials().identifier, ownerA.credentials().password);
    await waitForSchoolSignedIn(page);
    await expectSignedInAs(page, ownerA);
    await shot(page, 'edge-d-relogin.png');
    writeEvidence('edge-d-relogin.json', { url: page.url(), tenant: await tenantOf(page), email: ownerA.email });
  });

  test('AC3: after A logs out, B on the same browser sees only B\'s account and campus', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await signInSchool(page, ownerA);
    await expectSignedInAs(page, ownerA);
    await shot(page, 'ac3-user-a-signed-in.png');
    await logoutSchool(page);
    await page.locator('[data-action="return-home"]').click();
    await expectLoginForm(page);

    await new LoginPage(page).signIn(ownerB.credentials().identifier, ownerB.credentials().password);
    await waitForSchoolSignedIn(page);
    await expectSignedInAs(page, ownerB);
    await page.locator('[data-shell-user-menu]').first().click();
    await expect(page.getByText(ownerB.email, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(ownerA.email, { exact: false })).toHaveCount(0);
    const tenant = await tenantOf(page);
    expect(tenant).toBe(ownerB.tenantId);
    expect(tenant).not.toBe(ownerA.tenantId);
    await page.keyboard.press('Escape');
    await shot(page, 'ac3-user-b-only.png');
    writeEvidence('ac3-user-b.json', {
      tenant,
      expectedTenantB: ownerB.tenantId,
      notTenantA: ownerA.tenantId,
      email: ownerB.email,
    });
  });

  test('AC4: family-app session on the same browser stays signed in and its refresh still works', async ({ context, page }) => {
    test.setTimeout(5 * 60_000);
    await signInSchool(page, ownerA);
    const schoolBefore = await schoolTokens(page);
    expect(schoolBefore.refresh).toBeTruthy();

    const familyPage = await context.newPage();
    await signInFamily(familyPage, ownerA);
    const familyBefore = await schoolTokens(familyPage);
    expect(familyBefore.refresh, 'family refresh token present').toBeTruthy();
    expect(familyBefore.refresh).not.toBe(schoolBefore.refresh);
    // Do not redeem the family refresh token before logout: OpenIddict refresh tokens are
    // single-use, and a probe here would invalidate the one the family app is holding.
    writeEvidence('ac4-family-before-school-logout.json', {
      schoolAndFamilyTokensDiffer: familyBefore.refresh !== schoolBefore.refresh,
      familyAccessPresent: Boolean(familyBefore.access),
      familyRefreshPresent: Boolean(familyBefore.refresh),
    });
    await shot(familyPage, 'ac4-family-signed-in-before.png');

    await logoutSchool(page);
    await shot(page, 'ac4-school-signed-out.png');

    // Family tab must still be signed in (not sent to the login form).
    await familyPage.bringToFront();
    await expect(familyPage.getByRole('heading', { name: 'Sign in to your account' })).toHaveCount(0);
    const familyAfter = await schoolTokens(familyPage);
    expect(familyAfter.refresh, 'family refresh token still in localStorage').toBeTruthy();
    const familyRefreshAfter = await redeemRefresh(familyAfter.refresh!, FAMILY_CLIENT);
    writeEvidence('ac4-family-after-school-logout.json', {
      familyTokensStillPresent: Boolean(familyAfter.refresh),
      familyRefresh: { status: familyRefreshAfter.status, hasAccessToken: familyRefreshAfter.hasAccessToken, error: familyRefreshAfter.error },
      schoolRefreshRevoked: await redeemRefresh(schoolBefore.refresh!, WEB_CLIENT),
    });
    expect(familyRefreshAfter.status, 'family refresh must still work').toBe(200);
    expect(familyRefreshAfter.hasAccessToken).toBeTruthy();
    await expect(familyPage.getByRole('heading', { name: 'Sign in to your account' })).toHaveCount(0);
    await shot(familyPage, 'ac4-family-still-signed-in.png');

    // The school refresh captured before logout must still be dead (client isolation, not a global revoke).
    const schoolRefreshAfter = await redeemRefresh(schoolBefore.refresh!, WEB_CLIENT);
    expect(schoolRefreshAfter.status).toBe(400);
    expect(schoolRefreshAfter.error).toBe('invalid_grant');
  });

  test('edge (a): a failed API /auth/logout still clears tokens and reaches /connect/logout', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await signInSchool(page, ownerA);
    const before = await schoolTokens(page);
    expect(before.refresh).toBeTruthy();

    const apiOrigin = new URL(API).origin;
    let apiLogoutAborted = 0;
    await page.route((url) => url.origin === apiOrigin && url.pathname === '/auth/logout', async (route) => {
      apiLogoutAborted += 1;
      await route.abort('failed');
    });

    let connectLogoutSeen = false;
    let connectLogoutUrl = '';
    page.on('request', (req) => {
      try {
        const u = new URL(req.url());
        if (u.pathname === '/connect/logout') {
          connectLogoutSeen = true;
          connectLogoutUrl = req.url();
        }
      } catch { /* ignore */ }
    });

    await page.locator('[data-shell-user-menu]').first().click();
    await page.locator('el-menu [data-shell-logout]').click();
    await expect(page.locator('[data-oidc-signed-out]')).toBeVisible({ timeout: 45_000 });
    const after = await schoolTokens(page);
    await shot(page, 'edge-a-api-logout-aborted.png');
    writeEvidence('edge-a-api-logout-abort.json', {
      apiLogoutAborted,
      connectLogoutSeen,
      connectLogoutHadClientId: /[?&]client_id=/.test(connectLogoutUrl),
      tokensCleared: { access: after.access, refresh: after.refresh },
    });
    expect(apiLogoutAborted, 'the API logout call was blocked').toBeGreaterThan(0);
    expect(connectLogoutSeen, 'the app still navigated to /connect/logout').toBeTruthy();
    expect(after.access).toBeNull();
    expect(after.refresh).toBeNull();
    const refreshAfter = await redeemRefresh(before.refresh!, WEB_CLIENT);
    expect(refreshAfter.status).toBe(400);
    expect(refreshAfter.error).toBe('invalid_grant');
  });

  test('edge (b): a second open tab keeps its access token until it expires, then refresh is rejected', async ({ context, page }) => {
    test.setTimeout(5 * 60_000);
    await signInSchool(page, ownerA);

    const tab2 = await context.newPage();
    await tab2.goto(WEB + '/');
    await waitForSchoolSignedIn(tab2);
    const tab2Before = await schoolTokens(tab2);
    expect(tab2Before.access).toBeTruthy();
    const tab2Lifetime = accessLifetime(tab2Before.access!);
    const tab2Refresh = tab2Before.refresh;
    expect(tab2Refresh).toBeTruthy();
    await shot(tab2, 'edge-b-tab2-signed-in.png');

    // Tab 1 logs out. Tab 2 is not told to drop its tokens (Dan skipped that optional step).
    await logoutSchool(page);
    await shot(page, 'edge-b-tab1-signed-out.png');

    await tab2.bringToFront();
    const tab2AfterLogout = await schoolTokens(tab2);
    // sessionStorage is per-tab, so tab 2 still has its access token.
    expect(tab2AfterLogout.access, 'tab 2 still holds its access token after tab 1 logs out').toBeTruthy();
    const stillValid = await probeAccessToken(tab2AfterLogout.access!);
    writeEvidence('edge-b-two-tabs.json', {
      tab2AccessLifetimeSeconds: tab2Lifetime.lifetimeSeconds,
      tab2AccessStillPresent: Boolean(tab2AfterLogout.access),
      tab2RefreshStillPresent: Boolean(tab2AfterLogout.refresh),
      tab2AccessProbeWhileUnexpired: stillValid,
      notedLimits: {
        noRevocationAfter8hAuthCookieExpires: 'not exercised (cookie lifetime is 8 hours); recorded as a documented limit, not a bug',
        otherTabsKeepAccessUntilExpiry: 'verified live: tab 2 kept its access token after tab 1 logged out',
      },
    });
    await shot(tab2, 'edge-b-tab2-still-has-access.png');
    // A still-unexpired access token should keep tab 2 on the app.
    await expect(tab2.locator('[data-shell-user-menu]').first()).toBeVisible();
    await expect(tab2.getByRole('heading', { name: 'Sign in to your account' })).toHaveCount(0);

    // Force the refresh path without waiting out the access-token lifetime: drop the access token and reload.
    await tab2.evaluate((key) => sessionStorage.removeItem(key), ACCESS_KEY);
    await tab2.reload();
    // The refresh token was revoked (and likely cleared from shared localStorage by tab 1). Tab 2 must not silently sign back in.
    await expect(tab2.getByRole('heading', { name: 'Sign in to your account' }).or(tab2.locator('[data-oidc-signed-out]'))).toBeVisible({ timeout: 45_000 });
    const refreshAfter = await redeemRefresh(tab2Refresh!, WEB_CLIENT);
    writeEvidence('edge-b-tab2-refresh-after-access-cleared.json', {
      refresh: refreshAfter,
      tab2Url: tab2.url(),
    });
    expect(refreshAfter.status).toBe(400);
    expect(refreshAfter.error).toBe('invalid_grant');
    await expect(tab2.locator('[data-shell-user-menu]')).toHaveCount(0);
    await shot(tab2, 'edge-b-tab2-refresh-rejected.png');
  });
});
