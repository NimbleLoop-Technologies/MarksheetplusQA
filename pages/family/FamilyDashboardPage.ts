import { expect, type Locator, type Page } from '@playwright/test';

/** Family app: /dashboard ("Good morning, …" with one card per linked child). */
export class FamilyDashboardPage {
  readonly greeting: Locator;
  readonly main: Locator;

  constructor(private readonly page: Page) {
    this.greeting = page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/, level: 1 });
    this.main = page.getByRole('main');
  }

  async goto() {
    await this.page.goto('/dashboard');
    await this.expectLoaded();
  }

  async expectLoaded() {
    await expect(this.page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    await expect(this.greeting).toBeVisible({ timeout: 30_000 });
  }

  /** A child's card is identified by the child's full name (cards have no role or label). */
  child(fullName: string): Locator {
    return this.main.getByText(fullName, { exact: true });
  }
}
