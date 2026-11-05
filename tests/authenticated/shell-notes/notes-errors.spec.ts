// PR 543 probes: storage quota (save failure + Retry save) and unreadable stored notes (load failure).
import { test, expect } from '@playwright/test';
import { AppShell } from '../../../pages/shell/AppShell';
import { clearNotes, fillStorage, notesKey, readNotes, readNotesRaw, releaseStorage, writeNotesRaw } from '../../../fixtures/notes-storage';

test.describe('shell notes: storage failures', () => {
  let shell: AppShell;

  test.beforeEach(async ({ page }) => {
    shell = new AppShell(page);
    await shell.gotoHome();
    await clearNotes(page);
  });

  test.afterEach(async ({ page }) => {
    await releaseStorage(page).catch(() => undefined);
  });

  test('a save beyond the storage quota shows "Retry save", keeps the text, and the retry succeeds once space frees up', async ({ page }) => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('Quota note');
    const key = await notesKey(page);
    await fillStorage(page, 500);

    const big = `Quota note\n${'q'.repeat(5_000)}`;
    await notes.write(big);
    await expect(notes.saveErrorAlert).toBeVisible();
    await expect(notes.status).toHaveText('Not saved');
    await expect(notes.editor).toHaveValue(big);
    expect((await readNotes(page, key)).map((n) => n.Content)).toEqual(['Quota note']);

    await releaseStorage(page);
    await notes.retrySaveButton.click();
    await expect(notes.saveErrorAlert).toBeHidden();
    await expect(notes.status).toHaveText('Saved');
    expect((await readNotes(page, key)).map((n) => n.Content)).toEqual([big]);
  });

  test('unreadable stored notes show the load error and are not overwritten', async ({ page }) => {
    let notes = await shell.openNotesFromHeader();
    await notes.newNote('Will be corrupted');
    const key = await notesKey(page);
    await writeNotesRaw(page, key, '{not json');
    await page.reload();
    await shell.expectLoaded();

    notes = await shell.openNotesFromHeader();
    await expect(notes.loadErrorAlert).toBeVisible();
    await expect(notes.newNoteButton).toBeHidden();
    await notes.loadRetryButton.click();
    await expect(notes.loadErrorAlert).toBeVisible();
    expect(await readNotesRaw(page, key)).toBe('{not json');
  });
});
