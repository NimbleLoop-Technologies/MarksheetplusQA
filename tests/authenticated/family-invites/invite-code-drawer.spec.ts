/**
 * PR 550 / ClickUp z94x8ebqpt, updated for PR 571 / CU-z94x8ed11f — school admin side of the
 * code-only Parent app drawer. Cancel invite is gone from the UI (the cancel endpoint may still
 * exist). First issue is Copy code (no WhatsApp) or Send by WhatsApp; expiry default is 7 days.
 */
import { test, expect } from '../../../fixtures/family';
import { DEFAULT_PARENT_PHONE, expireInvite, inviteWhatsAppsFor, seedStudent, waitForInviteWhatsApp } from '../../../fixtures/devenv';
import { StudentsRegisterPage } from '../../../pages/StudentsRegisterPage';

const SCHOOL = 'Testenv High School - Main';
/** The seeded parent's number in E.164 (the stack's QA_PARENT_PHONE: 03xxxxxxxxx on the box, a fictional +1 number in CI). */
const PARENT_E164 = DEFAULT_PARENT_PHONE.startsWith('+') ? DEFAULT_PARENT_PHONE : `+92${DEFAULT_PARENT_PHONE.slice(1)}`;
/** How the drawer masks it: country code + first digit, then stars, then the last two digits ("+92********03"). */
const PARENT_MASKED = `${PARENT_E164.slice(0, 3)}${'*'.repeat(PARENT_E164.length - 5)}${PARENT_E164.slice(-2)}`;
/** ABC-DEF; alphabet excludes 0, O, 1, I and L. */
const CODE_FORMAT = /^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/;
const SENT = 'Code sent. You will see the student connect once the parent enters it.';
const REGENERATED = 'New code sent. The old code no longer works.';
const NO_CODE_YET = 'No code yet. Send one to the parent on WhatsApp, or copy it.';
const COPY_ONLY = 'Not sent (copied)';
/** "03 Nov 2026" — the server formats the expiry date in UTC. */
const utcDay = (ms: number) =>
  new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const OTP_LIMIT_PER_IP = 30;

/** "06 Nov 2026, 1:31 PM" (browser-local) → epoch ms. The runner and browser share a timezone. */
const parseDrawerDate = (text: string) => Date.parse(text.replace(',', ''));

// Each test seeds a student via seed.sh before the WASM app loads; 30 s is tight on the local stack.
test.describe.configure({ timeout: 60_000 });

