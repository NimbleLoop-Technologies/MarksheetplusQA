// PR 543 AC1 (phone) + AC5 theme row regression: the kebab ("More options") Notes and Theme rows at 390x844.
import { test, expect } from '@playwright/test';
import { AppShell } from '../../../pages/shell/AppShell';
import { clearNotes, notesKey, readNotes } from '../../../fixtures/notes-storage';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.describe('shell notes: phone', () => {
  let shell: AppShell;

  test.beforeEach(async ({ page }) => {
    shell = new AppShell(page);
    await shell.gotoHome();
    await clearNotes(page);
  });

  test('the header Notes action is replaced by a Notes row in the More options menu', async () => {
    await expect(shell.headerNotesButton).toBeHidden();
    await shell.openMobileMenu();
    await expect(shell.mobileNotesRow).toHaveCount(1);
  });

  test('the Notes row opens the bottom sheet and a note can be written there', async ({ page }) => {
    const notes = await shell.openNotesFromMobileMenu();
    await notes.newNote('Phone note\nfrom the bus');
    await expect(notes.note('Phone note')).toBeVisible();
    await expect(notes.editor).toBeInViewport();
    await expect(notes.newNoteButton).toBeInViewport();
    expect((await readNotes(page, await notesKey(page))).map((n) => n.Content)).toEqual(['Phone note\nfrom the bus']);
    await notes.close();
  });

  test('the Theme row in the More options menu still toggles dark mode', async ({ page }) => {
    const html = page.locator('html');
    await shell.openMobileMenu();
    const startsDark = await html.evaluate((el) => el.classList.contains('dark'));
    await shell.mobileThemeRow.click();
    await expect.poll(() => html.evaluate((el) => el.classList.contains('dark'))).toBe(!startsDark);
    // Restore (theme lives in this test's own browser context, but keep the run tidy).
    if (!(await shell.mobileThemeRow.isVisible())) await shell.openMobileMenu();
    await shell.mobileThemeRow.click();
    await expect.poll(() => html.evaluate((el) => el.classList.contains('dark'))).toBe(startsDark);
  });
});
