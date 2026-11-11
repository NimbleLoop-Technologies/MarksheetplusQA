// PR 543 (CU z94x8e3azg) cycle 2: AC1 + AC2 on desktop (server-side notes).
import { test, expect } from '@playwright/test';
import { AppShell } from '../../../pages/shell/AppShell';
import { clearNotes, listServerNotes } from '../../../fixtures/notes-storage';
import { skipIfNoNotes } from '../../../fixtures/notes-available';

test.describe('shell notes: create, edit, switch, delete (desktop)', () => {
  test.beforeEach(async ({ page }) => { await skipIfNoNotes(page); });

  let shell: AppShell;

  test.beforeEach(async ({ page }) => {
    shell = new AppShell(page);
    await shell.gotoHome();
    await clearNotes(page);
  });

  test('the Notes action in the Dashboard header opens the Notes drawer with an empty state', async () => {
    await expect(shell.headerNotesButton).toBeVisible();
    const notes = await shell.openNotesFromHeader();
    await expect(notes.emptyStateHeading).toBeVisible();
    await expect(notes.emptyStateDescription()).toBeVisible();
    await expect(notes.newNoteButton).toBeVisible();
  });

  test('a new note takes multi-line text and is titled by its first line', { tag: '@smoke' }, async ({ page }) => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote();
    await expect(notes.note('Untitled note')).toBeVisible();
    await notes.write('Staff meeting at 2pm\nBring the attendance report\nCall Mr. Ali');

    await expect(notes.note('Staff meeting at 2pm')).toBeVisible();
    await expect(notes.editor).toHaveValue('Staff meeting at 2pm\nBring the attendance report\nCall Mr. Ali');
    await expect.poll(async () => (await listServerNotes(page)).map((n) => n.content)).toEqual([
      'Staff meeting at 2pm\nBring the attendance report\nCall Mr. Ali',
    ]);
  });

  test('several notes keep separate contents when switching between them', async () => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('Fee reminders\nClass 5 defaulters');
    await notes.newNote('Exam datesheet\nPrint on Monday');
    await notes.newNote('Bookshop order');
    expect(await notes.noteTitles()).toEqual(['Fee reminders', 'Exam datesheet', 'Bookshop order']);

    await notes.selectNote('Fee reminders');
    await expect(notes.editor).toHaveValue('Fee reminders\nClass 5 defaulters');
    await notes.selectNote('Exam datesheet');
    await expect(notes.editor).toHaveValue('Exam datesheet\nPrint on Monday');
    await expect(notes.note('Exam datesheet')).toHaveAttribute('aria-expanded', 'true');
    await expect(notes.note('Fee reminders')).toHaveAttribute('aria-expanded', 'false');
  });

  test('closing the editor hides it and keeps the note in the list', async () => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('Keep me');
    await notes.closeEditor();
    await expect(notes.editor).toBeHidden();
    await expect(notes.note('Keep me')).toBeVisible();
    await notes.selectNote('Keep me');
    await expect(notes.editor).toHaveValue('Keep me');
  });

  test('deleting a note with content asks for confirmation, then removes it from the list and the server', async ({ page }) => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('First');
    await notes.newNote('Second');
    await notes.selectNote('First');
    await notes.deleteSelectedNote();
    await notes.confirmDelete();
    expect(await notes.noteTitles()).toEqual(['Second']);
    // The delete is confirmed in the UI immediately; the server row follows. The default 5 s expect
    // timeout loses that race on a loaded stack.
    await expect.poll(async () => (await listServerNotes(page)).map((n) => n.content), { timeout: 20_000 }).toEqual(['Second']);
  });

  test('Escape closes the drawer and returns focus to the header Notes action', async ({ page }) => {
    const notes = await shell.openNotesFromHeader();
    await page.keyboard.press('Escape');
    await expect(notes.dialog).toBeHidden();
    await expect(shell.headerNotesButton).toBeFocused();
  });

  test('note titles trim leading spaces, capitalise the first letter, keep emoji/Urdu, and fall back to "Untitled note"', async () => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('   indented title\nbody');
    await notes.newNote('😀 emoji first');
    await notes.newNote('اردو نوٹ\nدوسری لائن');
    await notes.newNote('   \n\t\nonly body');
    expect(await notes.noteTitles()).toEqual(['Indented title', '😀 emoji first', 'اردو نوٹ', 'Untitled note']);
  });
});
