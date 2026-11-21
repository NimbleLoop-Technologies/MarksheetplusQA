import { expect, type Locator, type Page } from '@playwright/test';

/** School WebApp: the right-hand "Parent app" drawer opened from an Admission Register row. */
export class FamilyInviteCodeDrawer {
  readonly root: Locator;
  readonly description: Locator;
  readonly closeButton: Locator;
  /**
   * The code itself renders as a bare <span> with no role or label, so there is no accessible
   * locator for it. data-invite-code is the component's own hook (FamilyInviteCodeDrawer.razor).
   */
  readonly code: Locator;
  /** Message shown when there is no live code (never sent, expired, declined). */
  readonly statusMessage: Locator;
  /** Inline success Alert (role=status with a heading). */
  readonly notice: Locator;
  /** Inline danger Alert (role=alert with a heading). */
  readonly error: Locator;
  readonly copyButton: Locator;
  /** First issue via Copy code (WhatsApp is off unless staff send). Alias for the old generate control. */
  readonly generateButton: Locator;
  readonly sendWhatsAppButton: Locator;
  readonly resendButton: Locator;
  readonly regenerateButton: Locator;
  readonly unlinkButton: Locator;
  readonly regenerateConfirm: Locator;
  readonly unlinkConfirm: Locator;
  readonly whatsAppBlocked: Locator;
  readonly cancelInviteButton: Locator;

  constructor(private readonly page: Page) {
    this.root = page.getByRole('dialog', { name: 'Parent app' });
    this.description = this.root.getByRole('paragraph').first();
    this.closeButton = this.root.getByRole('button', { name: 'Close panel' });
    this.code = this.root.locator('[data-invite-code]');
    this.statusMessage = this.root.locator('[data-invite-message]');
    this.notice = this.root.getByRole('status').getByRole('heading', { level: 3 });
    this.whatsAppBlocked = this.root.locator('[data-whatsapp-blocked]');
    // The trial/exhausted WhatsApp banner is also role=alert with a heading; it is not an error.
    this.error = this.root.getByRole('alert').filter({ hasNot: this.whatsAppBlocked }).getByRole('heading', { level: 3 });
    this.copyButton = this.root.getByRole('button', { name: 'Copy code' });
    this.generateButton = this.copyButton;
    this.sendWhatsAppButton = this.root.getByRole('button', { name: 'Send by WhatsApp' });
    this.resendButton = this.root.getByRole('button', { name: 'Re-send', exact: true });
    this.regenerateButton = this.root.getByRole('button', { name: 'New code', exact: true });
    this.unlinkButton = this.root.getByRole('button', { name: 'Unlink', exact: true });
    this.regenerateConfirm = page.getByRole('alertdialog', { name: 'Make a new code?' });
    this.unlinkConfirm = this.root.locator('[data-unlink-confirm]');
    this.cancelInviteButton = this.root.getByRole('button', { name: 'Cancel invite' });
  }

  async expectLoaded(studentName: string) {
    await expect(this.root).toBeVisible();
    await expect(this.root.getByRole('heading', { name: 'Parent app', level: 2 })).toBeVisible();
    await expect(this.root.getByText(studentName, { exact: true })).toBeVisible();
    // Loaded = status badge or an error (Copy + Send are both present on Not linked, so or() is not strict-safe).
    await expect(this.root.locator('[data-parent-app-state]').first()).toBeVisible({ timeout: 15_000 });
  }

  /** Value of a row in the details list, e.g. "Expires" or "Sent to". */
  detail(label: 'Expires' | 'Sent to' | 'Sent' | 'Expired' | 'Family phone' | 'Linked'): Locator {
    return this.root.getByRole('term').filter({ hasText: label }).locator('xpath=following-sibling::*[1]');
  }

  async currentCode(): Promise<string> {
    await expect(this.code).toBeVisible();
    return (await this.code.innerText()).trim();
  }

  /** Mints the first code with Copy (no WhatsApp) and returns it as displayed (ABC-DEF). */
  async generate(): Promise<string> {
    await this.copyButton.click();
    // The "Code copied." toast only appears when the clipboard write succeeds; the live code is the issue signal.
    await expect(this.code).toBeVisible();
    return this.currentCode();
  }

  /** Sends the first code by WhatsApp to the selected recipient (Mother / Father / Guardian). */
  async sendByWhatsApp(): Promise<string> {
    await expect(this.sendWhatsAppButton).toBeEnabled();
    await this.sendWhatsAppButton.click();
    await expect(this.code).toBeVisible();
    await expect(this.notice).toHaveText('Code sent. You will see the student connect once the parent enters it.');
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
    await this.regenerateConfirm.getByRole('button', { name: 'New code', exact: true }).click();
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

  async startUnlink() {
    await this.unlinkButton.click();
    await expect(this.unlinkConfirm).toBeVisible();
    await expect(this.unlinkConfirm).toContainText('Unlink the parent app?');
    await expect(this.unlinkConfirm).toContainText('The family stops seeing this student in their app. You can send a new code later.');
  }

  async confirmUnlink(reason?: string) {
    if (reason) await this.root.getByLabel('Reason (optional)').fill(reason);
    await this.root.locator('[data-action="confirm-unlink"]').click();
    await expect(this.unlinkConfirm).toBeHidden();
  }

  async cancelUnlink() {
    await this.root.locator('[data-action="cancel-unlink"]').click();
    await expect(this.unlinkConfirm).toBeHidden();
  }

  async close() {
    await this.closeButton.click();
    await expect(this.root).toBeHidden();
  }
}
