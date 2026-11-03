import { expect, type Locator, type Page } from '@playwright/test';

/** Family app: /join and /join?code=… (where the WhatsApp invite button lands). */
export class JoinWithCodePage {
  readonly heading: Locator;
  readonly main: Locator;
  readonly form: Locator;
  readonly codeInput: Locator;
  readonly continueButton: Locator;
  readonly seeInvitationsButton: Locator;
  /** Invite card: the school name is the card's level-2 heading. */
  readonly schoolName: Locator;
  readonly newChildNotice: Locator;
  readonly connectButton: Locator;
  readonly notMyChildButton: Locator;
  readonly useDifferentCodeButton: Locator;
  readonly rejectConfirmation: Locator;
  readonly confirmRejectButton: Locator;
  readonly cancelRejectButton: Locator;
  /** Error shown on the invite card after a refused Connect / Not my child (a bare danger Alert). */
  readonly cardError: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Join with an invite code', level: 1 });
    this.main = page.getByRole('main');
    this.form = page.getByRole('form', { name: 'Invite code' });
    this.codeInput = page.getByRole('textbox', { name: 'Invite code' });
    this.continueButton = page.getByRole('button', { name: 'Continue' });
    this.seeInvitationsButton = page.getByRole('button', { name: 'See invitations sent to my number' });
    this.schoolName = this.main.getByRole('heading', { level: 2 });
    this.newChildNotice = this.main.getByRole('status').filter({ has: page.getByRole('heading', { name: 'Add as a new child' }) });
    this.connectButton = page.getByRole('button', { name: 'Connect', exact: true });
    this.notMyChildButton = page.getByRole('button', { name: 'Not my child' });
    this.useDifferentCodeButton = page.getByRole('button', { name: 'Use a different code' });
    this.rejectConfirmation = this.main.getByRole('heading', { name: 'Tell the school this is not your child?' });
    this.confirmRejectButton = page.getByRole('button', { name: "Yes, it's not my child" });
    this.cancelRejectButton = page.getByRole('button', { name: 'Cancel', exact: true });
    this.cardError = this.main.getByRole('alert');
  }

  async goto(code?: string) {
    await this.page.goto(code === undefined ? '/join' : `/join?code=${encodeURIComponent(code)}`);
    await this.expectLoaded();
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  /**
   * Types the code exactly as given (no normalisation) and presses Continue, then waits for the
   * redeem call to answer. Without the wait, a second submit can land while the first is in flight
   * (the page drops it) and an earlier identical error message makes the assertion pass too early.
   * A blank code never reaches the server, so there is nothing to wait for.
   */
  async submitCode(code: string) {
    await this.codeInput.fill(code);
    if (code.trim() === '') {
      await this.continueButton.click();
      return;
    }
    const answered = this.page.waitForResponse((r) => r.url().includes('/family/link-invites/redeem') && r.request().method() === 'POST');
    await this.continueButton.click();
    await answered;
  }

  /** Value next to a label on the invite card: "Child", "Class", "Admission number", "Code expires". */
  cardValue(label: 'Child' | 'Class' | 'Admission number' | 'Code expires'): Locator {
    // DescriptionItem renders <dt>/<dd> siblings with no ids; the definition is the term's next sibling.
    return this.main.getByRole('term').filter({ hasText: label }).locator('xpath=following-sibling::*[1]');
  }

  /** Any message on the page with this text (card-mode warnings render as a bare Alert). */
  message(text: string | RegExp): Locator {
    return this.main.getByText(text);
  }

  /**
   * "Is <First> already in your family?" — a radio group (cards layout) listing the parent's own
   * children, shown only when the family has at least one child the invite could be.
   */
  attachChoice(): Locator {
    return this.main.getByRole('group', { name: /^Is .+ already in your family\?$/ });
  }

  /**
   * The option to link the invite to the parent's existing child `childName`. The label is
   * "Yes, this is <name>" with " (suggested)" for a lookalike. Names are matched case-insensitively:
   * the family plane stores names lower-cased and the label shows them as stored.
   */
  existingChildOption(childName: string): Locator {
    const escaped = childName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.main.getByRole('radio', { name: new RegExp(`^Yes, this is ${escaped}( \\(suggested\\))?$`, 'i') });
  }

  /** Every "Yes, this is …" option, i.e. the children offered for linking. */
  existingChildOptions(): Locator {
    return this.main.getByRole('radio', { name: /^Yes, this is / });
  }

  /** The option marked "(suggested)", if any. */
  suggestedChildOption(): Locator {
    return this.main.getByRole('radio', { name: /\(suggested\)$/ });
  }

  /** "No, add <First> as a new child" (always offered when the radio group is shown). */
  newChildOption(): Locator {
    return this.main.getByRole('radio', { name: /^No, add .+ as a new child$/ });
  }

  async chooseExistingChild(childName: string) {
    await this.existingChildOption(childName).check();
  }

  async chooseNewChild() {
    await this.newChildOption().check();
  }

  async connect() {
    await this.connectButton.click();
  }

  async startReject() {
    await this.notMyChildButton.click();
    await expect(this.rejectConfirmation).toBeVisible();
  }

  async useDifferentCode() {
    await this.useDifferentCodeButton.click();
  }
}
