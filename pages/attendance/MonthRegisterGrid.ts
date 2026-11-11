import { expect, type Locator, type Page } from '@playwright/test';

/** The Month tab of the Attendance Register: one row per student, one column per day. */
export class MonthRegisterGrid {
  readonly region: Locator;

  constructor(private readonly page: Page) {
    this.region = page.getByRole('region', { name: /^Month register, / });
  }

  async expectLoaded() {
    await expect(this.region.getByRole('table')).toBeVisible({ timeout: 30_000 });
  }

  /** Header button for an unmarked past working day (PR 548): "30, mark attendance for Friday, 30 Oct". */
  unmarkedDayButton(dayOfMonth: number, label: string): Locator {
    return this.region.getByRole('button', { name: `${dayOfMonth}, mark attendance for ${label}`, exact: true });
  }

  /** Any "mark attendance" header button, whichever day. */
  anyUnmarkedDayButtons(): Locator {
    return this.region.getByRole('columnheader').getByRole('button', { name: /, mark attendance for / });
  }

  /** Per-student cell button on an unmarked past working day. */
  missingCellButton(studentName: string, label: string): Locator {
    return this.region.getByRole('button', { name: `Not marked, ${studentName}, ${label}, mark attendance`, exact: true });
  }

  row(studentName: string): Locator {
    return this.region.getByRole('row').filter({ has: this.page.getByRole('rowheader', { name: new RegExp(`· ${studentName}$`) }) });
  }

  /** The P / A / - code the grid prints for a student on a day. */
  async code(studentName: string, dayOfMonth: number): Promise<string | null> {
    // Cell accessible names vary by state (button, sr-only text, plain letter); the component's data-day/data-code
    // attributes are the stable hook for "which day" and "which code".
    return this.row(studentName).locator(`td[data-day="${dayOfMonth}"]`).getAttribute('data-code');
  }

  /** The row's last column (Total). */
  total(studentName: string): Locator {
    return this.row(studentName).getByRole('cell').last();
  }

  async openUnmarkedDay(dayOfMonth: number, label: string) {
    await this.unmarkedDayButton(dayOfMonth, label).click();
  }
}
