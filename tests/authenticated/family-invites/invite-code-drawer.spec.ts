/**
 * PR 550 / ClickUp z94x8ebqpt — school admin side of the family invite code.
 * AC1 (generate a short, unique, shareable code), AC2 (WhatsApp carries code + link), AC9 (regenerate).
 */
import { test, expect } from '../../../fixtures/family';
import { expireInvite, inviteWhatsAppsFor, seedStudent, waitForInviteWhatsApp } from '../../../fixtures/devenv';
import { StudentsRegisterPage } from '../../../pages/StudentsRegisterPage';

const SCHOOL = 'Testenv High School - Main';
/** ABC-DEF; alphabet excludes 0, O, 1, I and L. */
const CODE_FORMAT = /^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/;
const SENT = 'Invite code sent. You will see the student connect once the parent enters it.';
const REGENERATED = 'New code sent. The old code no longer works.';
// uta: the drawer always says why there is no live code.
const NO_CODE_YET = 'No invite code yet. Generate one to send it to the parent on WhatsApp.';
const CANCELLED = "The last code was cancelled. Generate a new one when you're ready.";
/** "03 Nov 2026" — the server formats the expiry date in UTC. */
const utcDay = (ms: number) =>
  new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const OTP_LIMIT_PER_IP = 30;

/** "06 Nov 2026, 1:31 PM" (browser-local) → epoch ms. The runner and browser share a timezone. */
const parseDrawerDate = (text: string) => Date.parse(text.replace(',', ''));

// Each test seeds a student via seed.sh before the WASM app loads; 30 s is tight on the local stack.
test.describe.configure({ timeout: 60_000 });

