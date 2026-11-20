/**
 * PR 549 (role assignments to invited staff, CU-z94x8ean2x): local-stack helpers for the Roles tab, the role page's
 * members, staff invites, and pre-RBAC ("legacy") campus members. Legacy members are seeded the way they exist in
 * production: an account with a Campus membership, a Head Admin assignment written by the 20260705 backfill, and no
 * staff invite. Writes go to the throwaway stack's Mongo / Postgres only.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { AUTH_APP, REST_API } from './campus-owner';
import { DESIGNATION, karachiToday, q, sql, sqlExec } from './payroll';

const run = promisify(execFile);
const OTP = process.env.QA_OTP ?? '000000';

export const ROLE = {
  headAdmin: { id: 'Head Admin', name: 'Head Admin' },
  teacher: { id: 'Teacher', name: 'Teacher' },
  accountant: { id: 'Accountant', name: 'Accountant' },
  campusManager: 'Campus Manager',
} as const;
export const BIND_MIGRATION = '20261120_BindLegacyStaffAccounts';
export const LEGACY_LOCK = (first: string) => `${first}'s login was set up before app invites, so roles can't be changed here yet.`;

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
export const letters = (n: number) => Array.from({ length: n }, () => LETTERS[randomInt(LETTERS.length)]).join('');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Throwaway 03xx mobile reserved for these specs (03{40-49}549xxxx). */
export const mobile549 = () => `03${randomInt(40, 50)}549${String(randomInt(0, 10_000)).padStart(4, '0')}`;
export const intl = (local: string) => `+92${local.slice(1)}`;
const randomPassword = () => `Qa!${randomBytes(9).toString('base64url')}9a`;

// ── Mongo (stack-local, through ci/bin/mongosh) ─────────────────────────────────────────────────
export async function mongo<T = any>(script: string): Promise<T> {
  const bin = process.env.QA_MONGOSH ?? 'mongosh';
  const url = process.env.QA_MONGO_URL ?? 'mongodb://localhost:27017/mp-accounts-db';
  const { stdout } = await run(bin, [url, '--quiet', '--eval', `print(EJSON.stringify((() => { ${script} })(), {relaxed: true}))`], { maxBuffer: 20 * 1024 * 1024 });
  const out = stdout.trim().split('\n').pop() ?? 'null';
  return JSON.parse(out === 'undefined' ? 'null' : out);
}
/** The staff-invite collection (EF Core Mongo names it after the DbSet, lower-cased like the others). */
export const INVITES = `(db.getCollectionNames().includes('staffinvites') ? db.staffinvites : db.StaffInvites)`;

// ── Accounts ────────────────────────────────────────────────────────────────────────────────────
export interface Account { userId: string; phone: string; email: string; password: string; first: string }

/** Registers + verifies a platform account with no tenant (AuthApp /account/register). */
export async function registerAccount(first: string, opts: { phone?: string; email?: string } = {}): Promise<Account> {
  const c = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  const password = randomPassword();
  let phone = opts.phone ?? mobile549();
  const email = opts.email ?? `pr549-${first.toLowerCase()}+${letters(6)}@testenv.local`;
  try {
    const reg = () => c.post(`${AUTH_APP}/account/register`, {
      data: { firstName: first, lastName: 'Legacy', phoneNumber: phone, email, password, recaptchaToken: null, returnUrl: null },
    });
    let res = await reg();
    for (let i = 1; res.status() === 409 && !opts.phone && i < 4; i++) { phone = mobile549(); res = await reg(); }
    expect(res.status(), `register ${email}: ${(await res.text()).slice(0, 300)}`).toBeLessThan(300);
    const pendingUserId = (await res.json()).pendingUserId as string;
    const v = await c.post(`${AUTH_APP}/account/verify-email`, { data: { pendingUserId, code: OTP } });
    expect(v.status(), `verify ${email}`).toBeLessThan(300);
  } finally { await c.dispose(); }
  const userId = await mongo<string>(`return db.users.findOne({ Email: ${JSON.stringify(email.toLowerCase())} })._id.toString()`);
  return { userId, phone, email, password, first };
}

/**
 * Makes an account a pre-RBAC campus member of a tenant: a Campus membership (TenantType 1) and a Head Admin system
 * assignment stamped by "System", exactly what 20260705_AssignHeadAdminToExistingCampusUsers wrote. No staff invite.
 */
