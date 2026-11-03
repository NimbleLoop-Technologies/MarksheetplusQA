import { expect, type Locator, type Page } from '@playwright/test';

/** WebApp /setup/campus-settings → "WhatsApp notifications" section (CampusSettings.razor, PR 538). Each toggle saves on change. */
export class CampusNotificationSettings {
  readonly heading: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'WhatsApp notifications', level: 2 });
  }

  async open() {
    await this.page.goto('/setup/campus-settings');
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
    await expect(this.toggle('Result published')).toBeVisible({ timeout: 30_000 });
  }

  /** "Result published" | "Fee dues" */
  toggle(label: string) { return this.page.getByRole('checkbox', { name: label, exact: true }); }

  /** Clicks the toggle and waits for its PUT campus/notification-preferences to answer. */
  async setEnabled(label: string, enabled: boolean) {
    const toggle = this.toggle(label);
    if ((await toggle.isChecked()) === enabled) return;
    const saved = this.page.waitForResponse((r) => r.url().includes('campus/notification-preferences') && r.request().method() === 'PUT');
    await toggle.click();
    expect((await saved).ok()).toBe(true);
  }
}
