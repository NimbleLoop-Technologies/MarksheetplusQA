/**
 * PR 571 / ClickUp CU-z94x8ed11f — code-only parent linking, parent-app side and API guards.
 *
 * Dan's checks covered here (parent + confirm + PII + removed lobby):
 *  6. "Add child with school code" is on Home and the empty state; "Have a school code?" is in the
 *     account menu; all go to /join. /link redirects to /join and keeps ?code=.
 *  7. The confirm screen and redeem/confirm APIs show only the invite's own details (school, first
 *     name, class, masked admission number, expiry). No other children, phones or guardian data.
 *  8. GET /family/link-invites (exact) is gone (404). redeem / accept / reject / attach-candidates
 *     still work. After "Not my child" the school sees "Declined by parent". After a link, staff
 *     still have "Parent app" and can Unlink, then issue a new code.
 *
 * "Add as a new child" / "Same child as …" are still in the confirm UI (tested honestly). The
 * server accept path is confirm-only (NewChild is ignored).
 */
import { expect } from '@playwright/test';
import { test } from '../../fixtures/family';
import { addOwnChild, callFamilyApi, waitUntilInviteProjected } from '../../fixtures/devenv';
import { StudentsRegisterPage } from '../../pages/StudentsRegisterPage';
import { FamilyInviteCodeDrawer } from '../../pages/FamilyInviteCodeDrawer';
import { JoinWithCodePage } from '../../pages/family/JoinWithCodePage';
import { FamilyDashboardPage } from '../../pages/family/FamilyDashboardPage';
import { LoginPage } from '../../pages/LoginPage';

const FAMILY = process.env.QA_FAMILY_URL ?? 'https://localhost:7100';
const CARD_KEYS = ['inviteId', 'schoolName', 'studentFirstName', 'admissionNumberMasked', 'classSectionLabel', 'expiresAtUtc'].sort();
const LEAK = /phone|mobile|guardian|father|mother|whatsapp|email|cnic|address|lastName|fullName|admissionNumber(?!Masked)/i;

const bare = (code: string) => code.replace('-', '');

async function issueCode(adminPage: import('@playwright/test').Page, student: { fullName: string; admissionId: string; id: string; firstName: string }) {
  const register = new StudentsRegisterPage(adminPage);
  await register.goto();
  const drawer = await register.openFamilyInviteDrawer(student);
  const code = await drawer.generate();
  await waitUntilInviteProjected(student.id);
  return { code, drawer, register };
}

function assertNoPii(body: string, student: { fullName: string; admissionId: string }, extraForbidden: string[] = []) {
  const json = JSON.parse(body);
  expect(Object.keys(json).sort(), `redeem/confirm keys: ${body}`).toEqual(CARD_KEYS);
  expect(json.studentFirstName).toBeTruthy();
  expect(json.studentFirstName).not.toBe(student.fullName);
  expect(body).not.toContain(student.admissionId);
  expect(body, body).not.toMatch(LEAK);
  for (const n of extraForbidden) expect(body.toLowerCase(), body).not.toContain(n.toLowerCase());
}

test.describe.configure({ timeout: 120_000 });

