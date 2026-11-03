import { expect, type Locator, type Page } from '@playwright/test';

/** School WebApp: the right-hand "Family invite code" drawer opened from an Admission Register row. */
export class FamilyInviteCodeDrawer {
  readonly root: Locator;
  readonly description: Locator;
  readonly closeButton: Locator;
  /**
   * The code itself renders as a bare <span> with no role or label, so there is no accessible
   * locator for it. data-invite-code is the component's own hook (FamilyInviteCodeDrawer.razor).
   */
  readonly code: Locator;
  /** Message shown when there is no live code (never sent, expired, cancelled). */
  readonly statusMessage: Locator;
  /** Inline success Alert (role=status with a heading). */
  readonly notice: Locator;
  /** Inline danger Alert (role=alert with a heading). */
  readonly error: Locator;
  readonly copyButton: Locator;
  readonly generateButton: Locator;
  readonly resendButton: Locator;
  readonly regenerateButton: Locator;
  readonly cancelInviteButton: Locator;
  readonly regenerateConfirm: Locator;
  readonly cancelConfirm: Locator;

  constructor(private readonly page: Page) {
    this.root = page.getByRole('dialog', { name: 'Family invite code' });
    this.description = this.root.getByRole('paragraph').first();
    this.closeButton = this.root.getByRole('button', { name: 'Close panel' });
    this.code = this.root.locator('[data-invite-code]');
    // Same reason as `code`: a plain <p> with no role; data-invite-message is the component hook.
    this.statusMessage = this.root.locator('[data-invite-message]');
    this.notice = this.root.getByRole('status').getByRole('heading', { level: 3 });
    this.error = this.root.getByRole('alert').getByRole('heading', { level: 3 });
    this.copyButton = this.root.getByRole('button', { name: 'Copy', exact: true });
    this.generateButton = this.root.getByRole('button', { name: 'Generate code' });
    this.resendButton = this.root.getByRole('button', { name: 'Resend', exact: true });
    this.regenerateButton = this.root.getByRole('button', { name: 'Regenerate', exact: true });
    this.cancelInviteButton = this.root.getByRole('button', { name: 'Cancel invite', exact: true });
    this.regenerateConfirm = page.getByRole('alertdialog', { name: 'Replace this code?' });
    this.cancelConfirm = page.getByRole('alertdialog', { name: 'Cancel this invite?' });
  }

  async expectLoaded(studentName: string) {
    await expect(this.root).toBeVisible();
    await expect(this.root.getByRole('heading', { name: 'Family invite code', level: 2 })).toBeVisible();
    await expect(this.root.getByText(studentName, { exact: true })).toBeVisible();
    // Loaded = either a live code or the Generate action (the skeleton has neither).
    await expect(this.code.or(this.generateButton)).toBeVisible({ timeout: 15_000 });
  }

  /** Value of a row in the details list, e.g. "Expires" or "Sent to". */
  detail(label: 'Expires' | 'Sent to'): Locator {
    // <dt>/<dd> pairs with no wrapper or ids; the definition is the term's next sibling.
    return this.root.getByRole('term').filter({ hasText: label }).locator('xpath=following-sibling::*[1]');
  }

  async currentCode(): Promise<string> {
    await expect(this.code).toBeVisible();
    return (await this.code.innerText()).trim();
  }

  /** Generates the first code and returns it as displayed (ABC-DEF). */
  async generate(): Promise<string> {
    await this.generateButton.click();
    return this.currentCode();
  }

  async copy() {
    await this.copyButton.click();
  }

  async clipboardText(): Promise<string> {
    return this.page.evaluate(() => navigator.clipboard.readText());
  }

  async resend() {
    await this.resendButton.click();
  }

  async startRegenerate() {
    await this.regenerateButton.click();
    await expect(this.regenerateConfirm).toBeVisible();
  }

  async confirmRegenerate() {
    await this.regenerateConfirm.getByRole('button', { name: 'Regenerate', exact: true }).click();
    await expect(this.regenerateConfirm).toBeHidden();
  }

  async keepCodeOnRegenerate() {
    await this.regenerateConfirm.getByRole('button', { name: 'Keep it' }).click();
    await expect(this.regenerateConfirm).toBeHidden();
  }

  /** Regenerates and waits until the drawer shows a code different from `previous`. */
  async regenerate(previous: string): Promise<string> {
    await this.startRegenerate();
    await this.confirmRegenerate();
    await expect(this.code).not.toHaveText(previous);
    return this.currentCode();
  }

  async startCancelInvite() {
    await this.cancelInviteButton.click();
    await expect(this.cancelConfirm).toBeVisible();
  }

  async confirmCancelInvite() {
    await this.cancelConfirm.getByRole('button', { name: 'Cancel invite', exact: true }).click();
    await expect(this.cancelConfirm).toBeHidden();
  }

  async close() {
    await this.closeButton.click();
    await expect(this.root).toBeHidden();
  }
}
