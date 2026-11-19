import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Account Office → Staff Payroll landing page (/accounts/staff-payroll), PR 544.
 * Month card (month heading + one state line), header actions (Incentives & deductions, Policy, the state's primary
 * action) and the past runs table. Recorded in docs/qa/ui-reference.md → "Staff Payroll".
 */
export class StaffPayrollPage {
  readonly heading: Locator;
  readonly main: Locator;
  readonly generateButton: Locator;
  readonly continueDraftButton: Locator;
  readonly viewRunButton: Locator;
  readonly discardDraftButton: Locator;
  readonly policyButton: Locator;
  readonly incentivesButton: Locator;
  readonly stateLine: Locator;
  readonly noPolicyReason: Locator;
  readonly policyLink: Locator;
  readonly staffRegisterLink: Locator;
  readonly pastRunsTable: Locator;
  readonly readOnlyNote: Locator;
  readonly breadcrumb: Locator;
  readonly loadingSkeleton: Locator;
  readonly accountOfficeNav: Locator;

  constructor(private readonly page: Page) {
    this.main = page.getByRole('main');
    this.heading = this.main.getByRole('heading', { name: 'Staff Payroll', level: 1 });
    this.generateButton = this.main.getByRole('button', { name: 'Generate payroll' });
    this.continueDraftButton = this.main.getByRole('button', { name: 'Continue draft' });
    // The month card's primary action is a Button with Href, rendered as a button (not the per-row "View run for …" link).
    this.viewRunButton = this.main.getByRole('button', { name: 'View run', exact: true });
    this.discardDraftButton = this.main.getByRole('button', { name: 'Discard draft' }).or(this.main.getByRole('link', { name: 'Discard draft' }));
    this.policyButton =this.main.getByRole('button', { name: 'Policy', exact: true });
    this.incentivesButton = this.main.getByRole('button', { name: 'Incentives & deductions' });
    // The card's state sentence is the paragraph directly under the month heading (data-month-state; no role).
    this.stateLine = this.main.locator('[data-month-state]');
    this.noPolicyReason = this.main.locator('[data-no-policy]');
    this.policyLink = this.noPolicyReason.getByRole('link');
    this.staffRegisterLink = this.main.getByRole('link', { name: 'Staff Register' });
    this.pastRunsTable = this.main.getByRole('table');
    this.readOnlyNote = this.main.getByText('You can view payroll. Running it needs the Payroll edit permission.');
    this.breadcrumb = page.getByRole('navigation', { name: /breadcrumb/i });
    this.loadingSkeleton = this.main.locator('[aria-busy="true"]');
    this.accountOfficeNav = page.getByRole('navigation', { name: 'Account Office pages' });
  }

  async goto() {
    await this.page.goto('/accounts/staff-payroll');
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  /** Waits for the month card (or a load error) to replace the skeleton. */
  async expectMonthCard() {
    await expect(this.stateLine.or(this.main.getByRole('alert'))).toBeVisible({ timeout: 30_000 });
  }

  monthHeading(label: string): Locator {
    return this.main.getByRole('heading', { name: label, level: 2 });
  }

  /** Staff Payroll entry in the Account Office sub-navigation. */
  navLink(): Locator {
    return this.accountOfficeNav.getByRole('link', { name: 'Staff Payroll' });
  }

  /** Past runs, top to bottom, as the cell texts of each body row. */
  async pastRuns(): Promise<string[][]> {
    const rows = this.pastRunsTable.getByRole('rowgroup').nth(1).getByRole('row');
    const out: string[][] = [];
    for (const row of await rows.all()) out.push((await row.getByRole('cell').allInnerTexts()).map((t) => t.trim()));
    return out;
  }

  async pastRunHeaders(): Promise<string[]> {
    return (await this.pastRunsTable.getByRole('columnheader').allInnerTexts()).map((t) => t.trim());
  }

  viewRunLink(month: string): Locator {
    return this.pastRunsTable.getByRole('link', { name: `View run for ${month}` });
  }

  /** The inline load-failure alert (any role="alert" in main) and its Retry control. */
  loadError(): Locator {
    return this.main.getByRole('alert').first();
  }

  /** The spec's "Retry" control (link or button). */
  retry(): Locator {
    return this.main.getByRole('button', { name: /^retry$/i }).or(this.main.getByRole('link', { name: /^retry$/i })).first();
  }

  /** Whatever retry control the alert renders today ("Try again" button from LoadErrorAlert, or "Retry"). */
  retryControl(): Locator {
    return this.loadError().getByRole('button', { name: /^(retry|try again)$/i }).or(this.loadError().getByRole('link', { name: /^retry$/i })).first();
  }

  deniedText(text: string): Locator {
    return this.main.getByText(text);
  }

  /** Computed background colour of a control (to tell a solid orange primary from an outlined secondary). */
  async backgroundColor(control: Locator): Promise<string> {
    return control.evaluate((el) => getComputedStyle(el).backgroundColor);
  }
}
