// PR 543 cycle 1 bug repros. Each test asserts the EXPECTED behaviour, so it FAILS while the bug exists.
// IDs match /workspace/qa-cycles/pr-543/cycle-1/claude-report.md.
import { test, expect } from '@playwright/test';
import { AppShell } from '../../../pages/shell/AppShell';
import {
  clearNotes, notesKey, notesKeys, notesWriteCount, readNotes, resetNotesWriteCount, trackNotesWrites, writeNotesRaw,
} from '../../../fixtures/notes-storage';

test.describe('shell notes: bug repros (expected to fail at PR head 4c9e4b69)', () => {
  let shell: AppShell;

  test.beforeEach(async ({ page }) => {
    shell = new AppShell(page);
    await shell.gotoHome();
    await clearNotes(page);
  });

  test('BUG-01 a note added in a second tab is not lost when the first tab saves', async ({ page, context }) => {
    const tabOne = await shell.openNotesFromHeader();
    await tabOne.newNote('Shared note');

    const page2 = await context.newPage();
    const shell2 = new AppShell(page2);
    await shell2.gotoHome();
    const tabTwo = await shell2.openNotesFromHeader();
    await tabTwo.newNote('Added in tab two');
    await page2.close();

    await tabOne.write('Shared note edited in tab one');
    const stored = (await readNotes(page, await notesKey(page))).map((n) => n.Content);
    expect(stored).toContain('Added in tab two');
  });

  test('BUG-02 deleting a note with content asks for confirmation or offers undo', async ({ page }) => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('Important: parent meeting list\nAhmed, Sara, Bilal');
    await notes.deleteSelectedNote();
    await expect(notes.deleteConfirmation().or(notes.undoDelete())).toBeVisible({ timeout: 5_000 });
    expect((await readNotes(page, await notesKey(page))).length).toBe(1);
  });

  test('BUG-03 typing a sentence does not rewrite storage on every keystroke (debounced save)', async ({ page, context }) => {
    await trackNotesWrites(context);
    await page.reload();
    await shell.expectLoaded();
    const notes = await shell.openNotesFromHeader();
    await notes.newNote();
    await resetNotesWriteCount(page);
    await notes.type('Collect fee slips today', 30); // 23 keystrokes
    await expect(notes.status).toHaveText('Saved', { timeout: 10_000 });
    await expect.poll(async () => (await readNotes(page, await notesKey(page)))[0]?.Content).toBe('Collect fee slips today');
    expect(await notesWriteCount(page)).toBeLessThanOrEqual(3);
  });

  test('BUG-04 the status live region is not re-announced on every keystroke', async () => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote();
    await notes.recordStatusAnnouncements();
    await notes.type('Collect fee slips today', 30);
    await expect(notes.status).toHaveText('Saved', { timeout: 10_000 });
    expect((await notes.statusAnnouncements()).length).toBeLessThanOrEqual(4);
  });

  test('BUG-05 the empty state shows its description text', async () => {
    const notes = await shell.openNotesFromHeader();
    await expect(notes.emptyStateHeading).toBeVisible();
    await expect(notes.emptyStateDescription()).toBeVisible();
  });

  test('BUG-06 unreadable stored notes leave the user a way forward besides "Try again"', async ({ page }) => {
    let notes = await shell.openNotesFromHeader();
    await notes.newNote('x');
    await writeNotesRaw(page, await notesKey(page), '{not json');
    await page.reload();
    await shell.expectLoaded();
    notes = await shell.openNotesFromHeader();
    await expect(notes.loadErrorAlert).toBeVisible();
    await expect(notes.loadRecoveryActions().first()).toBeVisible({ timeout: 5_000 });
  });

  test('BUG-07 typing in a 1 MB note stays responsive (10 keystrokes saved within 5 s)', async ({ page }) => {
    let notes = await shell.openNotesFromHeader();
    await notes.newNote('Big');
    const key = await notesKey(page);
    await writeNotesRaw(page, key, JSON.stringify([{ Id: 'qa543big', Content: `Big\n${'a'.repeat(1_000_000)}` }]));
    await page.reload();
    await shell.expectLoaded();
    notes = await shell.openNotesFromHeader();
    await notes.selectNote('Big');
    const started = Date.now();
    await notes.type('0123456789');
    await expect.poll(async () => (await readNotes(page, key))[0].Content.endsWith('0123456789'), { timeout: 60_000 }).toBe(true);
    expect(Date.now() - started, 'ms from first keystroke to all 10 persisted').toBeLessThan(5_000);
  });

  test('BUG-08 New note puts the cursor in the new note\'s editor', async () => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote();
    await expect(notes.editor).toBeFocused();
  });

  test('BUG-09 notes are stored under a shell-scoped "mp." key, not the dashboard-era name (review comment)', async ({ page }) => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('key check');
    const keys = await notesKeys(page);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^mp\./);
    expect(keys[0]).not.toContain('dashboard');
  });
});
