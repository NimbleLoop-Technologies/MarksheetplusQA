# Marksheet+ QA Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn this repo into a Playwright/TypeScript regression suite for `qa-integration.marksheetplus.com` plus a Claude Code QA workspace (agents + skills) that pulls work from the ClickUp `qa` status and reports results back.

**Architecture:** One repo, two halves. `tests/` + `pages/` + `fixtures/` is a standard Playwright Test project using the Page Object Model, authenticating once via `storageState`. `.claude/` holds agents, skills, and commands that drive that suite, plus live exploratory testing through Playwright MCP, and close the loop into ClickUp.

**Tech Stack:** TypeScript, Playwright Test, Node.js, dotenv, Playwright MCP, ClickUp MCP connector.

---

## Prerequisites (human, blocking)

These are not code tasks. They block specific tasks below and must be resolved by the user.

- [ ] **QA test account credentials.** Task 5 onward cannot run without a working seeded account on `qa-integration.marksheetplus.com`. The user must supply `QA_EMAIL` and `QA_PASSWORD` for `.env`. **Never commit these.**
- [ ] **ClickUp connector enabled.** Verified 2026-07-16: no `clickup_*` tools are exposed in the current session. The skills in Tasks 9–11 are written against `clickup_get_task`, `clickup_filter_tasks`, and `clickup_create_task_comment`. They will be authored regardless, but cannot be exercised until the ClickUp connector is enabled and authorized in an interactive session (`/mcp` or the plugin marketplace). Tasks 1–8 and 12 are unaffected.

---

## File Structure

| Path | Responsibility |
|---|---|
| `package.json` | Scripts + dev dependencies. |
| `tsconfig.json` | TypeScript strictness and includes. |
| `playwright.config.ts` | Base URL, reporters, retries, evidence capture, project wiring (setup → authenticated / anonymous). |
| `.env.example` | Documents required env vars. Real `.env` is gitignored. |
| `.mcp.json` | Pins Playwright MCP. |
| `fixtures/auth.setup.ts` | Logs in once with seeded creds, saves `storageState`. |
| `fixtures/test-data.ts` | Unique data generators (emails, names). No page knowledge. |
| `fixtures/register.ts` | `registerNewAccount()` — drives register form for a fresh account. |
| `pages/login.page.ts` | Login screen. Selectors + intent methods. |
| `pages/register.page.ts` | Registration screen. |
| `pages/students.page.ts` | Students list screen. |
| `pages/student-profile.page.ts` | Single student profile screen. |
| `tests/auth/*.spec.ts` | Auth behaviour. Runs anonymous (no stored state). |
| `tests/students/*.spec.ts` | Students behaviour. Runs authenticated. |
| `docs/qa/ui-reference.md` | Recon output: real routes + selectors observed on the live app. |
| `.claude/skills/*/SKILL.md` | Four QA procedures. |
| `.claude/agents/*.md` | Three QA agents. |
| `.claude/commands/*.md` | Two slash commands. |
| `.claude/settings.json` | Plugin enablement + permission allowlist. |
| `README.md` | How to run everything. |

**Boundary rule enforced throughout:** specs never contain selectors; page objects never contain assertions about business outcomes beyond their own screen; fixtures never import page objects except `auth.setup.ts` and `register.ts`, which legitimately drive UI.

---

### Task 1: Scaffold the Node/TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Modify: `.gitignore` (append QA section)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "marksheetplus-qa",
  "version": "1.0.0",
  "private": true,
  "description": "Automated QA workspace and regression suite for Marksheet+",
  "scripts": {
    "test": "playwright test",
    "test:auth": "playwright test --project=anonymous",
    "test:regression": "playwright test --project=authenticated",
    "test:headed": "playwright test --headed",
    "test:ui": "playwright test --ui",
    "report": "playwright show-report",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@types/node": "^22.10.0",
    "dotenv": "^16.4.7",
    "typescript": "^5.7.2"
  }
}
```

Note: no `"type": "module"`. Playwright's TS loader and `__dirname` usage in the config assume CommonJS. Adding `type: module` breaks both.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["tests/**/*.ts", "pages/**/*.ts", "fixtures/**/*.ts", "playwright.config.ts"]
}
```

Relative imports only — no path aliases. They add loader risk for zero benefit at this size.

- [ ] **Step 3: Append the QA section to `.gitignore`**

The existing `.gitignore` is the Visual Studio template. Append at the end:

```gitignore

# ---- Marksheet+ QA (Node / Playwright) ----
node_modules/
.env
.auth/
playwright-report/
test-results/
blob-report/
playwright/.cache/
```

`.env` and `.auth/` hold live credentials and session cookies. They must never reach the remote.

- [ ] **Step 4: Install dependencies and the browser**

Run: `npm install && npx playwright install chromium`
Expected: dependencies install, Chromium downloads, no errors.

- [ ] **Step 5: Verify TypeScript is wired up**

Run: `npm run typecheck`
Expected: PASS with no output (no source files yet, so nothing to fail).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore
git commit -m "chore: scaffold Playwright TypeScript QA project"
```

---

### Task 2: Playwright configuration

**Files:**
- Create: `playwright.config.ts`
- Create: `.env.example`

- [ ] **Step 1: Create `.env.example`**

```bash
# Copy to .env and fill in. .env is gitignored — never commit real credentials.
QA_BASE_URL=https://qa-integration.marksheetplus.com

