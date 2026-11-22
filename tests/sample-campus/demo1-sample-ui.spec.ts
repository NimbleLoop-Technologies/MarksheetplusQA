/**
 * DEMO-1 (CU-z94x8eebc9, PR 573): what a school user sees on a sample campus in the WebApp.
 *   AC6 (OIDC sign-in): a sample with no subscription goes straight into the app; a real campus with no subscription
 *       still gets the AuthApp plan screen (control).
 *   AC10 banner on every page while the sample is active, absent on a real campus, follows a campus switch.
 *   AC9 telemetry: gtag defaults carry is_sample=true on the sample and are cleared after switching to a real campus
 *       (GA is configured for the test only by rewriting the WebApp's appsettings.json response; gtag.js is stubbed).
 *   AC4 invite screens show the friendly refusal. AC7 quota card shows no quota.
 *
 * Self-seeding: owner A with R (real trial), S (sample, signup subscription deleted), N (real, subscription deleted).
 * DB PRECONDITIONS on these campuses only, as in demo1-sample-guards-api.spec.ts.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { evidencePath, newCampusOwner, signInToWebApp, WEBAPP, type CampusOwner } from '../../fixtures/quota';
import { addStudent, familyMobile, personName, setupSchool, type Student } from '../../fixtures/fees';
import { addStaffWithContacts } from '../../fixtures/access-roles';
import { LoginPage } from '../../pages/LoginPage';
import { StudentsRegisterPage } from '../../pages/StudentsRegisterPage';
import { SubscriptionQuotaCard } from '../../pages/setup/SubscriptionQuotaCard';
import {
  INVITES_OFF, SAMPLE_BANNER, SAMPLE_CACHE_MS, addCampus, apiFor, deleteSubscriptionOf, flagSample, restLogin, restSwitchCampus,
} from '../../fixtures/sample-campus';

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: WEBAPP, ignoreHTTPSErrors: true });

let A: CampusOwner;
let R: string;
let S: string;
let N: string;
let sStudent: Student;
let sStaffId: string;

const notice = (page: Page) => page.locator('[data-sample-campus-notice]');

/** Persists `tenantId` as A's default campus (SwitchCampus stores it), so the next sign-in opens there. */
async function makeDefault(tenantId: string) {
  const login = await restLogin(A);
  expect(login.status).toBe(200);
  const sw = await restSwitchCampus(login.body.accessToken, tenantId);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
  return sw.body.accessToken as string;
}

async function freshPage(browser: Browser, withAnalytics = false): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: WEBAPP, ignoreHTTPSErrors: true, timezoneId: 'Asia/Karachi' });
  if (withAnalytics) {
    // Turn GA on for this browser only: rewrite the WebApp's appsettings.json and stub gtag.js (no network to Google).
    await ctx.route(/\/appsettings(\.[A-Za-z]+)?\.json(\?.*)?$/, async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      if (json.GoogleAnalytics) json.GoogleAnalytics = { MeasurementId: 'G-QA573TEST', Enabled: true };
      await route.fulfill({ response: res, json });
    });
    await ctx.route(/googletagmanager\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* qa573 gtag stub */' }));
  }
  return ctx.newPage();
}

const dataLayer = (page: Page) => page.evaluate(() => ((window as any).dataLayer ?? []).map((a: any) => JSON.parse(JSON.stringify(Array.from(a), (_k, v) => (v === undefined ? '__undefined__' : v)))));

