# Testing notes

Environment facts and lessons that save time in the next cycle.

## Environment

- The integration environment is shared and long-lived: data persists between runs and other
  people create data too. Use unique values; never rely on the database being empty.
- Sign-in is OIDC: the web app redirects to the auth host, which redirects back after "Sign in".
  `fixtures/auth.setup.ts` saves cookies + localStorage for both hosts into `.auth/user.json`.
- The seeded account is shared by every run. Wrong-password attempts count towards lockout
  ("Too many failed attempts…"), which would block everyone. The invalid-password spec runs
  with `retries: 0` for that reason.
- Sign-up creates a real tenant. `register.spec.ts` only does it when `QA_ALLOW_SIGNUP=true`.

## Lessons

- 2026-11-03: `qa-integration.marksheetplus.com` timed out (TCP) from the authoring machine
  while DNS resolved to `101.50.85.175`. If Playwright cannot connect, check VPN / IP allow-listing
  before suspecting the app. Classify as BLOCKED, not FAIL.
- 2026-11-03: Blazor `@bind-Value` commits on `change`; the forms also re-validate on `input`.
  Use Playwright `fill()` / `browser_type`, not JS value assignment, or the model is not updated.
- 2026-11-03: Names must be letters only (the name validator rejects digits), so generated names
  use a base-26 suffix (`fixtures/test-data.ts`), not `Date.now()`.

- 2026-11-10 (PR 547 fee challans): on a local stack the Worker `GenerateFeeChallansScheduler` runs every
  minute and re-runs today's cycle whenever a policy's generation day == today (UTC). A school policy with
  `challanGenerationDay` = today's day (allowed days 1/5/10/15/30) and `effectiveFrom` = today gets challans
  in 0.5–2 min. A "next cycle" in the same day: move the issued cycle back with
  `fixtures/fees.ts shiftIssuedCycleBack()` (dates, labels AND the `yyMM-` challan-number prefix, else the
  `IX_FeeChallans_TenantId_ChallanNumber` index clashes). Shift a second time by 2 months, not 1.
- 2026-11-10: `fee-policies/{id}` detail returns `policyName` (lower-cased), not `name`. Root set-up
  (`/accounts/fee-policies/new`) opens the existing school policy's settings once one exists.
- 2026-11-10: the shared `Toggle` component is exposed as role **checkbox** (not switch); `RowActionButton`
  with an Href is an `<a role="button">`. Defaulters "Receive" opens the family page with the family's own
  Receive drawer already open (when the family has combined dues).
- 2026-11-10: `Students.Status` (and other enums in SchoolDbContext) are stored Humanized: 'Active', 'Struck off',
  'Passed'. Writing '1' or 'StruckOff' in a DB setup makes every query that loads students 500 (Humanizer
  NoMatchFoundException) — e.g. the whole Fee Payment list.
- 2026-11-10: two Playwright runs at once on one worktree wipe each other's `test-results/` (cached seed
  files). Give the second run `--output=<other dir>`.

## Unverified (confirm in the first live cycle)

- Whether the access token kept in sessionStorage is re-issued from the refresh token in
  localStorage when `.auth/user.json` is replayed (sessionStorage is not part of storageState).
  If authenticated specs land on the sign-in page, this is why.
- Whether the "WhatsApp Number or Email" and "Password" inputs resolve with `getByLabel`
  (TailwindUi `TextField`); the password label is visually hidden.
- Where sign-up lands on integration with OTP off (expected: away from `/auth/register`).
- The heading role and text on `/students` ("Admission Register" from the breadcrumb).
