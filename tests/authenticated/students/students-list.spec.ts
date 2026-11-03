import { test, expect } from '@playwright/test';
import { StudentsPage } from '../../../pages/students.page';
import { StudentProfilePage } from '../../../pages/student-profile.page';

test.describe('Admission Register', () => {
  test('the students list loads for a signed-in user', { tag: '@critical' }, async ({ page }) => {
    const studentsPage = new StudentsPage(page);
    await studentsPage.goto();
    await studentsPage.expectLoaded();
  });

  // Assumes the seeded campus has students. If it has none, seed one — do not weaken this to >= 0.
  test('the students list renders at least one student', async ({ page }) => {
    const studentsPage = new StudentsPage(page);
    await studentsPage.goto();
    await studentsPage.expectLoaded();
    await studentsPage.waitForRows();
    expect(await studentsPage.studentCount()).toBeGreaterThan(0);
  });

  test("opening a student shows that student's profile", async ({ page }) => {
    const studentsPage = new StudentsPage(page);
    await studentsPage.goto();
    await studentsPage.waitForRows();
    const studentId = await studentsPage.openFirstStudent();
    expect(studentId).not.toBe('');
    await new StudentProfilePage(page).expectLoadedFor(studentId);
  });
});