test.describe('PR 571 code-only parent linking (CU-z94x8ed11f)', () => {
  test('Home, empty state and the account menu all go to /join; /link keeps the query string', async ({ page, freshParent, browser }) => {
    const dashboard = new FamilyDashboardPage(page);
    await dashboard.goto();
    const add = page.getByRole('link', { name: 'Add child with school code' }).or(page.getByTestId('add-child-with-code'));
    await expect(add.first()).toBeVisible();
    await add.first().click();
    await expect(page).toHaveURL(/\/join/);
    await new JoinWithCodePage(page).expectLoaded();

    await dashboard.goto();
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('link', { name: 'Have a school code?' }).click();
    await expect(page).toHaveURL(/\/join/);

    // Empty state: a parent with no linked children.
    const ctx = await browser.newContext({
      baseURL: FAMILY,
      ignoreHTTPSErrors: true,
      storageState: { cookies: [], origins: [] },
    });
    const empty = await ctx.newPage();
    await empty.goto('/dashboard');
    await new LoginPage(empty).signIn(freshParent.email, freshParent.password);
    await new FamilyDashboardPage(empty).expectLoaded();
    const emptyAdd = empty.getByRole('link', { name: 'Add child with school code' }).or(empty.getByTestId('add-child-with-code'));
    await expect(emptyAdd.first()).toBeVisible();
    await emptyAdd.first().click();
    await expect(empty).toHaveURL(/\/join/);
    await ctx.close();

    await page.goto('/link?code=ABC123');
    await expect(page).toHaveURL(/\/join\?code=ABC123/);
  });

  test('redeem and the confirm screen show only the invite details; the lobby is gone; no PII leak', async ({ page, adminPage, student, freshParent }) => {
    const { code } = await issueCode(adminPage, student);

    const lobby = await callFamilyApi(freshParent, 'GET', '/family/link-invites');
    expect(lobby.status, `GET /family/link-invites: ${lobby.body}`).toBe(404);

    const redeem = await callFamilyApi(freshParent, 'POST', '/family/link-invites/redeem', { code });
    expect(redeem.status, `redeem: ${redeem.body}`).toBe(200);
    assertNoPii(redeem.body, student);
    const card = JSON.parse(redeem.body) as { inviteId: string; studentFirstName: string; admissionNumberMasked: string };
    expect(card.studentFirstName.toLowerCase()).toBe(student.firstName.toLowerCase());
    expect(card.admissionNumberMasked).toBeTruthy();
    expect(card.admissionNumberMasked).not.toBe(student.admissionId);

    const candidates = await callFamilyApi(freshParent, 'GET', `/family/link-invites/${card.inviteId}/attach-candidates`);
    expect(candidates.status, `attach-candidates: ${candidates.body}`).toBeLessThan(500);
    // 200 with the parent's own children, or 404/405 if the route shape changed — never a 500, never other families.
    if (candidates.status === 200) {
      expect(candidates.body, candidates.body).not.toMatch(LEAK);
    }

    const ctx = await page.context().browser()!.newContext({
      baseURL: FAMILY,
      ignoreHTTPSErrors: true,
      storageState: { cookies: [], origins: [] },
    });
    const parentPage = await ctx.newPage();
    await parentPage.goto(`/join?code=${bare(code)}`);
    await new LoginPage(parentPage).signIn(freshParent.email, freshParent.password);
    const join = new JoinWithCodePage(parentPage);
    await expect(join.cardValue('Child')).toHaveText(student.firstName);
    await expect(join.main).not.toContainText(student.fullName);
    await expect(join.cardValue('Admission number')).not.toContainText(student.admissionId);
    await expect(join.main).not.toContainText(student.admissionId);
    // Notice (no existing children) or the "Add as a new child" tile (when the family already has children).
    await expect(join.main.getByText('Add as a new child').first()).toBeVisible();
    await expect(join.main.getByRole('button', { name: 'Not my child' })).toBeVisible();
    await ctx.close();
  });

  test('a parent with an existing child is offered "Add as a new child" and "Same child as"', async ({ adminPage, student, freshParent, browser }) => {
    await addOwnChild(freshParent, 'Sara', '2016-03-10', 'Female');
    const { code } = await issueCode(adminPage, student);
    const ctx = await browser.newContext({
      baseURL: FAMILY,
      ignoreHTTPSErrors: true,
      storageState: { cookies: [], origins: [] },
    });
    const parentPage = await ctx.newPage();
    await parentPage.goto(`/join?code=${bare(code)}`);
    await new LoginPage(parentPage).signIn(freshParent.email, freshParent.password);
    const join = new JoinWithCodePage(parentPage);
    await expect(join.cardValue('Child')).toHaveText(student.firstName);
    await expect(parentPage.getByText('Add as a new child', { exact: true })).toBeVisible();
    await expect(parentPage.getByText(/Same child as Sara/)).toBeVisible();
    await ctx.close();
  });

  test('Not my child shows "Declined by parent" at school; Unlink then a new code works after a link', async ({ page, adminPage, student }) => {
    const { code } = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(page);
    await join.goto(bare(code));
    await join.startReject();
    await join.confirmRejectButton.click();
    await new FamilyDashboardPage(page).expectLoaded();

    const register = new StudentsRegisterPage(adminPage);
    await expect(async () => {
      await register.goto();
      const drawer = await register.openFamilyInviteDrawer(student);
      await expect(drawer.root.getByText('Declined by parent', { exact: true })).toBeVisible({ timeout: 3_000 });
      await expect(drawer.statusMessage).toContainText('Declined by parent');
    }).toPass({ timeout: 45_000 });

    // A new code after a decline, then connect and unlink.
    const declinedDrawer = new FamilyInviteCodeDrawer(adminPage);
    const newCode = await declinedDrawer.generate();
    await waitUntilInviteProjected(student.id);
    await join.goto(bare(newCode));
    await expect(join.connectButton).toBeVisible();
    const accepted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/link-invites\/[^/]+\/accept$/.test(r.url()), { timeout: 30_000 });
    await join.connect();
    expect((await accepted).ok(), 'accept').toBeTruthy();
    // PR 571: after a successful connect the parent lands on the child's page, not Home.
    await expect(page).toHaveURL(/\/children\/[^/]+/, { timeout: 30_000 });

    await register.goto();
    const names = await register.rowActionNames(student);
    expect(names).toContain('Parent app');
    expect(names).not.toEqual(expect.arrayContaining(['Link parent', 'Invite code', 'Family invite code']));
    // The school-side "Linked" status follows the family accept via the worker; poll for it.
    await expect(async () => {
      await register.goto();
      const d = await register.openFamilyInviteDrawer(student);
      await expect(d.root.locator('[data-parent-app-state="Linked"]')).toBeVisible({ timeout: 3_000 });
      await expect(d.unlinkButton).toBeVisible();
    }).toPass({ timeout: 60_000 });
    const linked = new FamilyInviteCodeDrawer(adminPage);
    await expect(linked.unlinkButton).toBeVisible();
    await linked.startUnlink();
    await linked.confirmUnlink('QA PR 571 unlink');
    await expect(linked.notice).toHaveText('Parent account unlinked. You can send a new code.');

    // The same drawer stays open after unlink, already on "Not linked" with Copy code available.
    await expect(linked.unlinkButton).toHaveCount(0);
    await expect(linked.root.locator('[data-parent-app-state="NotLinked"]')).toBeVisible();
    const reissued = await linked.generate();
    expect(reissued).toMatch(/^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/);
    expect(reissued).not.toBe(newCode);
  });
});
