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
  OWNER_GUARD, LAST_HEAD_ADMIN_GUARD, removeRoleAccount, roleMemberCount, inviteAndAccept, letters,
} from '../../fixtures/access-roles';
import { signInUi, sql, sqlExec, q, EVIDENCE_DIR, shot, markLeft } from '../../fixtures/payroll';

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
    await expect(drawer.locator(`[data-candidate="${s.id}"]`)).toHaveAttribute('data-eligibility', 'legacyaccess');
    await expect(drawer.locator(`[data-candidate="${s.id}"] [data-reason]`)).toHaveText('App access active (legacy)');
    await expect(drawer.locator(`[data-candidate="${s.id}"]`).getByRole('checkbox')).toBeDisabled();
  }
  const creator = drawer.locator(`[data-candidate="${seed.creatorStaff.staff.id}"]`);
  await expect(creator).toHaveAttribute('data-eligibility', 'campusowner');
  await expect(creator.locator('[data-reason]')).toHaveText('Campus owner (holds Head Admin)');
  await expect(creator.getByRole('checkbox')).toBeDisabled();
  await creator.scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot('c2-drawer-legacy-owner-labels.png') });
  await drawer.locator(`[data-candidate="${seed.twoUsersOneStaff.staff.id}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot('ac-add-members-drawer.png') });
  await row.getByRole('checkbox').check();
  await page.locator('[data-action="confirm-add-members"]').click();
  await expect(page.locator('#role-members-table tr', { hasText: staff.name })).toBeVisible({ timeout: 15_000 });
  expect((await assignmentsOf(seed.tenantId, userId)).map(a => a.SystemRoleName)).toEqual([ROLE.campusManager]);

  const bad = await owner.post(`access-roles/${encodeURIComponent(ROLE.campusManager)}/members`, { data: { staffIds: [seed.oneUserTwoStaff.staff[0].id] } });
  expect(bad.status(), 'adding an ambiguous legacy staffer').toBe(400);
  const badOwner = await owner.post(`access-roles/${encodeURIComponent(ROLE.campusManager)}/members`, { data: { staffIds: [seed.creatorStaff.staff.id] } });
  expect(badOwner.status(), 'adding the campus owner\'s staff record').toBe(400);
  evidence('c2-drawer-direct-post.json', { legacy: { status: bad.status(), body: await bad.text() }, owner: { status: badOwner.status(), body: await badOwner.text() } });
  expect((await assignmentsOf(seed.tenantId, seed.oneUserTwoStaff.account.userId)).map(a => a.SystemRoleName)).not.toContain(ROLE.campusManager);
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

test('PR549 C2 legacy holders are listed as "Legacy login" rows; count matches rows; Remove revokes the role @smoke', async ({ page }) => {
  const legacy = [seed.oneUserTwoStaff.account, ...seed.twoUsersOneStaff.accounts, seed.noMatch.account];
  for (const a of legacy) {
    if (!(await assignmentsOf(seed.tenantId, a.userId)).some(x => x.SystemRoleName === ROLE.headAdmin.name))
      await sqlExec(`insert into "AccessRoleAssignments" ("Id","TenantId","UserId","AccessRoleId","SystemRoleName","Scope","CreatedDate","CreatedBy") values (gen_random_uuid(), ${q(seed.tenantId)}, ${q(a.userId)}, null, 'Head Admin', 'Tenant', now(), 'System')`);
  }
  const members = await roleMembers(owner, ROLE.headAdmin.id);
  const count = await roleMemberCount(owner, ROLE.headAdmin.id);
  evidence('c2-head-admin-members.json', { count, members });
  expect(count, 'Head Admin "N members" equals rows listed').toBe(members.length);
  for (const a of legacy) {
    const row = members.find(m => m.userId === a.userId);
    expect(row, `legacy holder ${a.first} listed`).toBeTruthy();
    expect(row).toMatchObject({ isLegacy: true, staffId: null, name: `${a.first} Legacy`, removeBlockedReason: null });
  }
  watch5xx(page);
  await signInUi(page, { identifier: seed.owner.phone, password: seed.owner.password }, `${BASE}/setup/roles/${encodeURIComponent(ROLE.headAdmin.id)}`);
  await expect(page.locator('#role-members-table')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-legacy="true"]')).toHaveCount(legacy.length);
  await expect(page.getByText(`${members.length} member`, { exact: false }).first()).toBeVisible();
  const legacyRow = page.locator('#role-members-table tr', { hasText: `${seed.noMatch.account.first} Legacy` });
  await expect(legacyRow.locator('[data-legacy-badge]')).toHaveText('Legacy login');
  await expect(legacyRow.locator('[data-member-contacts]')).toContainText(`+92${seed.noMatch.account.phone.slice(1)}`);
  await page.screenshot({ path: shot('c2-legacy-rows.png'), fullPage: true });

  await removeOnRolePage(page, ROLE.headAdmin.id, `${seed.noMatch.account.first} Legacy`);
  expect(await assignmentsOf(seed.tenantId, seed.noMatch.account.userId)).toEqual([]);
  expect(await roleMemberCount(owner, ROLE.headAdmin.id)).toBe(members.length - 1);
  expect((await roleMembers(owner, ROLE.headAdmin.id)).length).toBe(members.length - 1);
  // Access really goes: a fresh sign-in carries no permissions and the role screens refuse it.
  const after = await campusApi(seed.noMatch.account.phone, seed.noMatch.account.password);
  const status = (await after.get('access-roles')).status();
  await after.dispose();
  evidence('c2-legacy-removed-login.json', { getAccessRoles: status });
  expect(status).toBe(403);
  expect(serverErrors).toEqual([]);
});

test('PR549 C2 a Left staffer who still holds a role shows as a legacy row and can be removed', async ({ page }) => {
  const phone = mobile549(); const email = `pr549-leaver+${letters(6)}@testenv.local`;
  const s = await addStaffWithContacts(owner, { first: 'Leaver', phone, email });
  const acc = await inviteAndAccept(owner, s.id, email);
  expect((await assignmentsOf(seed.tenantId, acc.userId)).map(a => a.SystemRoleName)).toEqual([ROLE.teacher.name]);
  await markLeft(owner, s.id, new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
  const left = await assignmentsOf(seed.tenantId, acc.userId);
  const members = await roleMembers(owner, ROLE.teacher.id);
  const row = members.find(m => m.userId === acc.userId);
  evidence('c2-left-holder.json', { assignmentsAfterLeft: left, row, count: await roleMemberCount(owner, ROLE.teacher.id), rows: members.length });
  expect(await roleMemberCount(owner, ROLE.teacher.id)).toBe(members.length);
  // Mark-as-left takes the role away itself; a Left holder only exists from older data, so put one back the way such data looks.
  expect(left, 'mark-as-left removes the role').toEqual([]);
  expect(row, 'no row once mark-as-left removed the role').toBeUndefined();
  await sqlExec(`insert into "AccessRoleAssignments" ("Id","TenantId","UserId","AccessRoleId","SystemRoleName","Scope","CreatedDate","CreatedBy") values (gen_random_uuid(), ${q(seed.tenantId)}, ${q(acc.userId)}, null, 'Teacher', 'Tenant', now(), 'System')`);
  const membersAfter = await roleMembers(owner, ROLE.teacher.id);
  const leftRow = membersAfter.find(m => m.userId === acc.userId);
  const leftAccess = await campusApi(phone, acc.password).then(async a => { const st = (await a.get('access-roles')).status(); await a.dispose(); return st; }).catch(e => `sign-in refused: ${String(e).slice(0, 200)}`);
  evidence('c2-left-holder-restored.json', { row: leftRow, count: await roleMemberCount(owner, ROLE.teacher.id), rows: membersAfter.length, leftAccountAccessRolesGet: leftAccess });
  expect(await roleMemberCount(owner, ROLE.teacher.id)).toBe(membersAfter.length);
  const row2 = leftRow;
  expect(row2, 'Left holder listed').toBeTruthy();
  expect(row2).toMatchObject({ isLegacy: true, staffId: null, removeBlockedReason: null });
  watch5xx(page);
  await signInUi(page, { identifier: seed.owner.phone, password: seed.owner.password }, `${BASE}/setup/roles/${encodeURIComponent(ROLE.teacher.id)}`);
  await expect(page.locator('#role-members-table')).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: shot('c2-left-holder-row.png'), fullPage: true });
  await removeOnRolePage(page, ROLE.teacher.id, row2!.name);
  expect(await assignmentsOf(seed.tenantId, acc.userId)).toEqual([]);
  expect(serverErrors).toEqual([]);
});

const insertAssignment = (tenantId: string, userId: string, role: string) => sqlExec(`insert into "AccessRoleAssignments" ("Id","TenantId","UserId","AccessRoleId","SystemRoleName","Scope","CreatedDate","CreatedBy") values (gen_random_uuid(), ${q(tenantId)}, ${q(userId)}, null, ${q(role)}, 'Tenant', now(), 'System')`);
const haMembersPath = (staffId: string) => `access-roles/${encodeURIComponent(ROLE.headAdmin.id)}/members/${staffId}`;
async function invitedStaff(api: APIRequestContext, first: string) {
  const phone = mobile549(); const email = `pr549-${first.toLowerCase()}+${letters(6)}@testenv.local`;
  const staff = await addStaffWithContacts(api, { first, phone, email });
  const acc = await inviteAndAccept(api, staff.id, email);
  return { staff, phone, ...acc };
}
async function removeButton(page: Page, roleId: string, userId: string) {
  await page.goto(`${BASE}/setup/roles/${encodeURIComponent(roleId)}`);
  const row = page.locator(`#role-members-table [data-member="${userId}"]`).locator('xpath=ancestor::tr');
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row.locator('[data-action="remove-member"]');
}
async function untickHeadAdminOnRolesTab(page: Page, staffId: string) {
  await page.goto(`${BASE}/staff/register/${staffId}?tab=roles`);
  await expect(page.locator('[data-staff-card="roles"]')).toHaveAttribute('data-state', 'loaded', { timeout: 30_000 });
  await page.getByRole('button', { name: `Remove ${ROLE.headAdmin.name}` }).click();
}

