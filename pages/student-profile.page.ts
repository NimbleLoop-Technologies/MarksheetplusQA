import { Page, expect } from '@playwright/test';

/** Student profile (`/students/{id}`). Page title is the student's full name. */
export class StudentProfilePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async expectLoadedFor(studentId: string): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`/students/${studentId}$`));
    // "<Full Name> | <app>", and not the list's title still showing from before navigation.
    await expect(this.page).toHaveTitle(/^(?!Admission Register \|).+ \| /, { timeout: 30_000 });
  }
}
