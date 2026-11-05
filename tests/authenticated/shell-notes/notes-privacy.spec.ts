// PR 543 AC3 (sign-out/sign-in) + AC4: notes are private to the account and campus in a shared browser.
// Self-seeding: registers a throwaway two-campus owner (qa543-owner+…@testenv.local, campuses "Main" + "North")
// and also signs in the seeded owner (QA_EMAIL). Runs in a fresh browser context (no stored session).
import { test, expect } from '@playwright/test';
import { AppShell } from '../../../pages/shell/AppShell';
import { LoginPage } from '../../../pages/LoginPage';
import { clearNotes, newTwoCampusOwner, notesKeys } from '../../../fixtures/notes-storage';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 });

test('notes are scoped per campus, per account, and come back after signing out and in', async ({ page }) => {
  const owner = await newTwoCampusOwner();
  const shell = new AppShell(page);
  const login = new LoginPage(page);
  const ownerSignIn = async () => {
    const { identifier, password } = owner.credentials();
    await page.goto('/');
    await login.signIn(identifier, password);
    await shell.expectLoaded();
  };

  await test.step('owner A writes a note on the first campus', async () => {
    await ownerSignIn();
    await clearNotes(page);
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('Owner A first campus note');
    await notes.close();
  });
  const firstCampus = await shell.currentCampus();
  const otherCampus = firstCampus === owner.secondCampusName ? 'Main' : owner.secondCampusName;

  await test.step('switching campus shows that campus\'s own (empty) notepad', async () => {
    await shell.switchCampus(otherCampus);
    const notes = await shell.openNotesFromHeader();
    await expect(notes.emptyStateHeading).toBeVisible();
    await notes.newNote('Owner A second campus note');
    await notes.close();
    expect(await notesKeys(page)).toHaveLength(2);
  });

  await test.step('switching back restores the first campus\'s notes only', async () => {
    await shell.switchCampus(firstCampus);
    const notes = await shell.openNotesFromHeader();
    expect(await notes.noteTitles()).toEqual(['Owner A first campus note']);
    await notes.close();
  });

  await test.step('another account signing in on the same browser does not see owner A\'s notes', async () => {
    await shell.signOut();
    await page.goto('/');
    await login.signIn(process.env.QA_EMAIL!, process.env.QA_PASSWORD!);
    await shell.expectLoaded();
    const notes = await shell.openNotesFromHeader();
    await expect(notes.emptyStateHeading).toBeVisible();
    expect(await notes.noteTitles()).toEqual([]);
    await notes.close();
    await shell.signOut();
  });

  await test.step('owner A signs back in and finds the note intact', async () => {
    await ownerSignIn();
    if ((await shell.currentCampus()) !== firstCampus) await shell.switchCampus(firstCampus);
    const notes = await shell.openNotesFromHeader();
    expect(await notes.noteTitles()).toEqual(['Owner A first campus note']);
  });

  await owner.api.dispose();
});