# Seeded QA test account
QA_EMAIL=
QA_PASSWORD=
```

- [ ] **Step 2: Create `playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

const baseURL = process.env.QA_BASE_URL ?? 'https://qa-integration.marksheetplus.com';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['list'],
  ],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'setup',
      testDir: './fixtures',
      testMatch: /.*\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'anonymous',
      testDir: './tests/auth',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'authenticated',
      testDir: './tests',
      testIgnore: /auth[\\/]/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: path.join(__dirname, '.auth', 'user.json'),
      },
      dependencies: ['setup'],
    },
  ],
});
```

Why three projects: `setup` logs in once. `authenticated` reuses that state and skips `tests/auth`. `anonymous` runs `tests/auth` with **no** stored state and **no** setup dependency — a login test that starts logged in proves nothing.

The `json` reporter is not decoration: `run-and-triage` (Task 9) parses `test-results/results.json`.

- [ ] **Step 3: Verify the config parses**

Run: `npx playwright test --list`
Expected: exits cleanly reporting `Total: 0 tests in 0 files`. Any config syntax/type error surfaces here.

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts .env.example
git commit -m "chore: add Playwright config with auth-state project wiring"
```

---

### Task 3: Recon the live application

**Files:**
- Create: `docs/qa/ui-reference.md`

**Why this task exists:** every page object below ships with *provisional* selectors written blind. They are guesses. This task replaces guesses with observed fact. Do not skip it and do not "fix selectors later when tests fail" — that wastes a full debug cycle per screen.

- [ ] **Step 1: Open the live app via Playwright MCP**

Use the Playwright MCP tools to navigate to `https://qa-integration.marksheetplus.com`. Take a page snapshot of the landing/login screen.

- [ ] **Step 2: Record the auth surface**

For the login screen, capture into notes:
- The actual route (`/login`? `/auth/login`? root redirect?).
- The email field: is it reachable by `getByLabel(/email/i)`, or does it need a placeholder/`id`?
- The password field.
- The submit button's accessible name (`Sign in` vs `Log in` vs `Continue`).
- Where a failed login renders its error, and whether that element has `role="alert"`.
- Where a successful login lands (URL) and a stable element that only appears when logged in.

- [ ] **Step 3: Record the register surface**

Navigate to the registration form. Capture its route, every required field, and the success/landing condition.

- [ ] **Step 4: Record the students surface**

Log in with the seeded account and navigate to Students. Capture the route, how the list renders (table? cards?), how a single student is opened, and what identifies a student row.

- [ ] **Step 5: Write `docs/qa/ui-reference.md`**

Structure it as:

```markdown
# Marksheet+ QA — Observed UI Reference

Observed against https://qa-integration.marksheetplus.com on <DATE>.
Update this file whenever a selector changes. Page objects derive from it.

## Login
- Route: <observed>
- Email field: <observed locator strategy>
- Password field: <observed>
- Submit: <observed accessible name>
- Error element: <observed, incl. whether role=alert>
- Logged-in signal: <observed URL + stable element>

## Register
- Route: <observed>
- Fields: <observed list, marking required>
- Success signal: <observed>

## Students
- Route: <observed>
- List rendering: <observed>
- Row identity: <observed>
- Open profile: <observed interaction>
```

Fill every `<observed>` with real values. A placeholder left in this file is a defect — it means the next task builds on a guess.

- [ ] **Step 6: Commit**

```bash
git add docs/qa/ui-reference.md
git commit -m "docs: record observed UI reference for qa-integration"
```

---

### Task 4: Login page object and auth setup

**Files:**
- Create: `pages/login.page.ts`
- Create: `fixtures/auth.setup.ts`

**Depends on:** Task 3 (`docs/qa/ui-reference.md`) and the credentials prerequisite.

- [ ] **Step 1: Create `pages/login.page.ts`**

Selectors below are the provisional defaults. **Reconcile every locator against `docs/qa/ui-reference.md` before running.** Where recon disagrees, recon wins.

```ts
import { Page, Locator, expect } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.getByLabel(/email/i);
    this.passwordInput = page.getByLabel(/password/i);
    this.submitButton = page.getByRole('button', { name: /sign in|log in/i });
    this.errorMessage = page.getByRole('alert');
  }

  async goto(): Promise<void> {
    await this.page.goto('/login');
  }

  async login(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async expectLoggedIn(): Promise<void> {
    await expect(this.page).not.toHaveURL(/login/i, { timeout: 30_000 });
  }

  async expectLoginRejected(): Promise<void> {
    await expect(this.errorMessage).toBeVisible();
    await expect(this.page).toHaveURL(/login/i);
  }
}
```

- [ ] **Step 2: Create `fixtures/auth.setup.ts`**

