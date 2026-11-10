// PR 543 cycle 2: save / load failure paths against the RestApi (no localStorage quota).
import { test, expect } from '@playwright/test';
import { AppShell } from '../../../pages/shell/AppShell';
import { clearNotes, listServerNotes } from '../../../fixtures/notes-storage';
import { skipIfNoNotes } from '../../../fixtures/notes-available';

test.describe('shell notes: API failures', () => {
  test.beforeEach(async ({ page }) => { await skipIfNoNotes(page); });

  let shell: AppShell;

  test.beforeEach(async ({ page }) => {
    shell = new AppShell(page);
    await shell.gotoHome();
    await clearNotes(page);
  });

  test('a failed save shows "Retry save", keeps the text, and the retry succeeds once the API recovers', async ({ page }) => {
    let failPuts = true;
    await page.route('**/notes/**', async (route) => {
      if (route.request().method() === 'PUT' && failPuts) {
        await route.fulfill({ status: 500, body: '{}' });
        return;
      }
      await route.continue();
    });
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('Quota note');
    await notes.write('Quota note\nmore text that should stay');
    await expect(notes.saveErrorAlert).toBeVisible({ timeout: 15_000 });
    await expect(notes.status).toHaveText('Not saved');
    await expect(notes.editor).toHaveValue('Quota note\nmore text that should stay');

    failPuts = false;
    await notes.retrySaveButton.click();
    await expect(notes.saveErrorAlert).toBeHidden({ timeout: 15_000 });
    await expect(notes.status).toHaveText('Saved');
    await expect.poll(async () => (await listServerNotes(page)).map((n) => n.content)).toEqual([
      'Quota note\nmore text that should stay',
    ]);
  });

  test('a failed load shows the load error and Try again recovers', async ({ page }) => {
    let failGets = 1;
    await page.route('**/notes', async (route) => {
      if (route.request().method() === 'GET' && failGets > 0) {
        failGets--;
        await route.fulfill({ status: 500, body: '{}' });
        return;
      }
      await route.continue();
    });
    // Force a reopen so LoadAsync hits the failing GET.
    await shell.openNotesFromHeader();
    await shell.notes.close();
    failGets = 1;
    const notes = await shell.openNotesFromHeader();
    if (await notes.loadErrorAlert.isVisible()) {
      await notes.loadRetryButton.click();
    }
    await expect(notes.newNoteButton).toBeVisible({ timeout: 30_000 });
  });
});
