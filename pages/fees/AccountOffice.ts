import { expect, type Locator, type Page } from '@playwright/test';
import { LoginPage } from '../LoginPage';

/**
 * Account Office (fee management) screens touched by PR 547 "challans under family or student name".
 * Routes: MarksheetPlus.Shared/Constants/AppRoutes.cs (Accounts). Where a data-* hook is used it is the
 * app's own test hook (the markup has no better accessible handle), noted per locator.
 */

export const ROUTES = {
  feePolicies: '/accounts/fee-policies',
  newSchoolPolicy: '/accounts/fee-policies/new',
  newClassPolicy: '/accounts/fee-policies/new?type=class',
  editPolicy: (id: string) => `/accounts/fee-policies/new?policyId=${encodeURIComponent(id)}`,
  duplicateClassPolicy: (id: string) => `/accounts/fee-policies/new?duplicateFromPolicyId=${encodeURIComponent(id)}&type=class`,
  feePayment: '/accounts/fee-payment',
  family: (familyId: string, challanId?: string) =>
    `/accounts/fee-payment/families/${familyId}${challanId ? `?challanId=${encodeURIComponent(challanId)}` : ''}`,
  familyReceive: (familyId: string, challanId?: string) =>
    `/accounts/fee-payment/families/${familyId}/receive${challanId ? `?challanId=${encodeURIComponent(challanId)}` : ''}`,
  ledger: (familyId: string) => `/accounts/fee-payment/families/${familyId}/ledger`,
  receipt: (paymentId: string) => `/accounts/fee-payment/receipts/${paymentId}`,
  defaulters: '/accounts/dashboard/defaulters',
};

/** Signs a throwaway owner into the WebApp (AuthApp OIDC round trip) and waits for the app shell. */
export async function signInToWebApp(page: Page, credentials: { identifier: string; password: string }): Promise<void> {
  await page.goto('/');
  await new LoginPage(page).signIn(credentials.identifier, credentials.password);
  // Desktop shows the user menu; phones fold header actions into "More options".
  await expect(page.getByRole('button', { name: 'Open user menu' }).or(page.getByRole('button', { name: 'More options' })).first()).toBeVisible({ timeout: 60_000 });
}

/** /accounts/fee-policies/new[?type=class|?policyId=|?duplicateFromPolicyId=] */
export class FeePolicyEditor {
  readonly heading: Locator;
  readonly challanNameSection: Locator;
  readonly perStudentToggle: Locator;
  readonly perStudentDescription: Locator;
  readonly saveChanges: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('main').getByRole('heading', { level: 1 });
    this.challanNameSection = page.getByRole('heading', { name: 'Challan name' });
    // The shared Toggle renders as a checkbox named by its AriaLabel (the ActionPanel title).
    this.perStudentToggle = page.getByRole('checkbox', { name: 'Generate challans under student name' });
    this.perStudentDescription = page.getByText('Off: one combined challan under the family name.', { exact: false });
    this.saveChanges = page.getByRole('button', { name: 'Save changes' });
  }

  async open(url: string) {
    await this.page.goto(url);
    // The form (not its loading skeleton) is up once its first section shows (root: fee cycle; class: policy name).
    await expect(this.page.getByRole('heading', { level: 2 }).first()).toBeVisible({ timeout: 30_000 });
  }

  async isPerStudentOn(): Promise<boolean> {
    return this.perStudentToggle.isChecked();
  }

  async setPerStudent(on: boolean) {
    if ((await this.isPerStudentOn()) !== on) await this.perStudentToggle.click();
    await expect(this.perStudentToggle).toBeChecked({ checked: on });
  }

  async save() {
    await this.saveChanges.click();
  }

  /** The school policy set-up's required fields (effective date keeps its default). */
  async fillSchoolPolicy(v: { tuition: number; generationDay: number; dueDay: number }) {
    const suffix = v.generationDay === 1 ? 'st' : 'th';
    await this.page.getByRole('combobox', { name: 'Challan generation day' }).selectOption({ label: `${v.generationDay}${suffix} day` });
    await this.page.getByRole('spinbutton', { name: 'Due day' }).fill(String(v.dueDay));
    await this.page.getByRole('spinbutton', { name: 'Base tuition' }).fill(String(v.tuition));
  }

  async publish() {
    await this.page.getByRole('button', { name: 'Publish policy' }).click();
    await this.confirmIfAsked();
  }

  /** A confirm step some saves raise ("Confirm and save"), clicked when present. */
  async confirmIfAsked() {
    const confirm = this.page.getByRole('button', { name: 'Confirm and save' });
    if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.click();
  }
}

/** /accounts/fee-payment */
export class FeePaymentPage {
  readonly table: Locator;

  constructor(private readonly page: Page) {
    this.table = page.getByRole('table').first();
  }