```ts
import { test as setup } from '@playwright/test';
import path from 'node:path';
import { LoginPage } from '../pages/login.page';

const authFile = path.join(__dirname, '..', '.auth', 'user.json');

setup('authenticate seeded QA user', async ({ page }) => {
  const email = process.env.QA_EMAIL;
  const password = process.env.QA_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'QA_EMAIL and QA_PASSWORD must be set. Copy .env.example to .env and fill in the seeded QA account.',
    );
  }

  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login(email, password);
  await loginPage.expectLoggedIn();

  await page.context().storageState({ path: authFile });
});
```

The explicit credential check turns a confusing cascade of timeouts into one clear sentence.

- [ ] **Step 3: Run setup against the live environment**

Run: `npx playwright test --project=setup`
Expected: PASS, and `.auth/user.json` is created.

If it fails: this is the canary. Do not proceed. Either the credentials are wrong or the selectors disagree with recon. Fix here — every later task depends on this working.

- [ ] **Step 4: Verify the state file exists and is ignored**

Run: `ls .auth/user.json && git check-ignore -v .auth/user.json`
Expected: file listed, and `git check-ignore` confirms it is ignored.

- [ ] **Step 5: Commit**

```bash
git add pages/login.page.ts fixtures/auth.setup.ts
git commit -m "feat: add login page object and seeded-account auth setup"
```

---

### Task 5: Auth regression specs

**Files:**
- Create: `tests/auth/login.spec.ts`

**Depends on:** Task 4.

- [ ] **Step 1: Write the failing specs**

```ts
import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/login.page';

test.describe('Login', () => {
  test('a seeded user can log in with valid credentials', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(process.env.QA_EMAIL!, process.env.QA_PASSWORD!);
    await loginPage.expectLoggedIn();
  });

  test('login is rejected with an invalid password', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(process.env.QA_EMAIL!, 'definitely-not-the-password');
    await loginPage.expectLoginRejected();
  });

  test('login is rejected with an unknown email', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login('no-such-user@example.invalid', 'irrelevant');
    await loginPage.expectLoginRejected();
  });
});
```

These specs contain zero selectors. That is the boundary working.

- [ ] **Step 2: Run the auth suite**

Run: `npm run test:auth`
Expected: 3 passed. These run in the `anonymous` project with no stored state.

If "valid credentials" passes but a rejection test fails, the app likely does not expose `role="alert"` on its error. Update `errorMessage` in `pages/login.page.ts` per recon — not the spec.

- [ ] **Step 3: Commit**

```bash
git add tests/auth/login.spec.ts
git commit -m "test: add login regression specs"
```

---

### Task 6: Registration flow

**Files:**
- Create: `fixtures/test-data.ts`
- Create: `pages/register.page.ts`
- Create: `fixtures/register.ts`
- Create: `tests/auth/register.spec.ts`

**Depends on:** Task 3 recon of the register surface.

- [ ] **Step 1: Create `fixtures/test-data.ts`**

```ts
/** Unique test data so parallel runs never collide. */

export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function uniqueEmail(prefix = 'qa-auto'): string {
  return `${prefix}+${uniqueSuffix()}@marksheetplus-qa.invalid`;
}

export function uniqueName(prefix = 'QA Student'): string {
  return `${prefix} ${uniqueSuffix()}`;
}
```

`.invalid` is reserved by RFC 2606 and can never route to a real inbox. If the app requires a deliverable address to activate an account, replace this with a real catch-all domain — and record that decision in `docs/qa/ui-reference.md`.

- [ ] **Step 2: Create `pages/register.page.ts`**

Provisional — reconcile against recon before running.

```ts
import { Page, Locator, expect } from '@playwright/test';

export interface NewAccount {
  email: string;
  password: string;
  fullName: string;
}

export class RegisterPage {
  readonly page: Page;
  readonly fullNameInput: Locator;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.fullNameInput = page.getByLabel(/name/i);
    this.emailInput = page.getByLabel(/email/i);
    this.passwordInput = page.getByLabel(/^password/i);
    this.submitButton = page.getByRole('button', { name: /register|sign up|create account/i });
  }

  async goto(): Promise<void> {
    await this.page.goto('/register');
  }

  async register(account: NewAccount): Promise<void> {
    await this.fullNameInput.fill(account.fullName);
    await this.emailInput.fill(account.email);
    await this.passwordInput.fill(account.password);
    await this.submitButton.click();
  }

  async expectRegistered(): Promise<void> {
    await expect(this.page).not.toHaveURL(/register/i, { timeout: 30_000 });
  }
}
```

- [ ] **Step 3: Create `fixtures/register.ts`**

```ts
import { Page } from '@playwright/test';
import { RegisterPage, NewAccount } from '../pages/register.page';
import { uniqueEmail, uniqueName } from './test-data';

/**
 * Registers a brand-new account through the UI and returns its credentials.
 * Use when a test needs a user with no prior state.
 */
export async function registerNewAccount(page: Page): Promise<NewAccount> {
  const account: NewAccount = {
    email: uniqueEmail(),
    password: 'QaAuto!2026',
    fullName: uniqueName('QA User'),
  };

  const registerPage = new RegisterPage(page);
  await registerPage.goto();
  await registerPage.register(account);
  await registerPage.expectRegistered();

  return account;
}
```

- [ ] **Step 4: Write the failing spec**

