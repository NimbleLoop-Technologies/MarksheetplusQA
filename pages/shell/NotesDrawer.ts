import { expect, type Locator, type Page } from '@playwright/test';

/**
 * PR 543 shell Notes drawer (`ShellNotes`): a right-hand drawer on desktop, a bottom sheet on phones.
 * Opened from the header action "Notes" (desktop) or the "More options" kebab row "Notes" (phone).
 * Recorded in docs/qa/ui-reference.md → "Notes drawer".
 */
export class NotesDrawer {
  readonly dialog: Locator;
  readonly heading: Locator;
  readonly closePanelButton: Locator;
  readonly newNoteButton: Locator;
  readonly noteList: Locator;
  readonly editor: Locator;
  readonly editorTitle: Locator;
  readonly deleteButton: Locator;
  readonly closeNoteButton: Locator;
  readonly emptyStateHeading: Locator;
  readonly saveErrorAlert: Locator;
  readonly retrySaveButton: Locator;
  readonly loadErrorAlert: Locator;
  readonly loadRetryButton: Locator;
  /** The drawer's own sr-only live region ("Saving..." / "Saved" / "Not saved"). */
  readonly status: Locator;

  constructor(private readonly page: Page) {
    this.dialog = page.getByRole('dialog', { name: 'Notes' });
    this.heading = this.dialog.getByRole('heading', { name: 'Notes', level: 2 });
    this.closePanelButton = this.dialog.getByRole('button', { name: 'Close panel' });
    this.newNoteButton = this.dialog.getByRole('button', { name: 'New note' });
    this.noteList = this.dialog.getByRole('group', { name: 'Choose a note' });
    this.editor = this.dialog.getByRole('textbox', { name: 'Note' });
    // The editor's heading is a plain <p> with the note title; no role/label exists, so use the editor hook.
    this.editorTitle = this.dialog.locator('[data-notes-editor] p').first();
    this.deleteButton = this.dialog.getByRole('button', { name: 'Delete note' });
    this.closeNoteButton = this.dialog.getByRole('button', { name: 'Close note' });
    this.emptyStateHeading = this.dialog.getByRole('heading', { name: 'No notes yet' });
    this.saveErrorAlert = this.dialog.getByRole('alert').filter({ hasText: "Your latest changes weren't saved" });
    this.retrySaveButton = this.dialog.getByRole('button', { name: 'Retry save' });
    this.loadErrorAlert = this.dialog.getByRole('alert').filter({ hasText: "We couldn't load your notes" });
    this.loadRetryButton = this.loadErrorAlert.getByRole('button', { name: 'Try again' });
    // Every TailwindUi Button also carries a nested sr-only status; the drawer's own live region is the first in DOM order.
    this.status = this.dialog.getByRole('status').first();
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible();
    await expect(this.newNoteButton.or(this.loadErrorAlert)).toBeVisible({ timeout: 30_000 });
  }

  /** Buttons in the "Choose a note" list (one per note). */
  notes(): Locator {
    return this.noteList.getByRole('button');
  }

  note(title: string): Locator {
    return this.noteList.getByRole('button', { name: title, exact: true });
  }

  async noteTitles(): Promise<string[]> {
    if (!(await this.noteList.isVisible())) return [];
    return (await this.notes().allInnerTexts()).map((t) => t.trim());
  }

  /** Creates a note and (optionally) writes `text` into it as a single input (paste-like). */
  async newNote(text?: string) {
    const before = await this.notes().count();
    await this.newNoteButton.click();
    await expect(this.notes()).toHaveCount(before + 1);
    await expect(this.editor).toBeVisible();
    if (text !== undefined) await this.write(text);
  }

  /** Replaces the selected note's text in one input event and waits for the "Saved" status. */
  async write(text: string) {
    await this.editor.fill(text);
    await expect(this.status).toHaveText(/Saved|Not saved/, { timeout: 60_000 });
  }

  /**
   * Types key by key at the end of the selected note. Uses page.keyboard (no per-action timeout) so a slow
   * editor shows up as a slow save, not as an actionability timeout.
   */
  async type(text: string, delay = 0) {
    await this.editor.click();
    await this.editor.press('Control+End');
    await this.page.keyboard.type(text, { delay });
  }

  async selectNote(title: string) {
    await this.note(title).click();
    await expect(this.editor).toBeVisible();
  }

  async closeEditor() {
    await this.closeNoteButton.click();
  }

  async deleteSelectedNote() {
    await this.deleteButton.click();
  }

  async close() {
    await this.closePanelButton.click();
    await expect(this.dialog).toBeHidden();
  }

  /**
   * Starts recording every text the drawer's live region takes (a MutationObserver in the page).
   * Read with statusAnnouncements().
   */
  async recordStatusAnnouncements() {
    await this.status.evaluate((el) => {
      const w = window as unknown as { __qaNotesStatus: string[] };
      w.__qaNotesStatus = [];
      new MutationObserver(() => w.__qaNotesStatus.push(el.textContent ?? '')).observe(el, {
        childList: true, characterData: true, subtree: true,
      });
    });
  }

  async statusAnnouncements(): Promise<string[]> {
    return this.page.evaluate(() => (window as unknown as { __qaNotesStatus?: string[] }).__qaNotesStatus ?? []);
  }

  /** Any visible way out of the load-error state other than "Try again" (e.g. discard / start fresh / New note). */
  loadRecoveryActions(): Locator {
    return this.dialog.getByRole('button', { name: /start (fresh|over)|discard|reset|clear|new note/i });
  }

  /** A confirmation dialog raised by Delete note (IConfirmService → ConfirmHost renders an alertdialog). */
  deleteConfirmation(): Locator {
    return this.page.getByRole('alertdialog').or(this.page.getByRole('dialog').filter({ hasText: /delete/i }).filter({ hasNot: this.heading }));
  }

  /** Undo affordance shown after a delete (toast), the reviewer's alternative to a confirm. */
  undoDelete(): Locator {
    return this.page.getByRole('button', { name: /undo/i });
  }

  /** Text of the empty state's description, if rendered. */
  emptyStateDescription(): Locator {
    return this.dialog.getByText('Jot down reminders and to-dos. Only you can see them.');
  }
}
