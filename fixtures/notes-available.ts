import { expect, type Page, test } from '@playwright/test';

/** True when the Dashboard header exposes the Notes action. */
export async function notesUiPresent(page: Page): Promise<boolean> {
  await page.goto('/');
  await expect(page.locator('body')).toBeVisible({ timeout: 30_000 });
  // Wait for the WASM shell header to render before counting (otherwise the check races and skips).
  await page.getByRole('button', { name: /^(Open user menu|More options)$/ }).first().waitFor({ timeout: 30_000 }).catch(() => {});
  return (await page.getByRole('button', { name: /^Notes$/i }).count()) > 0;
}

/** Skip the calling test/suite when Notes is not on this stack. */
export async function skipIfNoNotes(page: Page) {
  if (!(await notesUiPresent(page))) {
    test.skip(true, 'Notes UI not on this stack (PR 543 product not deployed here); specs stay on main for when it is.');
  }
}
