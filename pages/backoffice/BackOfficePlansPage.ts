import { expect, type Locator, type Page } from '@playwright/test';

/** AuthApp /backoffice/plans (Plans.razor) — "New plan" / "Edit" modal (#plan-modal, dialog "New plan"). */
export class BackOfficePlansPage {
  readonly modal: Locator;

  constructor(private readonly page: Page, private readonly baseUrl: string) {
    this.modal = page.getByRole('dialog', { name: /New plan|Edit plan/ });
  }

  /** Expects the page's context to already carry the operator's AuthApp cookie (see BackOffice.storageState()). */
  async open() {
    await this.page.goto(`${this.baseUrl}/backoffice/plans`);
    await expect(this.page.getByRole('heading', { name: 'Plans', level: 1 })).toBeVisible({ timeout: 30_000 });
  }

  quotaInput() { return this.modal.getByRole('spinbutton', { name: 'WhatsApp messages / month' }); }
  row(name: string) { return this.page.getByRole('row', { name: new RegExp(name) }); }

  async startNewPlan(name: string, price: number) {
    await this.page.getByRole('button', { name: 'New plan' }).click();
    await expect(this.modal).toBeVisible();
    await this.modal.getByRole('textbox', { name: 'Plan name' }).fill(name);
    await this.modal.getByRole('spinbutton', { name: 'Price (PKR)' }).fill(String(price));
  }

  async typeQuota(value: string) {
    await this.quotaInput().fill(value);
    await this.quotaInput().press('Tab');
  }

  async create() { await this.modal.getByRole('button', { name: 'Create' }).click(); }
  /** Visible validation lines inside the modal. */
  async errors() { return (await this.modal.innerText()).split('\n').filter((l) => /must|invalid|valid number|greater/i.test(l)); }
}
