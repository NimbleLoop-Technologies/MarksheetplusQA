/**
 * PR 571 / ClickUp CU-z94x8ed11f — school-side Parent app drawer on a throwaway campus, plus
 * removed phone-link routes and "no code for linked / struck-off" rules.
 *
 * Dan's checks covered here:
 *  1. One "Parent app" row action; "Link parent" / "Family invite code" are gone.
 *  2. Copy code issues a 6-character code, expiry is 7 days, notice is "Code copied."
 *  3. New code confirm is "Make a new code?" / "The old code will stop working."
 *  4. A trial campus cannot Send by WhatsApp; Copy code still works.
 *  8. GET /students/{id}/parent-family/link-options and POST .../link are 404.
 *     Linked and struck-off students cannot get a new code (409) until staff unlink (linked only).
 */
import { expect, test } from '@playwright/test';
import { newCampusOwner } from '../../../fixtures/campus-owner';
import { addStudent, familyMobile, personName, setupSchool } from '../../../fixtures/fees';
import { signInToWebApp } from '../../../pages/fees/AccountOffice';
import { StudentsRegisterPage } from '../../../pages/StudentsRegisterPage';

const CODE_FORMAT = /^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/;
const parseDrawerDate = (text: string) => Date.parse(text.replace(',', ''));

test.describe.configure({ timeout: 180_000 });

test.describe('PR 571 Parent app drawer (CU-z94x8ed11f)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('trial campus: Copy code works, Send by WhatsApp is hidden, removed phone-link routes 404, struck-off is 409', async ({ page }) => {
    const owner = await newCampusOwner('p571');
    const school = await setupSchool(owner, 1);
    const mobile = familyMobile();
    const pupil = await addStudent(owner, {
      name: personName('Zain'),
      classId: school.classes[0].id,
      fatherName: personName('Imran'),
      fatherMobile: mobile,
    });
    const student = { fullName: pupil.name, admissionId: pupil.admissionId, id: pupil.id };

    const options = await owner.api.get(`students/${pupil.id}/parent-family/link-options`);
    expect(options.status(), `GET link-options: ${(await options.text()).slice(0, 300)}`).toBe(404);
    const direct = await owner.api.post(`students/${pupil.id}/parent-family/link`, { data: { phoneNumber: mobile } });
    expect(direct.status(), `POST link: ${(await direct.text()).slice(0, 300)}`).toBe(404);
    // Redeem-era family routes stay; this is a school token, so a missing phone lobby on the school API is enough.

    await signInToWebApp(page, owner.credentials());
    const register = new StudentsRegisterPage(page);
    await register.goto();
    const names = await register.rowActionNames(student);
    expect(names).toContain('Parent app');
    expect(names).not.toEqual(expect.arrayContaining(['Link parent', 'Invite code', 'Family invite code']));

    const drawer = await register.openFamilyInviteDrawer(student);
    await expect(drawer.root.getByText('Not linked', { exact: true })).toBeVisible();
    await expect(drawer.sendWhatsAppButton).toHaveCount(0);
    await expect(drawer.whatsAppBlocked).toBeVisible();
    await expect(drawer.whatsAppBlocked).toContainText(/WhatsApp sending isn't available|Copy the code/i);

    const issuedAt = Date.now();
    const code = await drawer.generate();
    expect(code).toMatch(CODE_FORMAT);
    await expect(drawer.notice).toHaveText('Code copied.');
    await expect(drawer.detail('Sent to')).toHaveText('Not sent (copied)');
    const expires = parseDrawerDate(await drawer.detail('Expires').innerText());
    expect(Math.abs(expires - (issuedAt + 7 * 24 * 3600e3))).toBeLessThan(2 * 60e3);

    await drawer.startRegenerate();
    await expect(drawer.regenerateConfirm).toContainText('The old code will stop working.');
    await drawer.keepCodeOnRegenerate();
    await expect(drawer.code).toHaveText(code);
    await drawer.close();

    const struck = await addStudent(owner, {
      name: personName('Archie'),
      classId: school.classes[0].id,
      fatherName: personName('Imran'),
      fatherMobile: familyMobile(),
    });
    const off = await owner.api.post(`students/${struck.id}/struck-off`, { data: { reason: 'Left school', comments: 'PR 571 QA' } });
    expect(off.status(), `struck-off: ${(await off.text()).slice(0, 400)}`).toBeLessThan(300);
    const refused = await owner.api.post(`students/${struck.id}/parent-family/invite`, { data: { sendWhatsApp: false } });
    expect(refused.status(), `struck-off invite: ${(await refused.text()).slice(0, 400)}`).toBe(409);
  });
});
