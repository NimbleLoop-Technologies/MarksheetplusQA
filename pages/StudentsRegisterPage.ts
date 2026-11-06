import { expect, type Locator, type Page } from '@playwright/test';
import { FamilyInviteCodeDrawer } from './FamilyInviteCodeDrawer';

export interface RegisterStudent {
  fullName: string;
  admissionId: string;
}

/** School WebApp: Admission Office → Admission Register (/registrar/students). */
export class StudentsRegisterPage {
  readonly heading: Locator;
  readonly search: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Admission Register', level: 1 });
    this.search = page.getByRole('textbox', { name: 'Search by name, admission ID or mobile' });
  }

  async goto() {
    await this.page.goto('/registrar/students');
    await this.expectLoaded();
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  /** Filters the register down to the one student. */
  async find(student: RegisterStudent) {
    await this.search.fill(student.admissionId);
    await expect(this.rowFor(student)).toBeVisible();
    await expect(this.page.getByText('Showing 1 to 1 of 1 results')).toBeVisible();
  }

  rowFor(student: RegisterStudent): Locator {
    return this.page.getByRole('row').filter({ hasText: `Admission ${student.admissionId}` });
  }

  private actionsButton(student: RegisterStudent): Locator {
    return this.rowFor(student).getByRole('button', { name: `Actions for ${student.fullName}` });
  }

  private actionsMenu(student: RegisterStudent): Locator {
    return this.page.getByRole('menu', { name: `Actions for ${student.fullName}` });
  }

  /**
   * Opens the row's action menu. The register re-renders once the debounced search settles, which
   * can swallow the first click or detach an open menu, so the open is retried until it sticks.
   */
  private async openActions(student: RegisterStudent) {
    await expect(async () => {
      if (!(await this.actionsMenu(student).isVisible())) await this.actionsButton(student).click();
      await expect(this.actionsMenu(student)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  }

  /** Names of the row actions currently offered for the student. */
  async rowActionNames(student: RegisterStudent): Promise<string[]> {
    await this.find(student);
    await this.openActions(student);
    const names = await this.actionsMenu(student).getByRole('menuitem').allInnerTexts();
    await this.page.keyboard.press('Escape');
    return names.map((n) => n.trim());
  }

  async openFamilyInviteDrawer(student: RegisterStudent): Promise<FamilyInviteCodeDrawer> {
    await this.find(student);
    await expect(async () => {
      await this.openActions(student);
      await this.actionsMenu(student).getByRole('menuitem', { name: 'Family invite code' }).click({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const drawer = new FamilyInviteCodeDrawer(this.page);
    await drawer.expectLoaded(student.fullName);
    return drawer;
  }
}
