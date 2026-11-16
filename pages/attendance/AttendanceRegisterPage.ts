import { expect, type Locator, type Page } from '@playwright/test';
import { MonthRegisterGrid } from './MonthRegisterGrid';
import { SubmitAttendanceDialog } from './SubmitAttendanceDialog';

/**
 * School WebApp: Classrooms → Attendance Register (/classrooms/attendance).
 * The "Today" tab also hosts a dated register (?date=yyyy-MM-dd) opened from the month grid (PR 548).
 */
export class AttendanceRegisterPage {
  readonly heading: Locator;
  readonly todayTab: Locator;
  readonly monthTab: Locator;
  readonly month: MonthRegisterGrid;
  readonly submitDialog: SubmitAttendanceDialog;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Attendance Register', level: 1 });
    const tabs = page.getByRole('navigation', { name: 'Tabs' });
    this.todayTab = tabs.getByRole('button', { name: 'Today' });
    this.monthTab = tabs.getByRole('button', { name: 'Month' });
    this.month = new MonthRegisterGrid(page);
    this.submitDialog = new SubmitAttendanceDialog(page);
  }

  async gotoToday(sectionId: string, date?: string) {
    const query = new URLSearchParams({ section: sectionId, view: 'today', ...(date ? { date } : {}) });
    await this.page.goto(`/classrooms/attendance?${query}`);
    await this.expectLoaded();
  }

  async gotoMonth(sectionId: string, isoMonth: string) {
    await this.page.goto(`/classrooms/attendance?section=${sectionId}&view=month&month=${isoMonth.slice(0, 7)}`);
    await this.expectLoaded();
    await this.month.expectLoaded();
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  /** The register's date line, e.g. "Friday, 30 Oct 2026". */
  registerDate(): Locator {
    // A plain <p> with no role or label; the data attribute is the component's own hook.
    return this.page.locator('[data-register-date]');
  }

  /** The "Mark past attendance" banner shown over an open, unsubmitted past register. */
  pastDateBanner(): Locator {
    return this.page.getByRole('status').filter({ has: this.page.getByRole('heading', { name: 'Mark past attendance' }) });
  }

  closedBanner(): Locator {
    return this.page.getByRole('status').filter({ has: this.page.getByRole('heading', { name: 'This register is closed' }) });
  }

  submittedBanner(): Locator {
    return this.page.getByRole('status').filter({ has: this.page.getByRole('heading', { name: 'Attendance submitted' }) });
  }

  rosterRow(studentName: string): Locator {
    return this.page.getByRole('row').filter({ has: this.page.getByRole('cell', { name: studentName, exact: true }) });
  }

  /** Every student name in the roster table, in order. */
  async rosterNames(): Promise<string[]> {
    const rows = this.page.getByRole('row').filter({ has: this.page.getByRole('group', { name: /^Status of / }) });
    await expect(rows.first()).toBeVisible();
    const groups = await rows.getByRole('group', { name: /^Status of / }).all();
    return Promise.all(groups.map(async (g) => (await g.getAttribute('aria-label'))!.replace(/^Status of /, '')));
  }

  async markAbsent(studentName: string) {
    const button = this.page.getByRole('group', { name: `Status of ${studentName}`, exact: true }).getByRole('button', { name: 'Absent' });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }

  async openSubmit() {
    await this.page.getByRole('button', { name: 'Submit attendance', exact: true }).click();
    await this.submitDialog.expectOpen();
  }

  async backToToday() {
    await this.page.getByRole('button', { name: 'Back to today' }).first().click();
  }

  async openMonthTab() {
    await this.monthTab.click();
    await this.month.expectLoaded();
  }

  successToast(): Locator {
    // The toast body reads "Attendance submitted. <section>, <date>." (its title repeats the first two words).
    return this.page.getByRole('region', { name: 'Notifications' }).getByText(/^Attendance submitted\. /);
  }

  url(): URL {
    return new URL(this.page.url());
  }
}
