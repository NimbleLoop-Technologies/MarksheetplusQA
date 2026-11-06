/**
 * PR 550 / ClickUp z94x8ebqpt, cycle 3 — N1: two invite dispatches in the same second.
 *
 * Cycle 2 found that two Regenerates committed in the same second collapsed into one WhatsApp
 * delivery (second-precision dedupe key), so the parent was sent a dead code while the drawer showed
 * a code that was never sent. cf6b458d keys each delivery on the code version + full-precision send time.
 *
 * Invariant checked after every race: the code the drawer finally shows is the code last sent on
 * WhatsApp for that child, it redeems (the card opens; nothing is connected), and every other code
 * seen during the race is refused.
 *
 * Two registrars are two independent admin browser contexts. The API calls are fired from inside the
 * two pages at the same browser-clock millisecond (fixtures/school-invite-api.ts), which guarantees
 * same-second commits; one iteration also races through the drawers' own buttons.
 *
 * Students are seeded with a throwaway father mobile, so the shared seeded parent's lobby is not
 * filled with pending invites; the seeded parent only redeems (opens the card), it never connects.
 *
 * QA_N1_SWEEP=1 runs the long investigation sweep (24 iterations) and, with QA_N1_CSV=<path>, writes
 * one CSV row per iteration.
 */
