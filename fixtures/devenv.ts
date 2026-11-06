/**
 * Local branch-testing stack helpers (no UI, no page objects).
 *
 *  - seedStudent():   runs the devenv seed script to create a fresh, unlinked student.
 *  - WhatsApp log:    the Development fake sender writes every template send to the worker log.
 *  - expireInvite():  back-dates a student's open invite in Mongo (AC8: codes expire after 3 days).
 *
 * Only for the local stack. Every path / URL can be overridden from .env.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { randomInt } from 'node:crypto';
import { expect } from '@playwright/test';

const run = promisify(execFile);

const SEED_SCRIPT = process.env.QA_SEED_SCRIPT ?? '/workspace/devenv/seed.sh';
const WORKER_LOG = process.env.QA_WORKER_LOG || '/workspace/devenv/worker.log';
const MONGO_URL = process.env.QA_MONGO_URL ?? 'mongodb://localhost:27017/mp-accounts-db';
/** The seeded parent account's number. Students seeded with it land in that parent's lobby. */
export const DEFAULT_PARENT_PHONE = process.env.QA_PARENT_PHONE ?? '03000000003';

const ADMISSION_PREFIX = process.env.QA_ADMISSION_PREFIX ?? 'C3-';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const randomLetters = (n: number) => Array.from({ length: n }, () => LETTERS[randomInt(LETTERS.length)]).join('');
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface SeededStudent {
  id: string;
  /** As shown in the register, e.g. "QT-4K9ZQ2". */
  admissionId: string;
  firstName: string;
  fullName: string;
  /** ISO date, e.g. 2016-03-10 */
  dateOfBirth: string;
  parentPhone: string;
}

export interface SeedOptions {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  parentPhone?: string;
}

/**
 * Seeds a fresh active student in Class 5-A whose father mobile is `parentPhone`.
 * The seed script prints an owner token on stdout; it is parsed here and never logged.
 */
export async function seedStudent(options: SeedOptions = {}): Promise<SeededStudent> {
  // Letters only: QuickAdd names reject digits. Unique enough that the first name identifies the child.
  const firstName = options.firstName ?? `Qa${randomLetters(6)}`;
  const lastName = options.lastName ?? 'Probe';
  const fullName = `${titleCase(firstName)} ${titleCase(lastName)}`;
  const dateOfBirth = options.dateOfBirth ?? `2016-0${randomInt(1, 10)}-1${randomInt(0, 10)}`;
  const parentPhone = options.parentPhone ?? DEFAULT_PARENT_PHONE;
  // <= 10 chars, [A-Za-z0-9-] (QuickAddStudent validation). The prefix marks the QA run that created
  // the student on the shared stack (override with QA_ADMISSION_PREFIX).
  const admissionId = `${ADMISSION_PREFIX}${Array.from({ length: 10 - ADMISSION_PREFIX.length }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[randomInt(31)]).join('')}`;

  const seedOnce = () =>
    run('bash', [SEED_SCRIPT], {
      env: {
        ...process.env,
        STUDENT_ADMISSION_ID: admissionId,
        STUDENT_FULL_NAME: fullName,
        STUDENT_DATE_OF_BIRTH: `${dateOfBirth}T00:00:00Z`,
        PARENT_PHONE: parentPhone,
      },
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });

  let stdout = '';
  for (let attempt = 1; ; attempt++) {
    try {
      ({ stdout } = await seedOnce());
      break;
    } catch (error) {
      const { stderr, message } = error as { stderr?: string; message: string };
      // stderr carries the seed script's own failure line; it never contains the token.
      const reason = stderr?.split('\n').filter((l) => l.includes('FAILED')).join(' ') || message.split('\n')[0];
      // Known product race (not PR 550): two concurrent quick-adds into one section can pick the
      // same roll number -> 23505 on IX_Students_TenantId_RollNumber_SectionId -> HTTP 500. The
      // student was not created, so retrying with the same admission id is safe.
      const rollNumberRace = /students\/quick-add -> HTTP 500/.test(reason);
      if (!rollNumberRace || attempt >= 4) throw new Error(`seed.sh failed for ${admissionId}: ${reason}`);
      await new Promise((r) => setTimeout(r, 500 + randomInt(1500)));
    }
  }

  const id = /^STUDENT_ID=(.+)$/m.exec(stdout)?.[1]?.trim();
  if (!id) throw new Error(`seed.sh printed no STUDENT_ID for ${admissionId}`);
  return { id, admissionId, firstName: titleCase(firstName), fullName, dateOfBirth, parentPhone };
}

/**
 * A unique Pakistani mobile (0300 + 7 random digits), for registering throwaway parents.
 * Never the seeded parent's 03000000003, whose family is shared by other runs.
 */
