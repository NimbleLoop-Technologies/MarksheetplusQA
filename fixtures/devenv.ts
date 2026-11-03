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
  // <= 10 chars, [A-Za-z0-9-] (QuickAddStudent validation).
  const admissionId = `QT-${Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[randomInt(31)]).join('')}`;

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

/** A unique Pakistani mobile in 03xx format, for registering throwaway parents. */
export const uniquePakistaniMobile = () => `0345${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;

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
