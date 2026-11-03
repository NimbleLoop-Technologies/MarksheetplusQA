import { Page, Locator, expect } from '@playwright/test';

/** Admission Register (`/students`). */
export class StudentsPage {
  readonly page: Page;
  readonly studentRows: Locator;
  readonly firstViewLink: Locator;

  constructor(page: Page) {
    this.page = page;
    // Header rows hold columnheaders, not cells.
    this.studentRows = page.getByRole('row').filter({ has: page.getByRole('cell') });
    // CSS: the eye link wraps only an icon and has no accessible name.
    this.firstViewLink = page.locator('a[href^="students/"]').first();
  }

  async goto(): Promise<void> {
    await this.page.goto('/students');
  }

  /** Page title comes from the breadcrumb <PageTitle>: "Admission Register | <app>". */
  async expectLoaded(): Promise<void> {
    await expect(this.page).toHaveTitle(/^Admission Register \|/, { timeout: 30_000 });
  }

  async waitForRows(): Promise<void> {
    await expect(this.studentRows.first()).toBeVisible();
  }

  async studentCount(): Promise<number> {
    return this.studentRows.count();
  }

  /** Opens the first student's profile and returns its id from the link. */
  async openFirstStudent(): Promise<string> {
    const href = await this.firstViewLink.getAttribute('href');
    await this.firstViewLink.click();
    return (href ?? '').replace(/^students\//, '');
  }
}