/** Opens the campus switcher and picks `campusName`; waits until the chip shows it. */
async function switchCampusInUi(page: Page, campusName: string) {
  const chip = page.getByRole('button', { name: /^Current campus: / });
  await expect(async () => {
    await chip.click();
    await page.getByRole('menuitem', { name: new RegExp(campusName) }).or(page.getByRole('option', { name: new RegExp(campusName) })).or(page.getByRole('button', { name: new RegExp(`^${campusName}`) })).first().click({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(chip).toHaveAccessibleName(new RegExp(campusName), { timeout: 60_000 });
}

test.beforeAll(async () => {
  test.setTimeout(8 * 60_000);
  A = await newCampusOwner('qa573u');
  R = A.tenantId;
  S = await addCampus(A, 'Sample');
  N = await addCampus(A, 'Noplan');
  console.log('[DB SETUP] S and N: delete the signup subscription; S: IsSample = true');
  await deleteSubscriptionOf(S);
  await deleteSubscriptionOf(N);
  await flagSample(S);
  await new Promise((r) => setTimeout(r, SAMPLE_CACHE_MS));
  // Data on the sample, created through the API while it is a sample.
  const sApi = await apiFor(await makeDefault(S));
  const sOwner = { ...A, api: sApi, tenantId: S } as CampusOwner;
  const school = await setupSchool(sOwner, 1);
  sStudent = await addStudent(sOwner, { name: personName('Practice'), classId: school.classes[0].id, fatherName: personName('Father'), fatherMobile: familyMobile() });
  sStaffId = (await addStaffWithContacts(sApi, { first: 'Practice', phone: familyMobile(), email: `qa573-ui-staff+${Date.now()}@testenv.local` })).id;
  await sApi.dispose();
});

test.afterAll(async () => {
  await A?.api.dispose();
});

test('AC6 + AC10: a sample with no subscription signs straight into the app and every module shows the sample banner', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  await makeDefault(S);
  const page = await freshPage(browser);
  await signInToWebApp(page, A);
  expect(new URL(page.url()).origin).toBe(new URL(WEBAPP).origin);
  await expect(notice(page)).toHaveText(SAMPLE_BANNER, { timeout: 60_000 });
  await page.screenshot({ path: evidencePath('pr573-ac10-banner-home.png') });
  const rail = page.getByRole('navigation', { name: 'Modules' });
  const modules = await rail.getByRole('link').allInnerTexts();
  expect(modules.length).toBeGreaterThan(3);
  for (const name of modules.map((m) => m.trim()).filter(Boolean)) {
    await rail.getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(notice(page), `banner on ${name}`).toHaveText(SAMPLE_BANNER);
    await expect(notice(page)).toBeVisible();
  }
  // A full reload keeps it (not dismissible, from the token claim).
  await page.goto('/registrar/students');
  await expect(notice(page)).toHaveText(SAMPLE_BANNER, { timeout: 60_000 });
  await expect(notice(page).getByRole('button')).toHaveCount(0);
  await page.screenshot({ path: evidencePath('pr573-ac10-banner-register.png') });
  await page.context().close();
});

test('AC6 control: a REAL campus with no subscription is still sent to the plan screen at sign-in', async ({ browser }) => {
  await makeDefault(N);
  const page = await freshPage(browser);
  await page.goto('/');
  await page.waitForURL(/\/auth\/login/, { timeout: 60_000 });
  const { identifier, password } = A.credentials();
  await new LoginPage(page).signIn(identifier, password);
  await page.waitForURL(/\/subscription\/plan/, { timeout: 60_000 });
  await page.screenshot({ path: evidencePath('pr573-ac6-real-noplan-plan-screen.png') });
  await page.context().close();
});

test('AC10 + AC9: no banner or is_sample on the real campus; switching to the sample adds both, switching back clears both', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  await makeDefault(R);
  const page = await freshPage(browser, true);
  await signInToWebApp(page, A);
  await expect(page.getByRole('button', { name: /^Current campus: / })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3_000);
  await expect(notice(page)).toHaveCount(0);
  const realLayer = await dataLayer(page);
  expect(realLayer.some((e: any[]) => e[0] === 'config' && e[1] === 'G-QA573TEST'), 'GA initialised for the test').toBe(true);
  expect(realLayer.filter((e: any[]) => e[0] === 'set' && e[1]?.is_sample === true)).toEqual([]);

  await switchCampusInUi(page, 'Sample');
  await expect(notice(page)).toHaveText(SAMPLE_BANNER, { timeout: 60_000 });
  await expect.poll(async () => (await dataLayer(page)).filter((e: any[]) => e[0] === 'set' && e[1]?.is_sample === true).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  // Navigate so a page_view is tracked while the default is set.
  await page.getByRole('navigation', { name: 'Modules' }).getByRole('link').nth(1).click();
  const sampleLayer = await dataLayer(page);
  const lastSet = sampleLayer.map((e: any[], i: number) => ({ e, i })).filter(({ e }: any) => e[0] === 'set' && 'is_sample' in (e[1] ?? {})).pop();
  expect(lastSet?.e[1].is_sample).toBe(true);
  expect(sampleLayer.slice(lastSet!.i).some((e: any[]) => e[0] === 'event'), 'an analytics event after is_sample was set').toBe(true);
  await page.screenshot({ path: evidencePath('pr573-ac10-banner-after-switch.png') });

  await page.evaluate(() => { (window as any).__qa573 = 'before-switch-back'; });
  await switchCampusInUi(page, 'Main');
  await expect(notice(page)).toHaveCount(0, { timeout: 60_000 });
  await page.getByRole('navigation', { name: 'Modules' }).getByRole('link').nth(2).click();
  // A campus switch may reload the WebApp (fresh dataLayer, nothing set) or stay in-app (gtag('set', {is_sample: undefined})).
  // Either way the default in force afterwards must not be is_sample=true.
  await expect.poll(async () => {
    const layer = await dataLayer(page);
    const last = layer.filter((e: any[]) => e[0] === 'set' && 'is_sample' in (e[1] ?? {})).pop();
    return last ? last[1].is_sample : 'not-set';
  }, { timeout: 30_000 }).not.toBe(true);
  const reloaded = await page.evaluate(() => (window as any).__qa573 !== 'before-switch-back');
  console.log(`[AC9] switch back to the real campus ${reloaded ? 'reloaded the WebApp' : 'stayed in-app'}; last is_sample default: ${JSON.stringify((await dataLayer(page)).filter((e: any[]) => e[0] === 'set').pop() ?? null)}`);
  await page.context().close();
});

test('AC4: the Parent app drawer on a sample student offers no Copy / Send and issues no code', async ({ browser }) => {
  await makeDefault(S);
  const page = await freshPage(browser);
  await signInToWebApp(page, A);
  const register = new StudentsRegisterPage(page);
  await register.goto();
  const drawer = await register.openFamilyInviteDrawer({ fullName: sStudent.name, admissionId: sStudent.admissionId });
  await expect(drawer.root.getByText('Not linked', { exact: true })).toBeVisible();
  await expect(drawer.copyButton).toHaveCount(0);
  await expect(drawer.sendWhatsAppButton).toHaveCount(0);
  await expect(drawer.code).toHaveCount(0);
  await page.screenshot({ path: evidencePath('pr573-ac4-parent-app-drawer.png') });
  await page.context().close();
});

test('AC4: the staff "Invite to Marksheet+" dialog shows the friendly refusal', async ({ browser }) => {
  await makeDefault(S);
  const page = await freshPage(browser);
  await signInToWebApp(page, A);
  await page.goto(`/staff/register/${sStaffId}`);
  const invite = page.getByRole('button', { name: 'Invite to Marksheet+' });
  await expect(invite).toBeVisible({ timeout: 30_000 });
  await invite.click();
  const dialog = page.getByRole('dialog', { name: /Invite .* to Marksheet\+\?/ });
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-action="send-invite"]').click();
  await expect(dialog.locator('[data-invite-error]')).toContainText(INVITES_OFF, { timeout: 15_000 });
  await page.screenshot({ path: evidencePath('pr573-ac4-staff-invite.png') });
  await page.context().close();
});

test('AC7: the sample\'s Subscription page shows no WhatsApp quota and no way to request more; no quota notice in the shell', async ({ browser }) => {
  await makeDefault(S);
  const page = await freshPage(browser);
  await signInToWebApp(page, A);
  const card = new SubscriptionQuotaCard(page);
  await card.open();
  await expect(card.card).toContainText('WhatsApp notifications are not available');
  await expect(card.card.locator('[data-quota-stats]')).toHaveCount(0);
  await expect(card.requestButton()).toHaveCount(0);
  await expect(page.locator('[data-whatsapp-quota-notice]')).toHaveCount(0);
  await page.context().close();
});

// Last on purpose: cycle 1 found these open (B2, B3). Soft assertions so both are reported; a failure here does not
// stop the serial chain above.
test('Known gaps: the sample shows no billing details (B2) and the Parent app drawer explains why there is no code (B3)', async ({ browser }) => {
  await makeDefault(S);
  const page = await freshPage(browser);
  await signInToWebApp(page, A);
  await page.goto('/setup/subscription');
  await expect(page.getByRole('heading', { name: 'Subscription', level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: evidencePath('pr573-b2-sample-subscription-page.png'), fullPage: true });
  const main = page.getByRole('main');
  await expect.soft(main.getByText('How to pay by bank transfer'), 'B2: bank-transfer payment details on the sample').toHaveCount(0);
  await expect.soft(main.getByText(/free trial/i).first(), 'B2: the owner\'s trial plan on the sample').toHaveCount(0);

  const register = new StudentsRegisterPage(page);
  await register.goto();
  const drawer = await register.openFamilyInviteDrawer({ fullName: sStudent.name, admissionId: sStudent.admissionId });
  await page.screenshot({ path: evidencePath('pr573-b3-parent-app-drawer.png') });
  await expect.soft(drawer.root.getByText(INVITES_OFF), 'B3: friendly refusal in the Parent app drawer').toBeVisible({ timeout: 10_000 });
  await expect.soft(drawer.root.getByText('No code yet. Send one to the parent on WhatsApp, or copy it.'), 'B3: drawer tells the user to send/copy with no buttons').toHaveCount(0);
  await page.context().close();
});