export function uniquePakistaniMobile(): string {
  for (;;) {
    const phone = `0300${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
    if (phone !== DEFAULT_PARENT_PHONE) return phone;
  }
}

// ── WhatsApp fake sender log ──────────────────────────────────────────────────────────────────

export interface InviteWhatsApp {
  to: string;
  header: string;
  /** [parent name, school, child first name, code XXX-XXX, expiry PKT] */
  body: string[];
  /** URL button suffix: the bare code; the template's base URL is "{family app}/join?code=". */
  button: string;
}

const TEMPLATE_LINE = /FAKE WhatsApp template → to=(\S+) template=family_invite_code_en header=(.*?) body=(.*?) button=(\S+)\s*$/;

/** Every family_invite_code_en send logged for this bare code, oldest first. */
export async function inviteWhatsAppsFor(code: string): Promise<InviteWhatsApp[]> {
  const bare = code.replace(/[-\s]/g, '').toUpperCase();
  const log = await readFile(WORKER_LOG, 'utf8');
  const sends: InviteWhatsApp[] = [];
  for (const line of log.split('\n')) {
    const m = TEMPLATE_LINE.exec(line);
    if (m && m[4] === bare) sends.push({ to: m[1], header: m[2], body: m[3].split(' | '), button: m[4] });
  }
  return sends;
}

/** Every family_invite_code_en send logged for the child with this (unique) first name, oldest first. */
export async function inviteWhatsAppsForChild(firstName: string): Promise<InviteWhatsApp[]> {
  const log = await readFile(WORKER_LOG, 'utf8');
  const sends: InviteWhatsApp[] = [];
  for (const line of log.split('\n')) {
    const m = TEMPLATE_LINE.exec(line);
    if (!m) continue;
    const body = m[3].split(' | ');
    if (body[2] === firstName) sends.push({ to: m[1], header: m[2], body, button: m[4] });
  }
  return sends;
}

/**
 * Waits until the worker has sent the invite WhatsApp for `code` at least `count` times.
 * The relay projects the invite to the family plane BEFORE it sends, so once this resolves the
 * parent can redeem the code (redeeming earlier is a 404 that also counts toward the lockout).
 */
export async function waitForInviteWhatsApp(code: string, count = 1, timeout = 45_000): Promise<InviteWhatsApp> {
  let sends: InviteWhatsApp[] = [];
  await expect
    .poll(async () => (sends = await inviteWhatsAppsFor(code)).length, {
      message: `worker log never showed ${count} family_invite_code_en send(s) for ${code}`,
      timeout,
      intervals: [500, 1000, 2000],
    })
    .toBeGreaterThanOrEqual(count);
  return sends[sends.length - 1];
}

/** Lines in the worker log matching `pattern`, for spotting exceptions raised during a test. */
export async function workerLogLines(pattern: RegExp): Promise<string[]> {
  const log = await readFile(WORKER_LOG, 'utf8');
  return log.split('\n').filter((l) => pattern.test(l));
}

// ── Mongo (school plane invites) ──────────────────────────────────────────────────────────────

async function mongo(script: string): Promise<string> {
  const { stdout } = await run('npx', ['-y', 'mongosh', MONGO_URL, '--quiet', '--eval', script], { timeout: 120_000 });
  return stdout.trim();
}

/**
 * Back-dates the student's open (Pending) invite so its code is expired, and re-arms the relay so
 * the new expiry is projected to the family plane (the redeem endpoint checks the family-plane copy).
 * The relay re-sends the template as part of that; callers wait on the projection log line.
 */
export async function expireInvite(studentId: string): Promise<string> {
  const id = JSON.stringify(studentId);
  const refreshed = (inviteId: string) => workerLogLines(new RegExp(`projection refreshed.*inviteId=${inviteId}`)).then((l) => l.length);
  const pendingId = await mongo(`
    const r = db.studentfamilylinkinvites.find({ StudentId: ${id}, Status: 0 }).sort({ CreatedDate: -1 }).limit(1).toArray()[0];
    print(r ? r._id.toString() : '');`);
  if (!/^[0-9a-f]{24}$/.test(pendingId)) throw new Error(`no pending invite to expire for student ${studentId}`);
  const before = await refreshed(pendingId);

  const inviteId = await mongo(`
    const now = new Date();
    const r = db.studentfamilylinkinvites.findOneAndUpdate(
      { StudentId: ${id}, Status: 0 },
      { $set: { ExpiresAtUtc: new Date(now.getTime() - 3600e3), DispatchedAtUtc: null, LastSentAtUtc: now } },
      { sort: { CreatedDate: -1 }, returnDocument: 'after' });
    print(r ? r._id.toString() : '');`);
  if (!/^[0-9a-f]{24}$/.test(inviteId)) throw new Error(`no pending invite to expire for student ${studentId}`);

  await expect
    .poll(() => refreshed(inviteId), {
      message: `relay never re-projected expired invite ${inviteId}`,
      timeout: 45_000,
      intervals: [500, 1000, 2000],
    })
    .toBeGreaterThan(inviteId === pendingId ? before : 0);
  return inviteId;
}

// ── Fresh family parents (AC5–AC7 need a family nobody else touches) ─────────────────────────

const PARENT_SCRIPT = process.env.QA_PARENT_SCRIPT ?? '/workspace/devenv/parent.sh';
const REST_API = process.env.QA_REST_API_URL ?? 'https://localhost:7244';

export interface FreshParent {
  phone: string;
  email: string;
  password: string;
  /** Family-plane bearer token. Never log it. */
  readonly token: string;
}

/**
 * Registers a brand-new parent (fixed OTP) and completes the family setup with no children, via the
 * devenv parent script. The script prints the parent's API token on stdout; it is kept in memory only.
 */
export async function createFamilyParent(): Promise<FreshParent> {
  const phone = uniquePakistaniMobile();
  const suffix = randomLetters(8);
  // c3-…@testenv.local in cycle 3: the email prefix follows the admission-id prefix of the run.
  const email = `${ADMISSION_PREFIX.replace(/-$/, '').toLowerCase()}-${suffix}@testenv.local`;
  const password = `Qa-${suffix}-Pw1!`;
  let stdout: string;
  try {
    ({ stdout } = await run('bash', [PARENT_SCRIPT], {
      env: {
        ...process.env,
        PARENT_PHONE: phone,
        PARENT_EMAIL: email,
        PARENT_PASSWORD: password,
        PARENT_FIRST_NAME: 'Qaparent',
        PARENT_LAST_NAME: titleCase(randomLetters(6)),
        FAMILY_FATHER_NAME: `Qafather ${titleCase(randomLetters(6))}`,
        // CNIC is unique per family: derive it from the phone.
        FAMILY_CNIC: `35202-${phone.slice(4, 11)}-1`,
      },
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    throw new Error(`parent.sh failed for ${phone}: ${stderr?.split('\n').filter((l) => l.includes('FAILED')).join(' ') || message.split('\n')[0]}`);
  }
  const token = /^export PARENT_TOKEN='(.+)'$/m.exec(stdout)?.[1];
  if (!token) throw new Error(`parent.sh printed no PARENT_TOKEN for ${phone}`);
  return { phone, email, password, token };
}

/** Calls the RestApi as the parent. The bearer header goes to curl on stdin, never on the command line. */
async function parentApi(parent: FreshParent, method: string, route: string, body?: unknown): Promise<{ status: number; body: string }> {
  const config = [`header = "Authorization: Bearer ${parent.token}"`].join('\n');
  const args = ['-sk', '-K', '-', '-X', method, `${REST_API}${route}`, '-H', 'Accept: application/json', '-w', '\n%{http_code}'];
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data', JSON.stringify(body));
  const out = await new Promise<string>((resolve, reject) => {
    const child = execFile('curl', args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, so) => (err ? reject(err) : resolve(so)));
    child.stdin?.end(config);
  });
  const i = out.lastIndexOf('\n');
  return { status: Number(out.slice(i + 1)), body: out.slice(0, i) };
}

export interface OwnChild {
  id: string;
  name: string;
  dateOfBirth: string;
}

/**
 * Adds a child the parent created themselves (Origin FamilyCreated), as the family app's profile
 * endpoint does. There is no UI for this in the family app yet, so the API is the only way in.
 */
export async function addOwnChild(parent: FreshParent, name: string, dateOfBirth: string, gender: 'Male' | 'Female' = 'Male'): Promise<OwnChild> {
  const res = await parentApi(parent, 'POST', '/family/setup/profile/children', {
    studentName: name, bayFormOrCnic: null, whatsApp: null, email: null, dateOfBirth, gender, bloodGroup: null, studentImageUrl: null,
  });
  if (res.status !== 200) throw new Error(`adding child ${name} failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
  const children = await ownChildren(parent);
  const child = children.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!child) throw new Error(`child ${name} not listed after adding it`);
  return child;
}

/** The family's children as the family plane lists them (GET /family/setup/profile). */
export async function ownChildren(parent: FreshParent): Promise<OwnChild[]> {
  const res = await parentApi(parent, 'GET', '/family/setup/profile');
  if (res.status !== 200) throw new Error(`profile read failed: HTTP ${res.status}`);
  const profile = JSON.parse(res.body) as Record<string, unknown>;
  const list = (profile.children ?? profile.Children ?? []) as Record<string, unknown>[];
  return list.map((c) => ({
    id: String(c.id ?? c.learnerId ?? c.childId ?? ''),
    name: String(c.studentName ?? c.name ?? c.displayName ?? ''),
    dateOfBirth: String(c.dateOfBirth ?? ''),
  }));
}

/**
 * Raw family-plane API call for probes (attach-candidates, accept replay). Returns status + body;
 * no assertions here.
 */
export function callFamilyApi(parent: FreshParent, method: 'GET' | 'POST', route: string, body?: unknown) {
  return parentApi(parent, method, route, body);
}
