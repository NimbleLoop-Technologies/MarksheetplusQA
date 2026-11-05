// PR 543 AC5: dashboard still renders, desktop theme toggle still works, no unhandled errors while using notes.
import { test, expect, type ConsoleMessage } from '@playwright/test';
import { AppShell } from '../../../pages/shell/AppShell';
import { clearNotes } from '../../../fixtures/notes-storage';

// Local-stack noise unrelated to the PR: self-signed cert blocks the service worker; the stored refresh token in
// .auth/user.json is already rotated, so the boot-time /connect/token refresh answers 400 ("Failed to load resource").
const ENV_NOISE = /SSL certificate|ServiceWorker|Failed to load resource/i;

test.describe('shell notes: regression', () => {
  let shell: AppShell;

  test.beforeEach(async ({ page }) => {
    shell = new AppShell(page);
    await shell.gotoHome();
    await clearNotes(page);
  });

  test('Home dashboard tiles and calendar still render next to the Notes action', async () => {
    for (const tile of ['Strength', 'Absent today', 'Pending results']) await expect(shell.homeTile(tile)).toBeVisible({ timeout: 30_000 });
    await expect(shell.calendarHeading).toBeVisible();
    await expect(shell.headerNotesButton).toBeVisible();
    await expect(shell.headerThemeToggle).toBeVisible();
  });

  test('the header theme toggle still switches theme and sits after the Notes action', async ({ page }) => {
    const html = page.locator('html');
    const startsDark = await html.evaluate((el) => el.classList.contains('dark'));
    await shell.headerThemeToggle.click();
    await expect.poll(() => html.evaluate((el) => el.classList.contains('dark'))).toBe(!startsDark);
    await expect(shell.headerThemeToggle).toHaveAttribute('aria-pressed', String(!startsDark));
    await shell.headerThemeToggle.click();
    await expect.poll(() => html.evaluate((el) => el.classList.contains('dark'))).toBe(startsDark);
  });

  test('a full notes session raises no console errors or unhandled exceptions', async ({ page }) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => { if (!ENV_NOISE.test(e.message)) problems.push(`pageerror: ${e.message}`); });
    page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error' && !ENV_NOISE.test(m.text())) problems.push(`console: ${m.text()}`); });

    const notes = await shell.openNotesFromHeader();
    await notes.newNote('One\ntwo');
    await notes.newNote('Three');
    await notes.selectNote('One');
    await notes.type(' more', 20);
    await notes.closeEditor();
    await notes.selectNote('Three');
    await notes.deleteSelectedNote();
    await notes.close();
    await shell.goToModule('Admission Office', /\/registrar\/students/);
    await shell.openNotesFromHeader();
    await page.keyboard.press('Escape');
    expect(problems).toEqual([]);
  });
});
