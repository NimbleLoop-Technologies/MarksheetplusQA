---
name: write-regression-test
description: Conventions for authoring Playwright/TypeScript regression tests in this repo — page objects, selectors, fixtures, and data isolation. Use before creating or editing anything under tests/ or pages/.
---

# Writing Regression Tests

## The boundary (non-negotiable)

- **Specs contain no selectors.** If a `.spec.ts` file contains `getByRole`, `locator(`, or a CSS string, it is wrong. Selectors live in `pages/`.
- **Page objects contain no business assertions.** They may assert their own screen loaded (`expectLoaded`). They do not assert business outcomes — that is the spec's job.
- **Fixtures do not import page objects**, except `auth.setup.ts` and `register.ts`, which legitimately drive UI.

## Where specs live

| Project | Directory | Stored state |
|---|---|---|
| `setup` | `fixtures/` | writes `.auth/user.json` |
| `anonymous` | `tests/anonymous/` | none |
| `authenticated` | `tests/authenticated/<module>/` | `.auth/user.json` |

- A spec goes in `tests/anonymous/` **only** if it must run logged out (login, register).
- Everything else goes in `tests/authenticated/<module>/`.
- **Never put a `.spec.ts` directly in `tests/`.** It would belong to no project and would silently never run. There is no `testIgnore` and no warning — it just vanishes from the suite.

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
- This runs against a **shared live environment**. Do not delete data you did not create.

## Structure

- One behaviour per test. The test name states the behaviour: *"login is rejected with an invalid password"*, not *"test login 2"*.
- Tag core journeys `{ tag: '@critical' }` (sign-in, admissions, attendance, results, fees). `npm run test:critical` runs only those.
- An open bug stays covered: wrap the spec with `test.fail()` and put the bug slug from `knowledge/known-issues.md` in the test name. When the bug is fixed the test "unexpectedly passes" and someone removes the marker.
- A test that needs a precondition the environment may lack (credentials, a feature flag, permission to create tenants) uses `test.skip(condition, 'why')` — never a silent early `return`.
- Hosts come from `pages/urls.ts` (`WEB_URL`, `AUTH_URL`). Sign-in and sign-up live on the auth host.

## Waiting

Never `page.waitForTimeout()`. Use web-first assertions (`await expect(locator).toBeVisible()`) which retry automatically. A fixed sleep is either flaky or slow, usually both.

## Workflow

1. Write the spec first, in terms of intent methods that may not exist yet.
2. Run it. Confirm it fails for the right reason (method missing / element absent) — not a typo.
3. Implement the page object method.
4. Run again. Confirm green.
5. Commit spec + page object together.

## Never weaken a test to make it pass

If a test fails because the product is genuinely broken, that is a finding — report it. Changing `toBeGreaterThan(0)` to `toBeGreaterThanOrEqual(0)` to get green asserts nothing and is worse than deleting the test, because it still looks like coverage.