test('PR549 C3 guard with an owner: the only other Head Admin can be removed on every path (Remove shown); the owner\'s roles stay protected', async ({ page, browser }) => {
  const t = seed.tenantId; const log: Record<string, any> = {};
  const ha = (u: string) => assignmentsOf(t, u).then(a => a.filter(x => x.SystemRoleName === ROLE.headAdmin.name));

  // (b) Owner: give the creator explicit Head Admin and Teacher rows; another Head Admin tries to remove them.
  const ga = await invitedStaff(owner, 'Guardadmin');
  expect((await putStaffRoles(owner, ga.staff.id, [ROLE.headAdmin.id])).status()).toBe(200);
  const admin = await campusApi(ga.phone, ga.password);
  if (!(await assignmentsOf(t, seed.owner.userId)).length) {
    await insertAssignment(t, seed.owner.userId, 'Teacher');
    await insertAssignment(t, seed.owner.userId, 'Head Admin');
  }
  for (const r of [ROLE.teacher, ROLE.headAdmin]) {
    const row = (await roleMembers(admin, r.id)).find(m => m.userId === seed.owner.userId);
    expect(row?.removeBlockedReason, `owner row on ${r.name}`).toBe(OWNER_GUARD);
    const del = await removeRoleAccount(admin, r.id, seed.owner.userId);
    log[`owner_${r.name}_remove`] = { status: del.status(), body: await del.text() };
    expect(del.status()).toBe(400); expect(log[`owner_${r.name}_remove`].body).toContain(OWNER_GUARD);
  }
  const untickOwner = await putStaffRoles(admin, seed.creatorStaff.staff.id, [ROLE.teacher.id]);
  log.owner_staff_roles_tab = { status: untickOwner.status(), body: await untickOwner.text() };
  expect(untickOwner.status(), 'creator Roles tab').toBe(400);
  const ownerSelf = await removeRoleAccount(owner, ROLE.headAdmin.id, seed.owner.userId);
  log.owner_self_remove = { status: ownerSelf.status(), body: await ownerSelf.text() };
  expect(ownerSelf.status()).toBe(400);
  expect((await assignmentsOf(t, seed.owner.userId)).map(a => a.SystemRoleName).sort()).toEqual([ROLE.headAdmin.name, ROLE.teacher.name]);
  await admin.dispose();
  const gaCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const gaPage = await gaCtx.newPage();
  await signInUi(gaPage, { identifier: ga.phone, password: ga.password }, `${BASE}/setup/roles/${encodeURIComponent(ROLE.headAdmin.id)}`);
  await expect(await removeButton(gaPage, ROLE.headAdmin.id, seed.owner.userId)).toHaveCount(0);
  await gaPage.screenshot({ path: shot('c3-owner-row-no-remove.png'), fullPage: true });
  await gaCtx.close();
  watch5xx(page);
  await sqlExec(`delete from "AccessRoleAssignments" where "TenantId" = ${q(t)} and "UserId" = ${q(seed.owner.userId)} and "SystemRoleName" = 'Head Admin'`);

  // (a) Owner plus one other Head Admin, on each path in turn (owner acts).
  const others = (await roleMembers(owner, ROLE.headAdmin.id)).filter(m => m.userId !== seed.owner.userId).sort((a, b) => Number(a.isLegacy) - Number(b.isLegacy));
  expect(others.some(m => m.isLegacy), 'a legacy holder is left to test with').toBe(true);
  for (const m of others.slice(0, -1)) {
    const r = m.staffId ? await owner.delete(haMembersPath(m.staffId)) : await removeRoleAccount(owner, ROLE.headAdmin.id, m.userId!);
    expect(r.status(), `remove ${m.name}: ${await r.text()}`).toBeLessThan(300);
  }
  const legacyLast = await roleMembers(owner, ROLE.headAdmin.id);
  expect(legacyLast).toHaveLength(1); expect(legacyLast[0].isLegacy).toBe(true);
  expect(legacyLast[0].removeBlockedReason, 'only other Head Admin (legacy) is removable').toBeNull();
  log.legacy_only_other = legacyLast[0];
  await signInUi(page, { identifier: seed.owner.phone, password: seed.owner.password }, `${BASE}/setup/roles/${encodeURIComponent(ROLE.headAdmin.id)}`);
  await expect(await removeButton(page, ROLE.headAdmin.id, legacyLast[0].userId!)).toHaveCount(1);
  await page.screenshot({ path: shot('c3-owner-plus-legacy-remove-shown.png'), fullPage: true });
  await removeOnRolePage(page, ROLE.headAdmin.id, legacyLast[0].name);  // legacy-account path
  expect(await ha(legacyLast[0].userId!)).toEqual([]);

  const s1 = seed.uniquePhone.staff; const s1User = seed.uniquePhone.account.userId;
  expect((await putStaffRoles(owner, s1.id, [ROLE.headAdmin.id])).status()).toBe(200);
  const s1Row = (await roleMembers(owner, ROLE.headAdmin.id));
  expect(s1Row.map(m => m.userId)).toEqual([s1User]);
  expect(s1Row[0].removeBlockedReason).toBeNull();
  await expect(await removeButton(page, ROLE.headAdmin.id, s1User)).toHaveCount(1);
  await page.screenshot({ path: shot('c3-owner-plus-staff-remove-shown.png'), fullPage: true });
  const staffDel = await owner.delete(haMembersPath(s1.id));                     // staff-member path
  log.staff_path = { status: staffDel.status(), body: await staffDel.text() };
  expect(staffDel.status()).toBe(204);
  expect(await ha(s1User)).toEqual([]);

  expect((await putStaffRoles(owner, s1.id, [ROLE.headAdmin.id])).status()).toBe(200);
  await untickHeadAdminOnRolesTab(page, s1.id);                                    // Roles tab untick
  await saveRoles(page, s1.name);
  await page.screenshot({ path: shot('c3-owner-plus-roles-tab-untick-saved.png'), fullPage: true });
  expect(await assignmentsOf(t, s1User)).toEqual([]);
  expect(await roleMembers(owner, ROLE.headAdmin.id)).toEqual([]);
  expect(await roleMemberCount(owner, ROLE.headAdmin.id)).toBe(0);
  log.owner_still_head_admin_get = (await owner.get(`access-roles/${encodeURIComponent(ROLE.headAdmin.id)}`)).status();
  expect(log.owner_still_head_admin_get).toBe(200);
  evidence('c3-guard-with-owner.json', log);
  expect(serverErrors).toEqual([]);
});