import { appendFile, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/family';
import { inviteWhatsAppsForChild, seedStudent, uniquePakistaniMobile, waitForInviteWhatsApp, type SeededStudent } from '../../fixtures/devenv';
import { captureInviteApi, fireInviteAction, type InviteApiHandle } from '../../fixtures/school-invite-api';
import { StudentsRegisterPage } from '../../pages/StudentsRegisterPage';
import { FamilyInviteCodeDrawer } from '../../pages/FamilyInviteCodeDrawer';
import { JoinWithCodePage } from '../../pages/family/JoinWithCodePage';

type Mode =
  | 'ui-regen-x2' // both drawers: Regenerate + confirm, Promise.all
  | 'api-regen-x2' // both pages POST /regenerate at the same millisecond
  | 'api-regen-x2-stagger' // second /regenerate `delayMs` later (sweeps the relay's 5 s poll window)
  | 'api-regen+resend-same-ms' // one page /regenerate, the other /resend, same millisecond
  | 'api-regen-then-resend' // /regenerate, then /resend as soon as it answers (same second)
  | 'api-generate-then-resend'; // /invite, then /resend as soon as it answers (same second)

interface Step { mode: Mode; delayMs?: number }

interface IterationResult {
  mode: Mode;
  delayMs: number;
  admissionId: string;
  firstName: string;
  firstCode: string;
  codeA: string;
  codeB: string;
  httpA: number;
  httpB: number;
  firedDeltaMs: number;
  drawerCode: string;
  lastWhatsApp: string;
  sendsForChild: number;
  sendsOfDrawerCode: number;
  drawerCodeRedeem: number | undefined;
  deadRedeems: string;
  pass: boolean;
}

const REDEEM_OK = 200;
const REDEEM_DEAD = 404;

/** Opens the student's drawer on `page`, capturing the WebApp's API headers on the way. */
async function openDrawer(page: Page, student: SeededStudent): Promise<{ drawer: FamilyInviteCodeDrawer; api: InviteApiHandle }> {
  const register = new StudentsRegisterPage(page);
  await register.goto();
  const captured = captureInviteApi(page, student.id);
  const drawer = await register.openFamilyInviteDrawer(student);
  return { drawer, api: await captured };
}

/** The code a freshly opened drawer shows: the registrar's source of truth. */
async function freshDrawerCode(page: Page, student: SeededStudent): Promise<string> {
  const register = new StudentsRegisterPage(page);
  await register.goto();
  return (await register.openFamilyInviteDrawer(student)).currentCode();
}

/**
 * Waits for the worker to send `code` as the child's latest WhatsApp, then for one more relay poll
 * (5 s) plus the send lag to pass, so a later send of a different code would also be seen.
 * Returns the child's sends after that quiet period.
 */
async function settledSendsFor(firstName: string, code: string) {
  await expect
    .poll(async () => (await inviteWhatsAppsForChild(firstName)).at(-1)?.body[3], { timeout: 30_000, intervals: [500, 1000, 2000] })
    .toBe(code)
    .catch(() => undefined); // a mismatch is recorded by the caller, not thrown here
  // A deliberate quiet period: proving that nothing is sent LATER needs one full relay cycle to elapse.
  await new Promise((r) => setTimeout(r, 8_000));
  return inviteWhatsAppsForChild(firstName);
}

async function runIteration(step: Step, pages: { adminA: Page; adminB: Page; parent: Page }): Promise<IterationResult> {
  const { mode, delayMs = 0 } = step;
  const student = await seedStudent({ parentPhone: uniquePakistaniMobile() });
  const a = await openDrawer(pages.adminA, student);
  let firstCode = '';
  if (mode !== 'api-generate-then-resend') {
    firstCode = await a.drawer.generate();
    await waitForInviteWhatsApp(firstCode);
  }
  const b = await openDrawer(pages.adminB, student);
  if (firstCode) await expect(b.drawer.code).toHaveText(firstCode);

  let codeA = '';
  let codeB = '';
  let httpA = 0;
  let httpB = 0;
  let firedDeltaMs = 0;
  const at = (ms: number) => Date.now() + ms;

  switch (mode) {
    case 'ui-regen-x2': {
      await Promise.all([a.drawer.startRegenerate(), b.drawer.startRegenerate()]);
      [codeA, codeB] = await Promise.all(
        [a.drawer, b.drawer].map((d) =>
          d.confirmRegenerate().then(() => expect(d.code).not.toHaveText(firstCode)).then(() => d.currentCode()),
        ),
      );
      httpA = httpB = 200;
      break;
    }
    case 'api-regen-x2':
    case 'api-regen-x2-stagger':
    case 'api-regen+resend-same-ms': {
      const t = at(500);
      const [ra, rb] = await Promise.all([
        fireInviteAction(a.api, 'regenerate', t),
        fireInviteAction(b.api, mode === 'api-regen+resend-same-ms' ? 'resend' : 'regenerate', t + delayMs),
      ]);
      [codeA, codeB, httpA, httpB, firedDeltaMs] = [ra.code ?? '', rb.code ?? '', ra.status, rb.status, rb.firedAt - ra.firedAt];
      break;
    }
    case 'api-regen-then-resend':
    case 'api-generate-then-resend': {
      const ra = await fireInviteAction(a.api, mode === 'api-regen-then-resend' ? 'regenerate' : 'invite', at(0));
      const rb = await fireInviteAction(b.api, 'resend', at(0));
      [codeA, codeB, httpA, httpB, firedDeltaMs] = [ra.code ?? '', rb.code ?? '', ra.status, rb.status, rb.firedAt - ra.firedAt];
      if (!firstCode) firstCode = codeA;
      break;
    }
  }

  const drawerCode = await freshDrawerCode(pages.adminB, student);
  const sends = await settledSendsFor(student.firstName, drawerCode);
  const lastWhatsApp = sends.at(-1)?.body[3] ?? '';

  // Redeem the dead codes first (each miss counts toward the 5-miss lockout; the live hit resets it).
  const join = new JoinWithCodePage(pages.parent);
  await join.goto();
  const seen = new Set([firstCode, codeA, codeB, ...sends.map((s) => s.body[3])].filter((c) => c && c !== drawerCode));
  const dead: string[] = [];
  for (const code of [...seen].slice(0, 3)) dead.push(`${code}=${await join.submitCode(code)}`);
  const drawerCodeRedeem = await join.submitCode(drawerCode);
  if (drawerCodeRedeem === REDEEM_OK) await expect(join.cardValue('Child')).toHaveText(student.firstName);

  const pass =
    lastWhatsApp === drawerCode &&
    drawerCodeRedeem === REDEEM_OK &&
    dead.every((d) => d.endsWith(`=${REDEEM_DEAD}`)) &&
    [httpA, httpB].every((s) => s === 200);
  return {
    mode, delayMs, admissionId: student.admissionId, firstName: student.firstName, firstCode, codeA, codeB, httpA, httpB,
    firedDeltaMs, drawerCode, lastWhatsApp, sendsForChild: sends.length,
    sendsOfDrawerCode: sends.filter((s) => s.body[3] === drawerCode).length, drawerCodeRedeem, deadRedeems: dead.join(' '), pass,
  };
}

const CSV_HEADER = 'iteration,mode,delayMs,admissionId,firstName,firstCode,codeA,codeB,httpA,httpB,firedDeltaMs,drawerCode,lastWhatsApp,sendsForChild,sendsOfDrawerCode,drawerCodeRedeem,deadRedeems,pass\n';
const csvRow = (i: number, r: IterationResult) =>
  [i, r.mode, r.delayMs, r.admissionId, r.firstName, r.firstCode, r.codeA, r.codeB, r.httpA, r.httpB, r.firedDeltaMs, r.drawerCode,
    r.lastWhatsApp, r.sendsForChild, r.sendsOfDrawerCode, r.drawerCodeRedeem, r.deadRedeems, r.pass].join(',') + '\n';

async function runPlan(plan: Step[], pages: { adminA: Page; adminB: Page; parent: Page }, csv?: string, tolerateHarnessErrors = false) {
  if (csv) await writeFile(csv, CSV_HEADER);
  const results: IterationResult[] = [];
  for (const [i, step] of plan.entries()) {
    try {
      const r = await runIteration(step, pages);
      results.push(r);
      if (csv) await appendFile(csv, csvRow(i + 1, r));
    } catch (error) {
      // Sweep only: a UI/harness timeout in one iteration is recorded and the sweep goes on.
      if (!tolerateHarnessErrors) throw error;
      const reason = String((error as Error).message).split('\n')[0].replace(/,/g, ';');
      if (csv) await appendFile(csv, `${i + 1},${step.mode},${step.delayMs ?? 0},HARNESS-ERROR: ${reason}\n`);
    }
  }
  return results;
}

test.describe('Same-second invite dispatches (N1)', () => {
  test('two registrars regenerating in the same second: the drawer shows the code last sent on WhatsApp, and only it works (×5)', async ({ adminPage, adminPage2, page }) => {
    test.setTimeout(5 * 120_000);
    const plan: Step[] = [
      { mode: 'api-regen-x2' }, { mode: 'api-regen-x2' }, { mode: 'api-regen-x2' }, { mode: 'api-regen-x2' }, { mode: 'ui-regen-x2' },
    ];
    const results = await runPlan(plan, { adminA: adminPage, adminB: adminPage2, parent: page });
    for (const r of results) {
      expect.soft(r.lastWhatsApp, `${r.mode} ${r.admissionId}: last WhatsApp vs drawer`).toBe(r.drawerCode);
      expect.soft(r.drawerCodeRedeem, `${r.mode} ${r.admissionId}: drawer code redeems`).toBe(REDEEM_OK);
      expect.soft(r.deadRedeems, `${r.mode} ${r.admissionId}: superseded codes are refused`).not.toMatch(/=(?!404\b)\d+/);
    }
  });

  test('a Resend in the same second as a Generate or a Regenerate is delivered with the live code (N1)', async ({ adminPage, adminPage2, page }) => {
    test.setTimeout(3 * 120_000);
    const plan: Step[] = [{ mode: 'api-generate-then-resend' }, { mode: 'api-regen-then-resend' }, { mode: 'api-regen+resend-same-ms' }];
    const results = await runPlan(plan, { adminA: adminPage, adminB: adminPage2, parent: page });
    for (const r of results) {
      expect.soft(r.lastWhatsApp, `${r.mode} ${r.admissionId}: last WhatsApp vs drawer`).toBe(r.drawerCode);
      expect.soft(r.drawerCodeRedeem, `${r.mode} ${r.admissionId}: drawer code redeems`).toBe(REDEEM_OK);
      expect.soft(r.deadRedeems, `${r.mode} ${r.admissionId}: superseded codes are refused`).not.toMatch(/=(?!404\b)\d+/);
    }
  });

  test('N1 investigation sweep (QA_N1_SWEEP=1)', async ({ adminPage, adminPage2, page }) => {
    test.skip(process.env.QA_N1_SWEEP !== '1', 'investigation sweep: set QA_N1_SWEEP=1');
    const plan: Step[] = [
      ...Array.from({ length: 10 }, () => ({ mode: 'api-regen-x2' as const })),
      ...Array.from({ length: 4 }, () => ({ mode: 'ui-regen-x2' as const })),
      ...[300, 1200, 2500, 3700, 4900].map((delayMs) => ({ mode: 'api-regen-x2-stagger' as const, delayMs })),
      { mode: 'api-regen+resend-same-ms' }, { mode: 'api-regen+resend-same-ms' },
      { mode: 'api-regen-then-resend' }, { mode: 'api-regen-then-resend' },
      { mode: 'api-generate-then-resend' }, { mode: 'api-generate-then-resend' },
    ];
    test.setTimeout(plan.length * 120_000);
    const results = await runPlan(plan, { adminA: adminPage, adminB: adminPage2, parent: page }, process.env.QA_N1_CSV, true);
    expect(results.length, 'iterations that completed (harness errors are in the CSV)').toBeGreaterThanOrEqual(20);
    for (const r of results) expect.soft(r.pass, `${r.mode} +${r.delayMs}ms ${r.admissionId}`).toBe(true);
  });
});
