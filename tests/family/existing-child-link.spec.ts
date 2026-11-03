/**
 * PR 550 / ClickUp z94x8ebqpt, cycle 2 — ut7: link an invite to one of the parent's OWN children.
 *  AC5: a name + date-of-birth match with an existing child is suggested (preselected).
 *  AC6: the parent can choose any of their own children, or add the invited student as a new child.
 *  AC7: accepting links the school profile to the chosen child (no duplicate child; placeholder merged)
 *       or to a new child.
 * Plus: attach-candidates leaks nothing about other families, a different family's child id is refused,
 * an accept retry is safe (same answer 200, a different child 409), and double-click links once.
 *
 * Runs on a brand-new parent (worker-scoped `freshParent`), never the shared seeded parent. Each test
 * adds its own children with unique first names, so tests do not depend on each other.
 */
import { randomInt } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { test as base, expect } from '../../fixtures/family';
import {
  addOwnChild,
  callFamilyApi,
  createFamilyParent,
  ownChildren,
  seedStudent,
  waitForInviteWhatsApp,
  type FreshParent,
  type SeededStudent,
} from '../../fixtures/devenv';
import { StudentsRegisterPage } from '../../pages/StudentsRegisterPage';
import { LoginPage } from '../../pages/LoginPage';
import { JoinWithCodePage } from '../../pages/family/JoinWithCodePage';
import { FamilyDashboardPage } from '../../pages/family/FamilyDashboardPage';

const ignoreHTTPSErrors = (process.env.QA_IGNORE_HTTPS_ERRORS ?? 'false').toLowerCase() === 'true';
const ANSWERED = 'That invitation has already been answered.';
const NOT_YOUR_CHILD = "That child isn't in your family.";

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
/** A unique, letters-only first name (family names reject digits), e.g. "Bilalqxkz". */
const uniqueFirst = (stem: string) => `${stem}${Array.from({ length: 5 }, () => LETTERS[randomInt(26)]).join('')}`;
const bare = (code: string) => code.replace('-', '');

/** Signs the fresh parent in through the AuthApp in a new family-app context. */
async function parentPageFor(browser: Browser, parent: FreshParent): Promise<Page> {
  // Explicitly signed out: browser.newContext() would otherwise inherit the project's parent storage state.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: process.env.QA_FAMILY_URL, ignoreHTTPSErrors });
  const page = await context.newPage();
  await page.goto('/dashboard');
  await new LoginPage(page).signIn(parent.email, parent.password);
  await new FamilyDashboardPage(page).expectLoaded();
  return page;
}

const test = base.extend<{ parentPage: Page }>({
  parentPage: async ({ browser, freshParent }, use) => {
    const page = await parentPageFor(browser, freshParent);
    await use(page);
    await page.context().close();
  },
});

async function issueCode(adminPage: Page, student: SeededStudent): Promise<string> {
  const register = new StudentsRegisterPage(adminPage);
  await register.goto();
  const code = await (await register.openFamilyInviteDrawer(student)).generate();
  await waitForInviteWhatsApp(code);
  return code;
}

/** Redeems through the API (as the parent) to learn the invite id. */
async function inviteIdFor(parent: FreshParent, code: string): Promise<string> {
  const res = await callFamilyApi(parent, 'POST', '/family/link-invites/redeem', { code });
  expect(res.status, `redeem ${code}: ${res.body}`).toBe(200);
  return JSON.parse(res.body).inviteId as string;
}

test.describe.configure({ timeout: 150_000 });

