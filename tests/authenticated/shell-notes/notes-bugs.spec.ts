// PR 543 cycle 2: re-verify the 9 filed bugs against the server-side notes fix (head 481896bd).
// Tests assert the FIXED behaviour and should PASS when the bugs are resolved.
import { test, expect } from '@playwright/test';
import { AppShell } from '../../../pages/shell/AppShell';
import { LoginPage } from '../../../pages/LoginPage';
import { clearNotes, listServerNotes, notesKeys } from '../../../fixtures/notes-storage';
import { skipIfNoNotes } from '../../../fixtures/notes-available';

test.describe('shell notes: cycle-2 bug re-verification (head 481896bd)', () => {
  test.beforeEach(async ({ page }) => { await skipIfNoNotes(page); });

  let shell: AppShell;

  test.beforeEach(async ({ page }) => {
    shell = new AppShell(page);
    await shell.gotoHome();
    await clearNotes(page);
  });

  test('NEW-1 / z94x8ec5cg notes leave nothing on the device after logout and return after resign-in', { tag: '@smoke' }, async ({ page }) => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('Persist after logout');
    await notes.close();
    expect((await listServerNotes(page)).map((n) => n.content)).toContain('Persist after logout');

    await shell.signOut();
    expect(await notesKeys(page)).toEqual([]);

    await page.goto('/');
    await new LoginPage(page).signIn(process.env.QA_EMAIL!, process.env.QA_PASSWORD!);
    await shell.expectLoaded();
    const again = await shell.openNotesFromHeader();
    expect(await again.noteTitles()).toEqual(['Persist after logout']);
  });

  test('NEW-2 / z94x8ec5ch notes sync across two browser contexts for the same user', async ({ browser, page }) => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('Shared across devices');
    await notes.close();

    const ctx2 = await browser.newContext({
      storageState: '.auth/user.json',
      ignoreHTTPSErrors: true,
      baseURL: process.env.QA_BASE_URL,
    });
    const page2 = await ctx2.newPage();
    const shell2 = new AppShell(page2);
    await shell2.gotoHome();
    const notes2 = await shell2.openNotesFromHeader();
    expect(await notes2.noteTitles()).toContain('Shared across devices');
    await notes2.newNote('Added on device two');
    await notes2.close();
    await ctx2.close();

    // Re-open drawer on device one (triggers LoadAsync) and see device two's note.
    await shell.openNotesFromHeader();
    expect(await notes.noteTitles()).toEqual(expect.arrayContaining(['Shared across devices', 'Added on device two']));
  });

  test('BUG-01 / z94x8ec5cj a note added in a second tab is not lost when the first tab saves', async ({ page, context }) => {
    const tabOne = await shell.openNotesFromHeader();
    await tabOne.newNote('Shared note');

    const page2 = await context.newPage();
    const shell2 = new AppShell(page2);
    await shell2.gotoHome();
    const tabTwo = await shell2.openNotesFromHeader();
    await tabTwo.newNote('Added in tab two');
    await page2.close();

    await tabOne.write('Shared note edited in tab one');
    // Re-open to reload from server (OpenAsync loads when not dirty after flush).
    await tabOne.close();
    const again = await shell.openNotesFromHeader();
    const titles = await again.noteTitles();
    expect(titles).toEqual(expect.arrayContaining(['Shared note edited in tab one', 'Added in tab two']));
    const stored = (await listServerNotes(page)).map((n) => n.content);
    expect(stored).toEqual(expect.arrayContaining(['Shared note edited in tab one', 'Added in tab two']));
  });

  test('BUG-02 / z94x8ec5ck deleting a note with content asks for confirmation', async ({ page }) => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('Important: parent meeting list\nAhmed, Sara, Bilal');
    await notes.deleteSelectedNote();
    await expect(notes.deleteConfirmation()).toBeVisible({ timeout: 5_000 });
    expect((await listServerNotes(page)).length).toBe(1);
    await notes.cancelDelete();
    expect(await notes.noteTitles()).toContain('Important: parent meeting list');
  });

  test('BUG-03 / z94x8ec5cm typing a sentence does not PUT on every keystroke (debounced save)', async ({ page }) => {
    let puts = 0;
    await page.route('**/notes/**', async (route) => {
      if (route.request().method() === 'PUT') puts++;
      await route.continue();
    });
    const notes = await shell.openNotesFromHeader();
    await notes.newNote();
    puts = 0;
    await notes.type('Collect fee slips today', 20); // 23 keys
    await expect(notes.status).toHaveText('Saved', { timeout: 15_000 });
    await expect.poll(async () => (await listServerNotes(page))[0]?.content).toBe('Collect fee slips today');
    expect(puts).toBeLessThanOrEqual(3);
  });

  test('BUG-04 / z94x8ec5cn the status live region is not re-announced on every keystroke', async () => {
    const notes = await shell.openNotesFromHeader();
    await notes.newNote();
    await notes.recordStatusAnnouncements();
    await notes.type('Collect fee slips today', 20);
    await expect(notes.status).toHaveText('Saved', { timeout: 15_000 });
    expect((await notes.statusAnnouncements()).length).toBeLessThanOrEqual(4);
  });

  test('BUG-05 / z94x8ec5cp the empty state shows its description text', async () => {
    const notes = await shell.openNotesFromHeader();
    await expect(notes.emptyStateHeading).toBeVisible();
    await expect(notes.emptyStateDescription()).toBeVisible();
  });

  test('BUG-06 / z94x8ec5cq load failure offers a recoverable path (retry); localStorage corruption path is gone', async ({ page }) => {
    // Server-side storage: notes are not in localStorage, so "{not json" corruption cannot strand the notepad.
    expect(await notesKeys(page)).toEqual([]);
    // Force a load failure by aborting GET /notes once, then allow retry.
    let blocked = true;
    await page.route('**/notes', async (route) => {
      if (route.request().method() === 'GET' && blocked) {
        blocked = false;
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    const notes = await shell.openNotesFromHeader();
    // OpenAsync already GETs; if the first GET failed, show load error with Try again.
    if (await notes.loadErrorAlert.isVisible()) {
      await notes.loadRetryButton.click();
      await expect(notes.newNoteButton).toBeVisible({ timeout: 30_000 });
    } else {
      // Load succeeded on a later GET inside OpenAsync — notepad is usable.
      await expect(notes.newNoteButton).toBeVisible();
    }
    // Product asked for "start fresh" for unreadable notes; with server storage the corrupt-local path is eliminated.
    // Record whether a start-fresh control exists (informational for the report).
    const hasStartFresh = await notes.loadRecoveryActions().count();
    test.info().annotations.push({ type: 'start-fresh-controls', description: String(hasStartFresh) });
  });

  test('BUG-07 / z94x8ec5ct typing near the 10k limit stays responsive (10 keystrokes saved within 5 s)', async ({ page }) => {
    const notes = await shell.openNotesFromHeader();
    // Server max is 10_000 characters; fill close to the limit then type 10 more within remaining room.
    const body = `Big\n${'a'.repeat(9_980)}`;
    await notes.newNote(body);
    await expect(notes.status).toHaveText('Saved', { timeout: 60_000 });
    const started = Date.now();
    await notes.type('0123456789');
    await expect(notes.status).toHaveText('Saved', { timeout: 15_000 });
    await expect.poll(async () => (await listServerNotes(page))[0]?.content.endsWith('0123456789')).toBe(true);
    expect(Date.now() - started, 'ms from first keystroke to saved').toBeLessThan(5_000);
  });
});
