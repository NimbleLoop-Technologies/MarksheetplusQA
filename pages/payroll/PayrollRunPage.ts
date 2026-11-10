import { expect, type Locator, type Page } from '@playwright/test';

/**
 * One payroll run (/accounts/staff-payroll/run/{RunId}), PR 544. The same page has three states:
 *  - Draft register: status strip, summary line, toolbar (search, Exceptions only, Review and publish), table, row panel.
 *  - Preview: strip, alerts / eligibility note, four tiles, table with change column, Back to draft / Publish payroll.
 *  - Published register: strip, four tiles, toolbar (search, Unpaid only), table, correction line.
 * Modals: publish confirmation, mark as paid, payslip, adjustment, preview breakdown.
 * Recorded in docs/qa/ui-reference.md → "Payroll run".
 */
export class PayrollRunPage {
  readonly main: Locator;
  readonly title: Locator;
  readonly backLink: Locator;
  readonly table: Locator;
  readonly search: Locator;
  readonly exceptionsOnly: Locator;
  readonly unpaidOnly: Locator;
  readonly reviewAndPublish: Locator;
  readonly pagination: Locator;
  readonly paginationSummary: Locator;
  readonly readOnlyNote: Locator;
  readonly notFound: Locator;
  // Draft
  readonly draftStrip: Locator;
  readonly summaryLine: Locator;
  readonly saveFailed: Locator;
  readonly panel: Locator;
  // Preview
  readonly previewStrip: Locator;
  readonly backToDraft: Locator;
  readonly publishPayroll: Locator;
  readonly irreversibilityLine: Locator;
  readonly previewSearch: Locator;
  // Published
  readonly publishedOn: Locator;
  readonly publishedLine: Locator;
  readonly correctionLine: Locator;
  readonly postAdjustment: Locator;
  readonly printButton: Locator;
  readonly exportButton: Locator;
  // Modals
  readonly dialog: Locator;
  readonly toasts: Locator;

  constructor(private readonly page: Page) {
    this.main = page.getByRole('main');
    this.title = this.main.getByRole('heading', { level: 1 });
    this.backLink = this.main.getByRole('link', { name: 'Back to Staff Payroll' });
    this.table = this.main.getByRole('table');
    this.search = this.main.getByRole('textbox', { name: 'Search staff' });
    this.exceptionsOnly = this.main.getByRole('button', { name: 'Exceptions only' });
    this.unpaidOnly = this.main.getByRole('button', { name: 'Unpaid only' });
    this.reviewAndPublish = this.main.getByRole('button', { name: 'Review and publish' });
    this.pagination = this.main.getByRole('navigation', { name: 'Pagination' });
    this.paginationSummary = this.main.getByText(/^Showing \d+ to \d+ of \d+ results/);
    this.readOnlyNote = this.main.getByText('You can view payroll. Running it needs the Payroll edit permission.');
    this.notFound = this.main.getByText('This payroll run could not be found.');
    this.draftStrip = this.main.getByText(/^Draft for /).first();
    this.summaryLine = this.main.getByText(/^\d+ staff members?\. \d+ at full month/);
    // The save-failure strip is an Alert (role=status) carrying data-save-failed.
    this.saveFailed = this.main.locator('[data-save-failed]');
    // The expanded row panel is a Card with data-row-panel; it has no role or name of its own.
    this.panel = this.main.locator('[data-row-panel]');
    this.previewStrip = this.main.getByText(/^Preview for /);
    this.backToDraft = this.main.getByRole('button', { name: 'Back to draft' });
    this.publishPayroll = this.main.getByRole('button', { name: 'Publish payroll' });
    this.irreversibilityLine = this.main.getByText('Publishing cannot be undone. A published run is corrected with a ledger adjustment, not by editing it.');
    this.previewSearch = this.main.getByRole('textbox', { name: /^Search/ });
    this.publishedOn = this.main.getByText(/^Published on /);
    this.publishedLine = this.main.getByText(/^Published by /);
    this.correctionLine = this.main.getByText('To correct a published run, post a ledger adjustment.');
    this.postAdjustment = this.main.getByRole('button', { name: 'Post an adjustment' }).or(this.main.getByRole('link', { name: 'Post an adjustment' }));
    this.printButton = this.main.getByRole('button', { name: 'Print' });
    this.exportButton = this.main.getByRole('button', { name: 'Export' });
    this.dialog = page.getByRole('dialog');
    this.toasts = page.getByRole('region', { name: 'Notifications' });
  }