export async function makeLegacyMember(account: Account, tenantId: string, tenantName: string) {
  await mongo(`return db.users.updateOne({ _id: ObjectId(${JSON.stringify(account.userId)}) },
    { $push: { AllowedTenants: { IsDefault: true, Name: ${JSON.stringify(tenantName)}, TenantId: ${JSON.stringify(tenantId)}, TenantType: 1 } } }).modifiedCount`);
  await sqlExec(`insert into "AccessRoleAssignments" ("Id","TenantId","UserId","AccessRoleId","SystemRoleName","Scope","CreatedDate","CreatedBy")
    values (gen_random_uuid(), ${q(tenantId)}, ${q(account.userId)}, null, 'Head Admin', 'Tenant', now() - interval '120 days', 'System')`);
}

/** RestApi bearer client for a campus account (persona Campus). */
export async function campusApi(identifier: string, password: string): Promise<APIRequestContext> {
  const c = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  const res = await c.post(`${REST_API}/auth/login`, { data: { username: identifier, password, persona: 1 } });
  expect(res.status(), `RestApi /auth/login ${identifier}: ${(await res.text()).slice(0, 200)}`).toBe(200);
  const token = (await res.json()).accessToken as string;
  await c.dispose();
  return pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: `${REST_API}/`, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

// ── Staff with chosen contacts ──────────────────────────────────────────────────────────────────
export interface StaffContactSeed { first: string; phone: string | null; email?: string | null; designationId?: string }
export interface StaffRow { id: string; name: string; first: string }
const cnic = () => `${randomInt(31101, 45505)}-${String(randomInt(0, 10_000_000)).padStart(7, '0')}-${randomInt(1, 10)}`;

/** AddStaff with a fixed mobile / email (the contacts the bind migration and App access match on). */
export async function addStaffWithContacts(api: APIRequestContext, s: StaffContactSeed): Promise<StaffRow> {
  const name = `Qa ${cap(s.first)} ${cap(letters(5))}`;
  const designationId = s.designationId ?? DESIGNATION.teacher;
  const res = await api.post('staff', {
    data: {
      staffId: `QA-${letters(4).toUpperCase()}${randomInt(100, 999)}`,
      fullName: name, cnic: cnic(), dateOfBirth: '1990-05-05', gender: 'Female', maritalStatus: null, bloodGroup: null,
      nationality: 'Pakistani', religion: 'Islam', profilePhotoUrl: null, cnicCopyUrl: null,
      mobileNumber: s.phone, alternateNumber: null, email: s.email ?? null,
      presentAddress: '1 QA Road, Lahore', permanentAddress: '1 QA Road, Lahore',
      emergencyContactName: 'Qa Contact', emergencyContactRelation: 'Sibling', emergencyContactPhone: mobile549(),
      category: 'Teaching', designationId, dateOfJoining: `${karachiToday().getUTCFullYear() - 1}-01-01`,
      employmentTypeId: '33333333-3333-3333-3333-333333333331', reportingManagerId: null, monthlySalary: 50000,
      highestQualification: 'Masters', specialization: null, university: 'Punjab University', yearOfCompletion: 2012,
      totalExperience: '5', previousInstitution: null,
    },
  });
  const text = await res.text();
  expect(res.status(), `add staff ${name}: ${text.slice(0, 400)}`).toBeLessThan(300);
  return { id: JSON.parse(text).id, name, first: 'Qa' };
}

// ── Invites ─────────────────────────────────────────────────────────────────────────────────────
/** Owner sends the app invite; the invitee accepts it with a new password (new account). Waits for role provisioning. */
export async function inviteAndAccept(ownerApi: APIRequestContext, staffId: string, email: string): Promise<{ userId: string; password: string }> {
  const send = await ownerApi.post(`staff/${staffId}/app-access/invite`);
  expect(send.status(), `send invite: ${(await send.text()).slice(0, 300)}`).toBeLessThan(300);
  const token = await mongo<string>(`const i = ${INVITES}.find({ StaffMemberId: ${JSON.stringify(staffId)} }).sort({ CreatedDate: -1 }).limit(1).toArray()[0]; return i && i.Token`);
  expect(token, 'invite token in Mongo').toBeTruthy();
  const password = randomPassword();
  const c = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  const acc = await c.post(`${AUTH_APP}/staff/app-access/invites/${token}/accept`, { data: { password, email } });
  expect(acc.status(), `accept invite: ${(await acc.text()).slice(0, 300)}`).toBeLessThan(300);
  await c.dispose();
  let userId = '';
  await expect.poll(async () => {
    const i = await mongo<any>(`const i = ${INVITES}.find({ StaffMemberId: ${JSON.stringify(staffId)} }).sort({ CreatedDate: -1 }).limit(1).toArray()[0]; return i && { u: i.AcceptedByUserId, p: i.RoleProvisionedAtUtc }`);
    userId = i?.u ?? '';
    return Boolean(i?.u && i?.p);
  }, { message: 'invite accepted and role provisioned by the worker', timeout: 90_000, intervals: [1000, 2000, 3000] }).toBe(true);
  return { userId, password };
}

// ── Reads / writes under test ───────────────────────────────────────────────────────────────────
export const staffRoles = async (api: APIRequestContext, staffId: string) => {
  const r = await api.get(`staff/${staffId}/access-roles`);
  return { status: r.status(), body: r.status() === 200 ? await r.json() as { roles: { id: string; name: string; type: string | number }[]; assignedRoleIds: string[] } : null, text: r.status() === 200 ? '' : await r.text() };
};
export const putStaffRoles = (api: APIRequestContext, staffId: string, roleIds: string[]) => api.put(`staff/${staffId}/access-roles`, { data: { roleIds } });
export const roleMembers = async (api: APIRequestContext, roleId: string) => {
  const r = await api.get(`access-roles/${encodeURIComponent(roleId)}/members`);
  expect(r.status(), `role ${roleId} members`).toBe(200);
  return await r.json() as { staffId: string; name: string; signInPhone: string | null }[];
};
export const staffAccess = async (api: APIRequestContext, staffId: string) => {
  const r = await api.get(`staff/${staffId}/profile`);
  expect(r.status(), `staff ${staffId} profile`).toBe(200);
  return (await r.json()).access as { status: string; hasRoleAccount?: boolean };
};
export const assignmentsOf = (tenantId: string, userId: string) =>
  sql<{ SystemRoleName: string | null; AccessRoleId: string | null }>(`select "SystemRoleName","AccessRoleId" from "AccessRoleAssignments" where "TenantId"=${q(tenantId)} and "UserId"=${q(userId)} order by 1`);
export const bindingsFor = (tenantId: string, staffId: string) =>
  mongo<any[]>(`return ${INVITES}.find({ TenantId: ${JSON.stringify(tenantId)}, StaffMemberId: ${JSON.stringify(staffId)} }).toArray().map(i => ({ status: i.Status, user: i.AcceptedByUserId, by: i.CreatedBy, provisioned: !!i.RoleProvisionedAtUtc, revoked: i.RevokedAtUtc || null }))`);

// ── Post-deployment (re-runs data migrations not recorded in DataMigrationHistory) ───────────────
function deployCredentials(): { user: string; pass: string } {
  const dir = process.env.QA_CI_WORK_DIR;
  if (!dir) throw new Error('QA_CI_WORK_DIR is not set (run through ci/run-regression.sh)');
  const env = readFileSync(path.join(dir, 'env', 'api.env'), 'utf8');
  const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '';
  return { user: get('DeploymentAuth__Username'), pass: get('DeploymentAuth__Password') };
}
export async function runPostDeployment(): Promise<{ status: number; body: string }> {
  const { user, pass } = deployCredentials();
  const c = await pwRequest.newContext({ ignoreHTTPSErrors: true, httpCredentials: { username: user, password: pass, send: 'always' } });
  try {
    const r = await c.get(`${REST_API}/api/post-deployment`, { timeout: 600_000 });
    return { status: r.status(), body: (await r.text()).slice(0, 2000) };
  } finally { await c.dispose(); }
}
export const forgetBindMigration = () => sqlExec(`delete from "DataMigrationHistory" where "Name"=${q(BIND_MIGRATION)}`);

// ── The legacy campus: every pre-RBAC shape the bind migration has to handle ─────────────────────
export interface LegacySeed {
  tenantId: string; tenantName: string;
  owner: { phone: string; password: string; userId: string };
  /** Unique phone match -> bound. */
  uniquePhone: { account: Account; staff: StaffRow };
  /** Unique match by e-mail only, staff e-mail in a different case -> bound. */
  uniqueEmail: { account: Account; staff: StaffRow };
  /** One account matching two active staffers -> skipped, both locked. */
  oneUserTwoStaff: { account: Account; staff: [StaffRow, StaffRow] };
  /** Two accounts matching one staffer (phone -> A, e-mail -> B) -> skipped, locked. */
  twoUsersOneStaff: { accounts: [Account, Account]; staff: StaffRow };
  /** Campus member with no staffer -> nothing to bind; still holds Head Admin. */
  noMatch: { account: Account };
  /** Matching staffer is marked Left -> skipped. */
  leftStaff: { account: Account; staff: StaffRow };
  /** Account matches by phone but is not a member of this campus -> never bound, App access not Active. */
  outsider: { account: Account; staff: StaffRow };
  /** Staffer with the campus creator's phone -> creator excluded from the bind. */
  creatorStaff: { staff: StaffRow };
  /** Invited and accepted through the real flow before the migration ran -> already bound, left alone. */
  invited: { staff: StaffRow; userId: string; phone: string; email: string; password: string };
}

export async function seedLegacyCampus(): Promise<LegacySeed> {
  const { newCampusOwner, cacheOwner } = await import('./campus-owner');
  const { markLeft } = await import('./payroll');
  const owner = await newCampusOwner('pr549');
  const cached = cacheOwner(owner);
  const tenantName = await mongo<string>(`return db.tenants.findOne({ _id: ObjectId(${JSON.stringify(owner.tenantId)}) }).Name`);
  const api = owner.api;
  const legacy = async (first: string, opts: { phone?: string; email?: string } = {}) => {
    const a = await registerAccount(first, opts);
    await makeLegacyMember(a, owner.tenantId, tenantName);
    return a;
  };

  const a1 = await legacy('Uniqphone');
  const s1 = await addStaffWithContacts(api, { first: 'Uniqphone', phone: a1.phone });
  const a2 = await legacy('Uniqmail');
  const s2 = await addStaffWithContacts(api, { first: 'Uniqmail', phone: mobile549(), email: a2.email.toUpperCase() });
  const a3 = await legacy('Twostaff');
  const s3a = await addStaffWithContacts(api, { first: 'Twostaffa', phone: a3.phone });
  const s3b = await addStaffWithContacts(api, { first: 'Twostaffb', phone: mobile549(), email: a3.email });
  const a4a = await legacy('Twousera');
  const a4b = await legacy('Twouserb');
  const s4 = await addStaffWithContacts(api, { first: 'Twousers', phone: a4a.phone, email: a4b.email });
  const a5 = await legacy('Nomatch');
  const a6 = await legacy('Leftstaff');
  const s6 = await addStaffWithContacts(api, { first: 'Leftstaff', phone: a6.phone });
  await markLeft(api, s6.id, new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
  const a7 = await registerAccount('Outsider');
  const s7 = await addStaffWithContacts(api, { first: 'Outsider', phone: a7.phone });
  const s0 = await addStaffWithContacts(api, { first: 'Creator', phone: owner.phone });

  const fPhone = mobile549();
  const fEmail = `pr549-invited+${letters(6)}@testenv.local`;
  const f = await addStaffWithContacts(api, { first: 'Invited', phone: fPhone, email: fEmail });
  const accepted = await inviteAndAccept(api, f.id, fEmail);

  return {
    tenantId: owner.tenantId, tenantName,
    owner: { phone: owner.phone, password: cached.password, userId: owner.userId },
    uniquePhone: { account: a1, staff: s1 }, uniqueEmail: { account: a2, staff: s2 },
    oneUserTwoStaff: { account: a3, staff: [s3a, s3b] }, twoUsersOneStaff: { accounts: [a4a, a4b], staff: s4 },
    noMatch: { account: a5 }, leftStaff: { account: a6, staff: s6 }, outsider: { account: a7, staff: s7 },
    creatorStaff: { staff: s0 },
    invited: { staff: f, userId: accepted.userId, phone: fPhone, email: fEmail, password: accepted.password },
  };
}
