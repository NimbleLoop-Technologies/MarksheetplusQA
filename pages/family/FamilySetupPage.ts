import { expect, type Locator, type Page } from '@playwright/test';

export interface FatherDetails {
  fatherName: string;
  /** 35202-1234567-1 */
  cnic: string;
  whatsApp: string;
  homeAddress: string;
  city: string;
  province: 'Punjab' | 'Sindh' | 'KPK' | 'Balochistan' | 'Gilgit-Baltistan' | 'Azad Kashmir';
  familyName: string;
}

/**
 * Family app: /family/setup ("Setup your family"), a three-step wizard (Father → Mother → Guardian).
 * A parent who registered from an invite link is sent here with ?returnUrl=/join?code=… when they
 * press Connect before having a family profile.
 */
export class FamilySetupPage {
  readonly heading: Locator;
  readonly fatherForm: Locator;
  readonly motherForm: Locator;
  readonly guardianForm: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Setup your family', level: 1 });
    this.fatherForm = page.getByRole('form', { name: 'Father information' });
    this.motherForm = page.getByRole('form', { name: 'Mother information' });
    this.guardianForm = page.getByRole('form', { name: 'Guardian information' });
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  /** Fills the father step, skips mother and guardian; the last skip submits the setup. */
  async completeWithFatherOnly(father: FatherDetails) {
    await this.expectLoaded();
    const f = this.fatherForm;
    await f.getByRole('textbox', { name: 'Father Name' }).fill(father.fatherName);
    await f.getByRole('textbox', { name: 'CNIC' }).fill(father.cnic);
    await f.getByRole('textbox', { name: 'WhatsApp #' }).fill(father.whatsApp);
    await f.getByRole('textbox', { name: 'Home Address' }).fill(father.homeAddress);
    await f.getByRole('textbox', { name: 'City' }).fill(father.city);
    await f.getByRole('combobox', { name: 'Province' }).selectOption(father.province);
    await f.getByRole('textbox', { name: 'Family Name' }).fill(father.familyName);
    await f.getByRole('button', { name: 'Next' }).click();

    await expect(this.motherForm).toBeVisible();
    await this.motherForm.getByRole('button', { name: 'Skip for Now' }).click();

    await expect(this.guardianForm).toBeVisible();
    await this.guardianForm.getByRole('button', { name: 'Skip for Now' }).click();
  }
}