test('PR549 C3 guard on a campus with no owner: the last Head Admin is blocked on every path and Remove is hidden', async ({ page }) => {
  const t = seed.tenantId; const log: Record<string, any> = {};
  // "No owner" = an empty Tenant.CreatedBy (the field is required, so it can't be absent; AccessRoleGuards treats empty as no owner).
  // Actor: a staffer on a custom copy of Head Admin (all its permissions, but not a Head Admin holder).
  const detail = await (await owner.get(`access-roles/${encodeURIComponent(ROLE.headAdmin.id)}`)).json();
  const copy = await owner.post('access-roles', { data: { sourceSystemRole: ROLE.headAdmin.name, roleName: `HA Copy ${letters(5)}`, description: 'QA actor', permissions: detail.permissions } });
  expect(copy.status(), await copy.text()).toBe(201);
  const copyId = (await copy.json()).id as string;
  const actorStaff = await invitedStaff(owner, 'Guardactor');
  expect((await putStaffRoles(owner, actorStaff.staff.id, [copyId])).status()).toBe(200);
  await sqlExec(`delete from "AccessRoleAssignments" where "TenantId" = ${q(t)} and "UserId" = ${q(seed.owner.userId)}`);
  const ownerId = await mongo<string>(`const r = db.tenants.findOne({ _id: ObjectId(${JSON.stringify(t)}) }); db.tenants.updateOne({ _id: r._id }, { $set: { CreatedBy: '' } }); return r.CreatedBy`);
  expect(ownerId).toBe(seed.owner.userId);
  try {
    const actor = await campusApi(actorStaff.phone, actorStaff.password);
    // Last holder is a legacy login.
    const legacy = seed.noMatch.account;
    await insertAssignment(t, legacy.userId, 'Head Admin');
    const rows = await roleMembers(actor, ROLE.headAdmin.id);
    log.legacy_last_rows = rows;
    expect(rows.map(m => m.userId)).toEqual([legacy.userId]);
    expect(rows[0].removeBlockedReason).toBe(LAST_HEAD_ADMIN_GUARD);
    const accDel = await removeRoleAccount(actor, ROLE.headAdmin.id, legacy.userId);
    log.legacy_account_path = { status: accDel.status(), body: await accDel.text() };
    expect(accDel.status()).toBe(400); expect(log.legacy_account_path.body).toContain(LAST_HEAD_ADMIN_GUARD);
    watch5xx(page);
    await signInUi(page, { identifier: actorStaff.phone, password: actorStaff.password }, `${BASE}/setup/roles/${encodeURIComponent(ROLE.headAdmin.id)}`);
    await expect(await removeButton(page, ROLE.headAdmin.id, legacy.userId)).toHaveCount(0);
    await page.screenshot({ path: shot('c3-no-owner-legacy-last-no-remove.png'), fullPage: true });

    // Hand Head Admin to a bound staffer, drop the legacy login: the staffer is the last holder.
    const s1 = seed.uniquePhone.staff; const s1User = seed.uniquePhone.account.userId;
    expect((await putStaffRoles(actor, s1.id, [ROLE.headAdmin.id])).status()).toBe(200);
    expect((await removeRoleAccount(actor, ROLE.headAdmin.id, legacy.userId)).status()).toBe(204);
    const staffDel = await actor.delete(haMembersPath(s1.id));
    log.staff_path = { status: staffDel.status(), body: await staffDel.text() };
    expect(staffDel.status()).toBe(400); expect(log.staff_path.body).toContain(LAST_HEAD_ADMIN_GUARD);
    const untick = await putStaffRoles(actor, s1.id, []);
    log.roles_tab_api = { status: untick.status(), body: await untick.text() };
    expect(untick.status()).toBe(400); expect(log.roles_tab_api.body).toContain(LAST_HEAD_ADMIN_GUARD);
    await expect(await removeButton(page, ROLE.headAdmin.id, s1User)).toHaveCount(0);
    await page.screenshot({ path: shot('c3-no-owner-staff-last-no-remove.png'), fullPage: true });
    await untickHeadAdminOnRolesTab(page, s1.id);
    await page.locator('[data-action="save-roles"]').click();
    await expect(page.locator('[data-roles-error]')).toContainText(LAST_HEAD_ADMIN_GUARD, { timeout: 15_000 });
    await page.screenshot({ path: shot('c3-no-owner-roles-tab-untick-refused.png'), fullPage: true });
    expect((await assignmentsOf(t, s1User)).map(a => a.SystemRoleName)).toEqual([ROLE.headAdmin.name]);
    // Probe (logged, not asserted): CreatedBy naming an account that no longer exists.
    await mongo(`db.tenants.updateOne({ _id: ObjectId(${JSON.stringify(t)}) }, { $set: { CreatedBy: '000000000000000000000000' } }); return 1`);
    log.probe_dangling_owner_row = (await roleMembers(actor, ROLE.headAdmin.id)).map(m => ({ name: m.name, removeBlockedReason: m.removeBlockedReason }));
    await actor.dispose();
    evidence('c3-guard-no-owner.json', log);
    expect(serverErrors).toEqual([]);
  } finally {
    await mongo(`db.tenants.updateOne({ _id: ObjectId(${JSON.stringify(t)}) }, { $set: { CreatedBy: ${JSON.stringify(ownerId)} } }); return 1`);
  }
});
