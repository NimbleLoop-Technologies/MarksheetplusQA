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
let rStudent: Student;
let rStaffId: string;

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
  const rSchool = await setupSchool(A, 1);
  rStudent = await addStudent(A, { name: personName('Real'), classId: rSchool.classes[0].id, fatherName: personName('Father'), fatherMobile: familyMobile() });
  rStaffId = (await addStaffWithContacts(A.api, { first: 'Real', phone: familyMobile(), email: `qa573-ui-real-staff+${Date.now()}@testenv.local` })).id;
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

test('AC4 / B3: the Parent app drawer on a sample student shows the invites-off message and no actions', async ({ browser }) => {
  await makeDefault(S);
  const page = await freshPage(browser);
  await signInToWebApp(page, A);
  const register = new StudentsRegisterPage(page);
  await register.goto();
  const drawer = await register.openFamilyInviteDrawer({ fullName: sStudent.name, admissionId: sStudent.admissionId });
  await expect(drawer.root.getByText('Not linked', { exact: true })).toBeVisible();
  await expect(drawer.root.locator('[data-invites-off]')).toContainText(INVITES_OFF);
  await expect(drawer.root.getByText('No code yet. Send one to the parent on WhatsApp, or copy it.')).toHaveCount(0);
  await expect(drawer.copyButton).toHaveCount(0);
  await expect(drawer.sendWhatsAppButton).toHaveCount(0);
  await expect(drawer.generateButton).toHaveCount(0);
  await expect(drawer.code).toHaveCount(0);
  await page.screenshot({ path: evidencePath('pr573-c2-parent-app-drawer.png') });
  await page.context().close();
});

test('AC4 / sweep: the staff App access panel on a sample shows the invites-off message and no Invite, Resend or Revoke', async ({ browser }) => {
  await makeDefault(S);
  const page = await freshPage(browser);
  await signInToWebApp(page, A);
  await page.goto(`/staff/register/${sStaffId}`);
  const panel = page.locator('[data-staff-card="access"]');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('[data-access-description]')).toHaveText(INVITES_OFF);
  await expect(panel.locator('[data-action="invite"]')).toHaveCount(0);
  await expect(panel.locator('[data-action="resend-invite"]')).toHaveCount(0);
  await expect(panel.locator('[data-action="revoke-invite"]')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Invite to Marksheet+' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Resend' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Revoke invite' })).toHaveCount(0);
  await page.screenshot({ path: evidencePath('pr573-c2-staff-app-access.png') });
  await page.context().close();
});

test('AC7: the sample\'s Subscription page has no WhatsApp quota card and no way to request more; no quota notice in the shell', async ({ browser }) => {
  await makeDefault(S);
  const page = await freshPage(browser);
  await signInToWebApp(page, A);
  await page.goto('/setup/subscription');
  await expect(page.getByRole('heading', { name: 'Subscription', level: 1 })).toBeVisible({ timeout: 30_000 });
  // After the B2 fix the page renders only the Sample school card — the quota card is not mounted at all.
  await expect(page.locator('[data-subscription-sample]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-quota-card]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /request more/i })).toHaveCount(0);
  await expect(page.locator('[data-whatsapp-quota-notice]')).toHaveCount(0);
  await page.context().close();
});

test('B2: the sample Subscription page shows a Sample school card with no plan or bank details, and the dashboard has no trial banner', async ({ browser }) => {
  await makeDefault(S);
  const page = await freshPage(browser);
  await signInToWebApp(page, A);
  await page.goto('/setup/subscription');
  await expect(page.getByRole('heading', { name: 'Subscription', level: 1 })).toBeVisible({ timeout: 30_000 });
  const sampleCard = page.locator('[data-subscription-sample]');
  await expect(sampleCard).toBeVisible({ timeout: 30_000 });
  await expect(sampleCard.getByRole('heading', { name: 'Sample school' })).toBeVisible();
  await expect(sampleCard.getByText('Practice', { exact: true })).toBeVisible();
  await expect(sampleCard.locator('[data-subscription-sample-note]')).toContainText("This is a practice school. It has no subscription, nothing here is billed, and extra WhatsApp quota can't be requested.");
  const main = page.getByRole('main');
  await expect(main.locator('[data-subscription-bank]')).toHaveCount(0);
  await expect(main.getByText('How to pay by bank transfer')).toHaveCount(0);
  await expect(main.getByText(/free trial/i)).toHaveCount(0);
  await page.screenshot({ path: evidencePath('pr573-c2-sample-subscription-page.png'), fullPage: true });

  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Your free trial ends/i)).toHaveCount(0);
  await expect(page.getByText('Pay by bank transfer to keep access for your school.')).toHaveCount(0);
  await page.screenshot({ path: evidencePath('pr573-c2-sample-dashboard.png') });
  await page.context().close();
});

test('Control: a real campus still shows its plan, and invites still work on the Parent app drawer and staff App access panel', async ({ browser }) => {
  await makeDefault(R);
  const page = await freshPage(browser);
  await signInToWebApp(page, A);
  await page.goto('/setup/subscription');
  await expect(page.getByRole('heading', { name: 'Subscription', level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-subscription-sample]')).toHaveCount(0);
  await expect(page.getByText(/free trial/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-subscription-bank]')).toBeVisible();
  await page.screenshot({ path: evidencePath('pr573-c2-real-subscription-page.png'), fullPage: true });

  await page.goto(`/staff/register/${rStaffId}`);
  const panel = page.locator('[data-staff-card="access"]');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole('button', { name: 'Invite to Marksheet+' })).toBeVisible();
  await expect(panel.locator('[data-access-description]')).not.toHaveText(INVITES_OFF);

  const register = new StudentsRegisterPage(page);
  await register.goto();
  const drawer = await register.openFamilyInviteDrawer({ fullName: rStudent.name, admissionId: rStudent.admissionId });
  await expect(drawer.root.locator('[data-invites-off]')).toHaveCount(0);
  await expect(drawer.copyButton).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: evidencePath('pr573-c2-real-invites.png') });
  await page.context().close();
});