test.describe('Parent app drawer', () => {
  test('Copy code shows a 6-character ABC-DEF code from the unambiguous alphabet', { tag: '@smoke' }, async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);

    await expect(drawer.code).toHaveCount(0);
    const code = await drawer.generate();

    expect(code).toMatch(CODE_FORMAT);
    await expect(drawer.notice).toHaveText('Code copied.');
    await expect(drawer.detail('Sent to')).toHaveText(COPY_ONLY);
    await expect(drawer.cancelInviteButton).toHaveCount(0);
  });

  test('a new code expires 7 days after it is generated', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const generatedAt = Date.now();
    await drawer.generate();

    const expires = parseDrawerDate(await drawer.detail('Expires').innerText());
    // Minute precision in the UI; allow two minutes either side.
    expect(Math.abs(expires - (generatedAt + 7 * 24 * 3600e3))).toBeLessThan(2 * 60e3);
  });

  test.skip('a sent code has never been sent for any other child', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const code = await drawer.sendByWhatsApp();
    await waitForInviteWhatsApp(code);
    // The worker log holds every code this stack ever sent; this one must belong to this child only.
    const sends = await inviteWhatsAppsFor(code);
    expect(new Set(sends.map((s) => s.body[2]))).toEqual(new Set([student.firstName]));
  });

  test.skip('the WhatsApp invite carries the school, parent, child first name, code, expiry and the bare code for the /join?code= button', { tag: '@smoke' }, async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const code = await drawer.sendByWhatsApp();

    const message = await waitForInviteWhatsApp(code);
    expect(message.to).toBe(PARENT_E164);
    expect(message.header).toBe(SCHOOL);
    const [parent, school, child, sentCode, expiry] = message.body;
    expect(parent).toBe('Imran Khan');
    expect(school).toBe(SCHOOL);
    expect(child).toBe(student.firstName);
    expect(sentCode).toBe(code);
    expect(expiry).toMatch(/^\d{2} [A-Z][a-z]{2}, \d{4} \d{1,2}:\d{2} [AP]M$/);
    expect(message.button).toBe(code.replace('-', ''));
    await expect(drawer.notice).toHaveText(SENT);
    await expect(drawer.detail('Sent to')).toHaveText(PARENT_MASKED);
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
      await expect(page.locator('#blazor-error-ui')).not.toBeVisible();
    });
  });

  // PR 571 cycle 2 (17d394e6): a denied clipboard must not crash the WASM drawer.
  test.describe('without clipboard access', () => {
    test.use({ permissions: [] });

    test('Copy still shows the code and a copy-by-hand notice, and does not crash', async ({ page, student }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      const register = new StudentsRegisterPage(page);
      await register.goto();
      const drawer = await register.openFamilyInviteDrawer(student);
      const code = await drawer.generate();

      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/);
      await expect(drawer.inviteNotice).toHaveText(`Couldn't copy automatically. The code is ${code}. Copy it by hand.`);
      await expect(drawer.notice).toHaveText(`Couldn't copy automatically. The code is ${code}. Copy it by hand.`);
      await expect(drawer.code).toHaveText(code);
      await expect(page.locator('#blazor-error-ui')).not.toBeVisible();
      await expect(drawer.root).toBeVisible();
      // Self-signed CI certs make the service worker fail to register; that is not a Copy crash.
      expect(pageErrors.filter((m) => !/ServiceWorker|SSL certificate/i.test(m)), pageErrors.join('\n')).toEqual([]);
    });
  });

  test.skip('Resend re-sends the same code and is disabled once the 3-per-24h allowance is used', { tag: '@smoke' }, async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const code = await drawer.sendByWhatsApp();
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

  test('New code asks for confirmation and "Keep it" leaves the code unchanged', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const code = await drawer.generate();

    await drawer.startRegenerate();
    await expect(drawer.regenerateConfirm).toContainText('The old code will stop working.');
    await drawer.keepCodeOnRegenerate();

    await expect(drawer.code).toHaveText(code);
  });

  test.skip('New code replaces the code and sends the new one on WhatsApp', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const oldCode = await drawer.sendByWhatsApp();

    const newCode = await drawer.regenerate(oldCode);

    expect(newCode).toMatch(CODE_FORMAT);
    expect(newCode).not.toBe(oldCode);
    await expect(drawer.notice).toHaveText(REGENERATED);
    const message = await waitForInviteWhatsApp(newCode);
    expect(message.body[3]).toBe(newCode);
  });

  test('the drawer no longer offers Cancel invite', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    await drawer.generate();

    await expect(drawer.cancelInviteButton).toHaveCount(0);
    await expect(drawer.copyButton).toBeVisible();
    await expect(drawer.regenerateButton).toBeVisible();
  });

  test('before any code exists the drawer says there is no code yet (uta)', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);

    await expect(drawer.statusMessage).toHaveText(NO_CODE_YET);
    await expect(drawer.copyButton).toBeVisible();
    await expect(drawer.sendWhatsAppButton).toHaveCount(0);
    await expect(drawer.whatsAppBlocked).toContainText("WhatsApp messages aren't available for this campus yet");
  });

  test('after the code expires, the drawer says when it expired and offers a new one (uta)', async ({ page, student }) => {
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const drawer = await register.openFamilyInviteDrawer(student);
    const code = await drawer.generate();
    const expiredAt = Date.now() - 3600e3;
    await expireInvite(student.id);

    await register.goto();
    const reopened = await register.openFamilyInviteDrawer(student);

    await expect(reopened.statusMessage).toHaveText(`The last code expired on ${utcDay(expiredAt)}. Generate a new one.`);
    await expect(reopened.code).toHaveCount(0);
    await expect(reopened.copyButton).toBeVisible();
    await expect(reopened.regenerateButton).toBeVisible();
  });

  test('more than 30 invite actions in 15 minutes are not rate limited (ut9)', async ({ page }) => {
    test.setTimeout(600_000);
    // The seeded campus is on a trial plan, so these are Copy + two New code actions (no WhatsApp).
    // 11 students × 3 calls is past the old 30-per-IP OTP limit that used to answer 429.
    const students = [];
    for (let i = 0; i < 11; i++) students.push(await seedStudent());
    const register = new StudentsRegisterPage(page);
    let actions = 0;
    for (const student of students) {
      await register.goto();
      const drawer = await register.openFamilyInviteDrawer(student);
      const code = await drawer.generate();
      const mid = await drawer.regenerate(code);
      await expect(drawer.notice).toHaveText('New code ready. The old code no longer works.');
      const fresh = await drawer.regenerate(mid);
      await expect(drawer.notice).toHaveText('New code ready. The old code no longer works.');
      await expect(drawer.code).toHaveText(fresh);
      // Trial campuses show a WhatsApp warning (role=alert); that is not a rate-limit error.
      await expect(drawer.root.getByText(/too many|rate limit|try again/i)).toHaveCount(0);
      actions += 3;
    }
    expect(actions).toBeGreaterThan(OTP_LIMIT_PER_IP);
  });
});


