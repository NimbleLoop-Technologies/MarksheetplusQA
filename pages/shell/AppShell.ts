import { expect, type Locator, type Page } from '@playwright/test';
import { NotesDrawer } from './NotesDrawer';

/**
 * School WebApp signed-in shell: header actions, phone kebab ("More options"), user menu, campus switcher,
 * module rail, and the Home dashboard blocks. Recorded in docs/qa/ui-reference.md → "App shell".
 */
export class AppShell {
  readonly banner: Locator;
  readonly headerNotesButton: Locator;
  readonly headerThemeToggle: Locator;
  readonly moreOptionsButton: Locator;
  readonly mobileNotesRow: Locator;
  readonly mobileThemeRow: Locator;
  readonly userMenuButton: Locator;
  readonly campusChip: Locator;
  readonly modules: Locator;
  readonly homeHeading: Locator;
  readonly calendarHeading: Locator;
  readonly signedOutHeading: Locator;
  readonly notes: NotesDrawer;

  constructor(private readonly page: Page) {
    this.banner = page.getByRole('banner');
    this.headerNotesButton = this.banner.getByRole('button', { name: 'Notes', exact: true });
    this.headerThemeToggle = this.banner.getByRole('button', { name: /^Switch to (dark|light) theme$/ });
    this.moreOptionsButton = this.banner.getByRole('button', { name: 'More options' });
    // The kebab popover rows are not inside the banner landmark; scope by the visible "Notes" button.
    this.mobileNotesRow = page.getByRole('button', { name: 'Notes', exact: true }).filter({ visible: true });
    this.mobileThemeRow = page.getByRole('button', { name: /^Theme Switch to (dark|light) theme$/ });
    this.userMenuButton = page.getByRole('button', { name: 'Open user menu' });
    this.campusChip = page.getByRole('button', { name: /^Current campus: / });
    this.modules = page.getByRole('navigation', { name: 'Modules' });
    this.homeHeading = page.getByRole('main').getByRole('heading', { name: 'Home', level: 1 });
    this.calendarHeading = page.getByRole('main').getByRole('heading', { name: 'Calendar' });
    this.signedOutHeading = page.getByRole('heading', { name: "You've been signed out" });
    this.notes = new NotesDrawer(page);
  }

  async gotoHome() {
    await this.page.goto('/');
    await this.expectLoaded();
  }

  async expectLoaded() {
    await expect(this.banner).toBeVisible({ timeout: 60_000 });
    await expect(this.homeHeading.or(this.page.getByRole('main').getByRole('heading', { level: 1 }))).toBeVisible({ timeout: 60_000 });
  }

  /** Desktop: header "Notes" action. Retries the click: the shell can re-render right after first paint. */
  async openNotesFromHeader(): Promise<NotesDrawer> {
    await expect(async () => {
      if (!(await this.notes.dialog.isVisible())) await this.headerNotesButton.click();
      await expect(this.notes.dialog).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await this.notes.expectLoaded();
    return this.notes;
  }

  /** Phone: "More options" kebab → "Notes" row. */
  async openNotesFromMobileMenu(): Promise<NotesDrawer> {
    await expect(async () => {
      if (!(await this.mobileNotesRow.first().isVisible())) await this.moreOptionsButton.click();
      await this.mobileNotesRow.first().click({ timeout: 3_000 });
      await expect(this.notes.dialog).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await this.notes.expectLoaded();
    return this.notes;
  }

  async openMobileMenu() {
    await this.moreOptionsButton.click();
    await expect(this.mobileThemeRow).toBeVisible();
  }

  /** Clicks a module in the rail (SPA navigation, no reload) and waits for the URL to change. */
  async goToModule(name: string, urlPart: RegExp) {
    await this.modules.getByRole('link', { name, exact: true }).click();
    await this.page.waitForURL(urlPart);
    await expect(this.page.getByRole('main')).toBeVisible();
  }

  async switchCampus(campusName: string) {
    await this.campusChip.click();
    await this.page.getByRole('menuitem', { name: campusName, exact: true }).click();
    await expect(this.page.getByRole('button', { name: `Current campus: ${campusName}` })).toBeVisible({ timeout: 60_000 });
  }

  async currentCampus(): Promise<string> {
    // The chip's text is "<initials>\n<campus name>" (the "Current campus:" prefix is sr-only); the name is the last line.
    const lines = (await this.campusChip.innerText()).split('\n').map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1].replace(/^Current campus:\s*/, '');
  }

  async signOut() {
    await this.userMenuButton.click();
    await this.page.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(this.signedOutHeading).toBeVisible({ timeout: 60_000 });
  }

  /** Home dashboard tiles (definition-list terms) and the calendar. */
  homeTile(term: string): Locator {
    return this.page.getByRole('main').getByRole('term').filter({ hasText: term });
  }
}
