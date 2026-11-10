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

## Unverified (confirm in the first live cycle)

- Whether the access token kept in sessionStorage is re-issued from the refresh token in
  localStorage when `.auth/user.json` is replayed (sessionStorage is not part of storageState).
  If authenticated specs land on the sign-in page, this is why.
- Whether the "WhatsApp Number or Email" and "Password" inputs resolve with `getByLabel`
  (TailwindUi `TextField`); the password label is visually hidden.
- Where sign-up lands on integration with OTP off (expected: away from `/auth/register`).
- The heading role and text on `/students` ("Admission Register" from the breadcrumb).

## WhatsApp fee receipts (PR 555, cycle 1)
- Project `whatsapp-receipts` self-seeds (throwaway owner, back-office activation, fees via fixtures/fees.ts with ChallanGenerationDay = today UTC so the Worker issues challans in ~1 min). Run --workers=1; flow file takes ~5-6 min.
- Kind 6 rows live in Mongo `mp-accounts-db.scheduledwhatsappmessages`; the dev fake sender ignores the PDF, so render `MessageJson.Document.Html` with page.setContent to inspect it.
- Recipient is FatherMobile else MotherMobile (stored normalized +92...); GuardianMobile alone gives no row.
- Adding a metered kind changes the preference list; whatsapp-quota specs assert the full list in MeteredKinds.All order.
