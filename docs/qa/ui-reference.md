# Marksheet+ QA — UI reference

Selectors the page objects use, and where each came from. Update this file whenever a selector
changes; page objects derive from it.

**Status (2026-11-03):** derived from the application source in `E:\MarksheetPlus2`. The live
environment timed out from the authoring machine, so nothing below is **observed** yet. The first
cycle with network access must confirm each row via Playwright MCP and change "source" to
"observed <date>".

## Login (auth host)

| Element | Locator | Basis |
| --- | --- | --- |
| Entry | web `/` redirects to `QA_AUTH_URL/auth/login?returnUrl=…` | source (OIDC) |
| Card heading | text "Sign in to your account" | source |
| Username | `getByLabel('WhatsApp Number or Email')` | source |
| Continue | `getByRole('button', { name: 'Continue' })` | source |
| Password | `getByLabel('Password', { exact: true })` (label visually hidden; input id `login-password`) | source |
| Show password | `getByRole('button', { name: 'Show password' })` | source (aria-label) |
| Sign in | `getByRole('button', { name: 'Sign in' })` | source |
| Field error | inline text, e.g. "Invalid password. Please try again." — no `role="alert"` known | source |
| Signed-in signal | URL back on the web origin, not `/auth/` or `/authentication/` | source |

## Register (auth host)

| Element | Locator | Basis |
| --- | --- | --- |
| Route | `/auth/register` (also reached from step 1 with an unknown username) | source |
| Fields | labels "First Name", "Last Name", "WhatsApp Number", "Email Address (optional)", "Password", "Confirm Password" | source |
| Submit | `getByRole('button', { name: 'Create account' })` | source |
| Success signal | URL leaves `/auth/register` (OTP off → onward; OTP on → `/auth/verify-whatsapp`) | source |

## Students (web)

| Element | Locator | Basis |
| --- | --- | --- |
| Route | `/students` | source |
| Loaded signal | document title `Admission Register \| <app>` (breadcrumb sets `<PageTitle>`; the visible title is a `span`, not a heading) | source |
| Rows | `getByRole('row')` filtered to rows that contain a `cell` | source (`Table` component) |
| Open student | `a[href^="students/"]` — the eye link has no accessible name | source |
| Profile route | `/students/{id}` | source |
