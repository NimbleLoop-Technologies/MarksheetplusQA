import { expect, type Locator, type Page } from '@playwright/test';

export interface QuotaStats { included: number; extra: number; used: number; remaining: number }

/**
 * WebApp /setup/subscription → "WhatsApp messages" card (WhatsAppQuotaCard.razor, PR 538) and its
 * "Request extra WhatsApp quota" modal (RequestQuotaModal.razor).
 * The card is a plain <div>; its `[data-quota-card]` hook is the only stable scope (no landmark/label).
 */
export class SubscriptionQuotaCard {
  readonly card: Locator;
  readonly modal: Locator;

  constructor(private readonly page: Page) {
    this.card = page.locator('[data-quota-card]');
    this.modal = page.getByRole('dialog', { name: 'Request extra WhatsApp quota' });
  }

  async open() {
    await this.page.goto('/setup/subscription');
    await this.expectLoaded();
  }

  async expectLoaded() {
    await expect(this.page.getByRole('heading', { name: 'Subscription', level: 1 })).toBeVisible({ timeout: 30_000 });
    // Loaded = the skeleton is gone (data-quota-loading) and either a state alert or the stats rendered.
    await expect(this.card.locator('[data-quota-loading]')).toHaveCount(0, { timeout: 30_000 });
    await expect(this.card.getByText(/WhatsApp notifications are not available|Included this month/)).toBeVisible();
  }

  text() { return this.card.innerText(); }
  trialNotice() { return this.card.locator('[data-quota-trial]'); }
  skippedNotice() { return this.card.locator('[data-quota-skipped]'); }
  pendingNotice() { return this.card.locator('[data-quota-pending]'); }
  requestButton() { return this.card.getByRole('button', { name: 'Request extra quota' }); }
  addOnsHeading() { return this.card.getByRole('heading', { name: 'Purchased add-ons' }); }

  /** Reads the four DescriptionList values ("Included this month" … "Remaining"). */
  async stats(): Promise<QuotaStats> {
    const text = await this.card.locator('[data-quota-stats]').innerText();
    const read = (label: string) => Number(new RegExp(`${label}\\s*\\n?\\s*([\\d,]+)`).exec(text)?.[1].replace(/,/g, '') ?? NaN);
    return { included: read('Included this month'), extra: read('Extra \\(purchased add-ons\\)'), used: read('Used'), remaining: read('Remaining') };
  }

  /** Card button → modal → pick the package by its "N messages" label → bank details → submit → Done. */
  async requestPackage(messages: number) {
    await this.requestButton().click();
    await expect(this.modal).toBeVisible();
    await this.modal.getByRole('radio', { name: `${messages.toLocaleString('en-US')} messages` }).first().check();
    await this.modal.getByRole('button', { name: 'Continue' }).click();
    await expect(this.modal.getByRole('heading', { name: 'Bank transfer details' })).toBeVisible();
    await this.modal.getByRole('button', { name: 'Submit request' }).click();
    await expect(this.modal.getByText('Request submitted')).toBeVisible();
    await this.modal.getByRole('button', { name: 'Done' }).click();
  }
}