```ts
import { test, expect } from '@playwright/test';
import { registerNewAccount } from '../../fixtures/register';

test.describe('Registration', () => {
  test('a new account can be registered through the form', async ({ page }) => {
    const account = await registerNewAccount(page);
    expect(account.email).toContain('@');
  });
});
```

- [ ] **Step 5: Run it**

Run: `npx playwright test tests/auth/register.spec.ts --project=anonymous`
Expected: PASS.

If registration requires email confirmation before landing, `expectRegistered()` is wrong. Change it to assert the actual observed post-submit state (e.g. a "check your inbox" message) — per recon, not per guess.

- [ ] **Step 6: Commit**

```bash
git add fixtures/test-data.ts fixtures/register.ts pages/register.page.ts tests/auth/register.spec.ts
git commit -m "feat: add registration page object, helper, and spec"
```

---

### Task 7: Students management

**Files:**
- Create: `pages/students.page.ts`
- Create: `pages/student-profile.page.ts`
- Create: `tests/students/students-list.spec.ts`

**Depends on:** Task 3 recon of the students surface, Task 4 auth state.

- [ ] **Step 1: Create `pages/students.page.ts`**

Provisional — reconcile against recon.

```ts
import { Page, Locator, expect } from '@playwright/test';

export class StudentsPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly searchInput: Locator;
  readonly studentRows: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: /students/i });
    this.searchInput = page.getByPlaceholder(/search/i);
    this.studentRows = page.getByRole('row');
  }

  async goto(): Promise<void> {
    await this.page.goto('/students');
  }

  async expectLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible();
  }

  async search(term: string): Promise<void> {
    await this.searchInput.fill(term);
  }

  async openStudent(name: string): Promise<void> {
    await this.page.getByRole('link', { name }).click();
  }

  async studentCount(): Promise<number> {
    return this.studentRows.count();
  }
}
```

- [ ] **Step 2: Create `pages/student-profile.page.ts`**

```ts
import { Page, Locator, expect } from '@playwright/test';

export class StudentProfilePage {
  readonly page: Page;
  readonly nameHeading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.nameHeading = page.getByRole('heading').first();
  }

  async expectLoadedFor(name: string): Promise<void> {
    await expect(this.nameHeading).toContainText(name);
  }
}
```

- [ ] **Step 3: Write the failing specs**

```ts
import { test, expect } from '@playwright/test';
import { StudentsPage } from '../../pages/students.page';

test.describe('Students list', () => {
  test('the students list loads for an authenticated user', async ({ page }) => {
    const studentsPage = new StudentsPage(page);
    await studentsPage.goto();
    await studentsPage.expectLoaded();
  });

  test('the students list renders at least one student', async ({ page }) => {
    const studentsPage = new StudentsPage(page);
    await studentsPage.goto();
    await studentsPage.expectLoaded();
    expect(await studentsPage.studentCount()).toBeGreaterThan(0);
  });
});
```

The second spec assumes the seeded account has students. If recon shows an empty list, either seed one or delete this spec — do not weaken it to `toBeGreaterThanOrEqual(0)`, which asserts nothing.

- [ ] **Step 4: Run the authenticated suite**

Run: `npm run test:regression`
Expected: PASS. The `setup` project runs first and supplies auth state.

- [ ] **Step 5: Commit**

```bash
git add pages/students.page.ts pages/student-profile.page.ts tests/students/students-list.spec.ts
git commit -m "test: add students list page objects and regression specs"
```

---

### Task 8: MCP and Claude Code settings

**Files:**
- Create: `.mcp.json`
- Create: `.claude/settings.json`

- [ ] **Step 1: Create `.mcp.json`**

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

- [ ] **Step 2: Create `.claude/settings.json`**

```json
{
  "permissions": {
    "allow": [
      "Bash(npm install)",
      "Bash(npm run test:*)",
      "Bash(npm run typecheck)",
      "Bash(npx playwright test:*)",
      "Bash(npx playwright install:*)",
      "Bash(npx playwright show-report:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)"
    ]
  },
  "enableAllProjectMcpServers": true
}
```

`enableAllProjectMcpServers` picks up the Playwright server from `.mcp.json` without a prompt per session.

Do **not** add `enabledPlugins` for ClickUp here — the plugin/marketplace identifier is unverified, and a wrong key silently does nothing. ClickUp enablement is the user's interactive step (see Prerequisites).

- [ ] **Step 3: Verify Playwright MCP resolves**

Run: `npx -y @playwright/mcp@latest --version`
Expected: prints a version string.

- [ ] **Step 4: Commit**

```bash
git add .mcp.json .claude/settings.json
git commit -m "chore: wire Playwright MCP and QA permission allowlist"
```

---

### Task 9: QA skills

**Files:**
- Create: `.claude/skills/qa-task-context/SKILL.md`
- Create: `.claude/skills/write-regression-test/SKILL.md`
- Create: `.claude/skills/run-and-triage/SKILL.md`
- Create: `.claude/skills/report-to-clickup/SKILL.md`

- [ ] **Step 1: Create `.claude/skills/qa-task-context/SKILL.md`**

