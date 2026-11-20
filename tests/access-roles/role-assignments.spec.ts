/**
 * PR 549 — Role assignments to invited staff members (CU-z94x8ean2x), QA cycle 1.
 *
 * Self-seeding (local stack only): a throwaway campus with every pre-RBAC ("legacy") member shape the
 * 20261120_BindLegacyStaffAccounts data migration has to handle, plus a member invited through the real flow. The spec
 * forgets the migration in DataMigrationHistory and re-runs the post-deployment hook so the migration really runs over
 * the seeded rows. With QA_PR549_SEED_FILE set it instead reads a campus seeded on an older build before an upgrade
 * (the cycle's main -> PR upgrade run) and does not re-run anything first.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  ROLE, BIND_MIGRATION, LEGACY_LOCK, type LegacySeed, seedLegacyCampus, campusApi, forgetBindMigration, runPostDeployment,
  staffRoles, putStaffRoles, roleMembers, staffAccess, assignmentsOf, bindingsFor, addStaffWithContacts, mobile549, mongo, INVITES,
} from '../../fixtures/access-roles';
import { signInUi, sql, q, EVIDENCE_DIR, shot } from '../../fixtures/payroll';

test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 });

const ACCEPTED = 1; // StaffInviteStatus.Accepted as stored in Mongo
const NO_ACCOUNT = "This staff member hasn't accepted their app invite, so they can't hold a role yet.";
const OWN_ROLES = "You can't change your own roles.";
const BASE = process.env.QA_BASE_URL ?? 'https://localhost:7236';
const SEED_FILE = process.env.QA_PR549_SEED_FILE;

let seed: LegacySeed;
let owner: APIRequestContext;
const serverErrors: string[] = [];

const evidence = (name: string, data: unknown) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(`${EVIDENCE_DIR}/${name}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};

function watch5xx(page: Page) {
  page.on('response', r => { if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
}

async function openRoles(page: Page, staffId: string) {
  watch5xx(page);
  await signInUi(page, { identifier: seed.owner.phone, password: seed.owner.password }, `${BASE}/staff/register/${staffId}?tab=roles`);
  const card = page.locator('[data-staff-card="roles"]');
  await expect(card).toHaveAttribute('data-state', 'loaded', { timeout: 30_000 });
  return card;
}
const pills = (page: Page) => page.locator('[data-staff-card="roles"] [data-multiselect-pill]');
const accessBadge = (page: Page) => page.locator('[data-staff-card="access"] [data-access-badge]');

async function pickRole(page: Page, name: string) {
  await page.locator('#staff-roles').click();
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
  await page.keyboard.press('Escape');
}

async function saveRoles(page: Page, staffName: string) {
  await expect(page.locator('[data-roles-status]')).toHaveText('Unsaved changes');
  await page.locator('[data-action="save-roles"]').click();
  await expect(page.getByText(`Roles saved for ${staffName}`).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-roles-status]')).toHaveText('All changes saved');
}

async function removeOnRolePage(page: Page, roleId: string, staffName: string) {
  await page.goto(`${BASE}/setup/roles/${encodeURIComponent(roleId)}`);
  const row = page.locator('#role-members-table tr', { hasText: staffName });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button', { name: `Remove ${staffName}` }).click();
  const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).last();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^(Remove|Yes.*|Confirm)/ }).last().click();
  await expect(page.locator('#role-members-table tr', { hasText: staffName })).toHaveCount(0, { timeout: 15_000 });
}

test.beforeAll(async () => {
  if (SEED_FILE && existsSync(SEED_FILE)) {
    seed = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
  } else {
    seed = await seedLegacyCampus();
    await forgetBindMigration();
    const pd = await runPostDeployment();
    expect(pd.status, `post-deployment: ${pd.body}`).toBe(200);
  }
  owner = await campusApi(seed.owner.phone, seed.owner.password);
});

test('PR549 bind migration binds unique legacy matches and skips every ambiguous or ineligible one @smoke', async () => {
  const t = seed.tenantId;
  const report: Record<string, unknown> = {};
  for (const [label, s, a] of [['uniquePhone', seed.uniquePhone.staff, seed.uniquePhone.account], ['uniqueEmail', seed.uniqueEmail.staff, seed.uniqueEmail.account]] as const) {
    const b = await bindingsFor(t, s.id);
    report[label] = b;
    expect(b, `${label}: one binding`).toHaveLength(1);
    expect(b[0]).toMatchObject({ status: ACCEPTED, user: a.userId, by: 'System', provisioned: true, revoked: null });
  }
  for (const [label, s] of [
    ['oneUserTwoStaff[0]', seed.oneUserTwoStaff.staff[0]], ['oneUserTwoStaff[1]', seed.oneUserTwoStaff.staff[1]],
    ['twoUsersOneStaff', seed.twoUsersOneStaff.staff], ['leftStaff', seed.leftStaff.staff], ['outsider', seed.outsider.staff], ['creatorStaff', seed.creatorStaff.staff],
  ] as const) {
    const b = await bindingsFor(t, s.id);
    report[label] = b;
    expect(b, `${label}: no binding`).toHaveLength(0);
  }
  const invited = await bindingsFor(t, seed.invited.staff.id);
  report.invited = invited;
  expect(invited.filter(i => i.status === ACCEPTED), 'invited member keeps exactly its own accepted invite').toHaveLength(1);
  expect(invited[0].user).toBe(seed.invited.userId);
  expect(invited[0].by).not.toBe('System');
  // No account got a binding it did not have: nothing bound to the no-match / two-user accounts.
  const all = await mongo<any[]>(`return ${INVITES}.find({ TenantId: ${JSON.stringify(t)}, CreatedBy: 'System' }).toArray().map(i => i.AcceptedByUserId)`);
  expect(all.sort()).toEqual([seed.uniquePhone.account.userId, seed.uniqueEmail.account.userId].sort());
  expect((await sql(`select 1 from "DataMigrationHistory" where "Name"=${q(BIND_MIGRATION)}`)).length).toBe(1);
  evidence('ac-bind-migration-result.json', report);
});

test('PR549 unique legacy member (phone match): Roles tab shows Head Admin, App access Active; change and save work @smoke', async ({ page }) => {
  const { staff, account } = seed.uniquePhone;
  expect(await staffAccess(owner, staff.id)).toMatchObject({ status: 'Active', hasRoleAccount: true });
  const roles = await staffRoles(owner, staff.id);
  expect(roles.status).toBe(200);
  // Upgrade runs start from the backfilled Head Admin; a re-run keeps whatever an earlier run left, so seed it back.
  if (roles.body!.assignedRoleIds.join() !== ROLE.headAdmin.id) expect((await putStaffRoles(owner, staff.id, [ROLE.headAdmin.id])).status()).toBe(200);

  await openRoles(page, staff.id);
  await expect(pills(page)).toHaveText([ROLE.headAdmin.name]);
  await expect(accessBadge(page)).toHaveText('Active');
  await expect(page.locator('[data-roles-locked]')).toHaveCount(0);
  await page.screenshot({ path: shot('ac-legacy-unique-roles-head-admin.png'), fullPage: true });

  await pickRole(page, ROLE.teacher.name);
  await page.getByRole('button', { name: `Remove ${ROLE.headAdmin.name}` }).click();
  await expect(pills(page)).toHaveText([ROLE.teacher.name]);
  await saveRoles(page, staff.name);
  expect((await assignmentsOf(seed.tenantId, account.userId)).map(a => a.SystemRoleName)).toEqual([ROLE.teacher.name]);

  await page.reload();
  await expect(page.locator('[data-staff-card="roles"]')).toHaveAttribute('data-state', 'loaded', { timeout: 30_000 });
  await expect(pills(page)).toHaveText([ROLE.teacher.name]);
  await page.screenshot({ path: shot('ac-legacy-unique-roles-changed.png'), fullPage: true });
  expect((await roleMembers(owner, ROLE.headAdmin.id)).map(m => m.staffId)).not.toContain(staff.id);
  expect((await roleMembers(owner, ROLE.teacher.id)).map(m => m.staffId)).toContain(staff.id);
  expect(serverErrors).toEqual([]);
});

test('PR549 unique legacy member (e-mail match, other case): self-change refused; listed on Head Admin page; Remove there drops the role', async ({ page }) => {
  const { staff, account } = seed.uniqueEmail;
  if ((await staffRoles(owner, staff.id)).body!.assignedRoleIds.join() !== ROLE.headAdmin.id)
    expect((await putStaffRoles(owner, staff.id, [ROLE.headAdmin.id])).status()).toBe(200);
  const self = await campusApi(account.phone, account.password);
  const own = await putStaffRoles(self, staff.id, [ROLE.headAdmin.id, ROLE.teacher.id]);
  expect(own.status(), 'changing your own roles').toBe(400);
  expect(await own.text()).toContain(OWN_ROLES);
  await self.dispose();

  const members = await roleMembers(owner, ROLE.headAdmin.id);
  const me = members.find(m => m.staffId === staff.id);
  expect(me, 'bound legacy member listed on the Head Admin page').toBeTruthy();
  expect(me!.signInPhone).toBe(`+92${account.phone.slice(1)}`);

  watch5xx(page);
  await signInUi(page, { identifier: seed.owner.phone, password: seed.owner.password }, `${BASE}/setup/roles/${encodeURIComponent(ROLE.headAdmin.id)}`);
  await page.screenshot({ path: shot('ac-legacy-head-admin-members.png'), fullPage: true });
  await removeOnRolePage(page, ROLE.headAdmin.id, staff.name);
  expect(await assignmentsOf(seed.tenantId, account.userId)).toEqual([]);

  await page.goto(`${BASE}/staff/register/${staff.id}?tab=roles`);
  await expect(page.locator('[data-staff-card="roles"]')).toHaveAttribute('data-state', 'loaded', { timeout: 30_000 });
  await expect(pills(page)).toHaveCount(0);
  await expect(page.locator('[data-no-roles]')).toBeVisible();
  await expect(accessBadge(page)).toHaveText('Active');
  await page.screenshot({ path: shot('ac-legacy-email-removed-no-roles.png'), fullPage: true });
  expect(serverErrors).toEqual([]);
});

test('PR549 ambiguous legacy members: Roles tab locked with a clear message, nothing editable, save refused without a 500 @smoke', async ({ page }) => {
  const cases = [
    { label: 'one-user-two-staff-a', staff: seed.oneUserTwoStaff.staff[0] },
    { label: 'one-user-two-staff-b', staff: seed.oneUserTwoStaff.staff[1] },
    { label: 'two-users-one-staff', staff: seed.twoUsersOneStaff.staff },
  ];
  for (const c of cases) {
    expect(await staffAccess(owner, c.staff.id), c.label).toMatchObject({ status: 'Active', hasRoleAccount: false });
    const roles = await staffRoles(owner, c.staff.id);
    expect(roles.status, c.label).toBe(200);
    expect(roles.body!.assignedRoleIds, c.label).toEqual([]);
    const put = await putStaffRoles(owner, c.staff.id, [ROLE.teacher.id]);
    expect(put.status(), `${c.label} save`).toBe(400);
    expect(await put.text()).toContain(NO_ACCOUNT);
  }
  let first = true;
  for (const c of cases) {
    if (first) { await openRoles(page, c.staff.id); first = false; }
    else {
      await page.goto(`${BASE}/staff/register/${c.staff.id}?tab=roles`);
      await expect(page.locator('[data-staff-card="roles"]')).toHaveAttribute('data-state', 'loaded', { timeout: 30_000 });
    }
    await expect(page.locator('[data-roles-locked]')).toHaveText(LEGACY_LOCK(c.staff.name.split(' ')[0]));
    await expect(page.locator('[data-action="save-roles"]')).toHaveCount(0);
    await expect(page.locator('[data-no-roles]')).toHaveCount(0);
    await expect(page.locator('#staff-roles')).toBeDisabled();
    await expect(pills(page)).toHaveCount(0);
    await expect(accessBadge(page)).toHaveText('Active');
    await page.screenshot({ path: shot(`ac-legacy-${c.label}-locked.png`), fullPage: true });
  }
  expect(serverErrors).toEqual([]);
});

test('PR549 legacy leftovers: Left staffer, outsider account and campus creator are not bound; no-match holder keeps Head Admin', async ({ page }) => {
  // Left: mark-as-left offboarded the legacy account (membership + role) and the tab says why.
  expect((await staffAccess(owner, seed.leftStaff.staff.id)).status).not.toBe('Active');
  const left = await putStaffRoles(owner, seed.leftStaff.staff.id, [ROLE.teacher.id]);
  expect(left.status()).toBe(400);
  // Outsider: an account with the staffer's phone but no membership of this campus.
  expect((await staffAccess(owner, seed.outsider.staff.id)).status).not.toBe('Active');
  const out = await putStaffRoles(owner, seed.outsider.staff.id, [ROLE.teacher.id]);
  expect(out.status()).toBe(400);
  expect(await out.text()).toContain(NO_ACCOUNT);
  // Creator: excluded from the bind (Head Admin comes from Tenant.CreatedBy).
  expect(await staffAccess(owner, seed.creatorStaff.staff.id)).toMatchObject({ status: 'Active', hasRoleAccount: false });
  // No match: still holds the backfilled Head Admin and is not listed (it has no staffer).
  expect((await assignmentsOf(seed.tenantId, seed.noMatch.account.userId)).map(a => a.SystemRoleName)).toEqual([ROLE.headAdmin.name]);

  await openRoles(page, seed.leftStaff.staff.id);
  await expect(page.locator('[data-roles-locked]')).toContainText('is marked as left');
  await page.screenshot({ path: shot('ac-legacy-left-locked.png'), fullPage: true });
  await page.goto(`${BASE}/staff/register/${seed.outsider.staff.id}?tab=roles`);
  await expect(page.locator('[data-staff-card="roles"]')).toHaveAttribute('data-state', 'loaded', { timeout: 30_000 });
  await expect(page.locator('[data-roles-locked]')).toContainText("doesn't have a Marksheet+ login yet");
  await page.screenshot({ path: shot('ac-legacy-outsider-locked.png'), fullPage: true });
  await page.goto(`${BASE}/staff/register/${seed.creatorStaff.staff.id}?tab=roles`);
  await expect(page.locator('[data-staff-card="roles"]')).toHaveAttribute('data-state', 'loaded', { timeout: 30_000 });
  await page.screenshot({ path: shot('ac-legacy-creator-roles.png'), fullPage: true });
  expect(serverErrors).toEqual([]);
});

test('PR549 bind migration is idempotent: re-running the hook (with and without its history row) adds nothing', async () => {
  const count = async () => (await mongo<any[]>(`return ${INVITES}.find({ TenantId: ${JSON.stringify(seed.tenantId)} }).toArray().map(i => i.StaffMemberId + '|' + i.AcceptedByUserId + '|' + i.Status)`)).sort();
  const before = await count();
  const rerun = await runPostDeployment();
  expect(rerun.status, rerun.body).toBe(200);
  expect(await count()).toEqual(before);
  await forgetBindMigration();
  const forced = await runPostDeployment();
  expect(forced.status, forced.body).toBe(200);
  const after = await count();
  expect(after).toEqual(before);
  expect(new Set(after.filter(r => r.endsWith(`|${ACCEPTED}`)).map(r => r.split('|')[0])).size, 'one accepted invite per staffer').toBe(after.filter(r => r.endsWith(`|${ACCEPTED}`)).length);
  expect((await sql(`select 1 from "DataMigrationHistory" where "Name"=${q(BIND_MIGRATION)}`)).length).toBe(1);
  evidence('ac-bind-idempotent.json', { before, after });
});

test('PR549 invited member: default role shown; assign, view, change and remove roles; App access stays Active @smoke', async ({ page }) => {
  const { staff, userId } = seed.invited;
  // Start from the role the invite provisioned (Teacher), whatever an earlier run left.
  if ((await staffRoles(owner, staff.id)).body!.assignedRoleIds.join() !== ROLE.teacher.id)
    expect((await putStaffRoles(owner, staff.id, [ROLE.teacher.id])).status()).toBe(200);
  expect(await staffAccess(owner, staff.id)).toMatchObject({ status: 'Active', hasRoleAccount: true });

  await openRoles(page, staff.id);
  await expect(pills(page)).toHaveText([ROLE.teacher.name]);
  await expect(accessBadge(page)).toHaveText('Active');
  await page.screenshot({ path: shot('ac-invited-roles-default.png'), fullPage: true });

  await pickRole(page, ROLE.accountant.name);
  await saveRoles(page, staff.name);
  await page.reload();
  await expect(page.locator('[data-staff-card="roles"]')).toHaveAttribute('data-state', 'loaded', { timeout: 30_000 });
  await expect(pills(page)).toHaveText([ROLE.accountant.name, ROLE.teacher.name].sort());
  expect((await assignmentsOf(seed.tenantId, userId)).map(a => a.SystemRoleName)).toEqual([ROLE.accountant.name, ROLE.teacher.name]);
  expect((await roleMembers(owner, ROLE.accountant.id)).map(m => m.staffId)).toContain(staff.id);
  await page.screenshot({ path: shot('ac-invited-roles-two.png'), fullPage: true });

  await page.getByRole('button', { name: `Remove ${ROLE.teacher.name}` }).click();
  await saveRoles(page, staff.name);
  expect((await assignmentsOf(seed.tenantId, userId)).map(a => a.SystemRoleName)).toEqual([ROLE.accountant.name]);

  await removeOnRolePage(page, ROLE.accountant.id, staff.name);
  expect(await assignmentsOf(seed.tenantId, userId)).toEqual([]);
  await page.goto(`${BASE}/staff/register/${staff.id}?tab=roles`);
  await expect(page.locator('[data-staff-card="roles"]')).toHaveAttribute('data-state', 'loaded', { timeout: 30_000 });
  await expect(pills(page)).toHaveCount(0);
  await expect(page.locator('[data-no-roles]')).toBeVisible();
  await expect(accessBadge(page)).toHaveText('Active');
  await page.screenshot({ path: shot('ac-invited-roles-none.png'), fullPage: true });
  expect(serverErrors).toEqual([]);
});

test('PR549 Add members drawer adds an invited member; legacy and uninvited staff are not addable', async ({ page }) => {
  const { staff, userId } = seed.invited;
  if ((await staffRoles(owner, staff.id)).body!.assignedRoleIds.length) expect((await putStaffRoles(owner, staff.id, [])).status()).toBe(200);
  const cand = await owner.get(`access-roles/${encodeURIComponent(ROLE.campusManager)}/member-candidates`);
  expect(cand.status()).toBe(200);
  const candidates = await cand.json();
  evidence('ac-candidates-campus-manager.json', candidates);

  watch5xx(page);
  await signInUi(page, { identifier: seed.owner.phone, password: seed.owner.password }, `${BASE}/setup/roles/${encodeURIComponent(ROLE.campusManager)}`);
  await page.locator('[data-action="add-members"]').first().click();
  const drawer = page.locator('[data-add-members]');
  await expect(drawer).toHaveAttribute('data-state', /loaded|ready|idle/, { timeout: 30_000 }).catch(() => {});
  const row = drawer.locator(`[data-candidate="${staff.id}"]`);
  await expect(row).toHaveAttribute('data-eligibility', 'eligible');
  for (const s of [seed.oneUserTwoStaff.staff[0], seed.twoUsersOneStaff.staff]) {
    await expect(drawer.locator(`[data-candidate="${s.id}"]`)).not.toHaveAttribute('data-eligibility', 'eligible');
    await expect(drawer.locator(`[data-candidate="${s.id}"]`).getByRole('checkbox')).toBeDisabled();
  }
  await drawer.locator(`[data-candidate="${seed.twoUsersOneStaff.staff.id}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot('ac-add-members-drawer.png') });
  await row.getByRole('checkbox').check();
  await page.locator('[data-action="confirm-add-members"]').click();
  await expect(page.locator('#role-members-table tr', { hasText: staff.name })).toBeVisible({ timeout: 15_000 });
  expect((await assignmentsOf(seed.tenantId, userId)).map(a => a.SystemRoleName)).toEqual([ROLE.campusManager]);

  const bad = await owner.post(`access-roles/${encodeURIComponent(ROLE.campusManager)}/members`, { data: { staffIds: [seed.oneUserTwoStaff.staff[0].id] } });
  expect(bad.status(), 'adding an ambiguous legacy staffer').toBe(400);
  expect(serverErrors).toEqual([]);
});

test('PR549 staff without an accepted invite: Roles tab locked (not invited / invite pending), save refused', async ({ page }) => {
  const s = await addStaffWithContacts(owner, { first: 'Uninvited', phone: mobile549() });
  const put = await putStaffRoles(owner, s.id, [ROLE.teacher.id]);
  expect(put.status()).toBe(400);
  expect(await put.text()).toContain(NO_ACCOUNT);
  await openRoles(page, s.id);
  await expect(page.locator('[data-roles-locked]')).toContainText("doesn't have a Marksheet+ login yet");
  await expect(page.locator('[data-action="save-roles"]')).toHaveCount(0);
  const send = await owner.post(`staff/${s.id}/app-access/invite`);
  expect(send.status()).toBeLessThan(300);
  await page.reload();
  await expect(page.locator('[data-staff-card="roles"]')).toHaveAttribute('data-state', 'loaded', { timeout: 30_000 });
  await expect(page.locator('[data-roles-locked]')).toContainText("hasn't accepted the app invite yet");
  await page.screenshot({ path: shot('ac-pending-invite-locked.png'), fullPage: true });
  expect((await putStaffRoles(owner, s.id, [ROLE.teacher.id])).status()).toBe(400);
  expect(serverErrors).toEqual([]);
});

test('PR549 permissions: a Teacher cannot read or change roles (403) and anonymous calls get 401 @smoke', async ({ playwright }) => {
  const { staff } = seed.invited;
  expect((await putStaffRoles(owner, staff.id, [ROLE.teacher.id])).status()).toBe(200);
  const teacher = await campusApi(seed.invited.phone, seed.invited.password);
  const target = seed.uniquePhone.staff.id;
  const calls = {
    getStaffRoles: await teacher.get(`staff/${target}/access-roles`),
    putStaffRoles: await putStaffRoles(teacher, target, [ROLE.headAdmin.id]),
    members: await teacher.get(`access-roles/${encodeURIComponent(ROLE.headAdmin.id)}/members`),
    candidates: await teacher.get(`access-roles/${encodeURIComponent(ROLE.headAdmin.id)}/member-candidates`),
    addMembers: await teacher.post(`access-roles/${encodeURIComponent(ROLE.headAdmin.id)}/members`, { data: { staffIds: [staff.id] } }),
    removeMember: await teacher.delete(`access-roles/${encodeURIComponent(ROLE.teacher.id)}/members/${target}`),
  };
  const statuses = Object.fromEntries(Object.entries(calls).map(([k, r]) => [k, r.status()]));
  const anon = await playwright.request.newContext({ ignoreHTTPSErrors: true, baseURL: `${process.env.QA_REST_API_URL}/` });
  statuses.anonymousPut = (await putStaffRoles(anon, target, [ROLE.headAdmin.id])).status();
  evidence('ac-permissions.json', statuses);
  for (const [k, v] of Object.entries(statuses)) expect(v, k).toBe(k.startsWith('anonymous') ? 401 : 403);
  expect((await assignmentsOf(seed.tenantId, seed.invited.userId)).map(a => a.SystemRoleName)).toEqual([ROLE.teacher.name]);
  await teacher.dispose(); await anon.dispose();
});

// Known finding, kept last: serial mode skips everything after a failure.
test('PR549 C1-ROLE-COUNT-HIDDEN-HOLDERS: a role\'s member count matches the members it lists', async ({ page }) => {
  const detail = await (await owner.get(`access-roles/${encodeURIComponent(ROLE.headAdmin.id)}`)).json();
  const listed = await roleMembers(owner, ROLE.headAdmin.id);
  evidence('bug-role-count-hidden-holders.json', { memberCount: detail.memberCount, listed: listed.map(m => m.name) });
  watch5xx(page);
  await signInUi(page, { identifier: seed.owner.phone, password: seed.owner.password }, `${BASE}/setup/roles/${encodeURIComponent(ROLE.headAdmin.id)}`);
  await expect(page.locator('[data-role-members]')).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: shot('bug-role-count-hidden-holders.png'), fullPage: true });
  // Unbound legacy holders (ambiguous / no staffer) are counted but never listed, so nobody can see or remove their Head Admin.
  expect(detail.memberCount, 'Head Admin "N members" vs rows listed').toBe(listed.length);
});
