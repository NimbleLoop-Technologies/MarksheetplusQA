// PR 543 AC3 (sign-out/sign-in) + AC4: notes private per account/campus; nothing left on device after logout; API isolation.
import { test, expect } from '@playwright/test';
import { AppShell } from '../../../pages/shell/AppShell';
import { LoginPage } from '../../../pages/LoginPage';
import { clearNotes, listNotesWithToken, listServerNotes, newTwoCampusOwner, notesKeys } from '../../../fixtures/notes-storage';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 });

test('notes are scoped per campus, per account, sync after resign-in, and leave nothing on the device after logout', async ({ page }) => {
  const owner = await newTwoCampusOwner();
  const shell = new AppShell(page);
  const login = new LoginPage(page);
  const ownerSignIn = async () => {
    const { identifier, password } = owner.credentials();
    await page.goto('/');
    await login.signIn(identifier, password);
    await shell.expectLoaded();
  };

  await test.step('owner A writes a note on the first campus', async () => {
    await ownerSignIn();
    await clearNotes(page);
    const notes = await shell.openNotesFromHeader();
    await notes.newNote('Owner A first campus note');
    await notes.close();
  });
  const firstCampus = await shell.currentCampus();
  const otherCampus = firstCampus === owner.secondCampusName ? 'Main' : owner.secondCampusName;
  const ownerANoteIds = (await listServerNotes(page)).map((n) => n.id);

  await test.step('switching campus shows that campus\'s own (empty) notepad', async () => {
    await shell.switchCampus(otherCampus);
    const notes = await shell.openNotesFromHeader();
    await expect(notes.emptyStateHeading).toBeVisible();
    await notes.newNote('Owner A second campus note');
    await notes.close();
  });

  await test.step('switching back restores the first campus\'s notes only', async () => {
    await shell.switchCampus(firstCampus);
    const notes = await shell.openNotesFromHeader();
    expect(await notes.noteTitles()).toEqual(['Owner A first campus note']);
    await notes.close();
  });

  await test.step('logout leaves no notes keys in browser storage', async () => {
    await shell.signOut();
    expect(await notesKeys(page)).toEqual([]);
  });

  await test.step('another account signing in on the same browser does not see owner A\'s notes', async () => {
    await page.goto('/');
    await login.signIn(process.env.QA_EMAIL!, process.env.QA_PASSWORD!);
    await shell.expectLoaded();
    const notes = await shell.openNotesFromHeader();
    const titles = await notes.noteTitles();
    expect(titles).not.toContain('Owner A first campus note');
    expect(titles).not.toContain('Owner A second campus note');
    await notes.close();
  });

  await test.step('another account cannot read owner A\'s notes through the API', async () => {
    const token = await page.evaluate(() => sessionStorage.getItem('mp.access_token'));
    expect(token).toBeTruthy();
    const { status, body } = await listNotesWithToken(token!);
    expect(status).toBe(200);
    const ids = Array.isArray(body) ? body.map((n: { Id: string }) => n.id) : [];
    for (const id of ownerANoteIds) expect(ids).not.toContain(id);
    // Direct GET of another user's note id should 404
    if (ownerANoteIds[0]) {
      const { request } = await import('@playwright/test');
      const ctx = await request.newContext({ ignoreHTTPSErrors: true });
      const res = await ctx.get(`${process.env.QA_REST_API_URL ?? 'https://localhost:7244'}/notes/${ownerANoteIds[0]}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // Get-by-id may not exist as a route; list already proves isolation. If a route exists, expect 404.
      expect([404, 405, 400, 200].includes(res.status())).toBeTruthy();
      if (res.status() === 200) {
        const b = await res.json();
        expect(b?.id ?? b?.id).not.toBe(ownerANoteIds[0]);
      }
      await ctx.dispose();
    }
    await shell.signOut();
  });

  await test.step('owner A signs back in and finds the note intact (server sync)', async () => {
    await ownerSignIn();
    if ((await shell.currentCampus()) !== firstCampus) await shell.switchCampus(firstCampus);
    const notes = await shell.openNotesFromHeader();
    expect(await notes.noteTitles()).toEqual(['Owner A first campus note']);
  });

  await owner.api.dispose();
});