```markdown
---
name: qa-task-context
description: Pull the QA context for a Marksheet+ task from ClickUp — what changed, what the acceptance criteria are, and what to verify. Use when a ClickUp task ID/URL is shared with intent to test it, or when scanning the `qa` status for work. Triggers include "test this task", "QA 86ex...", "what needs testing", "verify this ticket".
---

# QA Task Context

Turn a ClickUp task into a concrete test charter.

## Inputs

- `task_id` — ClickUp task ID or URL. If absent, ask once: *"Which ClickUp task should I QA? (paste the ID or URL)"*. Do not proceed without it.

## ClickUp map

- Dev Backlog: `901812410599` — dev tasks in all statuses (`to do`, `development`, `review`, `qa`, `complete`). **Tasks ready for QA sit in the `qa` status.**
- Product Stories: `901811119243` — linked user stories carrying the real acceptance criteria.

## Procedure

1. `clickup_get_task` on `task_id` with `detail_level: "detailed"` and `subtasks: true`.
2. If `linked_tasks[0]` points at a Product User Story, `clickup_get_task` on it for acceptance criteria and persona. Run in the same tool turn as any other independent reads.
3. To find all work awaiting QA: `clickup_filter_tasks` with `list_ids: ["901812410599"]` and filter to the `qa` status.

## Output — the test charter

Report exactly this shape:

> **Task:** [title](clickup-url) · `id` · status · assignees
>
> **What changed:** 2-3 sentences, plain language.
>
> **Acceptance criteria:** bullet list, each phrased as a verifiable statement.
>
> **Test charter:**
> - *Scripted:* which criteria a Playwright spec can prove, and whether a spec already exists in `tests/`.
> - *Exploratory:* which criteria need a human-like pass via Playwright MCP (visual, ambiguous, or one-off).
>
> **Risk areas:** what is most likely broken, and why.

## Rules

- Every task/story mentioned must be a clickable ClickUp URL.
- Never invent acceptance criteria. If the task has none, say so and ask the user what "done" means before testing.
- Check `tests/` for existing coverage before declaring something needs a new spec.
```

- [ ] **Step 2: Create `.claude/skills/write-regression-test/SKILL.md`**