test.describe('Linking an invite to an existing child (ut7, AC5–AC7)', () => {
  test('a child with the same first name and date of birth is listed and preselected as suggested (AC5)', async ({ freshParent, parentPage, adminPage }) => {
    const first = uniqueFirst('Bilal');
    const own = await addOwnChild(freshParent, `${first} Probe`, '2016-04-12');
    const sibling = await addOwnChild(freshParent, `${uniqueFirst('Sana')} Probe`, '2017-08-02', 'Female');
    const student = await seedStudent({ firstName: first, lastName: 'Probe', dateOfBirth: '2016-04-12', parentPhone: freshParent.phone });
    const code = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(parentPage);

    await join.goto(bare(code));

    await expect(join.attachChoice()).toBeVisible();
    await expect(join.existingChildOption(own.name)).toBeChecked();
    await expect(join.suggestedChildOption()).toHaveCount(1);
    await expect(join.suggestedChildOption()).toHaveAccessibleName(new RegExp(`^Yes, this is ${own.name} \\(suggested\\)$`, 'i'));
    await expect(join.existingChildOption(sibling.name)).not.toBeChecked();
    await expect(join.newChildOption()).toBeVisible();
    await expect(join.newChildOption()).not.toBeChecked();
  });

  test('a child with the same name but a different date of birth is offered but not suggested (AC5)', async ({ freshParent, parentPage, adminPage }) => {
    const first = uniqueFirst('Hamza');
    const own = await addOwnChild(freshParent, `${first} Probe`, '2015-02-02');
    const student = await seedStudent({ firstName: first, lastName: 'Probe', dateOfBirth: '2016-09-19', parentPhone: freshParent.phone });
    const code = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(parentPage);

    await join.goto(bare(code));

    await expect(join.existingChildOption(own.name)).toBeVisible();
    await expect(join.existingChildOption(own.name)).not.toBeChecked();
    await expect(join.suggestedChildOption()).toHaveCount(0);
    await expect(join.newChildOption()).toBeChecked();
  });

  test('a name written with the honorific "Muhammad" still suggests the matching child (AC5)', async ({ freshParent, parentPage, adminPage }) => {
    const given = uniqueFirst('Ahmad');
    const own = await addOwnChild(freshParent, `Muhammad ${given}`, '2015-06-30');
    // The school sends the first word ("Muhammad") as the child's first name.
    const student = await seedStudent({ firstName: 'Muhammad', lastName: given, dateOfBirth: '2015-06-30', parentPhone: freshParent.phone });
    const code = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(parentPage);

    await join.goto(bare(code));

    await expect(join.cardValue('Child')).toHaveText('Muhammad');
    await expect(join.existingChildOption(own.name)).toBeVisible();
    await expect(join.existingChildOption(own.name)).toBeChecked();
  });

  test('connecting the suggested child links the school to that child: no duplicate, no new child (AC7)', async ({ freshParent, parentPage, adminPage }) => {
    const first = uniqueFirst('Zain');
    const own = await addOwnChild(freshParent, `${first} Probe`, '2016-01-15');
    const student = await seedStudent({ firstName: first, lastName: 'Probe', dateOfBirth: '2016-01-15', parentPhone: freshParent.phone });
    const code = await issueCode(adminPage, student);
    const before = (await ownChildren(freshParent)).length;
    const join = new JoinWithCodePage(parentPage);
    await join.goto(bare(code));
    await expect(join.existingChildOption(own.name)).toBeChecked();

    await join.connect();

    const dashboard = new FamilyDashboardPage(parentPage);
    await dashboard.expectLoaded();
    await expect(dashboard.child(student.fullName)).toHaveCount(1);
    await expect(dashboard.childSchoolLine(student.fullName)).toContainText('Testenv High School - Main');
    expect((await ownChildren(freshParent)).length).toBe(before);
    expect((await ownChildren(freshParent)).map((c) => c.id)).toContain(own.id);

    const register = new StudentsRegisterPage(adminPage);
    await register.goto();
    await expect.poll(() => register.rowActionNames(student), { timeout: 45_000 }).not.toContain('Family invite code');
  });

  test('the parent can pick a child other than the suggested one, and that child is linked (AC6/AC7)', async ({ freshParent, parentPage, adminPage }) => {
    const first = uniqueFirst('Omar');
    await addOwnChild(freshParent, `${first} Probe`, '2014-03-03');
    const chosen = await addOwnChild(freshParent, `${uniqueFirst('Umar')} Probe`, '2014-03-03');
    const student = await seedStudent({ firstName: first, lastName: 'Probe', dateOfBirth: '2014-03-03', parentPhone: freshParent.phone });
    const code = await issueCode(adminPage, student);
    const join = new JoinWithCodePage(parentPage);
    await join.goto(bare(code));

    await join.chooseExistingChild(chosen.name);
    await join.connect();

    const dashboard = new FamilyDashboardPage(parentPage);
    await dashboard.expectLoaded();
    await expect(dashboard.childSchoolLine(chosen.name)).toContainText('Testenv High School - Main');
    await expect(dashboard.childSchoolLine(`${first} Probe`)).toContainText('Not connected to a school yet');
  });

  test('"add as a new child" is always available and creates a separate child even when a match exists (AC6/AC7)', async ({ freshParent, parentPage, adminPage }) => {
    const first = uniqueFirst('Ali');
    const own = await addOwnChild(freshParent, `${first} Probe`, '2015-01-01');
    const student = await seedStudent({ firstName: first, lastName: 'Probe', dateOfBirth: '2015-01-01', parentPhone: freshParent.phone });
    const code = await issueCode(adminPage, student);
    const before = (await ownChildren(freshParent)).length;
    const join = new JoinWithCodePage(parentPage);
    await join.goto(bare(code));
    await expect(join.existingChildOption(own.name)).toBeChecked();

    await join.chooseNewChild();
    await join.connect();

    const dashboard = new FamilyDashboardPage(parentPage);
    await dashboard.expectLoaded();
    // Same full name twice: the parent's own (unconnected) child and the new school-linked one.
    // A just-linked new child shows as "Child" until the school's profile snapshot is projected
    // (outbox relay, a few seconds), and the dashboard does not refresh itself.
    await expect(async () => {
      await dashboard.goto();
      await expect(dashboard.child(student.fullName)).toHaveCount(2, { timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
    expect((await ownChildren(freshParent)).length).toBe(before + 1);
  });

  test('a child already connected to this school is not offered for another invite from it', async ({ freshParent, parentPage, adminPage }) => {
    const first = uniqueFirst('Ayan');
    const own = await addOwnChild(freshParent, `${first} Probe`, '2016-05-05');
    const firstStudent = await seedStudent({ firstName: first, lastName: 'Probe', dateOfBirth: '2016-05-05', parentPhone: freshParent.phone });
    const join = new JoinWithCodePage(parentPage);
    await join.goto(bare(await issueCode(adminPage, firstStudent)));
    await join.connect();
    await new FamilyDashboardPage(parentPage).expectLoaded();

    const twin = await seedStudent({ firstName: first, lastName: 'Probe', dateOfBirth: '2016-05-05', parentPhone: freshParent.phone });
    await join.goto(bare(await issueCode(adminPage, twin)));

    await expect(join.cardValue('Child')).toHaveText(first);
    await expect(join.existingChildOption(own.name)).toHaveCount(0);
  });

  test('attach-candidates lists only the caller\'s own children and nothing about the invited student', async ({ freshParent, adminPage }) => {
    const first = uniqueFirst('Noor');
    await addOwnChild(freshParent, `${first} Probe`, '2017-07-07', 'Female');
    const student = await seedStudent({ firstName: first, lastName: 'Probe', dateOfBirth: '2017-07-07', parentPhone: freshParent.phone });
    const code = await issueCode(adminPage, student);
    const inviteId = await inviteIdFor(freshParent, code);

    const res = await callFamilyApi(freshParent, 'POST', `/family/link-invites/${inviteId}/attach-candidates`, { token: code });

    expect(res.status).toBe(200);
    const { candidates } = JSON.parse(res.body) as { candidates: Record<string, unknown>[] };
    const ownIds = (await ownChildren(freshParent)).map((c) => c.id);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(ownIds).toContain(c.childId);
      expect(Object.keys(c).sort()).toEqual(['childId', 'displayName', 'photoUrl', 'suggested']);
    }
    expect(res.body).not.toContain(student.id);
    expect(res.body).not.toContain(student.admissionId);
  });

  test('attach-candidates is refused without the right code', async ({ freshParent, adminPage }) => {
    const student = await seedStudent({ parentPhone: freshParent.phone });
    const code = await issueCode(adminPage, student);
    const inviteId = await inviteIdFor(freshParent, code);

    const wrong = await callFamilyApi(freshParent, 'POST', `/family/link-invites/${inviteId}/attach-candidates`, { token: 'ZZZ-ZZ9' });
    const none = await callFamilyApi(freshParent, 'POST', `/family/link-invites/${inviteId}/attach-candidates`, { token: null });

    expect([403, 404]).toContain(wrong.status);
    expect([403, 404]).toContain(none.status);
    expect(wrong.body).not.toContain('candidates');
    expect(none.body).not.toContain('candidates');
  });

  test('accepting with another family\'s child id is refused and links nothing', async ({ freshParent, adminPage }) => {
    const otherFamily = await createFamilyParent();
    const theirs = await addOwnChild(otherFamily, `${uniqueFirst('Other')} Probe`, '2015-05-05');
    const student = await seedStudent({ parentPhone: freshParent.phone });
    const code = await issueCode(adminPage, student);
    const inviteId = await inviteIdFor(freshParent, code);

    const res = await callFamilyApi(freshParent, 'POST', `/family/link-invites/${inviteId}/accept`, { childId: theirs.id, token: code });

    expect(res.status).toBe(404);
    expect(res.body).toContain(NOT_YOUR_CHILD);
    expect((await ownChildren(freshParent)).map((c) => c.id)).not.toContain(theirs.id);
    // The invite is still open: the redeem shows the card again.
    expect((await callFamilyApi(freshParent, 'POST', '/family/link-invites/redeem', { code })).status).toBe(200);
  });

  test('an accept retry with the same child answers 200; choosing a different child afterwards is refused with 409', async ({ freshParent, adminPage }) => {
    const first = uniqueFirst('Saad');
    const own = await addOwnChild(freshParent, `${first} Probe`, '2016-02-29');
    const other = await addOwnChild(freshParent, `${uniqueFirst('Taha')} Probe`, '2016-03-01');
    const student = await seedStudent({ firstName: first, lastName: 'Probe', dateOfBirth: '2016-02-29', parentPhone: freshParent.phone });
    const code = await issueCode(adminPage, student);
    const inviteId = await inviteIdFor(freshParent, code);
    const accept = (childId: string | null) =>
      callFamilyApi(freshParent, 'POST', `/family/link-invites/${inviteId}/accept`, { childId, token: code });

    const firstAnswer = await accept(own.id);
    const retry = await accept(own.id);
    const different = await accept(other.id);
    const asNew = await accept(null);

    expect(firstAnswer.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(JSON.parse(retry.body).childId).toBe(own.id);
    expect(different.status).toBe(409);
    expect(different.body).toContain(ANSWERED);
    expect(asNew.status).toBe(409);
  });

  test('double-clicking Connect with an existing child selected links it exactly once', async ({ freshParent, parentPage, adminPage }) => {
    const first = uniqueFirst('Rayan');
    const own = await addOwnChild(freshParent, `${first} Probe`, '2015-10-10');
    const student = await seedStudent({ firstName: first, lastName: 'Probe', dateOfBirth: '2015-10-10', parentPhone: freshParent.phone });
    const code = await issueCode(adminPage, student);
    const before = (await ownChildren(freshParent)).length;
    const join = new JoinWithCodePage(parentPage);
    await join.goto(bare(code));
    await expect(join.existingChildOption(own.name)).toBeChecked();
    const accepts: number[] = [];
    parentPage.on('response', (r) => /\/link-invites\/[^/]+\/accept$/.test(r.url()) && accepts.push(r.status()));

    await join.connectButton.dblclick();

    const dashboard = new FamilyDashboardPage(parentPage);
    await dashboard.expectLoaded();
    await expect(dashboard.child(student.fullName)).toHaveCount(1);
    expect(accepts.every((s) => s === 200)).toBe(true);
    expect((await ownChildren(freshParent)).length).toBe(before);
  });
});