  async goto(runId: string) {
    await this.page.goto(`/accounts/staff-payroll/run/${runId}`);
  }

  async expectDraftLoaded() {
    await expect(this.summaryLine).toBeVisible({ timeout: 30_000 });
    await expect(this.table.getByRole('row').nth(1)).toBeVisible();
  }

  async expectPublishedLoaded() {
    await expect(this.publishedOn).toBeVisible({ timeout: 30_000 });
    await expect(this.table.getByRole('row').nth(1)).toBeVisible();
  }

  async expectPreviewLoaded() {
    await expect(this.previewStrip).toBeVisible({ timeout: 30_000 });
    await expect(this.table.getByRole('row').nth(1)).toBeVisible();
  }

  // ── Table ────────────────────────────────────────────────────────────────────────────────────
  row(staffName: string): Locator {
    return this.table.getByRole('row').filter({ hasText: staffName });
  }

  async headers(): Promise<string[]> {
    return (await this.table.getByRole('columnheader').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  }

  async bodyRowCount(): Promise<number> {
    return this.table.getByRole('rowgroup').nth(1).getByRole('row').count();
  }

  /** The cell under a given column header for one staff member's row. */
  async cell(staffName: string, header: string): Promise<Locator> {
    const headers = (await this.table.getByRole('columnheader').allInnerTexts()).map((t) => t.trim());
    const index = headers.indexOf(header);
    expect(index, `column "${header}" in ${headers.join(' | ')}`).toBeGreaterThanOrEqual(0);
    return this.row(staffName).getByRole('cell').nth(index);
  }

  rowAction(staffName: string, name: string): Locator {
    return this.row(staffName).getByRole('button', { name, exact: true });
  }

  async openRow(staffName: string) {
    const row = this.row(staffName);
    await row.getByRole('button', { name: /^(Add exception|Edit)$/ }).click();
    await expect(this.panel).toBeVisible();
  }

  async searchFor(term: string) {
    await this.search.fill(term);
  }

  /** Text boxes, spin buttons, checkboxes and comboboxes in main (excluding the pager's rows-per-page select). */
  async editableControlCount(): Promise<number> {
    const n = await this.main.getByRole('textbox').count() + await this.main.getByRole('spinbutton').count() + await this.main.getByRole('checkbox').count();
    return n;
  }

  emptyState(text: string | RegExp): Locator {
    return this.main.getByText(text);
  }

  alert(text: string | RegExp): Locator {
    return this.main.getByRole('alert').filter({ hasText: text });
  }

  /** Any visible text inside main. */
  text(text: string | RegExp): Locator {
    return this.main.getByText(text);
  }

  // ── Row panel ────────────────────────────────────────────────────────────────────────────────
  get unpaidDays(): Locator {
    return this.panel.getByRole('spinbutton', { name: 'Unpaid days' });
  }

  async setUnpaidDays(value: string) {
    await this.unpaidDays.fill(value);
    await this.unpaidDays.blur();
  }

  panelText(text: string | RegExp): Locator {
    return this.panel.getByText(text);
  }

  /** The panel's big net figure ("Net for November" → value). */
  panelNet(): Locator {
    return this.panel.getByText(/^(Rs|PKR) [\d,-]+$|^Salary not set$/).last();
  }

  lineCheckbox(label: string): Locator {
    return this.panel.getByRole('checkbox', { name: label, exact: true });
  }

  /** The row holding one incentive / deduction line in the panel: checkbox, label and signed amount. */
  lineRow(label: string): Locator {
    // No role groups the line; take the checkbox's nearest ancestor that also holds the amount span.
    return this.lineCheckbox(label).locator('xpath=ancestor::div[.//span[contains(@class,"whitespace-nowrap")]][1]');
  }

  async lineAmountText(label: string): Promise<string> {
    const text = await this.lineRow(label).innerText();
    return (text.match(/[+−-]\s*(Rs|PKR)\s*[\d,]+/)?.[0] ?? '').replace(/\s+/g, ' ');
  }

  async lineAmountColor(label: string): Promise<string> {
    // The amount is the last span of the line row (no role, no name).
    return this.lineRow(label).locator('span.whitespace-nowrap').evaluate((el) => getComputedStyle(el).color);
  }

  /** "Open staff profile" — the panel's link to the Salary section when the salary is not set. */
  openProfileLink(): Locator {
    return this.panel.getByRole('link', { name: 'Open staff profile' }).or(this.panel.getByRole('button', { name: 'Open staff profile' }));
  }

  addOneOffLink(): Locator {
    return this.panel.getByRole('button', { name: '+ Add a one-off' }).or(this.panel.getByRole('link', { name: '+ Add a one-off' }));
  }

  oneOffField(name: 'Label' | 'Amount (PKR)' | 'Reason'): Locator {
    return this.panel.getByRole('textbox', { name, exact: true });
  }

  oneOffType(name: 'Incentive' | 'Deduction'): Locator {
    return this.panel.getByRole('radio', { name });
  }

  oneOffSubmit(): Locator {
    return this.panel.getByRole('button', { name: 'Add one-off' });
  }

  oneOffCancel(): Locator {
    return this.panel.getByRole('button', { name: 'Cancel' });
  }

  async fillOneOff(o: { type?: 'Incentive' | 'Deduction'; label?: string; amount?: string; reason?: string }) {
    if (o.type) await this.oneOffType(o.type).check({ force: true });
    if (o.label !== undefined) await this.oneOffField('Label').fill(o.label);
    if (o.amount !== undefined) await this.oneOffField('Amount (PKR)').fill(o.amount);
    if (o.reason !== undefined) await this.oneOffField('Reason').fill(o.reason);
  }

  panelButtons(): Locator {
    return this.panel.getByRole('button');
  }

  /** Sandwich-leave calendar: the day button for a day of the displayed month. */
  calendarDay(day: number): Locator {
    // Days of the neighbouring months are disabled gridcells with the same names; only this month's are enabled.
    return this.panel.getByRole('grid').getByRole('gridcell', { name: String(day), exact: true, disabled: false });
  }

  // ── Preview ──────────────────────────────────────────────────────────────────────────────────
  /** A Stat tile: the term and its two definitions (value, sub-line). */
  async tile(label: string): Promise<{ value: string; sub: string }> {
    const term = this.main.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) });
    await expect(term).toBeVisible();
    const defs = term.locator('xpath=following-sibling::*'); // the Stat's <dd> siblings have no names of their own
    const texts = (await defs.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    return { value: texts[0] ?? '', sub: texts[1] ?? '' };
  }

  async tileLabels(): Promise<string[]> {
    return (await this.main.getByRole('term').allInnerTexts()).map((t) => t.trim());
  }

  note(): Locator {
    return this.main.getByRole('note');
  }

  /** A staff name rendered as a link/button inside the eligibility note. */
  noteName(name: string): Locator {
    return this.note().getByRole('button', { name, exact: true }).or(this.note().getByRole('link', { name, exact: true })).first();
  }

  /** The first tile's label, used to compare vertical positions with alerts above the totals. */
  firstTile(): Locator {
    return this.main.getByRole('term').first();
  }

  /** Ink colour of the value inside a table cell. */
  async cellInk(cell: Locator): Promise<string> {
    return cell.locator('span').first().evaluate((el) => getComputedStyle(el).color);
  }

  retryButton(): Locator {
    return this.main.getByRole('button', { name: /^(Retry|Try again)$/ }).first();
  }

  nameLink(name: string): Locator {
    return this.main.getByRole('button', { name, exact: true }).or(this.main.getByRole('link', { name, exact: true })).first();
  }

  async viewBreakdown(staffName: string) {
    await this.row(staffName).getByRole('button', { name: 'View' }).click();
    await expect(this.dialog).toBeVisible();
  }

  // ── Modals ───────────────────────────────────────────────────────────────────────────────────
  /** A modal by its title (several modals can be in the DOM while one closes and the next opens). */
  dialogTitled(title: string): Locator {
    return this.page.getByRole('dialog', { name: title });
  }

  dialogHeading(): Locator {
    return this.dialog.getByRole('heading');
  }

  dialogButton(name: string): Locator {
    return this.dialog.getByRole('button', { name, exact: true });
  }

  /** The modal's own close icon (the second "Close" when the footer also has one). */
  dialogCloseIcon(): Locator {
    return this.dialog.getByRole('button', { name: 'Close' }).last();
  }

  dialogText(text: string | RegExp): Locator {
    return this.dialog.getByText(text);
  }

  async dialogLines(): Promise<string[]> {
    // Payslip lines are label/amount pairs in flex rows inside the dialog body (no list semantics).
    const rows = this.dialog.locator('div.flex.justify-between');
    return (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  }

  /** Retry control inside an open modal ("Try again" from LoadErrorAlert, or "Retry"). */
  dialogRetry(): Locator {
    return this.dialog.getByRole('button', { name: /^(Retry|Try again)$/ });
  }

  /** Font sizes (px) of the payslip's net figure and of an ordinary line amount. */
  async netFontSize(): Promise<number> {
    const rows = this.dialog.locator('div.flex.justify-between');
    return rows.last().locator('span').last().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  }

  async lineFontSize(): Promise<number> {
    const rows = this.dialog.locator('div.flex.justify-between');
    return rows.first().locator('span').last().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  }

  async adjustmentStaffOptions(): Promise<string[]> {
    return (await this.adjustmentStaff().getByRole('option').allInnerTexts()).map((t) => t.trim()).filter((t) => t && !/^Select/.test(t));
  }

  adjustmentStaff(): Locator {
    return this.dialog.getByRole('combobox', { name: 'Staff member' });
  }

  adjustmentDirection(name: 'Pay more' | 'Recover'): Locator {
    return this.dialog.getByRole('radio', { name });
  }

  adjustmentField(name: 'Amount (PKR)' | 'Reason'): Locator {
    return this.dialog.getByRole('textbox', { name, exact: true });
  }

  async fillAdjustment(a: { staff?: string; direction?: 'Pay more' | 'Recover'; amount?: string; reason?: string }) {
    if (a.staff) await this.adjustmentStaff().selectOption({ label: a.staff });
    if (a.direction) await this.adjustmentDirection(a.direction).check({ force: true });
    if (a.amount !== undefined) await this.adjustmentField('Amount (PKR)').fill(a.amount);
    if (a.reason !== undefined) await this.adjustmentField('Reason').fill(a.reason);
  }

  toast(text: string | RegExp): Locator {
    return this.toasts.getByText(text).first();
  }

  async box(locator: Locator) {
    const b = await locator.boundingBox();
    expect(b, 'element has a layout box').not.toBeNull();
    return b!;
  }

  async color(locator: Locator): Promise<string> {
    return locator.evaluate((el) => getComputedStyle(el).color);
  }

  /** How many buttons in main share this button's background fill (1 = it is the only solid one of its colour). */
  async buttonsFilledLike(reference: Locator): Promise<number> {
    const fill = await reference.evaluate((el) => getComputedStyle(el).backgroundColor);
    let n = 0;
    for (const b of await this.main.getByRole('button').all()) if ((await b.evaluate((el) => getComputedStyle(el).backgroundColor)) === fill) n++;
    return n;
  }

  /** WCAG contrast ratio of an element's text against the first opaque background behind it. */
  async contrastRatio(locator: Locator): Promise<number> {
    return locator.evaluate((el) => {
      const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const fg = parse(getComputedStyle(el).color);
      let node: Element | null = el;
      let bg = [255, 255, 255, 1];
      while (node) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c.length >= 3 && (c.length === 3 || c[3] > 0.5)) { bg = c; break; }
        node = node.parentElement;
      }
      const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return (l1 + 0.05) / (l2 + 0.05);
    });
  }

  /** How many CSS px the document is wider than the viewport (page-level sideways scroll). */
  async pageOverflowPx(): Promise<number> {
    return this.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  }

  /** True when the element's box lies inside the viewport horizontally at the table's initial scroll position. */
  async isWithinViewportWidth(locator: Locator): Promise<boolean> {
    const box = await locator.boundingBox();
    const vw = this.page.viewportSize()!.width;
    return !!box && box.x >= 0 && box.x + box.width <= vw + 1;
  }

  async resetHorizontalScroll() {
    await this.page.evaluate(() => window.scrollTo(0, window.scrollY));
  }

  async dialogFitsViewport(): Promise<boolean> {
    const box = await this.dialog.boundingBox();
    const vw = this.page.viewportSize()!.width;
    return !!box && box.x >= 0 && box.x + box.width <= vw + 1;
  }

  async tagName(locator: Locator): Promise<string> {
    return locator.evaluate((el) => el.tagName.toLowerCase());
  }
}