  async open() {
    await this.page.goto(ROUTES.feePayment);
    await expect(this.page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(this.page.getByRole('button', { name: /^Receive from / }).first()).toBeVisible({ timeout: 30_000 });
  }

  /** A summary tile ("Families with dues", "Outstanding", "Overdue"): its label's parent holds the value (no accessible name). */
  tile(label: string): Locator {
    return this.page.getByRole('main').getByText(label, { exact: true }).locator('xpath=..');
  }

  columnHeader(name: string): Locator {
    return this.page.getByRole('columnheader', { name, exact: true });
  }

  /** The row's Receive button, labelled "Receive from {row name}" (student name for a student row). */
  receiveButton(rowName: RegExp | string): Locator {
    return this.page.getByRole('button', { name: typeof rowName === 'string' ? `Receive from ${rowName}` : rowName });
  }

  rowFor(text: RegExp | string): Locator {
    return this.page.getByRole('row').filter({ hasText: text });
  }

  async rowNames(): Promise<string[]> {
    const labels = await this.page.getByRole('button', { name: /^Receive from / }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    return labels.map((l) => l.replace(/^Receive from /, ''));
  }
}

/** /accounts/fee-payment/families/{id}[/receive][?challanId=] */
export class FamilyAccountPage {
  readonly heading: Locator;
  // data-student-challans: the new "Billed per student" card (CardHeading has no landmark role).
  readonly studentChallansCard: Locator;
  // data-tile="outstanding" / "challans": the StatList tiles (no accessible name of their own).
  readonly outstandingTile: Locator;
  readonly challansTile: Locator;
  // data-receive-bar / data-receive-total: the pinned Receive bar.
  readonly receiveBar: Locator;
  readonly receiveTotal: Locator;
  readonly receivePayment: Locator;
  readonly noDues: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('main').getByRole('heading', { level: 1 });
    this.studentChallansCard = page.locator('[data-student-challans]');
    this.outstandingTile = page.locator('[data-tile="outstanding"]');
    this.challansTile = page.locator('[data-tile="challans"]');
    this.receiveBar = page.locator('[data-receive-bar]');
    this.receiveTotal = page.locator('[data-receive-total]');
    this.receivePayment = page.getByRole('button', { name: 'Receive payment' });
    this.noDues = page.locator('[data-family-no-dues]');
  }

  async open(url: string) {
    await this.page.goto(url);
    await this.waitLoaded();
  }

  async waitLoaded() {
    await expect(this.outstandingTile).toBeVisible({ timeout: 30_000 });
  }

  /** "Receive {student}" / "Open {student}" links in the Billed per student card. */
  studentChallanLink(student: string | RegExp): Locator {
    const name = typeof student === 'string' ? new RegExp(`^(Receive|Open) ${student}$`, 'i') : student;
    // RowActionButton with an Href: matched as link or button, whichever role it renders.
    return this.studentChallansCard.getByRole('link', { name }).or(this.studentChallansCard.getByRole('button', { name })).first();
  }

  async studentChallanRows(): Promise<{ name: string; amount: string }[]> {
    return this.studentChallansCard.getByRole('row').filter({ has: this.page.getByRole('link') }).evaluateAll((rows) =>
      rows.map((r) => {
        const cells = Array.from(r.querySelectorAll('td'));
        return { name: (cells[0]?.textContent ?? '').trim(), amount: (cells[1]?.textContent ?? '').trim() };
      }),
    );
  }
}

/** The Receive payment drawer (ReceivePaymentDrawer.razor, id receive-payment-drawer). */
export class ReceiveDrawer {
  readonly dialog: Locator;
  readonly amount: Locator;
  readonly confirm: Locator;

  constructor(private readonly page: Page) {
    this.dialog = page.getByRole('dialog', { name: 'Receive payment' });
    this.amount = this.dialog.getByLabel('Amount', { exact: false }).first();
    this.confirm = this.dialog.getByRole('button', { name: 'Confirm payment' });
  }

  async expectOpen() {
    await expect(this.dialog).toBeVisible({ timeout: 30_000 });
  }

  /** The drawer's description line (the family, or the student on a student challan). */
  description(): Locator {
    return this.dialog.getByRole('paragraph').first();
  }

  async cancel() {
    await this.dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(this.dialog).toBeHidden();
  }

  async pay(amount: number) {
    await this.amount.fill(String(amount));
    await this.confirm.click();
  }
}

/** /accounts/dashboard/defaulters */
export class DefaultersPage {
  constructor(private readonly page: Page) {}

  async open() {
    await this.page.goto(ROUTES.defaulters);
    await expect(this.page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
  }

  receiveLink(familyName: string): Locator {
    const name = new RegExp(`^Receive from ${familyName}$`, 'i');
    return this.page.getByRole('link', { name }).or(this.page.getByRole('button', { name })).first();
  }
}

/** /accounts/fee-payment/families/{id}/ledger and /accounts/fee-payment/receipts/{id}: their back link names the family. */
export class BackLinkedPage {
  constructor(private readonly page: Page) {}

  async open(url: string) {
    await this.page.goto(url);
    await expect(this.page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
  }

  backLink(name: string | RegExp): Locator {
    return this.page.getByRole('main').getByRole('link', { name }).first();
  }

  receivePayment(): Locator {
    const main = this.page.getByRole('main');
    return main.getByRole('link', { name: 'Receive payment' }).or(main.getByRole('button', { name: 'Receive payment' })).first();
  }

  /** The "Payment received" dialog shown on the Family page after a payment. */
  paymentReceivedDialog(): Locator {
    return this.page.getByRole('dialog').filter({ hasText: 'Payment received' });
  }
}
