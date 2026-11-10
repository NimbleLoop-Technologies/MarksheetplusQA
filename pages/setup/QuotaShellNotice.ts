import { type Locator, type Page } from '@playwright/test';

/**
 * The WebApp shell's "WhatsApp quota exhausted" notice (WhatsAppQuotaAlert.razor, PR 538). AppShellNotice
 * renders no landmark or label, so `[data-whatsapp-quota-notice]` is the only stable hook.
 */
export class QuotaShellNotice {
  readonly notice: Locator;

  constructor(private readonly page: Page) {
    this.notice = page.locator('[data-whatsapp-quota-notice]');
  }

  /** The WebApp home page heading (h1 "Home"), to know the shell has rendered. */
  homeHeading() { return this.page.getByRole('heading', { name: 'Home', level: 1 }); }
  requestLink() { return this.notice.getByRole('link', { name: 'Request extra quota' }); }
  closeButtons() { return this.notice.getByRole('button'); }
  /** In-app (no reload) navigation through the rail. */
  async goHomeInApp() { await this.page.getByRole('link', { name: 'Home' }).first().click(); }
}
