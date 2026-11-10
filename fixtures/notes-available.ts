import { expect, type Page, test } from '@playwright/test';

/**
 * True when the Dashboard header exposes the Notes action. Waits for the WASM shell to render first:
 * counting right after <body> is visible raced the shell and skipped every spec on a stack that HAS Notes
 * (PR 538 cycle 3, local b52eeae6 build: 0 buttons at once, 1 after the shell rendered).
 */
export async function notesUiPresent(page: Page): Promise<boolean> {
  await page.goto('/');
  await expect(page.locator('body')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 }).catch(() => undefined);
  // The phone layout hides the header action (Notes moves to the More options menu), so also accept the shell's hook.
  return (await page.getByRole('button', { name: /^Notes$/i }).count()) > 0 || (await page.locator('[data-shell-notes-open]').count()) > 0;
}

/** Skip the calling test/suite when Notes is not on this stack. */
export async function skipIfNoNotes(page: Page) {
  if (!(await notesUiPresent(page))) {
    test.skip(true, 'Notes UI not on this stack (PR 543 product not deployed here); specs stay on main for when it is.');
  }
}
