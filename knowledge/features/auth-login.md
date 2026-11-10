# Auth — sign in and sign up

**Source of truth:** `MarksheetPlus.Auth/Readme.md`, `Login/Login.razor`, `Register/Register.razor`
(no ClickUp story linked yet) · seeded 2026-11-03 from source · never run live yet.

## Behaviour (from source, inferred criteria)

1. Sign-in is two steps: username (WhatsApp number or email) → "Continue" → password → "Sign in".
2. An unknown username is sent to sign-up with the username prefilled, not shown an error.
3. A wrong password shows "Invalid password. Please try again." and stays on the password step.
4. Empty username shows "Please enter your email or phone to continue."; malformed values show the
   email or phone format message.
5. Repeated wrong passwords lock the account ("Too many failed attempts…").
6. Sign-up requires first/last name, WhatsApp number, password + matching confirmation; email is
   optional; duplicates of phone/email are rejected with "…is already registered…".
7. On integration (OTP off) a successful sign-up leaves `/auth/register` without a WhatsApp code.

## Critical flows

| Flow | Covered by |
| --- | --- |
| Seeded user signs in and lands back on the web app | `fixtures/auth.setup.ts`, `tests/anonymous/login.spec.ts` "a seeded user can sign in…" (@critical) |
| Wrong password rejected | `login.spec.ts` "sign-in is rejected with a wrong password" |
| Unknown username routed to sign-up | `login.spec.ts` "an unknown email is routed to sign-up" |
| Empty / malformed username validated | `login.spec.ts` "an empty username…", "a malformed email…" |
| Sign-up validation (required, mismatch, weak password) | `tests/anonymous/register.spec.ts` |
| Sign-up of a new account | `register.spec.ts` "a new account can be registered…" (only with `QA_ALLOW_SIGNUP=true`) |

## Data

- Seeded account in `.env` (`QA_EMAIL`, `QA_PASSWORD`).
- Sign-up generates a unique `03…` number and a `@marksheetplus-qa.invalid` email.

## Bug history

None yet.

## Still to test

- Lockout threshold and recovery (not automatable on the shared account).
- Forgot password, logout, returnUrl round trips, WhatsApp OTP (off on integration).