/**
 * Invite WhatsApp is metered (PR 571). The seeded Testenv campus is a trial plan, so Send is refused
 * there. These checks run on a throwaway campus after the operator activates the subscription.
 */
test.describe('Parent app drawer on a paid campus', () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ storageState: { cookies: [], origins: [] } });

  test('Send by WhatsApp delivers the school, parent, child, code and /join?code= button', { tag: '@smoke' }, async ({ page }) => {
    const { BackOffice, newCampusOwner, quotaDb } = await import('../../../fixtures/quota');
    const { addStudent, familyMobile, personName, setupSchool } = await import('../../../fixtures/fees');
    const { signInToWebApp } = await import('../../../pages/fees/AccountOffice');

    const owner = await newCampusOwner('p571wa');
    const ops = await BackOffice.signIn();
    try {
      const subscriptionId = await quotaDb.subscriptionId(owner.tenantId);
      await ops.activate(subscriptionId);
      await expect.poll(async () => {
        const res = await owner.api.get('subscription/quota');
        if (!res.ok()) return false;
        const q = await res.json();
        return q.isEntitled === true && q.remaining > 0;
      }, { timeout: 90_000, intervals: [5_000] }).toBeTruthy();

      const school = await setupSchool(owner, 1);
      const father = personName('Imran');
      const mobile = familyMobile();
      const pupil = await addStudent(owner, {
        name: personName('Zara'),
        classId: school.classes[0].id,
        fatherName: father,
        fatherMobile: mobile,
      });
      await signInToWebApp(page, owner.credentials());
      const register = new StudentsRegisterPage(page);
      await register.goto();
      const drawer = await register.openFamilyInviteDrawer({ fullName: pupil.name, admissionId: pupil.admissionId });
      await expect(drawer.sendWhatsAppButton).toBeEnabled();
      const code = await drawer.sendByWhatsApp();
      const message = await waitForInviteWhatsApp(code);
      expect(message.body[1]).toContain(owner.schoolName);
      expect(message.body[2]).toBe(pupil.name.split(' ')[0]);
      expect(message.body[3]).toBe(code);
      expect(message.button).toBe(code.replace('-', ''));
      await expect(drawer.notice).toHaveText(SENT);

      const newCode = await drawer.regenerate(code);
      expect(newCode).not.toBe(code);
      await expect(drawer.notice).toHaveText(REGENERATED);
      const resent = await waitForInviteWhatsApp(newCode);
      expect(resent.body[3]).toBe(newCode);
    } finally {
      await ops.dispose();
      await owner.api.dispose();
    }
  });
});
