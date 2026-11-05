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
    return this.dialog.getByRole('status');
  }

  async expectClosed() {
    await expect(this.dialog).toBeHidden({ timeout: 15_000 });
  }
}