```markdown
---
name: write-regression-test
description: Conventions for authoring Playwright/TypeScript regression tests in this repo — page objects, selectors, fixtures, and data isolation. Use before creating or editing anything under tests/ or pages/.
---

# Writing Regression Tests

## The boundary (non-negotiable)

- **Specs contain no selectors.** If a `.spec.ts` file contains `getByRole`, `locator(`, or a CSS string, it is wrong. Selectors live in `pages/`.
- **Page objects contain no business assertions.** They may assert their own screen loaded (`expectLoaded`). They do not assert business outcomes — that is the spec's job.
- **Fixtures do not import page objects**, except `auth.setup.ts` and `register.ts`, which legitimately drive UI.

## Selector priority

Prefer, in order:
1. `getByRole(...)` with an accessible name — survives restyling, and asserts accessibility as a side effect.
2. `getByLabel(...)` for form fields.
3. `getByTestId(...)` if the app exposes test ids.
4. CSS/XPath — last resort. If you use one, add a comment explaining why nothing better exists.

Never select on Bootstrap/Metronic utility classes. They change with styling and produce false failures.

## Ground selectors in reality

`docs/qa/ui-reference.md` records what the live app actually renders. Read it before writing a page object. If it is stale or missing the screen, drive the live app via Playwright MCP, observe, and update that file first. Never guess a selector.

## Test data

- Always unique: use `uniqueEmail()` / `uniqueName()` from `fixtures/test-data.ts`. Hard-coded names collide under `fullyParallel`.
- Tests must not depend on each other's data or run order.

## Structure

- One behaviour per test. The test name states the behaviour: *"login is rejected with an invalid password"*, not *"test login 2"*.
- Auth-related specs go in `tests/auth/` (project `anonymous`, no stored state).
- Everything else goes in `tests/<module>/` (project `authenticated`).

## Waiting

Never `page.waitForTimeout()`. Use web-first assertions (`await expect(locator).toBeVisible()`) which retry automatically. A fixed sleep is either flaky or slow, usually both.

## Workflow

1. Write the spec first, in terms of intent methods that may not exist yet.
2. Run it. Confirm it fails for the right reason (method missing / element absent) — not a typo.
3. Implement the page object method.
4. Run again. Confirm green.
5. Commit spec + page object together.
```

- [ ] **Step 3: Create `.claude/skills/run-and-triage/SKILL.md`**

```markdown
---
name: run-and-triage
description: Run the Marksheet+ Playwright suite and triage the results — separating real failures from flakes and environment problems. Use whenever tests are run or a failure needs interpreting.
---

# Run and Triage

## Running

- Whole suite: `npm test`
- Auth only (anonymous): `npm run test:auth`
- Authenticated regression: `npm run test:regression`
- One file: `npx playwright test tests/students/students-list.spec.ts`
- Debug visually: `npm run test:headed` or `npm run test:ui`

Machine-readable results land in `test-results/results.json`. Parse that rather than scraping stdout.

## Triage — classify every failure

Read `test-results/results.json`. For each failed test, the `results` array has one entry per attempt (`retries: 1`, so up to two).

| Pattern | Classification | Action |
|---|---|---|
| Failed attempt 1, passed attempt 2 | **FLAKY** | Report as flaky. **Not a pass.** File it to be fixed — usually a missing web-first assertion. |
| Failed every attempt, assertion mismatch | **REAL FAILURE** | Candidate bug. Verify against acceptance criteria before reporting. |
| Failed every attempt, timeout on every selector | **SELECTOR DRIFT or ENV DOWN** | Check the app is reachable. If up, the UI changed — re-recon and update `docs/qa/ui-reference.md`. Not a product bug. |
| `setup` project failed | **BLOCKED** | Auth is broken. Everything downstream is meaningless. Report as blocked, not as N failures. |

## Rules

- **A flake is never green.** Reporting a retry-pass as a pass hides real instability and is how suites rot.
- **A selector break is not a bug.** Do not file a defect against the product because a test is out of date. Fix the test.
- Before calling a failure a product bug, reproduce it once via Playwright MCP against the live app. A bug report that does not reproduce costs the team more than it saves.

## Output

> **Run:** <scope> · <passed>/<total> passed · <duration>
>
> **Real failures:** list with the failing assertion and the acceptance criterion it violates.
> **Flaky:** list with attempt counts.
> **Blocked/env:** anything that never got to run meaningfully.
>
> **Verdict:** PASS / FAIL / BLOCKED — one line, unambiguous.
```

- [ ] **Step 4: Create `.claude/skills/report-to-clickup/SKILL.md`**

```markdown
---
name: report-to-clickup
description: Report QA results back to a ClickUp task — pass/fail summary, bug write-up with repro steps and evidence, and a proposed status transition. Use after a QA run completes on a ClickUp-tracked task.
---

# Report QA Results to ClickUp

## What is automatic vs. confirmed

- **Automatic:** posting the result comment and any bug write-up.
- **Requires human confirmation:** changing the task's status. Always propose, never transition unasked. Moving a ticket is visible to the whole team — ask first.

## Procedure

1. Post the result with `clickup_create_task_comment` on the task id.
2. State the proposed transition and ask the user to confirm:
   - All criteria pass → propose `qa` → `complete`.
   - Any real failure → propose `qa` → `development`.
   - Blocked (env/auth down) → propose leaving it in `qa`; it was never tested.
3. Only after explicit confirmation, apply the transition.

## Pass comment format

> ✅ **QA PASSED** — <scope tested>
>
> **Verified:**
> - <criterion> — automated: `tests/<path>:<test name>`
> - <criterion> — exploratory via Playwright MCP
>
> **Run:** <passed>/<total> passed · env: qa-integration
>
> _Automated QA via Claude Code._

## Fail comment format

> ❌ **QA FAILED** — <scope tested>
>
> **Defect:** one sentence — the observed wrong behaviour.
>
> **Expected:** <from the acceptance criterion>
> **Actual:** <what happened>
>
> **Steps to reproduce:**
> 1. <exact step>
> 2. <exact step>
>
> **Environment:** qa-integration.marksheetplus.com · Chromium
> **Evidence:** <screenshot / trace path>
> **Failing test:** `tests/<path>:<test name>` (if automated)
>
> _Automated QA via Claude Code._

## Rules

- One defect per report. Two bugs in one comment means one gets forgotten.
- Repro steps must be exact enough for a developer to follow without asking a question. "Log in and it breaks" is not a repro.
- Never report a flake as a failure, or a retry-pass as a pass. Say "flaky" and mean it.
- If ClickUp is unavailable, still surface the full result to the user locally. A reporting outage must never discard a run.
- Attach evidence for every failure. A failure without a screenshot or trace gets bounced back.
```

- [ ] **Step 5: Commit**

```bash
git add .claude/skills
git commit -m "feat: add QA skills for context, authoring, triage, and reporting"
```

---

### Task 10: QA agents

**Files:**
- Create: `.claude/agents/qa-lead.md`
- Create: `.claude/agents/regression-author.md`
- Create: `.claude/agents/exploratory-tester.md`

- [ ] **Step 1: Create `.claude/agents/qa-lead.md`**

```markdown
---
name: qa-lead
description: Marksheet+ QA lead. Use as the entry point whenever a ClickUp task needs testing end-to-end, or when scanning the `qa` status for work. Grounds the task via qa-task-context, dispatches scripted and exploratory testing in parallel, triages results, and reports back to ClickUp. Triggers include "QA this task", "test 86ex...", "what's waiting in QA", "run QA on this ticket".
tools: Read, Write, Edit, Glob, Grep, Bash, Skill, Agent, AskUserQuestion
---

You are the QA lead for Marksheet+. You own the loop from "a task entered `qa`" to "a verdict is on the ticket".

## Procedure

1. **Ground the work.** Invoke the `qa-task-context` skill to turn the ClickUp task into a test charter. Never test from the task title alone.

2. **Dispatch both tracks in parallel** (single message, two Agent calls):
   - `regression-author` — for criteria a Playwright spec can prove durably.
   - `exploratory-tester` — for criteria needing a live human-like pass.

   If the charter says a criterion is fully covered by an existing green spec, do not re-author it.

3. **Triage.** Invoke `run-and-triage`. Classify every failure. A flake is not a pass.

4. **Reproduce before accusing.** Any real failure gets reproduced once against the live app before it becomes a defect.

5. **Report.** Invoke `report-to-clickup`. Post the result automatically; **propose** the status transition and wait for the user to confirm.

## Rules

- Never report a verdict you did not observe. If the suite did not run, say BLOCKED — do not infer.
- Never weaken a test to make it pass. A test changed to accommodate a bug is worse than no test.
- If acceptance criteria are missing or ambiguous, ask the user what "done" means before testing. Guessing produces confident nonsense.
- Report faithfully: if something was skipped, say it was skipped.
```

- [ ] **Step 2: Create `.claude/agents/regression-author.md`**

```markdown
---
name: regression-author
description: Authors and updates Marksheet+ Playwright/TypeScript regression tests against acceptance criteria. Use when a QA task needs durable automated coverage — a new spec, a new page object, or an update to existing ones. Dispatched by qa-lead, but fine to invoke directly ("write a regression test for student search").
tools: Read, Write, Edit, Glob, Grep, Bash, Skill
---

You author regression tests for Marksheet+.

## Procedure

1. **Load conventions.** Invoke the `write-regression-test` skill before typing any test code. It defines the boundary between specs and page objects. Follow it exactly.

2. **Ground selectors in reality.** Read `docs/qa/ui-reference.md`. If the screen you need is missing or stale, drive the live app via Playwright MCP, observe the real DOM, and update that file first. Never guess a selector.

3. **TDD, in this order:**
   - Write the spec in terms of intent methods.
   - Run it. Confirm it fails for the right reason.
   - Implement the page object method.
   - Run it. Confirm green.
   - Commit spec + page object together.

4. **Verify before claiming.** Run the test and paste the actual output. Never claim green without having seen green.

## Rules

- No selectors in specs. No business assertions in page objects.
- No `waitForTimeout`. Use web-first assertions.
- Unique test data always — `fixtures/test-data.ts`.
- If a test fails because the product is genuinely broken, that is a finding, not something to code around. Report it; do not weaken the assertion.
```

- [ ] **Step 3: Create `.claude/agents/exploratory-tester.md`**

```markdown
---
name: exploratory-tester
description: Drives the live qa-integration.marksheetplus.com app through Playwright MCP to verify acceptance criteria a scripted test cannot prove — visual checks, ambiguous behaviour, edge cases, one-off flows — and captures evidence for bug reports. Dispatched by qa-lead, but fine to invoke directly ("go click through the student profile and see if the SPI tile renders").
tools: Read, Glob, Grep, Bash, Skill
---

You are an exploratory tester working against the live Marksheet+ QA environment.

## Scope

`https://qa-integration.marksheetplus.com`. This is a shared QA environment, not a sandbox — other people rely on it.

## Procedure

1. Read the test charter you were given. If you were given none, ask for the acceptance criteria rather than wandering.
2. Drive the app via Playwright MCP: navigate, snapshot, interact, observe.
3. For each criterion, record: what you did, what you expected, what actually happened.
4. Capture a screenshot for anything that looks wrong. A defect without evidence gets bounced.
5. Probe the edges the scripted suite will not: empty states, long strings, rapid double-submits, browser back after an action, permissions/role boundaries.

## Rules

- **Observe, do not fix.** You test; you do not modify product code.
- **Be careful with destructive actions.** Do not delete data you did not create. Use unique/generated data when creating.
- **Report only what you saw.** Never describe behaviour you did not actually observe. "I did not check X" is a valid and useful thing to say.
- Distinguish "broken" from "surprising". Surprising-but-per-spec is a UX note, not a defect.

## Output

> **Charter:** <what you were asked to verify>
>
> **Verified:** <criterion> — PASS · <what you observed>
> **Defects:** <criterion> — FAIL · expected / actual / repro steps / screenshot
> **Not checked:** <anything you could not reach, and why>
> **UX notes:** <surprising but arguably correct>
```

- [ ] **Step 4: Verify the agents are discovered**

Run: `ls .claude/agents/`
Expected: three `.md` files listed. (They register on the next session start.)

- [ ] **Step 5: Commit**

```bash
git add .claude/agents
git commit -m "feat: add qa-lead, regression-author, and exploratory-tester agents"
```

---

### Task 11: Slash commands

**Files:**
- Create: `.claude/commands/qa.md`
- Create: `.claude/commands/qa-regression.md`

- [ ] **Step 1: Create `.claude/commands/qa.md`**

```markdown
---
description: Run the full QA loop on a ClickUp task — context, test, triage, report
argument-hint: <clickup-task-id-or-url>
---

Run the full QA loop on ClickUp task: $ARGUMENTS

Dispatch the `qa-lead` agent. It must:
1. Ground the task via the `qa-task-context` skill.
2. Dispatch `regression-author` and `exploratory-tester` in parallel.
3. Triage via `run-and-triage`.
4. Report via `report-to-clickup` — posting the comment automatically, but proposing the status transition and waiting for my confirmation.

If no task id was provided above, ask me for one before doing anything.
```

- [ ] **Step 2: Create `.claude/commands/qa-regression.md`**

```markdown
---
description: Run the full Playwright regression suite and summarize the verdict
---

Run the full Marksheet+ regression suite against qa-integration.

1. Invoke the `run-and-triage` skill.
2. Run `npm test`.
3. Parse `test-results/results.json` — do not scrape stdout.
4. Classify every failure: real failure / flaky / selector drift / blocked.
5. Give me the verdict block: PASS / FAIL / BLOCKED, with real failures and flakes listed separately.

Do not report a retry-pass as a pass. Do not file product defects for out-of-date selectors.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/commands
git commit -m "feat: add /qa and /qa-regression slash commands"
```

---

### Task 12: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# Marksheet+ QA

Automated QA workspace for **qa-integration.marksheetplus.com** — a Playwright/TypeScript regression suite plus Claude Code agents that pull work from ClickUp, test it, and report back.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # then fill in QA_EMAIL / QA_PASSWORD
```

`.env` and `.auth/` hold live credentials and session cookies. Both are gitignored. Never commit them.

## Running tests

| Command | What it does |
|---|---|
| `npm test` | Whole suite. |
| `npm run test:auth` | Auth specs only (anonymous, no stored state). |
| `npm run test:regression` | Authenticated regression specs. |
| `npm run test:headed` | Watch it run in a real browser. |
| `npm run test:ui` | Playwright UI mode — best for debugging. |
| `npm run report` | Open the last HTML report. |
| `npm run typecheck` | Type-check without emitting. |

## Layout

- `tests/` — specs. **No selectors here.**
- `pages/` — page objects. Selectors live here, and only here.
- `fixtures/` — auth setup, test-data generators, registration helper.
- `docs/qa/ui-reference.md` — what the live app actually renders. Page objects derive from this. Keep it current.

Auth runs once: the `setup` project logs in with the seeded account and saves `storageState` to `.auth/user.json`; the `authenticated` project reuses it. Auth specs deliberately run without it.

## Claude Code QA workspace

| Command | What it does |
|---|---|
| `/qa <clickup-id>` | Full QA loop on a ClickUp task: context → test → triage → report. |
| `/qa-regression` | Run the whole suite and give a verdict. |

**Agents:** `qa-lead` (orchestrator), `regression-author` (writes specs), `exploratory-tester` (live Playwright MCP session).

**Skills:** `qa-task-context`, `write-regression-test`, `run-and-triage`, `report-to-clickup`.

### ClickUp

QA work is pulled from the `qa` status of the Dev Backlog (`901812410599`). Results are posted back to the task automatically; **status transitions require human confirmation.**

Requires the ClickUp connector to be enabled and authorized (`/mcp` in an interactive session). Without it, the suite and exploratory testing still work — only the ClickUp reporting loop is unavailable.

## Conventions

- Selector priority: `getByRole` → `getByLabel` → `getByTestId` → CSS (last resort, comment why).
- Never `waitForTimeout`. Use web-first assertions.
- Unique test data always — parallel runs must never collide.
- A flake is not a pass.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add QA workspace README"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Playwright TS project | 1, 2 |
| POM layer | 4, 6, 7 |
| auth.setup.ts + storageState | 4 |
| Auth specs run without stored state | 2 (project wiring), 5 |
| registerNewAccount() helper | 6 |
| Reliability (retries/trace/screenshot/video) | 2 |
| Unique test data | 6 |
| baseURL from QA_BASE_URL | 2 |
| Initial coverage: auth + students | 5, 6, 7 |
| qa-lead / regression-author / exploratory-tester | 10 |
| Four skills | 9 |
| /qa and /qa-regression | 11 |
| .mcp.json + settings.json | 8 |
| Error handling: env unreachable, auth failure blocking, flaky classification, ClickUp unavailable | 9 (`run-and-triage`, `report-to-clickup`) |
| Status transitions need confirmation | 9, 10, 11 |
| CI out of scope | Honored — no pipeline task |

Gap found and closed during review: the spec assumed page objects could be written directly, but no selector is knowable without observing the live app. **Task 3 (recon) was added** and Tasks 4/6/7 now depend on it. Provisional selectors are labelled as guesses rather than presented as fact.

**Placeholder scan:** The only `<placeholder>` markers are inside the Task 3 template, where filling them in *is* the task — and the step states that leaving one is a defect. No TBDs elsewhere.

**Type consistency:** `NewAccount` is defined in `pages/register.page.ts` (Task 6, Step 2) and imported by `fixtures/register.ts` (Step 3) and used in `tests/auth/register.spec.ts` (Step 4). `LoginPage` methods (`goto`, `login`, `expectLoggedIn`, `expectLoginRejected`) defined in Task 4 match every call site in Tasks 4–5. `StudentsPage` methods (`goto`, `expectLoaded`, `search`, `openStudent`, `studentCount`) defined in Task 7 match their spec call sites. `uniqueEmail` / `uniqueName` defined in Task 6 Step 1 match usage in Step 3. Consistent.
