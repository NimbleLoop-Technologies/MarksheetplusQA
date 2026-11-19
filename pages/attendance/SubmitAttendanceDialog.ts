import { expect, type Locator, type Page } from '@playwright/test';

/** "Submit attendance for <section>?" confirmation modal. */
export class SubmitAttendanceDialog {
  readonly dialog: Locator;

  constructor(private readonly page: Page) {
    this.dialog = page.getByRole('dialog', { name: /^Submit attendance for / });
  }

  async expectOpen() {
    await expect(this.dialog).toBeVisible();
  }

  title(): Locator {
    return this.dialog.getByRole('heading').or(this.dialog.locator('[data-dialog-title], h2, h3').first());
  }

  async cancel() {
    const btn = this.dialog.getByRole('button', { name: /cancel|close|keep/i });
    if (await btn.count()) await btn.first().click();
    else await this.page.keyboard.press('Escape');
  }

  async confirm() {
    await this.dialog.getByRole('button', { name: 'Submit register', exact: true }).click();
  }

  async doubleClickConfirm() {
    await this.dialog.getByRole('button', { name: 'Submit register', exact: true }).dblclick();
  }

  async review() {
    await this.dialog.getByRole('button', { name: 'Review', exact: true }).click();
  }

  /** The warning/status text the dialog shows after the server refused the register. */
  statusText(): Locator {
    // The dialog also holds empty sr-only live regions (buttons, data-submit-status); the outcome is the alert with a heading.
    return this.dialog.locator('div').filter({ has: this.page.getByRole('heading', { name: /needs review|submitted by another|roster changed/i }) }).last();
  }

  async expectClosed() {
    await expect(this.dialog).toBeHidden({ timeout: 15_000 });
  }
}
