// PR 543 AC3: notes are not wiped out on page change, reload (sign-out/sign-in is in notes-privacy.spec.ts).
import { test, expect } from '@playwright/test';
import { AppShell } from '../../../pages/shell/AppShell';
import { clearNotes } from '../../../fixtures/notes-storage';

test.describe('shell notes: persistence', () => {
  let shell: AppShell;

  test.beforeEach(async ({ page }) => {
    shell = new AppShell(page);
    await shell.gotoHome();
    await clearNotes(page);
  });

  test('notes survive navigating to Admission Office, Classrooms and back to Home', async () => {
    let notes = await shell.openNotesFromHeader();
    await notes.newNote('Navigation note\nline two');
    await notes.newNote('Second navigation note');
    await notes.close();

    await shell.goToModule('Admission Office', /\/registrar\/students/);
    await shell.goToModule('Classrooms', /\/classrooms\//);
    await shell.goToModule('Home', /\/$/);

    notes = await shell.openNotesFromHeader();
    expect(await notes.noteTitles()).toEqual(['Navigation note', 'Second navigation note']);
    await notes.selectNote('Navigation note');
    await expect(notes.editor).toHaveValue('Navigation note\nline two');
  });

  test('the drawer can be opened on another page and shows the same notes', async () => {
    let notes = await shell.openNotesFromHeader();
    await notes.newNote('Visible everywhere');
    await notes.close();
    await shell.goToModule('Admission Office', /\/registrar\/students/);
    notes = await shell.openNotesFromHeader();
    expect(await notes.noteTitles()).toEqual(['Visible everywhere']);
  });

  test('notes survive a full page reload', async ({ page }) => {
    let notes = await shell.openNotesFromHeader();
    await notes.newNote('Reload note\nsecond line');
    await page.reload();
    await shell.expectLoaded();
    notes = await shell.openNotesFromHeader();
    expect(await notes.noteTitles()).toEqual(['Reload note']);
    await notes.selectNote('Reload note');
    await expect(notes.editor).toHaveValue('Reload note\nsecond line');
  });
});