test.describe('Family invite code drawer', () => {
  test('generating a code shows a 6-character ABC-DEF code from the unambiguous alphabet', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);

    await expect(drawer.code).toHaveCount(0);
    const code = await drawer.generate();

    expect(code).toMatch(CODE_FORMAT);
    await expect(drawer.notice).toHaveText(SENT);
    await expect(drawer.detail('Sent to')).toHaveText('+92********03');
  });

  test('a new code expires 3 days after it is generated', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const generatedAt = Date.now();
    await drawer.generate();

    const expires = parseDrawerDate(await drawer.detail('Expires').innerText());
    // Minute precision in the UI; allow two minutes either side.
    expect(Math.abs(expires - (generatedAt + 3 * 24 * 3600e3))).toBeLessThan(2 * 60e3);
  });

  test('a generated code has never been sent for any other child', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const code = await drawer.generate();
    await waitForInviteWhatsApp(code);
    // The worker log holds every code this stack ever sent; this one must belong to this child only.
    const sends = await inviteWhatsAppsFor(code);
    expect(new Set(sends.map((s) => s.body[2]))).toEqual(new Set([student.firstName]));
  });

  test('the WhatsApp invite carries the school, parent, child first name, code, expiry and the bare code for the /join?code= button', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const code = await drawer.generate();

    const message = await waitForInviteWhatsApp(code);
    expect(message.to).toBe('+923000000003');
    expect(message.header).toBe(SCHOOL);
    const [parent, school, child, sentCode, expiry] = message.body;
    expect(parent).toBe('Imran Khan');
    expect(school).toBe(SCHOOL);
    expect(child).toBe(student.firstName);
    expect(sentCode).toBe(code);
    expect(expiry).toMatch(/^\d{2} [A-Z][a-z]{2}, \d{4} \d{1,2}:\d{2} [AP]M$/);
    expect(message.button).toBe(code.replace('-', ''));
  });

  test.describe('with clipboard access', () => {
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

    test('Copy puts the code on the clipboard and confirms inline', async ({ page, student }) => {
      const register = new StudentsRegisterPage(page);
      await register.goto();
      const drawer = await register.openFamilyInviteDrawer(student);
      const code = await drawer.generate();

      await drawer.copy();

      await expect(drawer.notice).toHaveText('Code copied.');
      expect(await drawer.clipboardText()).toBe(code);
      await expect(drawer.root).toBeVisible();
    });
  });

  test('Resend re-sends the same code and is disabled once the 3-per-24h allowance is used', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const code = await drawer.generate();
    await waitForInviteWhatsApp(code, 1);
    await expect(drawer.resendButton).toBeEnabled();

    for (let sends = 2; sends <= 4; sends++) {
      await drawer.resend();
      await expect(drawer.notice).toHaveText('Invite code re-sent.');
      await expect(drawer.code).toHaveText(code);
      await waitForInviteWhatsApp(code, sends);
    }

    await expect(drawer.resendButton).toBeDisabled();
  });

  test('Regenerate asks for confirmation and "Keep it" leaves the code unchanged', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const code = await drawer.generate();

    await drawer.startRegenerate();
    await expect(drawer.regenerateConfirm).toContainText('The current code stops working and the parent gets a new one on WhatsApp.');
    await drawer.keepCodeOnRegenerate();

    await expect(drawer.code).toHaveText(code);
  });

  test('Regenerate replaces the code and sends the new one on WhatsApp', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const oldCode = await drawer.generate();

    const newCode = await drawer.regenerate(oldCode);

    expect(newCode).toMatch(CODE_FORMAT);
    expect(newCode).not.toBe(oldCode);
    await expect(drawer.notice).toHaveText(REGENERATED);
    const message = await waitForInviteWhatsApp(newCode);
    expect(message.body[3]).toBe(newCode);
  });

  test('Cancel invite asks for confirmation, withdraws the code and offers Generate again', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    await drawer.generate();

    await drawer.startCancelInvite();
    await expect(drawer.cancelConfirm).toContainText('The code stops working. You can generate a new one later.');
    await drawer.confirmCancelInvite();

    await expect(drawer.notice).toHaveText('Invite cancelled.');
    await expect(drawer.code).toHaveCount(0);
    await expect(drawer.generateButton).toBeVisible();
  });

  test('before any code exists the drawer says there is no code yet (uta)', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);

    await expect(drawer.statusMessage).toHaveText(NO_CODE_YET);
    await expect(drawer.generateButton).toBeVisible();
  });

  test('after Cancel invite, reopening the drawer says the last code was cancelled (uta)', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    await drawer.generate();
    await drawer.startCancelInvite();
    await drawer.confirmCancelInvite();
    await drawer.close();

    await register.goto();
    const reopened = await register.openFamilyInviteDrawer(student);

    await expect(reopened.statusMessage).toHaveText(CANCELLED);
    await expect(reopened.code).toHaveCount(0);
    await expect(reopened.generateButton).toBeVisible();
  });

  test('after the code expires, the drawer says when it expired and offers a new one (uta)', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const code = await drawer.generate();
    await waitForInviteWhatsApp(code);
    const expiredAt = Date.now() - 3600e3;
    await expireInvite(student.id);

    await register.goto();
    const reopened = await register.openFamilyInviteDrawer(student);

    await expect(reopened.statusMessage).toHaveText(`The last code expired on ${utcDay(expiredAt)}. Generate a new one.`);
    await expect(reopened.code).toHaveCount(0);
    await expect(reopened.generateButton).toBeVisible();
  });

  test('more than 30 invite sends in 15 minutes are not rate limited (ut9)', async ({ page }) => {
    test.setTimeout(600_000);
    // Generate + Regenerate + Resend on 11 students = 33 limited calls, past the old 30-per-IP OTP
    // limit that used to answer 429. The new per-school invite limit is 300 per 15 minutes.
    const students = [];
    for (let i = 0; i < 11; i++) students.push(await seedStudent());
    const register = new StudentsRegisterPage(page);
    let sends = 0;
    for (const student of students) {
      await register.goto();
      const drawer = await register.openFamilyInviteDrawer(student);
      const code = await drawer.generate();
      await expect(drawer.notice).toHaveText(SENT);
      const fresh = await drawer.regenerate(code);
      await expect(drawer.notice).toHaveText(REGENERATED);
      await drawer.resend();
      await expect(drawer.notice).toHaveText('Invite code re-sent.');
      await expect(drawer.code).toHaveText(fresh);
      await expect(drawer.error).toHaveCount(0);
      sends += 3;
    }
    expect(sends).toBeGreaterThan(OTP_LIMIT_PER_IP);
  });
});
